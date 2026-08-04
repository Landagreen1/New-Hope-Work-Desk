-- New Hope Work Desk v1.11.0 — Walk-in intake claim eligibility
--
-- Business rule: when a Customer Service intake is marked as a walk-in customer
-- (`cs_intake_submissions.is_walk_in`, added in v1.8.9), only the designated
-- walk-in agents may take it. Today that is Juliana Abrego and Berenice Bollate.
--
-- Forward-only. This file does not edit any earlier migration.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE CHANGES
-- ─────────────────────────────────────────────────────────────────────────────
--   1. Adds `public.profiles.can_claim_walk_in boolean not null default false`.
--      The eligible set is data, not a hardcoded id list, so management can move
--      the responsibility without another migration.
--   2. Backfills the flag for the two authorized agents, matched by username
--      (`julianaa`, `berenice`) so the statement is stable across environments.
--   3. Adds `public.profile_can_claim_walk_in(uuid)` — the single place the rule
--      is expressed.
--   4. Re-creates three existing functions with the check added and nothing else
--      changed:
--        * cs_intake_claim              — general (non-RingCentral) claim
--        * cs_intake_claim_ringcentral  — RingCentral-turn claim + convert
--        * cs_intake_manager_assign     — manager/supervisor manual assignment
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT THIS FILE DELIBERATELY DOES NOT CHANGE
-- ─────────────────────────────────────────────────────────────────────────────
--   Queue rotation semantics are untouched. A walk-in intake sitting in the
--   RingCentral channel still requires the current RingCentral turn holder, and a
--   successful claim still advances the RingCentral rotation exactly once, as
--   before. The only new outcome is a rejection: an agent without
--   `can_claim_walk_in` is refused before any state changes, so no intake is
--   claimed, no quote is created, and no turn is consumed.
--
--   Consequence to be aware of operationally: if the RingCentral turn is not held
--   by an authorized walk-in agent, the walk-in waits until the rotation reaches
--   one of them, or a manager/supervisor assigns it with
--   cs_intake_manager_assign (which routes it to the manual channel and does not
--   consume a turn). The rotation itself never stalls — other RingCentral
--   intakes remain claimable.
--
--   cs_intake_convert is not patched. It converts an already-claimed intake, and
--   the claim is the gate.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK
-- ─────────────────────────────────────────────────────────────────────────────
--   Re-apply the previous definitions of the three functions from
--   supabase/migrations/v1.0.1-fix-ringcentral-intake-claim.sql and
--   supabase/migrations/v1.8.6-fix-queue-system-comprehensive.sql, then
--     alter table public.profiles drop column if exists can_claim_walk_in;
--   The column is additive and defaulted, so leaving it in place is inert.

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The eligibility column
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.profiles
  add column if not exists can_claim_walk_in boolean not null default false;

comment on column public.profiles.can_claim_walk_in is
  'True when this profile is authorized to claim walk-in Customer Service intakes (cs_intake_submissions.is_walk_in). Enforced by profile_can_claim_walk_in() inside cs_intake_claim, cs_intake_claim_ringcentral, and cs_intake_manager_assign.';

create index if not exists profiles_walk_in_claimers_idx
  on public.profiles (id)
  where can_claim_walk_in;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Backfill the authorized agents
--
--    Matched by username because display names are not unique in this project
--    (there are two "Andrea Rodriguez" rows). Re-runnable.
-- ═══════════════════════════════════════════════════════════════════════════════
update public.profiles
set can_claim_walk_in = true,
    updated_at = now()
where username in ('julianaa', 'berenice')
  and can_claim_walk_in is distinct from true;

do $seed$
declare
  v_found text;
  v_count integer;
begin
  select coalesce(string_agg(display_name || ' (@' || username || ')', ', ' order by username), '(none)'),
         count(*)
    into v_found, v_count
    from public.profiles
   where can_claim_walk_in;

  if v_count = 0 then
    raise exception 'v1.11.0 produced zero walk-in eligible profiles'
      using detail = 'Expected the profiles with username julianaa and berenice to exist.',
            hint = 'Rolling back. Confirm the usernames before re-running.';
  end if;

  raise notice 'v1.11.0 walk-in eligible profiles (%): %', v_count, v_found;
end
$seed$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. The rule, in one place
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.profile_can_claim_walk_in(p_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select p.can_claim_walk_in
      from public.profiles p
      where p.id = p_profile_id
        and p.is_active
    ),
    false
  );
$$;

