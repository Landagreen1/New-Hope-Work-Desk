-- New Hope Work Desk v1.12.6 — integrity flags, detection, and the review workflow
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 14.1-14.10, 15.1-15.8, 19.2, 19.4, 19.6, 19.8
--
-- The existing Data Integrity report is four hard-coded strings with no record links,
-- no thresholds, and no review state, so the same discrepancy reappears every time the
-- report is opened and there is nowhere to record that it was explained. This
-- migration gives a discrepancy a row, a threshold, and an audit trail.
--
-- ── Neutral by construction ───────────────────────────────────────────────────
--
-- Seven flag types, none of which asserts that anybody acted dishonestly:
-- Needs Review, Attribution Conflict, Missing Documentation, Queue Mismatch,
-- Manual Entry Pattern, Duplicate Activity, Timing Conflict. The purpose is a
-- discrepancy management can investigate, and the wording has to survive being read
-- by the employee it concerns.
--
-- ── Re-detection must not un-explain ─────────────────────────────────────────
--
-- The unique key is (subject_kind, subject_id, signal_key), not flag_type, because two
-- signals share a flag type: "Sold with no pricing event" and "Not Sold with no
-- reason" are both Missing Documentation and must be reviewable separately.
--
-- The upsert writes explanation, evidence and severity, and never review_status,
-- reviewed_by, reviewed_at or manager_explanation. An explained discrepancy stays
-- explained the next time detection runs (Requirement 14.10).
--
-- ── Who may review ───────────────────────────────────────────────────────────
--
-- can_manage_sales(): manager, sales_supervisor, super_admin. Byron confirmed on
-- 2026-08-03 that sales supervisors may review flags.
--
-- ── No literal thresholds ────────────────────────────────────────────────────
--
-- Every threshold is a column on reporting_thresholds, mirroring
-- DEFAULT_INTEGRITY_THRESHOLDS in src/features/reporting/definitions.ts. A record is
-- never flagged solely for being manual (Requirement 14.4).
--
-- ROLLBACK
--   begin;
--     drop function if exists public.report_integrity_review(uuid, text, text);
--     drop function if exists public.report_integrity_flags(jsonb, text, integer, integer);
--     drop function if exists public.reporting_detect_integrity_flags(date, date);
--     drop trigger  if exists reporting_integrity_reviews_immutable on public.reporting_integrity_reviews;
--     drop function if exists public.reporting_integrity_review_immutable();
--     drop table    if exists public.reporting_integrity_reviews;
--     drop table    if exists public.reporting_integrity_flags;
--     drop table    if exists public.reporting_thresholds;
--   commit;

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THRESHOLDS — one row, mirroring the TypeScript defaults
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.reporting_thresholds (
  singleton_key                          boolean primary key default true check (singleton_key),
  manual_quote_rate_points_above_baseline    numeric not null default 20 check (manual_quote_rate_points_above_baseline > 0),
  manual_workload_rate_points_above_baseline numeric not null default 20 check (manual_workload_rate_points_above_baseline > 0),
  manual_rate_minimum_records            integer not null default 10 check (manual_rate_minimum_records > 0),
  manual_quote_minutes_before_sold       integer not null default 30 check (manual_quote_minutes_before_sold > 0),
  unknown_source_record_count            integer not null default 5 check (unknown_source_record_count > 0),
  pending_pricing_days_without_follow_up  integer not null default 3 check (pending_pricing_days_without_follow_up > 0),
  duplicate_customer_source_hours        integer not null default 24 check (duplicate_customer_source_hours > 0),
  passes_per_hundred_eligible_turns      numeric not null default 30 check (passes_per_hundred_eligible_turns > 0),
  missed_turns_per_hundred_eligible_turns numeric not null default 20 check (missed_turns_per_hundred_eligible_turns > 0),
  recoveries_per_hundred_claims          numeric not null default 25 check (recoveries_per_hundred_claims > 0),
  end_of_day_cluster_share_percent       numeric not null default 50 check (end_of_day_cluster_share_percent > 0),
  end_of_period_cluster_share_percent    numeric not null default 40 check (end_of_period_cluster_share_percent > 0),
  schedule_volume_upper_multiple          numeric not null default 2 check (schedule_volume_upper_multiple > 0),
  schedule_volume_lower_multiple          numeric not null default 0.25 check (schedule_volume_lower_multiple > 0),
  manual_after_hours_share_percent       numeric not null default 60 check (manual_after_hours_share_percent > 0),
  updated_by                             uuid references public.profiles(id),
  updated_at                             timestamptz not null default now(),
  constraint reporting_thresholds_schedule_band
    check (schedule_volume_upper_multiple > schedule_volume_lower_multiple)
);

