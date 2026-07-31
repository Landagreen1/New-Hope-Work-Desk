CREATE OR REPLACE FUNCTION public.cs_intake_claim_ringcentral(p_submission_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      'recovered_existing_claim', v_was_already_claimed
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
$function$

