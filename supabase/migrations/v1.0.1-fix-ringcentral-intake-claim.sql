-- New Hope Work Desk v1.0.1
-- Fix the Customer Service Intake Queue -> RingCentral claim workflow.
--
-- Result of one agent click:
--   1. Validate that the caller is the current eligible RingCentral agent.
--   2. Claim the cs_intake_submissions row.
--   3. Convert it into the canonical active work_items quote.
--   4. Mark the work item as a RingCentral-turn assignment.
--   5. Advance the RingCentral rotation.
--   6. Preserve the structured intake details and audit trail.
--
-- This migration is intentionally built on the current production lifecycle:
-- Active work_items -> Pending Pricing -> Sold / Not Sold.

begin;

-- -----------------------------------------------------------------------------
-- 0. Fail early when the current production baseline is incomplete.
-- -----------------------------------------------------------------------------
do $preflight$
declare
  v_missing text[] := array[]::text[];
begin
  if to_regclass('public.profiles') is null then
    v_missing := array_append(v_missing, 'profiles');
  end if;
  if to_regclass('public.rotation_state') is null then
    v_missing := array_append(v_missing, 'rotation_state');
  end if;
  if to_regclass('public.turn_events') is null then
    v_missing := array_append(v_missing, 'turn_events');
  end if;
  if to_regclass('public.cs_intake_submissions') is null then
    v_missing := array_append(v_missing, 'cs_intake_submissions');
  end if;
  if to_regclass('public.cs_intake_events') is null then
    v_missing := array_append(v_missing, 'cs_intake_events');
  end if;
  if to_regclass('public.work_items') is null then
    v_missing := array_append(v_missing, 'work_items');
  end if;
  if to_regclass('public.work_item_events') is null then
    v_missing := array_append(v_missing, 'work_item_events');
  end if;
  if to_regclass('public.user_notifications') is null then
    v_missing := array_append(v_missing, 'user_notifications');
  end if;
  if to_regprocedure('public.is_agent()') is null then
    v_missing := array_append(v_missing, 'is_agent()');
  end if;
  if to_regprocedure('public.nhwd_role()') is null then
    v_missing := array_append(v_missing, 'nhwd_role()');
  end if;
  if to_regprocedure('public.next_eligible_profile(public.rotation_kind,integer)') is null then
    v_missing := array_append(v_missing, 'next_eligible_profile(rotation_kind, integer)');
  end if;
  if to_regprocedure('public.cs_intake_convert(uuid)') is null then
    v_missing := array_append(v_missing, 'cs_intake_convert(uuid)');
  end if;

  if cardinality(v_missing) > 0 then
    raise exception
      'RingCentral intake fix cannot be installed. Missing: %',
      array_to_string(v_missing, ', ');
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- 1. Stop guessing the intake source from work_item_id.
--    Existing queue submissions are RingCentral by default. Manager-routed items
--    are marked manual so they keep the manager-assignment workflow.
-- -----------------------------------------------------------------------------
alter table public.cs_intake_submissions
  add column if not exists intake_channel text not null default 'ringcentral';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'cs_intake_channel_check'
      and conrelid = 'public.cs_intake_submissions'::regclass
  ) then
    alter table public.cs_intake_submissions
      add constraint cs_intake_channel_check
      check (intake_channel in ('ringcentral', 'manual'));
  end if;
end
$$;

-- Preserve manager-assigned legacy records as manual workflow records.
update public.cs_intake_submissions s
set intake_channel = 'manual',
    updated_at = now()
where exists (
  select 1
  from public.cs_intake_events e
  where e.submission_id = s.id
    and e.event_type = 'manager_assigned'
)
and s.intake_channel is distinct from 'manual';

create index if not exists cs_intake_channel_status_idx
  on public.cs_intake_submissions (intake_channel, status, submitted_at);

