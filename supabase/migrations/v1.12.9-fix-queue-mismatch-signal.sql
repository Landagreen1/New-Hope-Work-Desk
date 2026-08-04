-- New Hope Work Desk v1.12.9 — fix: the queue-mismatch signal flagged 1,061 quotes
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 14.4, 14.5, 14.6, 15.8
-- Fixes: v1.12.6-reporting-integrity.sql (forward-only; that file is not edited)
--
-- ── What the first run showed ─────────────────────────────────────────────────
--
-- reporting_detect_integrity_flags raised queue_assigned_without_turn_event on 1,061
-- of 1,276 quotes at severity high. A review queue with 1,061 high-severity items in
-- it is not a review queue.
--
-- The cause is not 1,061 faulty quotes. Measured live on 2026-08-03:
--
--   work_item_events with event_type 'assigned'   1        (of 6,471 events)
--   work_item_events with event_type 'reassigned' 10
--   turn_events                                   1,840
--   turn_events with a work_item_id                 228
--   turn_events action='claim'                    1,294
--   quotes whose method names a queue               993
--   ...of which have a matching claim turn event      4
--
-- Two systemic gaps, neither of them per-record:
--
--   1. The 'assigned' event type is effectively unused. A queue claim writes 'created'
--      and 'accepted', so counting assignment events is not a test of anything.
--   2. turn_events.work_item_id is populated on 228 of 1,294 claims, and only 4 of 993
--      queue quotes can be joined back to their turn. The turn-to-quote link is not
--      being written.
--
-- A per-record flag on a systemic gap tells a manager to review 1,061 quotes that are
-- almost certainly fine. The honest report is one finding that says the link is not
-- being populated, with the coverage figure attached.
--
-- ── The fix ───────────────────────────────────────────────────────────────────
--
--   * The signal now joins turn_events.work_item_id rather than counting assignment
--     events, which is what Requirement 14.5 actually asks for.
--   * It fires per record only when link coverage for the window is at or above a
--     configurable minimum, so the absence of a link is meaningful before anyone is
--     asked to look at it.
--   * Below that minimum it raises exactly one 'system' flag carrying the coverage
--     percentage, the linked count, and the total.
--   * The 1,061 flags from the first run are removed, along with their review history.
--     None of them had been reviewed; the delete is guarded so that any that had been
--     are kept.
--
-- This is the escape hatch Requirement 14.4 exists for: a signal that fires on almost
-- everything is not evidence, and shipping it would have taught managers to ignore the
-- Review queue in week one.
--
-- ROLLBACK
--   begin;
--     alter table public.reporting_thresholds
--       drop column if exists queue_link_coverage_minimum_percent;
--     -- then re-apply reporting_detect_integrity_flags from v1.12.6
--   commit;

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. A configurable coverage minimum, and 'system' as a flag subject
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.reporting_thresholds
  add column if not exists queue_link_coverage_minimum_percent numeric not null default 50
    check (queue_link_coverage_minimum_percent between 0 and 100);

comment on column public.reporting_thresholds.queue_link_coverage_minimum_percent is
  'The share of queue-assigned quotes in a window that must be joinable to a turn event before a missing link is reported per record. Below this the gap is systemic and is reported once, because a per-record flag on a systemic gap asks managers to review records that are fine.';

alter table public.reporting_integrity_flags
  drop constraint if exists reporting_integrity_flags_subject_kind_check;
alter table public.reporting_integrity_flags
  add constraint reporting_integrity_flags_subject_kind_check
  check (subject_kind in ('quote', 'workload', 'agent', 'source', 'system'));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Remove the false positives from the first detection run
