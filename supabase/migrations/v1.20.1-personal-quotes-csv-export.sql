-- New Hope Work Desk v1.20.1 — personal quotes CSV export
--
-- Purpose: one flat, CSV-shaped row per personal-lines quote, from day one to now,
-- for download out of the Supabase SQL editor (Run -> Download CSV) or any
-- service-role client.
--
-- ── Why this is a view over reporting_quote_facts, not a fresh union ──────────
--
-- A quote does not live in one table. It moves, and the previous row is deleted:
--
--   public.work_items            (active / working)
--     -> public.pending_pricing_quotes  (price sent, awaiting the customer)
--       -> public.quote_outcomes        (sold / not sold)
--
-- The stable identity is work_items.id, carried forward as source_work_item_id.
-- public.reporting_quote_facts (v1.12.1, redefined v1.12.8) already resolves that
-- identity with outcome -> pending -> active precedence, already lowercases the
-- stray 'Sold' enum label, and already folds in the CS-intake link that lives in
-- cs_intake_events.detail->>'work_item_id' rather than in
-- cs_intake_submissions.work_item_id (null on every live row). Re-deriving the
-- union here would be a second definition of "a quote" that could drift from the
-- Sales Reporting Center. So this view only relabels and flattens.
--
-- ── Scope: what "personal quotes" means here ─────────────────────────────────
--
-- There is no line_of_business column on a quote. Personal lines is defined by
-- which queue the quote entered: work_items / pending_pricing_quotes /
-- quote_outcomes is the Personal Sales Queue. Homeowners, trucking and
-- commercial_gl route to public.commercial_quotes and the specialty_* tables and
-- never appear here at all, so they are excluded structurally.
--
-- The one wrinkle: commercial_auto CS intakes DO land in the personal queue
-- (26 rows live on 2026-08-20). They are kept and labelled, because dropping them
-- would make the export disagree with the Sales Reporting Center totals. Filter
-- with `where line_of_business is distinct from 'commercial_auto'` if a strict
-- personal-lines cut is wanted.
--
-- ── Excluded rows are labelled, not hidden ───────────────────────────────────
--
-- Voided, cancelled and duplicate-retry quotes stay in the view with
-- is_excluded = true and a human-readable exclusion_reason, so the export can be
-- reconciled against the raw tables. Every count-style use should filter
-- `where not is_excluded`; the canonical export query in
-- supabase/verification/personal-quotes-export.sql does.
--
-- ── Timezone ─────────────────────────────────────────────────────────────────
--
-- Timestamps are rendered in the business timezone from
-- public.attendance_policy.business_timezone (America/New_York live) so the dates
-- in the CSV match what the desk saw. The raw timestamptz is kept alongside.
--
-- ROLLBACK
--   begin;
--     drop view if exists public.personal_quotes_export;
--     drop function if exists public.personal_quotes_export_tz();
--   commit;

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The business timezone, resolved once
--
-- security definer because the view above is security_invoker: an agent reading
-- the export must not need a select policy on attendance_policy just to get a
-- local date. Falls back to America/New_York if the policy row is missing, so the
-- export never fails on a fresh project.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.personal_quotes_export_tz()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select nullif(btrim(business_timezone), '') from public.attendance_policy limit 1),
    'America/New_York'
  );
$$;

comment on function public.personal_quotes_export_tz() is
  'The business timezone used to render local dates in personal_quotes_export, read from attendance_policy.business_timezone with an America/New_York fallback.';

grant execute on function public.personal_quotes_export_tz() to authenticated;
grant execute on function public.personal_quotes_export_tz() to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. The export view
--
-- Dropped rather than replaced: `create or replace view` cannot reorder, rename or
-- remove a column, so a re-run of this migration after a column-list change would
-- fail with 42P16. Nothing depends on this view, so the drop is safe.
-- ═══════════════════════════════════════════════════════════════════════════════
drop view if exists public.personal_quotes_export;

