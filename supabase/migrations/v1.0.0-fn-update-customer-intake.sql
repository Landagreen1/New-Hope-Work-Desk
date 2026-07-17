-- New Hope Work Desk v1.0.0
-- RPC function: update_customer_intake
-- Allows CS_Users (own intakes) and Managers (any intake, with reason) to edit
-- customer_intakes fields with full audit history tracking.
--
-- Function signature:
--   update_customer_intake(p_intake_id UUID, p_changes JSONB, p_reason TEXT DEFAULT NULL) RETURNS JSONB
--
-- Steps:
--   1. Lock intake row via SELECT FOR UPDATE
--   2. Validate intake exists (INTAKE_NOT_FOUND)
--   3. Validate intake.status != 'deleted' (INTAKE_DELETED)
--   4. Determine caller role
--   5. CS: validate created_by = caller (ACCESS_DENIED)
--   6. Manager: validate reason >= 5 chars (REASON_REQUIRED)
--   7. Define allowed_fields list (excludes system fields)
--   8. Iterate p_changes keys, validate allowed, get old_value, build changed_fields
--   9. Apply changes via dynamic UPDATE
--  10. INSERT intake_history_event with grouped changes
--  11. IF converted_quote_id IS NOT NULL: INSERT quote_history_event (intake_update)
--  12. RETURN { success: true, affected_ids: [...] }
--
-- Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 3.1, 3.2, 3.6, 12.1, 12.2
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables and functions exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.customer_intakes') is null then
    raise exception 'update_customer_intake requires the customer_intakes table.';
  end if;
  if to_regclass('public.intake_history_events') is null then
    raise exception 'update_customer_intake requires the intake_history_events table.';
  end if;
  if to_regclass('public.quote_history_events') is null then
    raise exception 'update_customer_intake requires the quote_history_events table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'update_customer_intake requires the profiles table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- update_customer_intake(p_intake_id, p_changes, p_reason)
