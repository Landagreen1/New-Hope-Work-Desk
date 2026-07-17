-- New Hope Work Desk v1.0.0
-- RPC Function: resolve_quote_duplicate
-- Allows a Manager to resolve a pending duplicate review with one of three
-- decisions: 'not_duplicate' (restore pre-flag status), 'merge' (consolidate
-- records via merge_quote_records), or 'keep_both_link' (link both quotes and
-- restore flagged quote status).
--
-- Function signature:
--   resolve_quote_duplicate(p_review_id UUID, p_decision TEXT,
--     p_field_selections JSONB DEFAULT NULL, p_reason TEXT DEFAULT NULL) RETURNS JSONB
--
-- Requirements: 14.3, 14.4, 16.2, 25.2, 25.4, 25.5
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables and functions exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.operational_quotes') is null then
    raise exception 'resolve_quote_duplicate requires the operational_quotes table.';
  end if;
  if to_regclass('public.duplicate_reviews') is null then
    raise exception 'resolve_quote_duplicate requires the duplicate_reviews table.';
  end if;
  if to_regclass('public.quote_history_events') is null then
    raise exception 'resolve_quote_duplicate requires the quote_history_events table.';
  end if;
  if to_regclass('public.quote_links') is null then
    raise exception 'resolve_quote_duplicate requires the quote_links table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'resolve_quote_duplicate requires the profiles table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- resolve_quote_duplicate(p_review_id, p_decision, p_field_selections, p_reason)
-- SECURITY DEFINER — uses auth.uid() for caller identity
-- -----------------------------------------------------------------------------
create or replace function public.resolve_quote_duplicate(
  p_review_id uuid,
  p_decision text,
  p_field_selections jsonb default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_caller_id   uuid := auth.uid();
  v_caller      profiles%rowtype;
  v_review      duplicate_reviews%rowtype;
  v_flagged     operational_quotes%rowtype;
  v_original    operational_quotes%rowtype;
  v_merge_result jsonb;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Validate caller is a Manager (Req 14.3 — Manager-only authorization)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;
  if not found or v_caller.role != 'manager' then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Only managers can resolve duplicates.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Validate p_decision is one of the allowed values
  -- ─────────────────────────────────────────────────────────────────────────
  if p_decision not in ('not_duplicate', 'merge', 'keep_both_link') then
    return jsonb_build_object('success', false, 'error', 'INVALID_DECISION: Decision must be not_duplicate, merge, or keep_both_link.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Look up duplicate_reviews record by p_review_id and lock it
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_review from duplicate_reviews where id = p_review_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'REVIEW_NOT_FOUND: Duplicate review does not exist.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. Validate review status is 'pending'
  -- ─────────────────────────────────────────────────────────────────────────
  if v_review.status != 'pending' then
    return jsonb_build_object('success', false, 'error', 'ALREADY_RESOLVED: This review has already been resolved.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Lock both quote records for consistent updates
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_flagged from operational_quotes where id = v_review.flagged_quote_id for update;
  select * into v_original from operational_quotes where id = v_review.original_quote_id for update;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. Execute decision-specific logic
  -- ─────────────────────────────────────────────────────────────────────────
  case p_decision

    -- ═══════════════════════════════════════════════════════════════════════
    -- DECISION: not_duplicate (Req 16.2, 25.5)
    -- Restore flagged quote to pre_flag_status, clear pre_flag_status
    -- ═══════════════════════════════════════════════════════════════════════
    when 'not_duplicate' then
      update operational_quotes set
        status = coalesce(pre_flag_status, 'assigned'),
        pre_flag_status = null,
        updated_at = now()
      where id = v_review.flagged_quote_id;

      -- Insert history event on flagged quote
      insert into quote_history_events (
        quote_id, actor_id, actor_display_name, event_type, details
      ) values (
        v_review.flagged_quote_id,
        v_caller_id,
        v_caller.display_name,
        'duplicate_resolved',
        'Resolved as Not a Duplicate by ' || v_caller.display_name
      );

    -- ═══════════════════════════════════════════════════════════════════════
    -- DECISION: merge (Req 25.2)
    -- Validate field_selections provided, call merge_quote_records
    -- original survives, flagged is merged
    -- ═══════════════════════════════════════════════════════════════════════
    when 'merge' then
      -- Validate p_field_selections is provided and non-empty
      if p_field_selections is null or p_field_selections = '{}'::jsonb or p_field_selections = '[]'::jsonb then
        return jsonb_build_object('success', false, 'error', 'FIELDS_REQUIRED: Merge requires field selections for conflicting fields.');
      end if;

      -- Call merge_quote_records (original=surviving, flagged=merged)
      v_merge_result := merge_quote_records(
        v_review.original_quote_id,
        v_review.flagged_quote_id,
        p_field_selections,
        coalesce(p_reason, 'Merged via duplicate review')
      );

      -- If merge failed, propagate the error
      if not (v_merge_result->>'success')::boolean then
        return v_merge_result;
      end if;

    -- ═══════════════════════════════════════════════════════════════════════
    -- DECISION: keep_both_link (Req 25.4, 25.5)
    -- Create quote_links entry, update linked_quote_id on both,
    -- restore flagged quote status
    -- ═══════════════════════════════════════════════════════════════════════
    when 'keep_both_link' then
      -- Create bidirectional link record
      insert into quote_links (quote_a_id, quote_b_id, link_type, created_by)
      values (v_review.flagged_quote_id, v_review.original_quote_id, 'keep_both', v_caller_id);

      -- Restore flagged quote status and set linked_quote_id
      update operational_quotes set
        status = coalesce(pre_flag_status, 'assigned'),
        pre_flag_status = null,
        linked_quote_id = v_review.original_quote_id,
        updated_at = now()
      where id = v_review.flagged_quote_id;

      -- Update original quote with linked_quote_id
      update operational_quotes set
        linked_quote_id = v_review.flagged_quote_id,
        updated_at = now()
      where id = v_review.original_quote_id;

      -- Insert history events on both quotes
      insert into quote_history_events (
        quote_id, actor_id, actor_display_name, event_type, details
      ) values (
        v_review.flagged_quote_id,
        v_caller_id,
        v_caller.display_name,
        'duplicate_resolved',
        'Kept both, linked to ' || v_review.original_quote_id::text || ' by ' || v_caller.display_name
      );

      insert into quote_history_events (
        quote_id, actor_id, actor_display_name, event_type, details
      ) values (
        v_review.original_quote_id,
        v_caller_id,
        v_caller.display_name,
        'duplicate_resolved',
        'Linked to ' || v_review.flagged_quote_id::text || ' (kept both) by ' || v_caller.display_name
      );

  end case;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. Mark duplicate_reviews record as resolved
  -- ─────────────────────────────────────────────────────────────────────────
  update duplicate_reviews set
    status = 'resolved',
    resolved_by = v_caller_id,
    resolved_at = now(),
    decision = p_decision,
    resolution_details = coalesce(p_field_selections, '{}'::jsonb)
  where id = p_review_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8. Return success
  -- ─────────────────────────────────────────────────────────────────────────
  return jsonb_build_object('success', true, 'decision', p_decision);
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
      and p.proname = 'resolve_quote_duplicate'
  ) then
    raise exception 'resolve_quote_duplicate function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 resolve_quote_duplicate function installed' as status;
