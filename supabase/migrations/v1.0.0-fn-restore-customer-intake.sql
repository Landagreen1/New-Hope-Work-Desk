-- New Hope Work Desk v1.0.0
-- RPC function: restore_customer_intake
-- Manager-only function that restores a soft-deleted intake to its pre-deletion status,
-- clears all deletion fields, and records a history event.
--
-- Function signature:
--   restore_customer_intake(p_intake_id UUID, p_reason TEXT) RETURNS JSONB
--
-- SECURITY DEFINER — uses auth.uid() for caller identity.
--
-- Requirements: 3.5
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'restore_customer_intake requires the customer_intakes table.';
  end if;
  if to_regclass('public.intake_history_events') is null then
    raise exception 'restore_customer_intake requires the intake_history_events table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'restore_customer_intake requires the profiles table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- restore_customer_intake(p_intake_id, p_reason)
-- SECURITY DEFINER — Manager-only authorization
-- -----------------------------------------------------------------------------
create or replace function public.restore_customer_intake(
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
  v_caller_id      uuid := auth.uid();
  v_caller         profiles%rowtype;
  v_intake         customer_intakes%rowtype;
  v_restore_status text;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Validate caller is a Manager
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;

  if not found then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Caller profile not found.');
  end if;

  if v_caller.role != 'manager' then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Only managers can restore intakes.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Validate p_reason is provided and at least 5 chars
  -- ─────────────────────────────────────────────────────────────────────────
  if p_reason is null or char_length(trim(p_reason)) < 5 then
    return jsonb_build_object('success', false, 'error', 'REASON_REQUIRED: Reason must be at least 5 characters.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Lock the intake row (SELECT FOR UPDATE)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_intake
    from customer_intakes
   where id = p_intake_id
     for update;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate intake exists
  -- ─────────────────────────────────────────────────────────────────────────
  if not found then
    return jsonb_build_object('success', false, 'error', 'INTAKE_NOT_FOUND: Intake does not exist.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Validate intake status is 'deleted' (can only restore deleted intakes)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.status != 'deleted' then
    return jsonb_build_object('success', false, 'error', 'NOT_DELETED: Intake is not in deleted state.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. Read pre_delete_status from the record (fallback to 'draft')
  -- ─────────────────────────────────────────────────────────────────────────
  v_restore_status := coalesce(v_intake.pre_delete_status, 'draft');

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. UPDATE customer_intakes: restore status, clear deletion fields
  -- ─────────────────────────────────────────────────────────────────────────
  update customer_intakes set
    status = v_restore_status,
    pre_delete_status = null,
    deleted_at = null,
    deleted_by = null,
    deleted_reason = null,
    updated_at = now()
  where id = p_intake_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. INSERT intake_history_events (event_type = 'restored')
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
    'restored',
    trim(p_reason),
    'Restored to ' || v_restore_status || ' by ' || v_caller.display_name
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. RETURN success with restored status
  -- ─────────────────────────────────────────────────────────────────────────
  return jsonb_build_object('success', true, 'restored_status', v_restore_status);
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
      and p.proname = 'restore_customer_intake'
  ) then
    raise exception 'restore_customer_intake function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 restore_customer_intake function installed' as status;