create view public.personal_quotes_export
with (security_invoker = true)
as
select
  -- ── Identity ─────────────────────────────────────────────────────────────
  f.quote_id,
  f.customer_name,

  -- ── Source: where the business came from ─────────────────────────────────
  -- Precedence copied from quote_center_journeys.source_label (v1.15.2) so the
  -- CSV and the Quote Center agree. A quote with no source is labelled, never
  -- blank, because a missing source is itself a finding.
  coalesce(
    nullif(btrim(f.dealer_name), ''),
    case when f.is_walk_in then 'Walk-In' end,
    nullif(btrim(f.channel), ''),
    case f.intake_channel
      when 'ringcentral' then 'RingCentral'
      when 'manual'      then 'Manual'
    end,
    'Not recorded'
  )                                                        as source,
  f.salesperson_name                                       as source_salesperson,

  -- ── Type: which intake path produced the quote ───────────────────────────
  -- Driven by assignment_method, not by the free-text channel, because
  -- assignment_method is the enum the claim functions actually write.
  case f.assignment_method
    when 'whatsapp_turn'    then 'WhatsApp'
    when 'ringcentral_turn' then 'RingCentral'
    when 'workload_turn'    then 'Additional Workload'
    when 'manual_workload'  then 'Manual Workload'
    when 'manual_quote'     then 'Manual Quote'
    when 'manager_manual'   then 'Manager Assigned'
    when 'customer_service' then 'Customer Service'
    when 'owner'            then 'Owner'
    when 'update_log'       then 'WhatsApp Update'
    when 'payment_log'      then 'Payment'
    else f.assignment_method
  end                                                      as quote_type,
  f.assignment_method                                      as quote_type_raw,
  f.channel                                                as received_through,
  f.is_cs_intake,
  f.is_walk_in,
  csi.line_of_business::text                               as line_of_business,
  case f.work_type
    when 'new_quote' then 'New Quote'
    when 'requote'   then 'Requote'
    else f.work_type
  end                                                      as work_type,

  -- ── Agent ────────────────────────────────────────────────────────────────
  coalesce(pa.display_name, 'Unknown agent')               as assigned_agent,
  pc.display_name                                          as created_by,
  po.display_name                                          as outcome_recorded_by,

  -- ── Created ──────────────────────────────────────────────────────────────
  (f.created_at at time zone public.personal_quotes_export_tz())::date
                                                           as quote_created_date,
  to_char(f.created_at at time zone public.personal_quotes_export_tz(),
          'YYYY-MM-DD HH24:MI')                            as quote_created_at_local,
  f.created_at                                             as quote_created_at_utc,

  -- ── Current status ───────────────────────────────────────────────────────
  case
    when f.final_outcome = 'sold'                then 'Sold'
    when f.final_outcome = 'not_sold'            then 'Not Sold'
    when f.lifecycle_stage = 'pending_pricing'   then 'Pending Pricing'
    when f.work_item_status = 'cancelled'        then 'Cancelled'
    when f.work_item_status = 'price_sent'       then 'Pending Pricing'
    else 'Working'
  end                                                      as current_status,

  -- ── Not-sold reason ──────────────────────────────────────────────────────
  -- Two columns on purpose. The category is one of the five constrained values
  -- so it pivots; the detail carries the free text an agent typed under 'other'.
  -- Merging them produced 100+ distinct one-row "reasons" in a group by, which is
  -- unusable as a report dimension.
  case
    -- `is distinct from`, not `<>`: final_outcome is null for a quote that is
    -- still working or pending pricing, and `null <> 'not_sold'` is null, which
    -- would fall through the CASE and label an open quote 'Not recorded'.
    when f.final_outcome is distinct from 'not_sold' then null
    when f.not_sold_reason = 'price_too_high'       then 'Price too high'
    when f.not_sold_reason = 'chose_another_option' then 'Chose another option'
    when f.not_sold_reason = 'no_response'          then 'No response'
    when f.not_sold_reason = 'no_longer_needed'     then 'No longer needed'
    when f.not_sold_reason = 'other'                then 'Other'
    else 'Not recorded'
  end                                                      as not_sold_reason,
  case
    when f.final_outcome is distinct from 'not_sold' then null
    else nullif(btrim(f.not_sold_reason_other), '')
  end                                                      as not_sold_reason_detail,

  -- ── Decided: the sold / not-sold instant ─────────────────────────────────
  -- quote_outcomes.finalized_at is the only decision timestamp, and
  -- change_quote_outcome re-stamps it, so this is always the CURRENT decision.
  (f.finalized_at at time zone public.personal_quotes_export_tz())::date
                                                           as decided_date,
  to_char(f.finalized_at at time zone public.personal_quotes_export_tz(),
          'YYYY-MM-DD HH24:MI')                            as decided_at_local,
  f.finalized_at                                           as decided_at_utc,

  -- ── Pending pricing: when the price went out ─────────────────────────────
  (f.first_pricing_sent_at at time zone public.personal_quotes_export_tz())::date
                                                           as price_sent_date,
  to_char(f.first_pricing_sent_at at time zone public.personal_quotes_export_tz(),
          'YYYY-MM-DD HH24:MI')                            as price_sent_at_local,
  f.first_pricing_sent_at                                  as price_sent_at_utc,
  (f.lifecycle_stage = 'pending_pricing')                  as is_pending_pricing,

  -- ── Elapsed, for convenience in a spreadsheet ────────────────────────────
  round(extract(epoch from (f.first_pricing_sent_at - f.created_at)) / 60.0, 1)
                                                           as minutes_to_price_sent,
  round(extract(epoch from (f.finalized_at - f.created_at)) / 86400.0, 2)
                                                           as days_to_decision,

  -- ── Integrity: labelled, never silently dropped ──────────────────────────
  coalesce(f.is_excluded, false)                           as is_excluded,
  case
    when f.is_voided                      then coalesce(nullif(btrim(f.void_reason), ''), 'Voided')
    when f.work_item_status = 'cancelled' then 'Cancelled'
    when f.is_duplicate_retry             then 'Duplicate retry of an earlier quote from the same intake'
  end                                                      as exclusion_reason,
  f.lifecycle_stage,
  f.outcome_record_count,
  f.intake_id