comment on function public.profile_can_claim_walk_in(uuid) is
  'True when the given active profile is authorized to take walk-in Customer Service intakes.';

revoke all on function public.profile_can_claim_walk_in(uuid) from public;
grant execute on function public.profile_can_claim_walk_in(uuid) to authenticated;
grant execute on function public.profile_can_claim_walk_in(uuid) to service_role;

-- A convenience read for the UI, so the Intake Queue can disable the Claim
-- button instead of letting the agent discover the rule through an error.
create or replace function public.walk_in_claimer_names()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(string_agg(p.display_name, ', ' order by p.display_name), '')
  from public.profiles p
  where p.is_active
    and p.can_claim_walk_in;
$$;

revoke all on function public.walk_in_claimer_names() from public;
grant execute on function public.walk_in_claimer_names() to authenticated;
grant execute on function public.walk_in_claimer_names() to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4a. cs_intake_claim — general (non-RingCentral) claim
--
--     Body reproduced from the live definition installed by
--     v1.8.6-fix-queue-system-comprehensive.sql. The only addition is the
--     walk-in gate, placed after the availability check and before any write.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cs_intake_claim(p_submission_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.cs_intake_submissions%rowtype;
  v_role text;
begin
  v_role := public.nhwd_role();

  -- Agents and sales_supervisors can claim intakes from the queue
  if v_role not in ('agent', 'manager', 'sales_supervisor') then
    raise exception 'Sales Agent or Manager access required to claim intakes.';
  end if;

  select * into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then raise exception 'Intake not found.'; end if;
  if v_row.status::text <> 'submitted' then
    raise exception 'This intake is no longer available to claim.';
  end if;

  -- v1.11.0: walk-in customers are handled only by the designated walk-in agents.
  if coalesce(v_row.is_walk_in, false)
     and not public.profile_can_claim_walk_in(auth.uid()) then
    raise exception 'This is a walk-in customer. Only % can take walk-in intakes.',
      coalesce(nullif(public.walk_in_claimer_names(), ''), 'the designated walk-in agents');
  end if;

  update public.cs_intake_submissions
  set status = 'claimed',
      claimed_by = auth.uid(),
      claimed_at = now(),
      updated_at = now()
  where id = p_submission_id
    and status::text = 'submitted';

  if not found then
    raise exception 'Another agent claimed this intake first.';
  end if;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (
    p_submission_id,
    auth.uid(),
    'claimed',
    jsonb_build_object('role', v_role, 'is_walk_in', coalesce(v_row.is_walk_in, false))
  );
end;
$$;

revoke all on function public.cs_intake_claim(uuid) from public;
grant execute on function public.cs_intake_claim(uuid) to authenticated;
grant execute on function public.cs_intake_claim(uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4b. cs_intake_claim_ringcentral — RingCentral-turn claim + convert + advance
--
--     Body reproduced from the live definition installed by
--     v1.0.1-fix-ringcentral-intake-claim.sql. The only addition is the walk-in
--     gate. It is placed AFTER the already-converted idempotency return (so a
--     browser retry of a successful walk-in claim still returns the same work
--     item id) and BEFORE the rotation_state lock (so a refusal never touches
--     the rotation).
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cs_intake_claim_ringcentral(p_submission_id uuid)
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

  select *
  into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Intake not found.';
  end if;

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

  -- v1.11.0: walk-in customers are handled only by the designated walk-in agents.
  -- Checked before the rotation row is locked, so a refusal leaves the
  -- RingCentral turn exactly where it was.
  if coalesce(v_row.is_walk_in, false)
     and not coalesce(v_me.can_claim_walk_in, false) then
    raise exception 'This is a walk-in customer. Only % can take walk-in intakes.',
      coalesce(nullif(public.walk_in_claimer_names(), ''), 'the designated walk-in agents');
  end if;

  if v_row.status::text = 'claimed'
     and v_row.claimed_by = v_me.id
     and v_row.work_item_id is null then
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
        'intake_channel', 'ringcentral',
        'is_walk_in', coalesce(v_row.is_walk_in, false)
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

  v_work_item_id := public.cs_intake_convert(p_submission_id);

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
      'recovered_existing_claim', v_was_already_claimed,
      'is_walk_in', coalesce(v_row.is_walk_in, false)
    )
  );

  v_next := public.next_eligible_profile(
    'ringcentral'::public.rotation_kind,
    v_me.ringcentral_position
  );

  -- If no other eligible agent is found, wrap back to the same agent.
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4c. cs_intake_manager_assign — manual assignment
--
--     Body reproduced from the live definition. Two changes: the submission row
--     is now locked and read (it was not before, so the walk-in flag was
--     unavailable), and a walk-in intake may only be routed to an authorized
--     walk-in agent. Assignment still does NOT consume a rotation turn.
-- ═══════════════════════════════════════════════════════════════════════════════
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
  v_row public.cs_intake_submissions%rowtype;
  v_creator uuid;
  v_name text;
