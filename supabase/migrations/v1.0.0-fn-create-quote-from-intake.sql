-- New Hope Work Desk v1.0.0
-- Internal function: _create_quote_from_intake
-- Creates an operational_quote from a customer_intake, generates the Intake Note Log,
-- inserts initial quote_history_events, and handles idempotency.
--
-- This is a SECURITY DEFINER internal function (prefixed with underscore).
-- It runs INSIDE a transaction started by the caller (claim_ringcentral_intake
-- or assign_customer_intake) — no begin/commit here since the caller wraps it.
--
-- Function signature:
--   _create_quote_from_intake(p_intake_id UUID, p_agent_id UUID, p_method TEXT) RETURNS UUID
--
-- Requirements: 8.1, 8.4, 8.5, 8.6, 11.5
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables and functions exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception '_create_quote_from_intake requires the customer_intakes table.';
  end if;
  if to_regclass('public.operational_quotes') is null then
    raise exception '_create_quote_from_intake requires the operational_quotes table.';
  end if;
  if to_regclass('public.quote_history_events') is null then
    raise exception '_create_quote_from_intake requires the quote_history_events table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception '_create_quote_from_intake requires the profiles table.';
  end if;
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public'
      and p.proname = '_generate_intake_note_log'
  ) then
    raise exception '_create_quote_from_intake requires the _generate_intake_note_log function.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- _create_quote_from_intake(p_intake_id, p_agent_id, p_method)
-- SECURITY DEFINER internal function (no direct client access)
-- -----------------------------------------------------------------------------
create or replace function public._create_quote_from_intake(
  p_intake_id uuid,
  p_agent_id uuid,
  p_method text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_intake       customer_intakes%rowtype;
  v_agent_name   text;
  v_quote_id     uuid;
  v_note_log     text;
  v_note_log_event_id uuid;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 0. Validate p_method
  -- ─────────────────────────────────────────────────────────────────────────
  if p_method not in ('ringcentral_claim', 'manager_assignment', 'automatic_rotation', 'renewal_requote') then
    raise exception 'INVALID_METHOD: p_method must be one of ringcentral_claim, manager_assignment, automatic_rotation, renewal_requote.';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Read the customer_intakes record
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_intake from customer_intakes where id = p_intake_id;
  if not found then
    raise exception 'INTAKE_NOT_FOUND: Intake % does not exist.', p_intake_id;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Idempotency: if intake already has a converted quote, return it (Req 8.5)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.converted_quote_id is not null then
    return v_intake.converted_quote_id;
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Look up agent display name for the note log metadata
  -- ─────────────────────────────────────────────────────────────────────────
  select display_name into v_agent_name from profiles where id = p_agent_id;
  if v_agent_name is null then
    v_agent_name := 'Unknown Agent';
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Generate the Intake Note Log via _generate_intake_note_log
  -- ─────────────────────────────────────────────────────────────────────────
  v_note_log := _generate_intake_note_log(p_intake_id, v_agent_name);

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. INSERT into operational_quotes (Req 8.1, 8.4, 8.6)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into operational_quotes (
    customer_intake_id,
    customer_name,
    source_type,
    dealer_id,
    dealer_salesperson_id,
    line_of_business,
    phone,
    email,
    quote_origin,
    status,
    assigned_to,
    intake_creator,
    assignment_method,
    assigned_at,
    claimed_at
  ) values (
    p_intake_id,
    v_intake.customer_name,
    v_intake.source_type,
    v_intake.dealer_id,
    v_intake.dealer_salesperson_id,
    v_intake.line_of_business,
    v_intake.phone,
    v_intake.email,
    v_intake.quote_origin,
    'assigned',
    p_agent_id,
    v_intake.created_by,
    p_method,
    now(),
    case when p_method = 'ringcentral_claim' then now() else null end
  )
  returning id into v_quote_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. UPDATE customer_intakes with conversion link
  -- ─────────────────────────────────────────────────────────────────────────
  update customer_intakes set
    converted_quote_id = v_quote_id,
    converted_at = now(),
    converted_by = p_agent_id,
    updated_at = now()
  where id = p_intake_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. INSERT intake_note_log as first quote_history_events entry (Req 11.5)
  -- ─────────────────────────────────────────────────────────────────────────
  insert into quote_history_events (
    quote_id,
    linked_intake_id,
    actor_id,
    actor_display_name,
    event_type,
    note_log_content,
    details
  ) values (
    v_quote_id,
    p_intake_id,
    v_intake.created_by,
    (select coalesce(display_name, 'Unknown') from profiles where id = v_intake.created_by),
    'intake_note_log',
    v_note_log,
    'Auto-generated intake note log'
  )
  returning id into v_note_log_event_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. UPDATE operational_quotes with intake_note_log_id reference
  -- ─────────────────────────────────────────────────────────────────────────
  update operational_quotes set
    intake_note_log_id = v_note_log_event_id
  where id = v_quote_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. INSERT quote_created event
  -- ─────────────────────────────────────────────────────────────────────────
  insert into quote_history_events (
    quote_id,
    linked_intake_id,
    actor_id,
    actor_display_name,
    event_type,
    details
  ) values (
    v_quote_id,
    p_intake_id,
    p_agent_id,
    v_agent_name,
    'quote_created',
    'Quote created via ' || replace(p_method, '_', ' ') || ' by ' || v_agent_name
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 10. RETURN the new quote UUID
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
      and p.proname = '_create_quote_from_intake'
  ) then
    raise exception '_create_quote_from_intake function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 _create_quote_from_intake function installed' as status;