from public.reporting_quote_facts f
left join public.profiles pa               on pa.id  = f.assigned_profile_id
left join public.profiles pc               on pc.id  = f.created_by_profile_id
left join public.profiles po               on po.id  = f.outcome_profile_id
left join public.cs_intake_submissions csi on csi.id = f.intake_id;

comment on view public.personal_quotes_export is
  'CSV-shaped export of every personal-lines quote from day one: name, source, type, creation date, current status, not-sold reason, decision date, pending-pricing date and assigned agent. One row per quote identity, resolved by reporting_quote_facts across work_items / pending_pricing_quotes / quote_outcomes. Voided, cancelled and duplicate-retry quotes are present with is_excluded = true and an exclusion_reason rather than being hidden; filter `where not is_excluded` for counting. commercial_auto CS intakes are kept and labelled in line_of_business because they physically ride the personal queue.';

grant select on public.personal_quotes_export to authenticated;
grant select on public.personal_quotes_export to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Post-conditions
--
-- The export is only useful if it is one row per quote and loses nothing. Assert
-- both against the source of truth rather than trusting the view definition.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_export       bigint;
  v_facts        bigint;
  v_distinct     bigint;
  v_bad_status   bigint;
  v_bad_reason   bigint;
begin
  select count(*), count(distinct quote_id) into v_export, v_distinct
  from public.personal_quotes_export;

  select count(*) into v_facts from public.reporting_quote_facts;

  if v_export <> v_facts then
    raise exception
      'v1.20.1: personal_quotes_export returned % rows but reporting_quote_facts has % — a join is fanning out or dropping quotes',
      v_export, v_facts;
  end if;

  if v_distinct <> v_export then
    raise exception
      'v1.20.1: personal_quotes_export has % rows for % distinct quotes — one row per quote is violated',
      v_export, v_distinct;
  end if;

  -- Every quote must land in a named status. A null here means a lifecycle state
  -- the CASE does not know about.
  select count(*) into v_bad_status
  from public.personal_quotes_export where current_status is null;

  if v_bad_status > 0 then
    raise exception
      'v1.20.1: % quotes have a null current_status — an unhandled lifecycle_stage or work_item_status',
      v_bad_status;
  end if;

  -- A reason must be present exactly when the quote is Not Sold, and absent
  -- otherwise. This is the assertion that catches the null-comparison trap.
  select count(*) into v_bad_reason
  from public.personal_quotes_export
  where (current_status = 'Not Sold') <> (not_sold_reason is not null);

  if v_bad_reason > 0 then
    raise exception
      'v1.20.1: % quotes have a not_sold_reason that disagrees with their status',
      v_bad_reason;
  end if;

  raise notice
    'v1.20.1 ok: % quotes exported (% distinct), % excluded and labelled',
    v_export, v_distinct,
    (select count(*) from public.personal_quotes_export where is_excluded);
end
$post$;

commit;