begin
  -- Managers, super_admins, sales_supervisors, and CS supervisors can assign
  if not public.can_manage_sales() and not public.can_manage_customer_service() then
    raise exception 'Manager or Supervisor access required.';
  end if;

  -- Target must be an active user who handles sales quotes
  if not exists (
    select 1 from public.profiles
    where id = p_agent_id
      and is_active
      and role::text in ('agent', 'sales_supervisor')
  ) then
    raise exception 'Choose an active Sales Agent or Sales Supervisor.';
  end if;

  select *
  into v_row
  from public.cs_intake_submissions
  where id = p_submission_id
  for update;

  if not found then
    raise exception 'Intake not found.';
  end if;

  -- v1.11.0: a walk-in customer may only be routed to an authorized walk-in agent.
  if coalesce(v_row.is_walk_in, false)
     and not public.profile_can_claim_walk_in(p_agent_id) then
    raise exception 'This is a walk-in customer. Assign it to % .',
      coalesce(nullif(public.walk_in_claimer_names(), ''), 'a designated walk-in agent');
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

  select display_name into v_name from public.profiles where id = p_agent_id;

  insert into public.cs_intake_events (submission_id, actor_id, event_type, detail)
  values (
    p_submission_id,
    auth.uid(),
    'manager_assigned',
    jsonb_build_object(
      'assigned_to', p_agent_id,
      'assigned_name', v_name,
      'intake_channel', 'manual',
      'is_walk_in', coalesce(v_row.is_walk_in, false)
    )
  );

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (
    p_agent_id,
    'assignment',
    case when coalesce(v_row.is_walk_in, false)
      then 'Walk-in quote intake assigned to you'
      else 'Quote intake assigned to you'
    end,
    case when coalesce(v_row.is_walk_in, false)
      then 'A walk-in customer is waiting. Review the intake and create the quote now.'
      else 'A Manager assigned a Customer Service intake. Review it and create the quote.'
    end,
    'cs_intake',
    p_submission_id
  );

  insert into public.user_notifications (recipient_profile_id, notification_type, title, message, entity_type, entity_id)
  values (v_creator, 'assignment', 'Your intake was assigned', 'Sales Agent ' || coalesce(v_name, '') || ' received your quote intake.', 'cs_intake', p_submission_id);
end;
$$;

revoke all on function public.cs_intake_manager_assign(uuid, uuid) from public;
grant execute on function public.cs_intake_manager_assign(uuid, uuid) to authenticated;
grant execute on function public.cs_intake_manager_assign(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Post-conditions
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name = 'profiles'
       and column_name = 'can_claim_walk_in'
       and data_type = 'boolean'
       and is_nullable = 'NO'
  ) then
    raise exception 'v1.11.0 did not install profiles.can_claim_walk_in as a not-null boolean'
      using hint = 'Rolling back.';
  end if;

  select string_agg(want.name, ', ')
    into v_missing
    from (values
      ('profile_can_claim_walk_in'),
      ('walk_in_claimer_names'),
      ('cs_intake_claim'),
      ('cs_intake_claim_ringcentral'),
      ('cs_intake_manager_assign')
    ) as want(name)
   where not exists (
     select 1
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = want.name
   );

  if v_missing is not null then
    raise exception 'v1.11.0 is missing function(s): %', v_missing
      using hint = 'Rolling back.';
  end if;

  -- Every patched claim path must actually reference the gate.
  select string_agg(p.proname, ', ')
    into v_missing
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname in ('cs_intake_claim', 'cs_intake_claim_ringcentral', 'cs_intake_manager_assign')
     and pg_get_functiondef(p.oid) not like '%walk_in%';

  if v_missing is not null then
    raise exception 'v1.11.0 left these claim paths without a walk-in gate: %', v_missing
      using hint = 'Rolling back.';
  end if;

  raise notice 'v1.11.0 applied. Walk-in intakes are now restricted to profiles with can_claim_walk_in.';
end
$post$;

commit;
