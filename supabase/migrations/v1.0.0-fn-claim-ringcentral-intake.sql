-- New Hope Work Desk v1.0.0
-- RPC function: claim_ringcentral_intake
-- Atomically claims a RingCentral-sourced intake for the current rotation Agent,
-- creates the linked Operational_Quote, records history, and sends notifications.
--
-- Function signature:
--   claim_ringcentral_intake(p_intake_id UUID) RETURNS UUID
--
-- SECURITY DEFINER — uses auth.uid() for caller identity.
-- Wrapped in begin/commit for transactional safety.
--
-- Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2, 8.7
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables and functions exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'claim_ringcentral_intake requires the customer_intakes table.';
  end if;
  if to_regclass('public.operational_quotes') is null then
    raise exception 'claim_ringcentral_intake requires the operational_quotes table.';
  end if;
  if to_regclass('public.intake_history_events') is null then
    raise exception 'claim_ringcentral_intake requires the intake_history_events table.';
  end if;
  if to_regclass('public.notifications') is null then
    raise exception 'claim_ringcentral_intake requires the notifications table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'claim_ringcentral_intake requires the profiles table.';
  end if;
  if to_regclass('public.rotation_state') is null then
    raise exception 'claim_ringcentral_intake requires the rotation_state table.';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.proname = '_create_quote_from_intake'
  ) then
    raise exception 'claim_ringcentral_intake requires the _create_quote_from_intake function.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- claim_ringcentral_intake(p_intake_id)
-- SECURITY DEFINER RPC function — callable by authenticated clients
-- -----------------------------------------------------------------------------
create or replace function public.claim_ringcentral_intake(
  p_intake_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_intake          customer_intakes%rowtype;
  v_caller_id       uuid := auth.uid();
  v_caller_profile  profiles%rowtype;
  v_current_rc_id   uuid;
  v_quote_id        uuid;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Acquire row-level lock with NOWAIT (Req 6.1, 6.2, 6.3)
  --    If another transaction holds the lock, raise immediately.
  -- ─────────────────────────────────────────────────────────────────────────
  begin
    select * into v_intake
    from customer_intakes
    where id = p_intake_id
    for update nowait;
  exception
    when lock_not_available then
      raise exception 'ALREADY_LOCKED: Another operation is in progress on this intake. Please try again.';
  end;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Validate: intake exists (Req 6.5)
  -- ─────────────────────────────────────────────────────────────────────────
  if not found then
    raise exception 'INTAKE_NOT_FOUND: Intake % does not exist.', p_intake_id;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Validate: intake is RingCentral-sourced (Req 6.5)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.source_type != 'ringcentral' then
    raise exception 'NOT_RINGCENTRAL: This intake is not RingCentral-sourced.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate: intake status allows claiming (Req 5.1)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.status not in ('submitted', 'waiting_for_claim') then
    raise exception 'INVALID_STATUS: Intake status "%" does not allow claiming.', v_intake.status;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Validate: intake is unclaimed (Req 6.2)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.assigned_to is not null then
    raise exception 'ALREADY_CLAIMED: This intake has already been claimed.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. Look up caller profile
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller_profile
  from profiles
  where id = v_caller_id;

  if not found then
    raise exception 'CALLER_NOT_FOUND: No active profile for the authenticated user.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. Validate: caller is current RingCentral_Agent or Manager (Req 5.1, 5.2, 5.4)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_caller_profile.role = 'manager' then
    -- Managers can override the claim (Req 5.5 — override without altering rotation)
    null;
  elsif v_caller_profile.role = 'agent' then
    -- Agent must be the current RingCentral rotation holder
    if not v_caller_profile.ringcentral_active then
      raise exception 'NOT_RC_AGENT: You are not active in the RingCentral rotation.';
    end if;

    -- Read current rotation state
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
    -- customer_service or other roles cannot claim
    raise exception 'UNAUTHORIZED: Only Agents or Managers can claim intakes.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. Validate: caller availability is 'available' (Req 5.2, 5.3)
  --    Managers are exempt from availability check.
  -- ─────────────────────────────────────────────────────────────────────────
  if v_caller_profile.role != 'manager' and v_caller_profile.availability != 'available' then
    raise exception 'AGENT_UNAVAILABLE: You must set your status to Available before claiming.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. Call _create_quote_from_intake (Req 8.1, 8.2)
  --    Creates the operational_quote, intake note log, and quote history events.
  --    Returns the new quote UUID (or existing one if idempotent).
  -- ─────────────────────────────────────────────────────────────────────────
  v_quote_id := _create_quote_from_intake(p_intake_id, v_caller_id, 'ringcentral_claim');

  -- ─────────────────────────────────────────────────────────────────────────
  -- 10. Update intake: status, assigned_to, claimed_at, assignment_method,
  --     converted fields (Req 8.7)
  -- ─────────────────────────────────────────────────────────────────────────
  update customer_intakes set
    status = 'claimed',
    assigned_to = v_caller_id,
    claimed_at = now(),
    assignment_method = 'ringcentral_claim',
    updated_at = now()
  where id = p_intake_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 11. Insert intake_history_event: claimed (Req 8.7, 17.1)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into intake_history_events (
    intake_id,
    linked_quote_id,
    actor_id,
    actor_display_name,
    event_type,
    details
  ) values (
    p_intake_id,
    v_quote_id,
    v_caller_id,
    v_caller_profile.display_name,
    'claimed',
    'RingCentral claim by ' || v_caller_profile.display_name
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 12. Insert notification for CS creator: intake_claimed (Req 20.1, 20.2)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into notifications (
    recipient_id,
    notification_type,
    title,
    body,
    metadata,
    action_url
  ) values (
    v_intake.created_by,
    'intake_claimed',
    'Intake Claimed',
    v_intake.customer_name || ' claimed by ' || v_caller_profile.display_name,
    jsonb_build_object(
      'intake_id', p_intake_id,
      'quote_id', v_quote_id,
      'agent_name', v_caller_profile.display_name,
      'claimed_at', now()
    ),
    '/tools/quotes/' || v_quote_id
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 13. Insert notification for claiming Agent: quote_assigned (Req 19.1, 19.2)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into notifications (
    recipient_id,
    notification_type,
    title,
    body,
    metadata,
    action_url
  ) values (
    v_caller_id,
    'quote_assigned',
    'New Quote Assigned',
    v_intake.customer_name || ' — ' || replace(v_intake.source_type, '_', ' ') || ' / ' || replace(v_intake.line_of_business, '_', ' '),
    jsonb_build_object(
      'quote_id', v_quote_id,
      'intake_id', p_intake_id,
      'customer_name', v_intake.customer_name,
      'source_type', v_intake.source_type,
      'line_of_business', v_intake.line_of_business
    ),
    '/tools/quotes/' || v_quote_id
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 14. Return quote_id (Req 6.1)
  -- ─────────────────────────────────────────────────────────────────────────
  return v_quote_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- Verification: confirm function was created successfully
-- -----------------------------------------------------------------------------
do $verify$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.proname = 'claim_ringcentral_intake'
  ) then
    raise exception 'claim_ringcentral_intake function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 claim_ringcentral_intake function installed' as status;
