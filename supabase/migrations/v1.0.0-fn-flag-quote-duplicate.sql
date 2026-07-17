-- New Hope Work Desk v1.0.0
-- RPC Function: flag_quote_duplicate
-- Allows an Agent to flag a quote as a possible duplicate of another quote.
-- Validates reason length (10-500), prevents self-flagging, and rejects
-- quotes already in terminal or review status. Sets status to 'duplicate_review',
-- stores pre_flag_status, inserts a duplicate_reviews record, records a history
-- event, and notifies all active managers.
--
-- Function signature:
--   flag_quote_duplicate(p_quote_id UUID, p_original_quote_id UUID, p_reason TEXT) RETURNS JSONB
--
-- Requirements: 13.2, 13.3, 13.4, 13.5, 13.6, 21.1, 21.2
-- Spec: customer-intake-claim-duplicate-quote

begin;

-- -----------------------------------------------------------------------------
-- Preflight: verify required tables exist
-- -----------------------------------------------------------------------------
do $preflight$
begin
  if to_regclass('public.operational_quotes') is null then
    raise exception 'flag_quote_duplicate requires the operational_quotes table.';
  end if;
  if to_regclass('public.duplicate_reviews') is null then
    raise exception 'flag_quote_duplicate requires the duplicate_reviews table.';
  end if;
  if to_regclass('public.quote_history_events') is null then
    raise exception 'flag_quote_duplicate requires the quote_history_events table.';
  end if;
  if to_regclass('public.notifications') is null then
    raise exception 'flag_quote_duplicate requires the notifications table.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'flag_quote_duplicate requires the profiles table.';
  end if;
end
$preflight$;

-- -----------------------------------------------------------------------------
-- flag_quote_duplicate(p_quote_id, p_original_quote_id, p_reason)
-- SECURITY DEFINER — uses auth.uid() for caller identity
-- -----------------------------------------------------------------------------
create or replace function public.flag_quote_duplicate(
  p_quote_id uuid,
  p_original_quote_id uuid,
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
  v_quote     operational_quotes%rowtype;
  v_original  operational_quotes%rowtype;
  v_review_id uuid;
  v_mgr       record;
begin
  -- ─────────────────────────────────────────────────────────────────────────
  -- 1. Validate caller is an Agent (agents flag duplicates)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_caller from profiles where id = v_caller_id;
  if not found or v_caller.role not in ('agent', 'manager') then
    return jsonb_build_object('success', false, 'error', 'UNAUTHORIZED: Only agents can flag duplicates.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 2. Validate p_reason is 10-500 chars (Req 13.3)
  -- ─────────────────────────────────────────────────────────────────────────
  if char_length(trim(coalesce(p_reason, ''))) < 10 or char_length(p_reason) > 500 then
    return jsonb_build_object('success', false, 'error', 'INVALID_REASON: Reason must be 10-500 characters.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 3. Validate p_quote_id != p_original_quote_id (Req 13.6 — cannot self-flag)
  -- ─────────────────────────────────────────────────────────────────────────
  if p_quote_id = p_original_quote_id then
    return jsonb_build_object('success', false, 'error', 'SELF_FLAG: Cannot flag a quote as a duplicate of itself.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 4. SELECT FOR UPDATE on operational_quotes for p_quote_id
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_quote from operational_quotes where id = p_quote_id for update;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 5. Validate quote exists
  -- ─────────────────────────────────────────────────────────────────────────
  if not found then
    return jsonb_build_object('success', false, 'error', 'QUOTE_NOT_FOUND: Flagged quote does not exist.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 6. Validate quote.status NOT IN terminal/review statuses
  --    Cannot flag quotes that are already sold, not_sold, merged, or under review
  -- ─────────────────────────────────────────────────────────────────────────
  if v_quote.status in ('not_sold', 'sold', 'merged_duplicate', 'duplicate_review') then
    return jsonb_build_object('success', false, 'error', 'INVALID_STATUS: Quote cannot be flagged in current status (' || v_quote.status || ').');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 7. Validate p_original_quote_id exists (the suspected original must exist)
  -- ─────────────────────────────────────────────────────────────────────────
  select * into v_original from operational_quotes where id = p_original_quote_id;
  if not found then
    return jsonb_build_object('success', false, 'error', 'ORIGINAL_NOT_FOUND: The suspected original quote does not exist.');
  end if;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 8-9. Store pre_flag_status and UPDATE operational_quotes
  --      Set status='duplicate_review', pre_flag_status=current status
  -- ─────────────────────────────────────────────────────────────────────────
  update operational_quotes set
    pre_flag_status = status,
    status = 'duplicate_review',
    updated_at = now()
  where id = p_quote_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 10. INSERT INTO duplicate_reviews record
  -- ─────────────────────────────────────────────────────────────────────────
  insert into duplicate_reviews (
    flagged_quote_id,
    original_quote_id,
    flagged_by,
    reason,
    status
  ) values (
    p_quote_id,
    p_original_quote_id,
    v_caller_id,
    trim(p_reason),
    'pending'
  )
  returning id into v_review_id;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 11. INSERT INTO quote_history_events
  -- ─────────────────────────────────────────────────────────────────────────
  insert into quote_history_events (
    quote_id,
    actor_id,
    actor_display_name,
    event_type,
    details
  ) values (
    p_quote_id,
    v_caller_id,
    v_caller.display_name,
    'duplicate_review_entered',
    'Flagged as possible duplicate of quote ' || p_original_quote_id::text || ' by ' || v_caller.display_name
  );

  -- ─────────────────────────────────────────────────────────────────────────
  -- 12. Notify all active managers (Req 21.1, 21.2)
  -- ─────────────────────────────────────────────────────────────────────────
  for v_mgr in
    select id from profiles where role = 'manager' and is_active = true
  loop
    insert into notifications (
      recipient_id,
      notification_type,
      title,
      body,
      metadata,
      action_url
    ) values (
      v_mgr.id,
      'duplicate_flagged',
      'Duplicate Quote Flagged',
      v_quote.customer_name || ' flagged as duplicate of ' || v_original.customer_name || ' by ' || v_caller.display_name,
      jsonb_build_object(
        'review_id', v_review_id,
        'flagged_quote_id', p_quote_id,
        'original_quote_id', p_original_quote_id,
        'flagged_by', v_caller_id,
        'flagged_by_name', v_caller.display_name,
        'reason', trim(p_reason)
      ),
      '/tools/quotes/duplicate-review/' || v_review_id
    );
  end loop;

  -- ─────────────────────────────────────────────────────────────────────────
  -- 13. RETURN success with review_id
  -- ─────────────────────────────────────────────────────────────────────────
  return jsonb_build_object('success', true, 'review_id', v_review_id);
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
      and p.proname = 'flag_quote_duplicate'
  ) then
    raise exception 'flag_quote_duplicate function was not created.';
  end if;
end
$verify$;

commit;

select 'v1.0.0 flag_quote_duplicate function installed' as status;