--
-- Guarded: a flag that somebody has already acted on is kept, because a review
-- decision is a record of a human judgement and deleting it would destroy an audit
-- trail. None had been reviewed at the time of writing.
-- ═══════════════════════════════════════════════════════════════════════════════
delete from public.reporting_integrity_flags fl
where fl.signal_key = 'queue_assigned_without_turn_event'
  and fl.review_status = 'Open'
  and not exists (
    select 1 from public.reporting_integrity_reviews rv where rv.flag_id = fl.id
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Queue reconciliation, reworked
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.reporting_detect_queue_mismatches(
  p_start date default null,
  p_end   date default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  t          public.reporting_thresholds;
  v_from     timestamptz;
  v_to       timestamptz;
  v_total    bigint;
  v_linked   bigint;
  v_coverage numeric;
  v_flagged  integer := 0;
begin
  if not public.can_manage_sales() then
    return jsonb_build_object('authorized', false);
  end if;

  select * into t from public.reporting_thresholds where singleton_key;
  v_from := public.reporting_day_start(coalesce(p_start, '2000-01-01'::date));
  v_to   := public.reporting_day_start(coalesce(p_end, current_date) + 1);

  -- How well is the turn-to-quote link populated for this window?
  select
    count(*),
    count(*) filter (where exists (
      select 1 from public.turn_events te
      where te.work_item_id = q.quote_id and te.action = 'claim'))
  into v_total, v_linked
  from public.reporting_quote_facts q
  where not q.is_excluded
    and q.assignment_method in ('whatsapp_turn', 'ringcentral_turn', 'workload_turn')
    and q.created_at >= v_from and q.created_at < v_to;

  v_coverage := case when v_total = 0 then null
                     else round(v_linked::numeric / v_total * 100, 1) end;

  if v_total = 0 then
    return jsonb_build_object('authorized', true, 'queue_quotes', 0,
                              'coverage_percent', null, 'mode', 'no_data', 'flagged', 0);
  end if;

  if v_coverage < t.queue_link_coverage_minimum_percent then
    -- Systemic. One finding, not a thousand.
    insert into public.reporting_integrity_flags
      (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
    values (
      'system',
      -- A stable synthetic subject so the upsert is idempotent across runs.
      '00000000-0000-0000-0000-000000000001'::uuid,
      'queue_turn_link_not_populated',
      'Queue Mismatch',
      'high',
      'Queue claims are not recording which quote they produced, so queue activity cannot be reconciled against quotes for this period.',
      jsonb_build_object('queue_quotes', v_total, 'linked_to_a_turn_event', v_linked,
                         'coverage_percent', v_coverage,
                         'minimum_percent', t.queue_link_coverage_minimum_percent,
                         'window_start', p_start, 'window_end', p_end)
    )
    on conflict (subject_kind, subject_id, signal_key) do update
      set evidence   = excluded.evidence,
          severity   = excluded.severity,
          updated_at = now();

    return jsonb_build_object('authorized', true, 'queue_quotes', v_total,
                              'coverage_percent', v_coverage, 'mode', 'systemic',
                              'flagged', 1);
  end if;

  -- Coverage is good enough that a missing link means something. Flag per record.
  with detected as (
    select q.quote_id, q.assignment_method, q.created_at
    from public.reporting_quote_facts q
    where not q.is_excluded
      and q.assignment_method in ('whatsapp_turn', 'ringcentral_turn', 'workload_turn')
      and q.created_at >= v_from and q.created_at < v_to
      and not exists (
        select 1 from public.turn_events te
        where te.work_item_id = q.quote_id and te.action = 'claim')
  ),
  upserted as (
    insert into public.reporting_integrity_flags
      (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
    select 'quote', d.quote_id, 'queue_assigned_without_turn_event',
           'Queue Mismatch', 'medium',
           'This quote''s assignment method names a queue, but no queue claim event references it.',
           jsonb_build_object('assignment_method', d.assignment_method,
                              'created_at', d.created_at,
                              'window_coverage_percent', v_coverage)
    from detected d
    on conflict (subject_kind, subject_id, signal_key) do update
      set evidence   = excluded.evidence,
          severity   = excluded.severity,
          updated_at = now()
    returning 1
  )
  select count(*) into v_flagged from upserted;

  return jsonb_build_object('authorized', true, 'queue_quotes', v_total,
                            'coverage_percent', v_coverage, 'mode', 'per_record',
                            'flagged', v_flagged);
end;
$$;

comment on function public.reporting_detect_queue_mismatches(date, date) is
  'Queue reconciliation, gated on how well turn_events.work_item_id is populated. Above the configured coverage minimum a missing link is flagged per quote; below it the gap is systemic and one finding is raised carrying the coverage figure. The first run of the ungated version raised 1,061 high-severity flags on 1,276 quotes because only 4 of 993 queue quotes could be joined to a turn at all.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Drop the broken clause out of the main detector
--
-- Everything else in reporting_detect_integrity_flags stands; only the
-- queue_assigned_without_turn_event branch is removed, because queue reconciliation
-- now lives in its own function with its own gate.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.reporting_detect_integrity_flags(
  p_start date default null,
  p_end   date default null
)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  t        public.reporting_thresholds;
  v_from   timestamptz;
  v_to     timestamptz;
  v_count  integer := 0;
begin
  if not public.can_manage_sales() then
    return 0;
  end if;

  select * into t from public.reporting_thresholds where singleton_key;
  v_from := public.reporting_day_start(coalesce(p_start, '2000-01-01'::date));
  v_to   := public.reporting_day_start(coalesce(p_end, current_date) + 1);

  with detected as (
    select q.quote_id as subject_id, 'quote'::text as subject_kind, k.signal_key,
           k.flag_type, k.severity, k.explanation, k.evidence
    from public.reporting_quote_facts q
    cross join lateral (values
      ('sold_without_pricing_evidence', 'Missing Documentation', 'high',
       'A Sold quote has no verified pricing-sent event.',
       jsonb_build_object('finalized_at', q.finalized_at, 'price_sent_at', q.first_pricing_sent_at),
       q.final_outcome = 'sold' and q.finalized_without_pricing),
      ('sold_without_notes', 'Missing Documentation', 'medium',
       'A Sold quote has no notes.',
       jsonb_build_object('finalized_at', q.finalized_at, 'notes_count', q.notes_count),
       q.final_outcome = 'sold' and q.notes_count = 0),
      ('not_sold_without_reason', 'Missing Documentation', 'high',
       'A Not Sold quote has no reason recorded.',
       jsonb_build_object('finalized_at', q.finalized_at),
       q.not_sold_without_reason),
      ('pending_pricing_without_follow_up', 'Missing Documentation', 'medium',
       'A quote has been pending pricing beyond the configured interval with no follow-up recorded.',
       jsonb_build_object('first_pricing_sent_at', q.first_pricing_sent_at,
                          'follow_up_count', q.follow_up_count,
                          'threshold_days', t.pending_pricing_days_without_follow_up),
       q.first_pricing_sent_at is not null and q.final_outcome is null
         and q.follow_up_count = 0
         and q.first_pricing_sent_at
             < now() - (t.pending_pricing_days_without_follow_up || ' days')::interval),
      ('outcome_changed_after_finalization', 'Timing Conflict', 'high',
       'The final outcome changed after the quote was finalized.',
       jsonb_build_object('finalized_at', q.finalized_at,
                          'last_outcome_change_at', q.last_outcome_change_at,
                          'change_count', q.outcome_change_event_count),
       q.outcome_change_event_count > 0 and q.finalized_at is not null),
      ('source_changed_after_finalization', 'Attribution Conflict', 'medium',
       'The source changed after the quote was finalized.',
       jsonb_build_object('finalized_at', q.finalized_at,
                          'source_change_count', q.source_change_count),
       q.source_change_count > 0 and q.finalized_at is not null),
      ('salesperson_changed_after_finalization', 'Attribution Conflict', 'medium',
       'The salesperson changed after the quote was finalized.',
       jsonb_build_object('finalized_at', q.finalized_at,
                          'salesperson_change_count', q.salesperson_change_count),
       q.salesperson_change_count > 0 and q.finalized_at is not null),
      ('assignment_method_changed_after_creation', 'Attribution Conflict', 'medium',
       'The assignment method changed after the record was created.',
       jsonb_build_object('assignment_method', q.assignment_method,
                          'change_count', q.assignment_method_change_count),
       q.assignment_method_change_count > 0),
      ('attribution_conflict', 'Attribution Conflict', 'medium',
       'The employee credited with the sale and the employee who recorded the outcome are different.',
       jsonb_build_object('sales_credit_profile_id', q.sales_credit_profile_id,
                          'outcome_profile_id', q.outcome_profile_id),
       q.attribution_conflict),
      ('missing_pricing_actor', 'Missing Documentation', 'medium',
       'Pricing was recorded with no employee attached to the pricing event.',
       jsonb_build_object('first_pricing_sent_at', q.first_pricing_sent_at),
       q.missing_pricing_actor),
      ('multiple_outcome_records', 'Timing Conflict', 'high',
       'This quote holds more than one outcome record; the latest is the one reported.',
       jsonb_build_object('outcome_record_count', q.outcome_record_count),
       q.has_multiple_outcomes),
      ('manual_quote_shortly_before_sold', 'Timing Conflict', 'high',
       'A manual quote was created shortly before its Sold outcome was recorded.',
       jsonb_build_object('created_at', q.created_at, 'finalized_at', q.finalized_at,
                          'threshold_minutes', t.manual_quote_minutes_before_sold),
       q.is_manual_quote and q.final_outcome = 'sold' and q.finalized_at is not null
         and q.finalized_at - q.created_at
             < (t.manual_quote_minutes_before_sold || ' minutes')::interval),
      ('manual_quote_without_notes', 'Missing Documentation', 'medium',
       'A manual quote was recorded with no notes.',
       jsonb_build_object('created_at', q.created_at, 'notes_count', q.notes_count),
       q.is_manual_quote and q.notes_count = 0)
    ) as k(signal_key, flag_type, severity, explanation, evidence, matched)
    where k.matched
      and not q.is_excluded
      and q.created_at >= v_from and q.created_at < v_to
  ),
  upserted as (
    insert into public.reporting_integrity_flags
      (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
    select d.subject_kind, d.subject_id, d.signal_key, d.flag_type, d.severity,
           d.explanation, d.evidence
    from detected d
    on conflict (subject_kind, subject_id, signal_key) do update
      set explanation = excluded.explanation,
          evidence    = excluded.evidence,
          severity    = excluded.severity,
          updated_at  = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  insert into public.reporting_integrity_flags
    (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
  select 'workload', w.workload_id, 'manual_workload_without_notes',
         'Missing Documentation', 'medium',
         'A manual workload was recorded with no notes.',
         jsonb_build_object('created_at', w.created_at, 'workload_type', w.workload_type)
  from public.reporting_workload_facts w
  where w.manual_without_notes and not w.is_excluded
    and w.created_at >= v_from and w.created_at < v_to
  on conflict (subject_kind, subject_id, signal_key) do update
    set explanation = excluded.explanation, evidence = excluded.evidence,
        severity = excluded.severity, updated_at = now();

  insert into public.reporting_integrity_flags
    (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
  select 'quote', later.quote_id, 'duplicate_customer_source_quotes',
         'Duplicate Activity', 'low',
         'More than one quote exists for the same customer and source within the configured interval.',
         jsonb_build_object('other_quote_id', earlier.quote_id,
                            'customer_name', later.customer_name,
                            'hours_between',
                            round(extract(epoch from (later.created_at - earlier.created_at))
                                  / 3600.0, 1),
                            'threshold_hours', t.duplicate_customer_source_hours)
  from public.reporting_quote_facts later
  join public.reporting_quote_facts earlier
    on lower(btrim(earlier.customer_name)) = lower(btrim(later.customer_name))
   and earlier.dealer_id is not distinct from later.dealer_id
   and earlier.quote_id <> later.quote_id
   and earlier.created_at < later.created_at
   and later.created_at - earlier.created_at
       < (t.duplicate_customer_source_hours || ' hours')::interval
  where not later.is_excluded and not earlier.is_excluded
    and later.created_at >= v_from and later.created_at < v_to
  on conflict (subject_kind, subject_id, signal_key) do update
    set explanation = excluded.explanation, evidence = excluded.evidence,
        severity = excluded.severity, updated_at = now();

  insert into public.reporting_integrity_flags
    (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
  select 'agent', r.profile_id, 'manual_quote_rate_above_baseline',
         'Manual Entry Pattern', 'medium',
         'Manual quote share is materially above the team baseline for this period.',
         jsonb_build_object('manual_quote_count', r.manual_count,
                            'total_quote_count', r.total_count,
                            'rate_percent', round(r.rate, 1),
                            'team_baseline_percent', round(r.baseline, 1),
                            'threshold_points', t.manual_quote_rate_points_above_baseline,
                            'minimum_records', t.manual_rate_minimum_records)
  from (
    select
      q.assigned_profile_id as profile_id,
      count(*) filter (where q.is_manual_quote) as manual_count,
      count(*) as total_count,
      count(*) filter (where q.is_manual_quote)::numeric / nullif(count(*), 0) * 100 as rate,
      (select count(*) filter (where a.is_manual_quote)::numeric / nullif(count(*), 0) * 100
         from public.reporting_quote_facts a
        where not a.is_excluded and a.created_at >= v_from and a.created_at < v_to) as baseline
    from public.reporting_quote_facts q
    where not q.is_excluded and q.created_at >= v_from and q.created_at < v_to
      and q.assigned_profile_id is not null
    group by q.assigned_profile_id
  ) r
  where r.total_count >= t.manual_rate_minimum_records
    and r.rate - coalesce(r.baseline, 0) >= t.manual_quote_rate_points_above_baseline
  on conflict (subject_kind, subject_id, signal_key) do update
    set explanation = excluded.explanation, evidence = excluded.evidence,
        severity = excluded.severity, updated_at = now();

  -- Queue reconciliation runs in its own gated function.
  perform public.reporting_detect_queue_mismatches(p_start, p_end);

  return v_count;
end;
$$;

grant execute on function public.reporting_detect_queue_mismatches(date, date) to authenticated;

commit;