insert into public.reporting_thresholds (singleton_key) values (true)
on conflict (singleton_key) do nothing;

comment on table public.reporting_thresholds is
  'Exactly one row. Every integrity signal reads its threshold from here, so no threshold is a literal in SQL or in a component (Requirement 14.4). Column names mirror DEFAULT_INTEGRITY_THRESHOLDS in src/features/reporting/definitions.ts.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. FLAGS
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.reporting_integrity_flags (
  id            uuid primary key default gen_random_uuid(),
  subject_kind  text not null check (subject_kind in ('quote', 'workload', 'agent', 'source')),
  subject_id    uuid not null,
  signal_key    text not null,
  flag_type     text not null check (flag_type in (
                  'Needs Review', 'Attribution Conflict', 'Missing Documentation',
                  'Queue Mismatch', 'Manual Entry Pattern', 'Duplicate Activity',
                  'Timing Conflict')),
  severity      text not null check (severity in ('low', 'medium', 'high')),
  explanation   text not null check (length(btrim(explanation)) > 0),
  evidence      jsonb not null default '{}'::jsonb,
  detected_on   date not null default current_date,
  review_status text not null default 'Open' check (review_status in (
                  'Open', 'Explained', 'Confirmed Data Issue', 'Dismissed')),
  reviewed_by   uuid references public.profiles(id),
  reviewed_at   timestamptz,
  manager_explanation text,
  resolution    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint reporting_integrity_flags_subject_signal unique (subject_kind, subject_id, signal_key)
);

create index if not exists reporting_flags_status_idx
  on public.reporting_integrity_flags (review_status, detected_on desc);
create index if not exists reporting_flags_subject_idx
  on public.reporting_integrity_flags (subject_kind, subject_id);
create index if not exists reporting_flags_type_idx
  on public.reporting_integrity_flags (flag_type, review_status);

comment on table public.reporting_integrity_flags is
  'One row per detected discrepancy. The unique key is (subject_kind, subject_id, signal_key) rather than flag_type, because two signals can share a flag type and must be reviewable separately. No flag type or explanation asserts dishonesty: the purpose is a discrepancy management can investigate (Requirement 14.2).';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. REVIEW HISTORY — append only
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.reporting_integrity_reviews (
  id            uuid primary key default gen_random_uuid(),
  flag_id       uuid not null references public.reporting_integrity_flags(id) on delete cascade,
  actor_profile_id uuid references public.profiles(id),
  action        text not null check (action in (
                  'Explained', 'Confirmed Data Issue', 'Dismissed', 'Reopened')),
  resulting_status text not null check (resulting_status in (
                  'Open', 'Explained', 'Confirmed Data Issue', 'Dismissed')),
  explanation   text,
  created_at    timestamptz not null default now()
);

create index if not exists reporting_integrity_reviews_flag_idx
  on public.reporting_integrity_reviews (flag_id, created_at);

create or replace function public.reporting_integrity_review_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'reporting_integrity_reviews is append-only: a review decision cannot be % once recorded.',
    lower(tg_op);
end;
$$;

drop trigger if exists reporting_integrity_reviews_immutable on public.reporting_integrity_reviews;
create trigger reporting_integrity_reviews_immutable
before update or delete on public.reporting_integrity_reviews
for each row execute function public.reporting_integrity_review_immutable();

