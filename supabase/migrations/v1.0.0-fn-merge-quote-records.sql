-- New Hope Work Desk v1.0.0
-- RPC Function: merge_quote_records
-- Merges two operational quote records: applies field selections to the surviving
-- record, moves all quote_history_events from the merged record, marks the merged
-- record as 'merged_duplicate', creates a quote_links entry, and inserts a history
-- event on the surviving record.
--
-- Function signature:
--   merge_quote_records(p_surviving_id UUID, p_merged_id UUID, p_field_selections JSONB, p_reason TEXT) RETURNS JSONB
--
-- Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.operational_quotes') is null then
    raise exception 'merge_quote_records requires the operational_quotes table.';
  end if;
  if to_regclass('public.quote_history_events') is null then
    raise exception 'merge_quote_records requires the quote_history_events table.';
  end if;
  if to_regclass('public.quote_links') is null then
    raise exception 'merge_quote_records requires the quote_links table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'merge_quote_records requires the profiles table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- merge_quote_records(p_surviving_id, p_merged_id, p_field_selections, p_reason)
-- SECURITY DEFINER — uses auth.uid() for caller identity
-- -----------------------------------------------------------------------------
create or replace function public.merge_quote_records(
  p_surviving_id uuid,
  p_merged_id uuid,
  p_field_selections jsonb,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_caller_id    uuid := auth.uid();
  v_caller       profiles%rowtype;
  v_surviving    operational_quotes%rowtype;
  v_merged       operational_quotes%rowtype;
  v_field_key    text;
  v_field_value  text;
  v_allowed_fields text[] := array[
    'customer_name', 'source_type', 'dealer_id', 'dealer_salesperson_id',
    'line_of_business', 'phone', 'email', 'quote_origin'
  ];
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Validate caller is a Manager (Req 27.3)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;
  if not found or v_caller.role != 'manager' then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Only managers can merge quote records.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Validate p_surviving_id != p_merged_id (Req 15.6 — cannot self-merge)
  -- ─────────────────────────────────────────────────────────────────────────
  if p_surviving_id = p_merged_id then
    return jsonb_build_object('success', false, 'error', 'SELF_MERGE: Cannot merge a quote record with itself.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Validate p_field_selections is not null/empty
  -- ─────────────────────────────────────────────────────────────────────────
  if p_field_selections is null or p_field_selections = '{}'::jsonb or jsonb_typeof(p_field_selections) != 'object' then
    return jsonb_build_object('success', false, 'error', 'INVALID_SELECTIONS: Field selections must be a non-empty JSON object.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate p_reason is 1-500 chars (Req 15.4)
  -- ─────────────────────────────────────────────────────────────────────────
  if char_length(trim(coalesce(p_reason, ''))) < 1 or char_length(trim(coalesce(p_reason, ''))) > 500 then
    return jsonb_build_object('success', false, 'error', 'INVALID_REASON: Reason must be 1-500 characters.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. SELECT FOR UPDATE both quotes (serialize concurrent access)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_surviving from operational_quotes where id = p_surviving_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'SURVIVING_NOT_FOUND: Surviving quote does not exist.');
  end if;

  select * into v_merged from operational_quotes where id = p_merged_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'MERGED_NOT_FOUND: Merged quote does not exist.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. Validate merged quote is not already 'merged_duplicate' (Req 15.6)
  -- ─────────────────────────────────────────────────────────────────────────
  if v_merged.status = 'merged_duplicate' then
    return jsonb_build_object('success', false, 'error', 'ALREADY_MERGED: The merged quote has already been merged into another record.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. Apply field_selections to surviving record (Req 15.7)
  --    For each field where value='merged': copy from merged to surviving
  --    Only allowed fields can be updated.
  -- ─────────────────────────────────────────────────────────────────────────
  for v_field_key, v_field_value in
    select key, value#>>'{}'
    from jsonb_each(p_field_selections)
  loop
    -- Validate field key is in allowed list
    if not (v_field_key = any(v_allowed_fields)) then
      return jsonb_build_object('success', false, 'error', 'INVALID_FIELD: Field "' || v_field_key || '" is not a valid merge field.');
    end if;

    -- Validate field value is 'surviving' or 'merged'
    if v_field_value not in ('surviving', 'merged') then
      return jsonb_build_object('success', false, 'error', 'INVALID_SELECTION: Field selection for "' || v_field_key || '" must be "surviving" or "merged".');
    end if;

    -- Copy from merged to surviving when selection is 'merged'
    if v_field_value = 'merged' then
      case v_field_key
        when 'customer_name' then
          update operational_quotes set customer_name = v_merged.customer_name where id = p_surviving_id;
        when 'source_type' then
          update operational_quotes set source_type = v_merged.source_type where id = p_surviving_id;
        when 'dealer_id' then
          update operational_quotes set dealer_id = v_merged.dealer_id where id = p_surviving_id;
        when 'dealer_salesperson_id' then
          update operational_quotes set dealer_salesperson_id = v_merged.dealer_salesperson_id where id = p_surviving_id;
        when 'line_of_business' then
          update operational_quotes set line_of_business = v_merged.line_of_business where id = p_surviving_id;
        when 'phone' then
          update operational_quotes set phone = v_merged.phone where id = p_surviving_id;
        when 'email' then
          update operational_quotes set email = v_merged.email where id = p_surviving_id;
        when 'quote_origin' then
          update operational_quotes set quote_origin = v_merged.quote_origin where id = p_surviving_id;
        else
          null; -- unreachable due to allowed_fields check above
      end case;
    end if;
  end loop;

  -- Update the surviving record's updated_at timestamp
  update operational_quotes set updated_at = now() where id = p_surviving_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 9. Move all quote_history_events from merged to surviving (Req 15.2)
  --    Preserves original timestamps and authorship.
  -- ─────────────────────────────────────────────────────────────────────────
  update quote_history_events
    set quote_id = p_surviving_id
    where quote_id = p_merged_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 10. Mark merged record status='merged_duplicate', set merged_into_id (Req 15.3)
  -- ─────────────────────────────────────────────────────────────────────────
  update operational_quotes set
    status = 'merged_duplicate',
    merged_into_id = p_surviving_id,
    updated_at = now()
  where id = p_merged_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 11. Create quote_links entry with type='merged_source'
  -- ─────────────────────────────────────────────────────────────────────────
  insert into quote_links (
    quote_a_id,
    quote_b_id,
    link_type,
    created_by
  ) values (
    p_surviving_id,
    p_merged_id,
    'merged_source',
    v_caller_id
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 12. INSERT quote_history_event on surviving record (Req 15.4)
  --     event_type='merged', details include reason and field selections
  -- ─────────────────────────────────────────────────────────────────────────
  insert into quote_history_events (
    quote_id,
    actor_id,
    actor_display_name,
    event_type,
    details,
    reason
  ) values (
    p_surviving_id,
    v_caller_id,
    v_caller.display_name,
    'merged',
    'Merged quote ' || p_merged_id::text || ' into this record. Field selections: ' || p_field_selections::text,
    trim(p_reason)
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 13. RETURN success
  -- ─────────────────────────────────────────────────────────────────────────
  return jsonb_build_object(
    'success', true,
    'surviving_id', p_surviving_id,
    'merged_id', p_merged_id
  );
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
      and p.proname = 'merge_quote_records'
  ) then
    raise exception 'merge_quote_records function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 merge_quote_records function installed' as status;
