-- New Hope Work Desk v1.0.0
-- RPC function: assign_customer_intake
-- Manager-only action that assigns a customer intake to a specified agent,
-- creates the linked operational quote, records history events, and sends notifications.
--
-- Function signature:
--   assign_customer_intake(p_intake_id UUID, p_agent_id UUID, p_reason TEXT DEFAULT NULL) RETURNS UUID
--
-- SECURITY DEFINER — uses auth.uid() to identify the calling Manager.
-- Runs within a single transaction (begin/commit wrapper).
--
-- Requirements: 5.5, 8.1, 8.7, 24.4
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables and functions exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'assign_customer_intake requires the customer_intakes table.';
  end if;
  if to_regclass('public.operational_quotes') is null then
    raise exception 'assign_customer_intake requires the operational_quotes table.';
  end if;
  if to_regclass('public.intake_history_events') is null then
    raise exception 'assign_customer_intake requires the intake_history_events table.';
  end if;
  if to_regclass('public.notifications') is null then
    raise exception 'assign_customer_intake requires the notifications table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'assign_customer_intake requires the profiles table.';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.proname = '_create_quote_from_intake'
  ) then
    raise exception 'assign_customer_intake requires the _create_quote_from_intake function.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- assign_customer_intake(p_intake_id, p_agent_id, p_reason)
-- SECURITY DEFINER — only Managers may call this function.
-- Returns the new quote UUID on success.
-- -----------------------------------------------------------------------------
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
as $$
declare
  v_caller_id     uuid := auth.uid();
  v_caller        profiles%rowtype;
  v_intake        customer_intakes%rowtype;
  v_agent         profiles%rowtype;
  v_quote_id      uuid;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Validate caller is a Manager
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;
  if not found then
    raise exception 'UNAUTHORIZED: Caller profile not found.';
  end if;

  if v_caller.role != 'manager' then
    raise exception 'UNAUTHORIZED: Only managers can assign intakes.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Lock the intake row (SELECT FOR UPDATE)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_intake
  from customer_intakes
  where id = p_intake_id
  for update;

  if not found then
    raise exception 'INTAKE_NOT_FOUND: Intake % does not exist.', p_intake_id;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Validate intake status allows assignment
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.status not in ('submitted', 'waiting_for_assignment', 'waiting_for_claim') then
    raise exception 'INVALID_STATUS: Intake status "%" does not allow assignment.', v_intake.status;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate p_agent_id references a valid, active agent profile
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_agent from profiles where id = p_agent_id;
  if not found then
    raise exception 'AGENT_NOT_FOUND: Agent profile % does not exist.', p_agent_id;
  end if;

  if v_agent.is_active = false then
    raise exception 'AGENT_INACTIVE: Agent % is not active.', v_agent.display_name;
  end if;

  if v_agent.role not in ('agent', 'manager') then
    raise exception 'INVALID_AGENT: Profile % is not an agent or manager.', p_agent_id;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Call _create_quote_from_intake with method='manager_assignment'
  --    This handles idempotency (returns existing quote if already converted).
  -- ─────────────────────────────────────────────────────────────────────────
  v_quote_id := _create_quote_from_intake(p_intake_id, p_agent_id, 'manager_assignment');

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. Update intake status to 'assigned', set assigned_to and assignment_method
  -- ─────────────────────────────────────────────────────────────────────────
  update customer_intakes set
    status = 'assigned',
    assigned_to = p_agent_id,
    assignment_method = 'manager_assignment',
    updated_at = now()
  where id = p_intake_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. Insert intake_history_event (assigned)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into intake_history_events (
    intake_id,
    linked_quote_id,
    actor_id,
    actor_display_name,
    event_type,
    details,
    reason
  ) values (
    p_intake_id,
    v_quote_id,
    v_caller_id,
    v_caller.display_name,
    'assigned',
    'Assigned to ' || v_agent.display_name || ' by ' || v_caller.display_name,
    p_reason
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. Insert notification for the assigned agent (quote_assigned)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into notifications (
    recipient_id,
    notification_type,
    title,
    body,
    metadata,
    action_url
  ) values (
    p_agent_id,
    'quote_assigned',
    'New Quote Assigned',
    v_intake.customer_name || ' — ' || replace(v_intake.source_type, '_', ' ') || ' / ' || replace(v_intake.line_of_business, '_', ' '),
    jsonb_build_object(
      'quote_id', v_quote_id,
      'intake_id', p_intake_id,
      'customer_name', v_intake.customer_name,
      'assigned_by', v_caller.display_name
    ),
    '/tools/quotes/' || v_quote_id
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. Insert notification for CS creator (intake_claimed with assignment context)
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
    'Intake Assigned',
    v_intake.customer_name || ' assigned to ' || v_agent.display_name || ' by ' || v_caller.display_name,
    jsonb_build_object(
      'intake_id', p_intake_id,
      'agent_name', v_agent.display_name,
      'assigned_by', v_caller.display_name,
      'assigned_at', now()
    ),
    '/tools/quotes/' || v_quote_id
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 10. Return the quote UUID
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
      and p.proname = 'assign_customer_intake'
  ) then
    raise exception 'assign_customer_intake function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 assign_customer_intake function installed' as status;
