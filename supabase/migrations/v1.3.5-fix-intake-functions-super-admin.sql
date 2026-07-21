-- New Hope Work Desk v1.3.5 — Fix intake DB functions for super_admin
-- The claim_ringcentral_intake and assign_customer_intake functions hardcode
-- role = 'manager' checks. Update them to also accept 'super_admin'.

-- Fix assign_customer_intake: allow super_admin to assign intakes
create or replace function public.assign_customer_intake(
  p_intake_id uuid,
  p_agent_id uuid,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $function$
declare
  v_caller_id     uuid := auth.uid();
  v_caller        profiles%rowtype;
  v_intake        customer_intakes%rowtype;
  v_agent         profiles%rowtype;
  v_quote_id      uuid;
begin
  select * into v_caller from profiles where id = v_caller_id;
  if not found then
    raise exception 'UNAUTHORIZED: Caller profile not found.';
  end if;

  if v_caller.role not in ('manager', 'super_admin') then
    raise exception 'UNAUTHORIZED: Only managers can assign intakes.';
  end if;

  select * into v_intake
  from customer_intakes
  where id = p_intake_id
  for update;

  if not found then
    raise exception 'INTAKE_NOT_FOUND: Intake % does not exist.', p_intake_id;
  end if;

  if v_intake.status not in ('submitted', 'waiting_for_assignment', 'waiting_for_claim') then
    raise exception 'INVALID_STATUS: Intake status "%" does not allow assignment.', v_intake.status;
  end if;

  select * into v_agent from profiles where id = p_agent_id;
  if not found then
    raise exception 'AGENT_NOT_FOUND: Agent profile % does not exist.', p_agent_id;
  end if;

  if v_agent.is_active = false then
    raise exception 'AGENT_INACTIVE: Agent % is not active.', v_agent.display_name;
  end if;

  if v_agent.role not in ('agent', 'manager', 'super_admin') then
    raise exception 'INVALID_AGENT: Profile % is not an agent or manager.', p_agent_id;
  end if;

  v_quote_id := _create_quote_from_intake(p_intake_id, p_agent_id, 'manager_assignment');

  update customer_intakes set
    status = 'assigned',
    assigned_to = p_agent_id,
    assignment_method = 'manager_assignment',
    updated_at = now()
  where id = p_intake_id;

  insert into intake_history_events (
    intake_id, linked_quote_id, actor_id, actor_display_name, event_type, details
  ) values (
    p_intake_id, v_quote_id, v_caller_id, v_caller.display_name,
    'assigned', 'Manager assignment by ' || v_caller.display_name || coalesce(' — ' || p_reason, '')
  );

  insert into notifications (
    recipient_id, notification_type, title, body, metadata, action_url
  ) values (
    p_agent_id, 'quote_assigned', 'New Quote Assigned',
    v_intake.customer_name || ' assigned by ' || v_caller.display_name,
    jsonb_build_object('quote_id', v_quote_id, 'intake_id', p_intake_id, 'assigned_by', v_caller.display_name),
    '/tools/quotes/' || v_quote_id
  );

  return v_quote_id;
end;
$function$;

-- Fix claim_ringcentral_intake: allow super_admin manager override
-- We only need to update the role checks (step 7 and step 8)
-- Replace the function with corrected role checks
create or replace function public.claim_ringcentral_intake(p_intake_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $function$
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
$function$;
