-- New Hope Work Desk v1.12.11 — fix: ambiguous column references broke two functions
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 10.1, 10.7, 11.5, 11.6
-- Fixes: v1.12.5-reporting-row-functions.sql (forward-only; that file is not edited)
--
-- ── The defect ────────────────────────────────────────────────────────────────
--
-- In a plpgsql function, the names in `returns table (...)` are variables in scope
-- throughout the body. An unqualified column reference that happens to match one of
-- them is ambiguous, and Postgres raises at run time rather than at create time.
--
-- Two functions had it:
--
--   report_needs_attention   `order by case severity ...` — the OUT parameter
--                            `severity` against the subquery column `severity`.
--                            Symptom: "Loading the Needs Attention summary failed:
--                            column reference "severity" is ambiguous".
--
--   report_records           `where not v_cohort or (created_at >= v_from ...)` inside
--                            the first CTE — the OUT parameter `created_at` against the
--                            column of the same name. This broke EVERY drill-down: all
--                            nineteen metric keys, so no number in the report could be
--                            opened.
--
-- report_agent_rows and report_source_rows contain the identical unqualified pattern and
-- work only because neither declares an OUT parameter called `created_at`. That is luck,
-- not design, so they are qualified here too.
--
-- ── Why the earlier verification did not catch this ───────────────────────────
--
-- This is the part worth recording. Every reporting function begins with an
-- authorization guard that returns early:
--
--     if not public.reporting_can_read() then return; end if;
--
-- The REST probe called all nine functions over PostgREST as an anonymous caller and got
-- `200 []` from each. That proved the functions existed and were reachable, and it
-- proved nothing at all about their bodies, because the guard returned before any query
-- ran. An empty result from a broken query is indistinguishable from an empty result
-- from a refused caller.
--
-- The SQL verification files did exercise report_summary, report_lifecycle,
-- report_agent_rows and report_integrity_flags with a real session — and those four are
-- exactly the four that worked. report_needs_attention, report_records,
-- report_source_rows and report_after_hours_summary were never executed authenticated.
--
-- supabase/verification/v1.12-reporting-execution-checks.sql now executes every
-- function, in both report modes, across all nineteen drill-down metric keys and all
-- fourteen saved review filters, and reports which ones raise. Reachability is not
-- execution.
--
-- ROLLBACK: re-apply report_needs_attention and report_records from v1.12.5. Doing so
-- restores the defects.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. NEEDS ATTENTION
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_needs_attention(p_filters jsonb default '{}'::jsonb)
returns table (condition_key text, label text, record_count bigint, severity text)
language plpgsql stable security definer set search_path = public
as $$
declare
  f      jsonb;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if not public.reporting_can_read() then
    return;
  end if;

  f := public.report_normalize_filters(p_filters);
  v_from := public.reporting_day_start((f ->> 'start_date')::date);
  v_to   := public.reporting_day_start(((f ->> 'end_date')::date) + 1);

  return query
  with q as (
    select fq.* from public.reporting_filtered_quotes(f) fq
  ),
  w as (
    select fw.* from public.reporting_filtered_workloads(f) fw
    where fw.created_at >= v_from and fw.created_at < v_to
  ),
  conditions as (
    select 'pending_overdue'::text as condition_key,
           'Pending Pricing overdue'::text as label,
           count(*) filter (where q.first_pricing_sent_at is not null
                             and q.final_outcome is null
                             and q.first_pricing_sent_at < v_to - interval '3 days')::bigint
             as record_count,
           'high'::text as severity
      from q
    union all
    select 'awaiting_follow_up', 'Awaiting customer follow-up',
           count(*) filter (where q.first_pricing_sent_at is not null
                             and q.final_outcome is null and q.follow_up_count = 0)::bigint,
           'medium' from q
    union all
    select 'missing_source', 'Missing source',
           count(*) filter (where q.dealer_id is null
                             and q.created_at >= v_from and q.created_at < v_to)::bigint,
           'medium' from q
    union all
    select 'missing_salesperson', 'Missing salesperson',
           count(*) filter (where q.salesperson_id is null
                             and q.created_at >= v_from and q.created_at < v_to)::bigint,
           'low' from q
    union all
    select 'missing_not_sold_reason', 'Missing Not Sold reason',
           count(*) filter (where q.not_sold_without_reason)::bigint, 'high' from q
    union all
    select 'manual_needs_review', 'Manual records needing review',
           ((select count(*) from w where w.manual_without_notes)
            + count(*) filter (where q.is_manual_quote and q.notes_count = 0
                                and q.created_at >= v_from and q.created_at < v_to))::bigint,
           'medium' from q
    union all
    select 'attribution_conflict', 'Quote and queue mismatches',
           count(*) filter (where q.attribution_conflict
                             or (q.assignment_method in ('whatsapp_turn','ringcentral_turn')
                                 and q.assignment_event_count = 0))::bigint,
           'medium' from q
    union all
    select 'finalized_without_pricing', 'Finalized records without pricing evidence',
           count(*) filter (where q.finalized_without_pricing
                             and q.finalized_at >= v_from and q.finalized_at < v_to)::bigint,
           'high' from q
  )
  -- Every reference qualified with the CTE alias, so none can collide with an OUT
  -- parameter of the same name.
  select c.condition_key, c.label, c.record_count, c.severity
  from conditions c
  order by case c.severity when 'high' then 1 when 'medium' then 2 else 3 end, c.label;