-- -----------------------------------------------------------------------------
-- 2. Keep manager assignment separate from the RingCentral rotation.
-- -----------------------------------------------------------------------------
create or replace function public.cs_intake_manager_assign(
  p_submission_id uuid,
  p_agent_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_creator uuid;
  v_name text;
begin
  if public.nhwd_role() <> 'manager' then
    raise exception 'Manager access required.';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = p_agent_id
      and is_active
      and role::text = 'agent'
  ) then
    raise exception 'Choose an active Sales Agent.';
  end if;

  update public.cs_intake_submissions
  set status = 'claimed',
      claimed_by = p_agent_id,
      claimed_at = now(),
      intake_channel = 'manual',
      updated_at = now()
  where id = p_submission_id
    and status::text = 'submitted'
  returning created_by into v_creator;

  if not found then
    raise exception 'This intake is no longer available for assignment.';
  end if;

  select display_name
  into v_name
  from public.profiles
  where id = p_agent_id;

  insert into public.cs_intake_events (
    submission_id,
    actor_id,
    event_type,
    detail
  )
  values (
    p_submission_id,
    auth.uid(),
    'manager_assigned',
    jsonb_build_object(
      'assigned_to', p_agent_id,
      'assigned_name', v_name,
      'intake_channel', 'manual'
    )
  );

  insert into public.user_notifications (
    recipient_profile_id,
    notification_type,
    title,
    message,
    entity_type,
    entity_id
  )
  values (
    p_agent_id,
    'assignment',
    'Quote intake assigned to you',
    'A Manager assigned a Customer Service intake. Review it and create the quote.',
    'cs_intake',
    p_submission_id
  );

  insert into public.user_notifications (
    recipient_profile_id,
    notification_type,
    title,
    message,
    entity_type,
    entity_id
  )
  values (
    v_creator,
    'assignment',
    'Your intake was assigned',
    'Sales Agent ' || coalesce(v_name, '') || ' received your quote intake.',
    'cs_intake',
    p_submission_id
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. Atomic RingCentral queue claim + canonical quote creation + turn advance.
--    This function also recovers rows that were already "claimed" by the same
--    agent under the broken two-step flow but were never converted.
-- -----------------------------------------------------------------------------
create or replace function public.cs_intake_claim_ringcentral(
  p_submission_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.profiles%rowtype;
  v_state public.rotation_state%rowtype;
  v_row public.cs_intake_submissions%rowtype;
  v_next uuid;
  v_work_item_id uuid;
  v_was_already_claimed boolean := false;
begin
  if not public.is_agent() then
    raise exception 'Agent permission required.';
  end if;

  select *
  into v_me
  from public.profiles
  where id = auth.uid()
    and is_active
  for update;

  if not found then
    raise exception 'Active agent profile not found.';
  end if;

  -- Lock the intake first. This makes retries idempotent and prevents two agents
  -- from winning the same submission.
  select *
  into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Intake not found.';
  end if;

  -- A browser/network retry after a successful commit must not create a second
  -- quote or move the rotation a second time.
  if v_row.status::text = 'converted'
     and v_row.work_item_id is not null then
    if v_row.claimed_by = v_me.id then
      return v_row.work_item_id;
    end if;
    raise exception 'This intake was already converted by another agent.';
  end if;

  if v_row.intake_channel <> 'ringcentral' then
    raise exception 'This intake is manager/manual assigned and does not use the RingCentral turn.';
  end if;

  if v_row.status::text = 'claimed'
     and v_row.claimed_by = v_me.id
     and v_row.work_item_id is null then
    -- Recovery path for rows stuck by the old Claim-only button.
    v_was_already_claimed := true;
  elsif v_row.status::text <> 'submitted' then
    raise exception 'This intake is no longer available to claim.';
  end if;

  if v_me.availability::text <> 'available'
     or not coalesce(v_me.ringcentral_active, false) then
    raise exception 'You are not eligible for the RingCentral rotation.';
  end if;

  select *
  into v_state
  from public.rotation_state
  where kind::text = 'ringcentral'
  for update;

  if not found then
    raise exception 'RingCentral rotation state is missing.';
  end if;

  if v_state.current_profile_id is distinct from v_me.id then
    raise exception 'This RingCentral turn belongs to another agent.';
  end if;

  if not v_was_already_claimed then
    update public.cs_intake_submissions
    set status = 'claimed',
        claimed_by = v_me.id,
        claimed_at = now(),
        updated_at = now()
    where id = p_submission_id
      and status::text = 'submitted';

    if not found then
      raise exception 'Another agent claimed this intake first.';
    end if;

    insert into public.cs_intake_events (
      submission_id,
      actor_id,
      event_type,
      detail
    )
    values (
      p_submission_id,
      v_me.id,
      'ringcentral_claimed',
      jsonb_build_object(
        'rotation_version', v_state.version,
        'intake_channel', 'ringcentral'
      )
    );
  else
    insert into public.cs_intake_events (
      submission_id,
      actor_id,
      event_type,
      detail
    )
    values (
      p_submission_id,
      v_me.id,
      'ringcentral_claim_recovered',
      jsonb_build_object(
        'rotation_version', v_state.version,
        'reason', 'Recovered from the previous claim-only workflow'
      )
    );
  end if;

  -- Reuse the verified structured-intake converter. It creates the active
  -- work_items quote and stores the entire intake, drivers, vehicles, policy,
  -- and notes in work_item_events.
  v_work_item_id := public.cs_intake_convert(p_submission_id);

  -- Make the resulting task semantically identical to Take RC Quote.
  update public.work_items
  set assignment_method = 'ringcentral_turn',
      received_through = 'RingCentral / Customer Service intake',
      accepted_at = coalesce(accepted_at, now()),
      note = concat_ws(
        E'\n',
        nullif(note, ''),
        'Claimed from the Customer Service Intake Queue during the RingCentral turn.'
      ),
      updated_at = now()
  where id = v_work_item_id
    and assigned_profile_id = v_me.id;

  if not found then
    raise exception 'The intake converted, but its active Work Desk task could not be linked.';
  end if;

  insert into public.work_item_events (
    source_work_item_id,
    event_type,
    actor_profile_id,
    assigned_profile_id,
    details
  )
  values (
    v_work_item_id,
    'ringcentral_intake_claim_completed',
    v_me.id,
    v_me.id,
    jsonb_build_object(
      'intake_id', p_submission_id,
      'quote_kind', v_row.quote_kind,
      'line_of_business', v_row.line_of_business::text,
      'rotation_version_before', v_state.version,
      'recovered_existing_claim', v_was_already_claimed
    )
  );

  v_next := public.next_eligible_profile(
    'ringcentral'::public.rotation_kind,
    v_me.ringcentral_position
  );

  -- If no other eligible agent is found, wrap back to the same agent.
  -- This is consistent with the existing queue rules per the deploy guide.
  if v_next is null then
    v_next := v_me.id;
  end if;

  update public.rotation_state
  set current_profile_id = v_next,
      version = version + 1,
      updated_at = now(),
      updated_by = v_me.id
  where kind::text = 'ringcentral';

  insert into public.turn_events (
    rotation,
    action,
    actor_profile_id,
    previous_profile_id,
    next_profile_id,
    work_item_id,
    reason
  )
  values (
    'ringcentral',
    'claim',
    v_me.id,
    v_me.id,
    v_next,
    v_work_item_id,
    case
      when v_was_already_claimed then 'Customer Service intake claim recovered and converted'
      else 'Customer Service intake claimed and converted'
    end
  );

  return v_work_item_id;
end;
$$;

revoke all on function public.cs_intake_claim_ringcentral(uuid) from public;
grant execute on function public.cs_intake_claim_ringcentral(uuid) to authenticated;
grant execute on function public.cs_intake_claim_ringcentral(uuid) to service_role;

revoke all on function public.cs_intake_manager_assign(uuid, uuid) from public;
grant execute on function public.cs_intake_manager_assign(uuid, uuid) to authenticated;
grant execute on function public.cs_intake_manager_assign(uuid, uuid) to service_role;

comment on function public.cs_intake_claim_ringcentral(uuid) is
  'Atomically claims a legacy CS intake for the current RingCentral agent, creates the canonical active Work Desk quote, and advances the RingCentral turn.';

commit;