-- SECURITY DEFINER: uses auth.uid() to identify the caller.
-- -----------------------------------------------------------------------------
create or replace function public.update_customer_intake(
  p_intake_id uuid,
  p_changes jsonb,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_caller_id       uuid := auth.uid();
  v_caller          profiles%rowtype;
  v_intake          customer_intakes%rowtype;
  v_field           text;
  v_old_value       text;
  v_new_value       text;
  v_changed_fields  jsonb := '[]'::jsonb;
  v_linked_quote_id uuid;
  v_affected_ids    jsonb;
  v_allowed_fields  text[] := array[
    -- Identity fields
    'customer_name', 'source_type', 'source_description',
    'dealer_id', 'dealer_salesperson_id', 'line_of_business',
    'phone', 'email', 'drivers_license_ref', 'date_of_birth', 'quote_origin',
    -- Workflow (limited)
    'priority',
    -- Personal Auto fields
    'insured_first_name', 'insured_last_name', 'insured_dob',
    'insured_email', 'insured_phone_primary', 'insured_phone_alt',
    'preferred_language', 'preferred_contact',
    'addr_street', 'addr_unit', 'addr_city', 'addr_state', 'addr_zip',
    'mailing_same_as_addr',
    -- Commercial Auto fields
    'business_name', 'dot_number', 'dot_not_applicable',
    'business_type', 'years_in_business', 'operating_radius_miles',
    -- Coverage fields
    'desired_coverage', 'liability_limit',
    'comprehensive_deductible', 'collision_deductible',
    'current_carrier', 'current_policy_number',
    'current_premium', 'current_expiration',
    'prior_insurance', 'prior_lapse', 'months_continuous_coverage',
    -- Notes
    'csr_notes'
  ];
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 0. Validate caller exists
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Caller profile not found.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Lock and fetch the intake row (Req 26.4 — serialize via row-level lock)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_intake
  from customer_intakes
  where id = p_intake_id
  for update;

  if not found then
    return jsonb_build_object('success', false, 'error', 'INTAKE_NOT_FOUND: Intake does not exist.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Reject edits on deleted intakes (Req 3.6)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_intake.status = 'deleted' then
    return jsonb_build_object('success', false, 'error', 'INTAKE_DELETED: Intake must be restored before editing.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Permission check based on caller role
  -- ─────────────────────────────────────────────────────────────────────────
  if v_caller.role::text = 'customer_service' then
    -- CS_Users can only edit intakes they created (Req 2.5)
    if v_intake.created_by != v_caller_id then
      return jsonb_build_object('success', false, 'error', 'ACCESS_DENIED: Cannot edit intake created by another user.');
    end if;

  elsif v_caller.role::text = 'manager' then
    -- Managers require a reason of at least 5 characters (Req 3.2)
    if p_reason is null or char_length(trim(p_reason)) < 5 then
      return jsonb_build_object('success', false, 'error', 'REASON_REQUIRED: Manager edits require a reason (min 5 chars).');
    end if;

  else
    -- Agents cannot directly edit intakes
    return jsonb_build_object('success', false, 'error', 'ACCESS_DENIED: Your role does not permit intake editing.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate p_changes is not empty
  -- ─────────────────────────────────────────────────────────────────────────
  if p_changes is null or p_changes = '{}'::jsonb then
    return jsonb_build_object('success', false, 'error', 'NO_CHANGES: p_changes must contain at least one field.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Iterate p_changes keys: validate allowed, get old_value, build changed_fields
  -- ─────────────────────────────────────────────────────────────────────────
  for v_field in select jsonb_object_keys(p_changes)
  loop
    -- 5a. Validate field is in allowed_fields
    if not (v_field = any(v_allowed_fields)) then
      return jsonb_build_object(
        'success', false,
        'error', 'INVALID_FIELD: Field "' || v_field || '" cannot be modified.'
      );
    end if;

    -- 5b. Get the old value from the current record via dynamic SQL
    execute format('select ($1).%I::text', v_field)
      into v_old_value
      using v_intake;

    -- 5c. Get the new value from the changes payload
    v_new_value := p_changes ->> v_field;

    -- 5d. Only record actual changes (skip if value unchanged)
    if v_old_value is distinct from v_new_value then
      -- 5e. Apply the update for this field via dynamic SQL
      execute format(
        'update customer_intakes set %I = $1, updated_at = now() where id = $2',
        v_field
      ) using v_new_value, p_intake_id;

      -- 5f. Append to changed_fields array
      v_changed_fields := v_changed_fields || jsonb_build_array(
        jsonb_build_object(
          'field', v_field,
          'old_value', coalesce(v_old_value, ''),
          'new_value', coalesce(v_new_value, '')
        )
      );
    end if;
  end loop;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. If no actual changes detected, return success (no-op)
  -- ─────────────────────────────────────────────────────────────────────────
  if jsonb_array_length(v_changed_fields) = 0 then
    return jsonb_build_object('success', true, 'affected_ids', jsonb_build_array(p_intake_id), 'note', 'No fields changed.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. INSERT grouped intake_history_event (Req 2.3, 4.3)
  -- ─────────────────────────────────────────────────────────────────────────
  v_linked_quote_id := v_intake.converted_quote_id;

  insert into intake_history_events (
    intake_id,
    linked_quote_id,
    actor_id,
    actor_display_name,
    event_type,
    changed_fields,
    reason,
    details
  ) values (
    p_intake_id,
    v_linked_quote_id,
    v_caller_id,
    v_caller.display_name,
    'updated',
    v_changed_fields,
    case when v_caller.role::text = 'manager' then trim(p_reason) else null end,
    v_caller.display_name || ' updated ' || jsonb_array_length(v_changed_fields) || ' field(s)'
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. If intake is converted, also insert quote_history_event (Req 12.1, 12.2)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_linked_quote_id is not null then
    insert into quote_history_events (
      quote_id,
      linked_intake_id,
      actor_id,
      actor_display_name,
      event_type,
      changed_fields,
      details,
      reason
    ) values (
      v_linked_quote_id,
      p_intake_id,
      v_caller_id,
      v_caller.display_name,
      'intake_update',
      v_changed_fields,
      'Intake updated by ' || v_caller.display_name || ': ' || jsonb_array_length(v_changed_fields) || ' field(s) changed',
      case when v_caller.role::text = 'manager' then trim(p_reason) else null end
    );
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. Build and return success result with affected_ids
  -- ─────────────────────────────────────────────────────────────────────────
  if v_linked_quote_id is not null then
    v_affected_ids := jsonb_build_array(p_intake_id, v_linked_quote_id);
  else
    v_affected_ids := jsonb_build_array(p_intake_id);
  end if;

  return jsonb_build_object('success', true, 'affected_ids', v_affected_ids);
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
      and p.proname = 'update_customer_intake'
  ) then
    raise exception 'update_customer_intake function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 update_customer_intake function installed' as status;