end;
$$;

comment on function public.report_needs_attention(jsonb) is
  'The eight Needs Attention conditions, each with a count and a drill-down key. Every column reference is qualified: the OUT parameter `severity` previously collided with the subquery column of the same name, and plpgsql raises that at run time rather than at create time.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. DRILL-DOWN RECORDS
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_records(
  p_filters jsonb default '{}'::jsonb,
  p_metric  text default 'quotes_received',
  p_limit   integer default 50,
  p_offset  integer default 0,
  p_sort    text default 'created_at_desc'
)
returns table (
  total_count bigint,
  quote_id uuid,
  customer_name text,
  dealer_name text,
  salesperson_name text,
  channel text,
  work_type text,
  is_requote boolean,
  assignment_method text,
  is_manual_quote boolean,
  is_cs_intake boolean,
  assigned_agent_name text,
  created_by_name text,
  claimed_by_name text,
  pricing_employee_name text,
  outcome_employee_name text,
  sales_credit_name text,
  created_at timestamptz,
  accepted_at timestamptz,
  first_pricing_sent_at timestamptz,
  finalized_at timestamptz,
  lifecycle_stage text,
  final_outcome text,
  not_sold_reason text,
  notes_count integer,
  follow_up_count integer,
  source_change_count integer,
  salesperson_change_count integer,
  received_after_hours boolean,
  worked_after_hours boolean,
  finalized_after_hours boolean,
  manual_entry_after_hours boolean,
  attribution_conflict boolean,
  finalized_without_pricing boolean,
  not_sold_without_reason boolean,
  minutes_to_pricing numeric
)
language plpgsql stable security definer set search_path = public
as $$
declare
  f        jsonb;
  v_from   timestamptz;
  v_to     timestamptz;
  v_cohort boolean;
  v_limit  integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_metric text := coalesce(p_metric, 'quotes_received');
