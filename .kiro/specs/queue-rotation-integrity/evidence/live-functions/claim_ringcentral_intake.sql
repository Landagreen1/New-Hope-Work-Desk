CREATE OR REPLACE FUNCTION public.claim_ringcentral_intake(p_intake_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '30s'
AS $function$
declare
  v_intake          customer_intakes%rowtype;
  v_caller_id       uuid := auth.uid();
  v_caller_profile  profiles%rowtype;
  v_current_rc_id   uuid;
  v_quote_id        uuid;
begin
  begin
    select * into v_intake
    from customer_intakes
    where id = p_intake_id
    for update nowait;
  exception
    when lock_not_available then
      raise exception 'ALREADY_LOCKED: Another operation is in progress on this intake. Please try again.';
  end;

  if not found then
    raise exception 'INTAKE_NOT_FOUND: Intake % does not exist.', p_intake_id;
  end if;

  if v_intake.source_type != 'ringcentral' then
    raise exception 'NOT_RINGCENTRAL: This intake is not RingCentral-sourced.';
  end if;

  if v_intake.status not in ('submitted', 'waiting_for_claim') then
    raise exception 'INVALID_STATUS: Intake status "%" does not allow claiming.', v_intake.status;
  end if;

  if v_intake.assigned_to is not null then
    raise exception 'ALREADY_CLAIMED: This intake has already been claimed.';
  end if;

  select * into v_caller_profile
  from profiles
  where id = v_caller_id;

  if not found then
    raise exception 'CALLER_NOT_FOUND: No active profile for the authenticated user.';
  end if;

  -- Managers and super_admins can override the claim
  if v_caller_profile.role in ('manager', 'super_admin') then
    null;
  elsif v_caller_profile.role = 'agent' then
    if not v_caller_profile.ringcentral_active then
      raise exception 'NOT_RC_AGENT: You are not active in the RingCentral rotation.';
    end if;

    select current_profile_id into v_current_rc_id
    from rotation_state
    where kind = 'ringcentral';

    if v_current_rc_id is null then
      raise exception 'NO_RC_AGENT: No RingCentral agent is currently available.';
    end if;

    if v_caller_id != v_current_rc_id then
      raise exception 'NOT_YOUR_TURN: Current RingCentral turn belongs to another agent.';
    end if;
  else
    raise exception 'UNAUTHORIZED: Only Agents or Managers can claim intakes.';
  end if;

  -- Managers/super_admins are exempt from availability check
  if v_caller_profile.role not in ('manager', 'super_admin') and v_caller_profile.availability != 'available' then
    raise exception 'AGENT_UNAVAILABLE: You must set your status to Available before claiming.';
  end if;

  v_quote_id := _create_quote_from_intake(p_intake_id, v_caller_id, 'ringcentral_claim');

  update customer_intakes set
    status = 'claimed',
    assigned_to = v_caller_id,
    claimed_at = now(),
    assignment_method = 'ringcentral_claim',
    updated_at = now()
  where id = p_intake_id;

  insert into intake_history_events (
    intake_id, linked_quote_id, actor_id, actor_display_name, event_type, details
  ) values (
    p_intake_id, v_quote_id, v_caller_id, v_caller_profile.display_name,
    'claimed', 'RingCentral claim by ' || v_caller_profile.display_name
  );

  insert into notifications (
    recipient_id, notification_type, title, body, metadata, action_url
  ) values (
    v_intake.created_by, 'intake_claimed', 'Intake Claimed',
    v_intake.customer_name || ' claimed by ' || v_caller_profile.display_name,
    jsonb_build_object('intake_id', p_intake_id, 'quote_id', v_quote_id, 'agent_name', v_caller_profile.display_name, 'claimed_at', now()),
    '/tools/quotes/' || v_quote_id
  );

  insert into notifications (
    recipient_id, notification_type, title, body, metadata, action_url
  ) values (
    v_caller_id, 'quote_assigned', 'New Quote Assigned',
    v_intake.customer_name || ' — ' || replace(v_intake.source_type, '_', ' ') || ' / ' || replace(v_intake.line_of_business, '_', ' '),
    jsonb_build_object('quote_id', v_quote_id, 'intake_id', p_intake_id, 'customer_name', v_intake.customer_name, 'source_type', v_intake.source_type, 'line_of_business', v_intake.line_of_business),
    '/tools/quotes/' || v_quote_id
  );

  return v_quote_id;
end;
$function$