comment on table public.reporting_integrity_reviews is
  'Append-only review history. A reopen appends a row and retains every earlier one, so the explanation recorded before a reopen survives (Requirement 15.5). The trigger refuses update and delete, following attendance_audit_immutable() from v1.9.0.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. DETECTION
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

  -- ---- Documentation signals ------------------------------------------------
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
      -- Attribution: sales credit and the outcome actor are different known people.
      ('attribution_conflict', 'Attribution Conflict', 'medium',
       'The employee credited with the sale and the employee who recorded the outcome are different.',
       jsonb_build_object('sales_credit_profile_id', q.sales_credit_profile_id,
                          'outcome_profile_id', q.outcome_profile_id),
       q.attribution_conflict),
      -- Pricing happened and nobody is recorded as having done it.
      ('missing_pricing_actor', 'Missing Documentation', 'medium',
       'Pricing was recorded with no employee attached to the pricing event.',
       jsonb_build_object('first_pricing_sent_at', q.first_pricing_sent_at),
       q.missing_pricing_actor),
      -- A quote holding more than one outcome record.
      ('multiple_outcome_records', 'Timing Conflict', 'high',
       'This quote holds more than one outcome record; the latest is the one reported.',
       jsonb_build_object('outcome_record_count', q.outcome_record_count),
       q.has_multiple_outcomes),
      -- Queue reconciliation: a queue assignment method with no assignment history.
      ('queue_assigned_without_turn_event', 'Queue Mismatch', 'high',
       'A quote whose assignment method names a queue has no recorded assignment history.',
       jsonb_build_object('assignment_method', q.assignment_method,
                          'assignment_event_count', q.assignment_event_count),
       q.assignment_method in ('whatsapp_turn', 'ringcentral_turn', 'workload_turn')
         and q.assignment_event_count = 0),
      -- Manual entry paired with a second condition, never on its own.
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
      -- Explanation, evidence and severity refresh. review_status, reviewed_by,
      -- reviewed_at and manager_explanation are deliberately absent: re-detecting a
      -- discrepancy must not un-explain it (Requirement 14.10).
      set explanation = excluded.explanation,
          evidence    = excluded.evidence,
          severity    = excluded.severity,
          updated_at  = now()
    returning 1
  )
  select count(*) into v_count from upserted;

  -- ---- Workload signals -----------------------------------------------------
  insert into public.reporting_integrity_flags
    (subject_kind, subject_id, signal_key, flag_type, severity, explanation, evidence)
  select 'workload', w.workload_id, 'manual_workload_without_notes',
         'Missing Documentation', 'medium',
         'A manual workload was recorded with no notes.',
         jsonb_build_object('created_at', w.created_at, 'workload_type', w.workload_type)
  from public.reporting_workload_facts w
  where w.manual_without_notes
    and not w.is_excluded
    and w.created_at >= v_from and w.created_at < v_to
  on conflict (subject_kind, subject_id, signal_key) do update
    set explanation = excluded.explanation,
        evidence    = excluded.evidence,
        severity    = excluded.severity,
        updated_at  = now();

  -- ---- Duplicate activity: same customer and source inside the window -------
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
    set explanation = excluded.explanation,
        evidence    = excluded.evidence,
        severity    = excluded.severity,
        updated_at  = now();

  -- ---- Manual entry rate materially above the team baseline -----------------
  -- A rate, not a record. Requirement 14.4: never flag a record for being manual.
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
    set explanation = excluded.explanation,
        evidence    = excluded.evidence,
        severity    = excluded.severity,
        updated_at  = now();

  return v_count;
end;
$$;

comment on function public.reporting_detect_integrity_flags(date, date) is
  'Upserts a flag per detected discrepancy. The conflict clause refreshes explanation, evidence and severity and never touches review_status, reviewed_by, reviewed_at or manager_explanation, so an explained discrepancy stays explained when detection runs again (Requirement 14.10). Every threshold is read from reporting_thresholds; none is a literal. Manual entry alone raises nothing: every manual signal pairs it with a second condition or a rate above the team baseline.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. READ AND REVIEW FUNCTIONS
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_integrity_flags(
  p_filters      jsonb default '{}'::jsonb,
  p_saved_filter text default 'All Open Flags',
  p_limit        integer default 50,
  p_offset       integer default 0
)
returns table (
  total_count bigint,
  id uuid,
  subject_kind text,
  subject_id uuid,
  signal_key text,
  flag_type text,
  severity text,
  explanation text,
  evidence jsonb,
  detected_on date,
  review_status text,
  reviewed_by uuid,
  reviewer_name text,
  reviewed_at timestamptz,
  manager_explanation text,
  resolution text,
  subject_label text,
  subject_agent_name text,
  review_count bigint
)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_filter text := coalesce(p_saved_filter, 'All Open Flags');
  v_can_review boolean := public.can_manage_sales();