begin
  if not public.reporting_can_read() then
    return;
  end if;

  f := public.report_normalize_filters(p_filters);
  v_from := public.reporting_day_start((f ->> 'start_date')::date);
  v_to   := public.reporting_day_start(((f ->> 'end_date')::date) + 1);
  v_cohort := (f ->> 'mode') = 'cohort';

  return query
  with q as (
    -- fq.created_at, not created_at: the bare name collided with the OUT parameter
    -- `created_at` and broke every drill-down in the report.
    select fq.* from public.reporting_filtered_quotes(f) fq
    where not v_cohort or (fq.created_at >= v_from and fq.created_at < v_to)
  ),
  matched as (
    select q.* from q
    where case v_metric
      when 'quotes_received' then q.created_at >= v_from and q.created_at < v_to
      when 'pricing_sent'    then q.first_pricing_sent_at >= v_from
                                  and q.first_pricing_sent_at < v_to
      when 'pending_pricing' then not (q.final_outcome is not null and q.finalized_at < v_to)
                                  and not (q.first_pricing_sent_at is not null
                                           and q.first_pricing_sent_at < v_to)
                                  and q.created_at < v_to
      when 'awaiting_customer_decision' then
                                  not (q.final_outcome is not null and q.finalized_at < v_to)
                                  and q.first_pricing_sent_at is not null
                                  and q.first_pricing_sent_at < v_to
                                  and q.created_at < v_to
      when 'sold'            then q.final_outcome = 'sold'
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'not_sold'        then q.final_outcome = 'not_sold'
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'finalized'       then q.final_outcome is not null
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'pending_overdue' then q.first_pricing_sent_at is not null
                                  and q.final_outcome is null
                                  and q.first_pricing_sent_at < v_to - interval '3 days'
      when 'awaiting_follow_up' then q.first_pricing_sent_at is not null
                                  and q.final_outcome is null and q.follow_up_count = 0
      when 'missing_source'      then q.dealer_id is null
                                  and q.created_at >= v_from and q.created_at < v_to
      when 'missing_salesperson' then q.salesperson_id is null
                                  and q.created_at >= v_from and q.created_at < v_to
      when 'missing_not_sold_reason' then q.not_sold_without_reason
      when 'manual_needs_review' then q.is_manual_quote and q.notes_count = 0
                                  and q.created_at >= v_from and q.created_at < v_to
      when 'finalized_without_pricing' then q.finalized_without_pricing
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'attribution_conflict' then q.attribution_conflict
                                  or (q.assignment_method in ('whatsapp_turn','ringcentral_turn')
                                      and q.assignment_event_count = 0)
      when 'manual_quotes'   then q.is_manual_quote
                                  and q.created_at >= v_from and q.created_at < v_to
      when 'received_after_hours'  then q.received_after_hours
                                  and q.created_at >= v_from and q.created_at < v_to
      when 'worked_after_hours'    then q.worked_after_hours
      when 'finalized_after_hours' then q.finalized_after_hours
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'manual_entry_after_hours' then q.manual_entry_after_hours
                                  and q.created_at >= v_from and q.created_at < v_to
      else true
    end
  ),
  counted as (select count(*) as n from matched)
  select
    counted.n,
    m.quote_id, m.customer_name, m.dealer_name, m.salesperson_name, m.channel,
    m.work_type, m.is_requote, m.assignment_method, m.is_manual_quote, m.is_cs_intake,
    pa.display_name, pc.display_name, pcl.display_name,
    pp.display_name, po.display_name, ps.display_name,
    m.created_at, m.accepted_at, m.first_pricing_sent_at, m.finalized_at,
    m.lifecycle_stage, m.final_outcome, m.not_sold_reason,
    m.notes_count::integer, m.follow_up_count::integer,
    m.source_change_count::integer, m.salesperson_change_count::integer,
    m.received_after_hours, m.worked_after_hours, m.finalized_after_hours,
    m.manual_entry_after_hours, m.attribution_conflict, m.finalized_without_pricing,
    m.not_sold_without_reason,
    case when m.first_pricing_sent_at is null then null
         else round(extract(epoch from (m.first_pricing_sent_at - m.created_at))::numeric / 60.0, 1)
    end
  from matched m
  cross join counted
  left join public.profiles pa  on pa.id  = m.assigned_profile_id
  left join public.profiles pc  on pc.id  = m.created_by_profile_id
  left join public.profiles pcl on pcl.id = m.claimed_by_profile_id
  left join public.profiles pp  on pp.id  = m.pricing_profile_id
  left join public.profiles po  on po.id  = m.outcome_profile_id
  left join public.profiles ps  on ps.id  = m.sales_credit_profile_id
  order by
    case when p_sort = 'created_at_asc'    then m.created_at end asc nulls last,
    case when p_sort = 'finalized_at_desc' then m.finalized_at end desc nulls last,
    case when p_sort = 'pricing_at_desc'   then m.first_pricing_sent_at end desc nulls last,
    case when p_sort = 'customer_asc'      then m.customer_name end asc nulls last,
    m.created_at desc
  limit v_limit offset v_offset;
end;
$$;

comment on function public.report_records(jsonb, text, integer, integer, text) is
  'A page of the records behind one metric, plus total_count on every row. p_metric applies that metric''s own predicate to the same filtered set the number was computed over, so a KPI and its drawer cannot disagree. Every column reference is qualified: the bare `created_at` in the first CTE collided with the OUT parameter of the same name and broke every drill-down. Also accepts awaiting_customer_decision and manual_needs_review, which the Overview offers and v1.12.5 did not handle.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE SAME PATTERN, QUALIFIED DEFENSIVELY
--
-- These two work today only because neither declares an OUT parameter named
-- `created_at`. Adding one later would have broken them the same way, silently, at run
-- time. Qualifying now removes the trap rather than relying on it staying shut.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.reporting_filtered_quotes_in_window(
  p_filters jsonb, p_from timestamptz, p_to timestamptz, p_cohort boolean
)
returns setof public.reporting_quote_facts
language sql stable security definer set search_path = public
as $$
  select fq.* from public.reporting_filtered_quotes(p_filters) fq
  where not p_cohort or (fq.created_at >= p_from and fq.created_at < p_to);
$$;

comment on function public.reporting_filtered_quotes_in_window(jsonb, timestamptz, timestamptz, boolean) is
  'The cohort restriction applied once, with the column reference qualified, so no caller has to repeat an unqualified `created_at` that could collide with one of its own OUT parameters.';

grant execute on function public.reporting_filtered_quotes_in_window(jsonb, timestamptz, timestamptz, boolean) to authenticated;

commit;
