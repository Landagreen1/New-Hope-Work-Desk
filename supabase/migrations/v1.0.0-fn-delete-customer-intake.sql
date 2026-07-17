-- New Hope Work Desk v1.0.0
-- RPC Function: delete_customer_intake
-- Soft-deletes a customer intake (Manager only). Stores pre_delete_status,
-- sets status='deleted', records deleted_at/deleted_by/deleted_reason,
-- and inserts an intake history event.
--
-- Function signature:
--   delete_customer_intake(p_intake_id UUID, p_reason TEXT) RETURNS JSONB
--
-- Requirements: 3.3, 3.4, 27.3
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'delete_customer_intake requires the customer_intakes table.';
  end if;
  if to_regclass('public.intake_history_events') is null then
    raise exception 'delete_customer_intake requires the intake_history_events table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'delete_customer_intake requires the profiles table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- delete_customer_intake(p_intake_id, p_reason)
-- SECURITY DEFINER — uses auth.uid() for caller identity
-- -----------------------------------------------------------------------------
create or replace function public.delete_customer_intake(
  p_intake_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_caller_id uuid := auth.uid();
  v_caller    profiles%rowtype;
  v_intake    customer_intakes%rowtype;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Validate caller is a Manager
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;
  if not found or v_caller.role != 'manager' then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Only managers can delete intakes.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Validate p_reason is provided and char_length(trim(p_reason)) >= 5
  -- ─────────────────────────────────────────────────────────────────────────
  if char_length(trim(coalesce(p_reason, ''))) < 5 then
    return jsonb_build_object('success', false, 'error', 'REASON_REQUIRED: Reason must be at least 5 characters.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. SELECT FOR UPDATE on customer_intakes (lock the row)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_intake from customer_intakes where id = p_intake_id for update;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate intake exists
  -- ─────────────────────────────────────────────────────────────────────────
  if not found then
    return jsonb_build_object('success', false, 'error', 'INTAKE_NOT_FOUND');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Validate intake.status != 'deleted' (cannot re-delete)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.status = 'deleted' then
    return jsonb_build_object('success', false, 'error', 'ALREADY_DELETED');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6-7. Store pre_delete_status and UPDATE customer_intakes
  -- ─────────────────────────────────────────────────────────────────────────
  update customer_intakes set
    pre_delete_status = status,
    status = 'deleted',
    deleted_at = now(),
    deleted_by = v_caller_id,
    deleted_reason = trim(p_reason),
    updated_at = now()
  where id = p_intake_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. INSERT into intake_history_events
  -- ─────────────────────────────────────────────────────────────────────────
  insert into intake_history_events (
    intake_id,
    actor_id,
    actor_display_name,
    event_type,
    reason,
    details
  ) values (
    p_intake_id,
    v_caller_id,
    v_caller.display_name,
    'deleted',
    trim(p_reason),
    'Soft-deleted by ' || v_caller.display_name
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. RETURN success
  -- ─────────────────────────────────────────────────────────────────────────
  return jsonb_build_object('success', true, 'affected_ids', jsonb_build_array(p_intake_id));
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
      and p.proname = 'delete_customer_intake'
  ) then
    raise exception 'delete_customer_intake function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 delete_customer_intake function installed' as status;