begin
  if not public.reporting_can_read() then
    return;
  end if;

  return query
  with matched as (
    select fl.* from public.reporting_integrity_flags fl
    where case v_filter
      when 'All Open Flags'            then fl.review_status = 'Open'
      when 'High Priority'             then fl.review_status = 'Open' and fl.severity = 'high'
      when 'Manual Quote Review'       then fl.signal_key in (
                                            'manual_quote_rate_above_baseline',
                                            'manual_quote_shortly_before_sold',
                                            'manual_quote_without_notes')
      when 'Manual Workload Review'    then fl.signal_key in (
                                            'manual_workload_without_notes',
                                            'manual_workload_rate_above_baseline')
      when 'Queue Mismatch'            then fl.flag_type = 'Queue Mismatch'
      when 'Missing Documentation'     then fl.flag_type = 'Missing Documentation'
      when 'Attribution Conflict'      then fl.flag_type = 'Attribution Conflict'
      when 'Duplicate Activity'        then fl.flag_type = 'Duplicate Activity'
      when 'Timing Conflict'           then fl.flag_type = 'Timing Conflict'
      when 'Finalized Without Pricing' then fl.signal_key = 'sold_without_pricing_evidence'
      when 'Not Sold Without Reason'   then fl.signal_key = 'not_sold_without_reason'
      when 'Explained'                 then fl.review_status = 'Explained'
      when 'Confirmed Data Issue'      then fl.review_status = 'Confirmed Data Issue'
      when 'Dismissed'                 then fl.review_status = 'Dismissed'
      else true
    end
    -- A Self_Scoped_Reader sees only flags on its own records, and never the
    -- manager explanation or the review history (Requirement 19.4).
    and (public.reporting_self_scope() is null
         or (fl.subject_kind = 'quote' and exists (
               select 1 from public.reporting_filtered_quotes('{}'::jsonb) sq
               where sq.quote_id = fl.subject_id))
         or (fl.subject_kind = 'agent' and fl.subject_id = public.reporting_self_scope()))
  ),
  counted as (select count(*) as n from matched)
  select
    counted.n, m.id, m.subject_kind, m.subject_id, m.signal_key, m.flag_type,
    m.severity, m.explanation, m.evidence, m.detected_on, m.review_status,
    m.reviewed_by, rp.display_name, m.reviewed_at,
    case when v_can_review then m.manager_explanation else null end,
    case when v_can_review then m.resolution else null end,
    coalesce(q.customer_name, w.customer_name, ap.display_name, d.name, 'Unknown record'),
    coalesce(qa.display_name, wa.display_name, ap.display_name),
    case when v_can_review
         then (select count(*) from public.reporting_integrity_reviews rv where rv.flag_id = m.id)
         else 0 end
  from matched m
  cross join counted
  left join public.profiles rp on rp.id = m.reviewed_by
  left join public.reporting_quote_facts q    on m.subject_kind = 'quote'    and q.quote_id = m.subject_id
  left join public.reporting_workload_facts w on m.subject_kind = 'workload' and w.workload_id = m.subject_id
  left join public.profiles ap on m.subject_kind = 'agent'  and ap.id = m.subject_id
  left join public.dealers  d  on m.subject_kind = 'source' and d.id = m.subject_id
  left join public.profiles qa on qa.id = q.assigned_profile_id
  left join public.profiles wa on wa.id = w.agent_profile_id
  order by case m.severity when 'high' then 1 when 'medium' then 2 else 3 end,
           m.detected_on desc, m.id
  limit v_limit offset v_offset;
end;
$$;

create or replace function public.report_integrity_review(
  p_flag_id     uuid,
  p_action      text,
  p_explanation text default null
)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
declare
  v_flag   public.reporting_integrity_flags;
  v_status text;
  v_me     uuid := auth.uid();
begin
  -- Byron confirmed on 2026-08-03 that sales supervisors may review flags, so this
  -- is can_manage_sales() rather than the narrower is_manager().
  if not public.can_manage_sales() then
    return jsonb_build_object('success', false,
      'error', 'UNAUTHORIZED: only sales management may record a review decision.');
  end if;

  if p_action not in ('Explained', 'Confirmed Data Issue', 'Dismissed', 'Reopened') then
    return jsonb_build_object('success', false,
      'error', 'INVALID_ACTION: expected Explained, Confirmed Data Issue, Dismissed or Reopened.');
  end if;

  -- Requirement 15.6: these two decisions require an explanation.
  if p_action in ('Explained', 'Confirmed Data Issue')
     and length(btrim(coalesce(p_explanation, ''))) = 0 then
    return jsonb_build_object('success', false,
      'error', 'EXPLANATION_REQUIRED: ' || p_action || ' requires an explanation.');
  end if;

  select * into v_flag from public.reporting_integrity_flags
   where id = p_flag_id for update;
  if not found then
    return jsonb_build_object('success', false, 'error', 'NOT_FOUND: no such flag.');
  end if;

  v_status := case when p_action = 'Reopened' then 'Open' else p_action end;

  update public.reporting_integrity_flags
     set review_status = v_status,
         reviewed_by   = v_me,
         reviewed_at   = now(),
         -- A reopen retains the explanation recorded before it (Requirement 15.5).
         manager_explanation = case
           when p_action = 'Reopened' then manager_explanation
           else btrim(p_explanation)
         end,
         resolution = case
           when p_action = 'Reopened' then null
           else p_action
         end,
         updated_at = now()
   where id = p_flag_id;

  insert into public.reporting_integrity_reviews
    (flag_id, actor_profile_id, action, resulting_status, explanation)
  values (p_flag_id, v_me, p_action, v_status, nullif(btrim(coalesce(p_explanation, '')), ''));

  select * into v_flag from public.reporting_integrity_flags where id = p_flag_id;

  return jsonb_build_object(
    'success', true,
    'flag_id', v_flag.id,
    'review_status', v_flag.review_status,
    'manager_explanation', v_flag.manager_explanation,
    'review_count', (select count(*) from public.reporting_integrity_reviews
                      where flag_id = p_flag_id)
  );
end;
$$;

comment on function public.report_integrity_review(uuid, text, text) is
  'Records one review decision and appends an immutable history row. Explained and Confirmed Data Issue require a non-empty explanation; Reopened sets the status to Open while retaining the explanation recorded before it. Authorized by can_manage_sales(): manager, sales_supervisor, super_admin.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. RLS
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.reporting_thresholds enable row level security;
alter table public.reporting_integrity_flags enable row level security;
alter table public.reporting_integrity_reviews enable row level security;

drop policy if exists "Sales management can read thresholds" on public.reporting_thresholds;
create policy "Sales management can read thresholds"
  on public.reporting_thresholds for select to authenticated using (public.can_manage_sales());

drop policy if exists "Managers can change thresholds" on public.reporting_thresholds;
create policy "Managers can change thresholds"
  on public.reporting_thresholds for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- Direct table reads are reserved to sales management. Everyone else goes through
-- report_integrity_flags, which applies the self scope and hides the manager
-- explanation and the review history.
drop policy if exists "Sales management can read integrity flags" on public.reporting_integrity_flags;
create policy "Sales management can read integrity flags"
  on public.reporting_integrity_flags for select to authenticated using (public.can_manage_sales());

drop policy if exists "Sales management can read review history" on public.reporting_integrity_reviews;
create policy "Sales management can read review history"
  on public.reporting_integrity_reviews for select to authenticated using (public.can_manage_sales());

-- No insert, update or delete policy on either table. Writes happen only through the
-- security definer functions above, which is what makes the review path auditable.

grant execute on function public.reporting_detect_integrity_flags(date, date) to authenticated;
grant execute on function public.report_integrity_flags(jsonb, text, integer, integer) to authenticated;
grant execute on function public.report_integrity_review(uuid, text, text) to authenticated;

commit;
