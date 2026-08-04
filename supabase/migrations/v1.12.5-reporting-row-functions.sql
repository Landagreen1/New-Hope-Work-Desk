-- New Hope Work Desk v1.12.5 — per-agent, per-source, drill-down and summary functions
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 8.8, 10.1, 10.6, 10.7, 11.5, 11.6, 11.7, 12.1, 12.2, 12.7, 12.8,
--               13.1, 13.2, 13.3, 17.1, 17.4, 19.3, 19.6, 20.1, 20.2
--
-- ── Attribution is the point of report_agent_rows ─────────────────────────────
--
-- Every current per-agent number groups by assigned_profile_id, so "quotes", "priced"
-- and "sold" are all counted against whichever employee happens to hold the quote.
-- Here each column is counted against the credit role it measures:
--
--   Quotes Received  -> assigned_profile_id
--   Pricing Sent     -> pricing_profile_id       (actor of the first price_sent event)
--   Sold / Not Sold  -> sales_credit_profile_id  (frozen at finalization)
--   Manual Quotes    -> created_by_profile_id
--
-- The five populations are also returned separately, so the drawer can say plainly
-- how many quotes an employee created, claimed, priced, was credited with selling, and
-- entered an outcome for. Those are five different numbers and today they are one.
--
-- ── report_records is what makes every number openable ───────────────────────
--
-- It takes the metric key the number came from and applies exactly that metric's own
-- predicate to the same filtered set, so a KPI and its drawer cannot disagree
-- (Requirement 10.1). total_count rides along on every row so the caller can show the
-- full count beside the page it is displaying (Requirement 10.7).
--
-- ROLLBACK: drop each function created below by name.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. AGENT ROWS
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_agent_rows(p_filters jsonb default '{}'::jsonb)
returns table (
  profile_id uuid,
  display_name text,
  username text,
  role text,
  quotes_received bigint,
  pricing_sent bigint,
  pending_pricing bigint,
  sold bigint,
  not_sold bigint,
  finalized bigint,
  conversion_rate numeric,
  manual_quotes bigint,
  manual_workloads bigint,
  after_hours_activity bigint,
  median_time_to_pricing_minutes numeric,
  new_quotes bigint,
  requotes bigint,
  intake_claims bigint,
  whatsapp_claims bigint,
  ringcentral_claims bigint,
  workload_queue_claims bigint,
  passes bigint,
  missed_turns bigint,
  recovered_quotes bigint,
  notes_coverage_percent numeric,
  follow_ups_overdue bigint,
  sold_without_pricing_evidence bigint,
  not_sold_without_reason bigint,
  scheduled_hours numeric,
  quotes_per_scheduled_hour numeric,
  sales_per_hundred_finalized numeric,
  manual_per_hundred_activities numeric,
  missed_turns_per_hundred_eligible numeric,
  quotes_created bigint,
  quotes_claimed bigint,
  quotes_priced bigint,
  quotes_sales_credited bigint,
  quotes_outcome_entered bigint
)
language plpgsql stable security definer set search_path = public
as $$
declare
  f       jsonb;
  v_from  timestamptz;
  v_to    timestamptz;
  v_start date;
  v_end   date;
  v_cohort boolean;
begin
  if not public.reporting_can_read() then
    return;
  end if;

  f := public.report_normalize_filters(p_filters);
  v_start := (f ->> 'start_date')::date;
  v_end   := (f ->> 'end_date')::date;
  v_from  := public.reporting_day_start(v_start);
  v_to    := public.reporting_day_start(v_end + 1);
  v_cohort := (f ->> 'mode') = 'cohort';

  return query
  with q as (
    select * from public.reporting_filtered_quotes(f)
    -- Cohort mode restricts the whole population up front; activity mode does not,
    -- because each metric below carries its own date predicate.
    where not v_cohort or (created_at >= v_from and created_at < v_to)
  ),
  w as (
    select * from public.reporting_filtered_workloads(f)
    where created_at >= v_from and created_at < v_to
  ),
  people as (
    select p.id, p.display_name, p.username, p.role::text as role
    from public.profiles p
    where p.role in ('agent', 'customer_service', 'sales_supervisor', 'manager', 'super_admin')
      and (public.reporting_self_scope() is null
           or p.id = public.reporting_self_scope())
  ),
  sched as (
    select s.profile_id,
           sum(extract(epoch from (s.shift_end - s.shift_start)) / 3600.0) as hours
    from public.employee_schedules s
    where s.schedule_date between v_start and v_end
      and s.shift_start is not null and s.shift_end is not null
    group by s.profile_id
  ),
  turns as (
    select t.actor_profile_id as profile_id,
           count(*) filter (where t.action = 'pass')  as passes,
           count(*) filter (where t.action = 'claim') as claims
    from public.turn_events t
    where t.created_at >= v_from and t.created_at < v_to
    group by t.actor_profile_id
  ),
  takes as (
    select te.taker_profile_id as profile_id, count(*) as recovered
    from public.quote_take_events te
    where te.taken_at >= v_from and te.taken_at < v_to
    group by te.taker_profile_id
  ),
  missed as (
    select skipped as profile_id, count(*) as missed_turns
    from public.quote_take_events te,
         unnest(coalesce(te.skipped_profile_ids, '{}'::uuid[])) as skipped
    where te.taken_at >= v_from and te.taken_at < v_to
    group by skipped
  )
  select
    pe.id, pe.display_name, pe.username, pe.role,

    -- Assigned agent: volume.
    count(*) filter (where q.assigned_profile_id = pe.id
                       and (v_cohort or (q.created_at >= v_from and q.created_at < v_to)))::bigint,
    -- Pricing employee: pricing.
    count(*) filter (where q.pricing_profile_id = pe.id
                       and q.first_pricing_sent_at is not null
                       and (v_cohort or (q.first_pricing_sent_at >= v_from
                                         and q.first_pricing_sent_at < v_to))
                       and (not v_cohort or q.first_pricing_sent_at < v_to))::bigint,
    -- Pending pricing is an as-of-date state, attributed to the assigned agent.
    count(*) filter (where q.assigned_profile_id = pe.id
                       and not (q.final_outcome is not null and q.finalized_at < v_to)
                       and not (q.first_pricing_sent_at is not null
                                and q.first_pricing_sent_at < v_to)
                       and q.created_at < v_to)::bigint,
    -- Sales credit: outcomes.
    count(*) filter (where q.sales_credit_profile_id = pe.id and q.final_outcome = 'sold'
                       and (v_cohort or (q.finalized_at >= v_from and q.finalized_at < v_to))
                       and q.finalized_at < v_to)::bigint,
    count(*) filter (where q.sales_credit_profile_id = pe.id and q.final_outcome = 'not_sold'
                       and (v_cohort or (q.finalized_at >= v_from and q.finalized_at < v_to))
                       and q.finalized_at < v_to)::bigint,
    count(*) filter (where q.sales_credit_profile_id = pe.id and q.final_outcome is not null
                       and (v_cohort or (q.finalized_at >= v_from and q.finalized_at < v_to))
                       and q.finalized_at < v_to)::bigint,
    -- Undefined, not zero, when nothing was finalized (Requirement 12.8).
    case when count(*) filter (where q.sales_credit_profile_id = pe.id
                                 and q.final_outcome is not null
                                 and q.finalized_at < v_to) = 0
         then null
         else round(
           count(*) filter (where q.sales_credit_profile_id = pe.id
                             and q.final_outcome = 'sold' and q.finalized_at < v_to)::numeric
           / count(*) filter (where q.sales_credit_profile_id = pe.id
                               and q.final_outcome is not null and q.finalized_at < v_to) * 100, 1)
    end,
    -- Manual quotes are credited to whoever entered them.
    count(*) filter (where q.created_by_profile_id = pe.id and q.is_manual_quote
                       and q.created_at >= v_from and q.created_at < v_to)::bigint,
    (select count(*) from w where w.is_manual_workload
       and (w.created_by_profile_id = pe.id or w.agent_profile_id = pe.id))::bigint,
    count(*) filter (where q.assigned_profile_id = pe.id
                       and (q.worked_after_hours or q.finalized_after_hours
                            or q.manual_entry_after_hours))::bigint,
    round(percentile_cont(0.5) within group (
      order by extract(epoch from (q.first_pricing_sent_at - q.created_at)) / 60.0
    ) filter (where q.pricing_profile_id = pe.id
               and q.first_pricing_sent_at is not null
               and q.first_pricing_sent_at < v_to)::numeric, 1),

    -- Expandable columns.
    count(*) filter (where q.assigned_profile_id = pe.id and not q.is_requote
                       and q.created_at >= v_from and q.created_at < v_to)::bigint,
    count(*) filter (where q.assigned_profile_id = pe.id and q.is_requote
                       and q.created_at >= v_from and q.created_at < v_to)::bigint,
    count(*) filter (where q.assigned_profile_id = pe.id and q.is_cs_intake
                       and q.created_at >= v_from and q.created_at < v_to)::bigint,
    count(*) filter (where q.assigned_profile_id = pe.id
                       and q.assignment_method = 'whatsapp_turn'
                       and q.created_at >= v_from and q.created_at < v_to)::bigint,
    count(*) filter (where q.assigned_profile_id = pe.id
                       and q.assignment_method = 'ringcentral_turn'
                       and q.created_at >= v_from and q.created_at < v_to)::bigint,
    (select count(*) from w where w.is_queue_workload and w.agent_profile_id = pe.id)::bigint,
    coalesce((select t.passes from turns t where t.profile_id = pe.id), 0)::bigint,
    coalesce((select m.missed_turns from missed m where m.profile_id = pe.id), 0)::bigint,
    coalesce((select k.recovered from takes k where k.profile_id = pe.id), 0)::bigint,
    case when count(*) filter (where q.assigned_profile_id = pe.id) = 0 then null
         else round(count(*) filter (where q.assigned_profile_id = pe.id and q.notes_count > 0)::numeric
                    / count(*) filter (where q.assigned_profile_id = pe.id) * 100, 1) end,
    count(*) filter (where q.assigned_profile_id = pe.id
                       and q.first_pricing_sent_at is not null
                       and q.final_outcome is null
                       and q.follow_up_count = 0
                       and q.first_pricing_sent_at < v_to - interval '3 days')::bigint,
    count(*) filter (where q.sales_credit_profile_id = pe.id and q.final_outcome = 'sold'
                       and q.finalized_without_pricing)::bigint,
    count(*) filter (where q.sales_credit_profile_id = pe.id
                       and q.not_sold_without_reason)::bigint,

    -- Rates. Every one is null rather than zero when its denominator is zero.
    round(coalesce((select s.hours from sched s where s.profile_id = pe.id), 0)::numeric, 2),
    case when coalesce((select s.hours from sched s where s.profile_id = pe.id), 0) = 0 then null
         else round(count(*) filter (where q.assigned_profile_id = pe.id
                                      and q.created_at >= v_from and q.created_at < v_to)::numeric
                    / (select s.hours from sched s where s.profile_id = pe.id)::numeric, 2) end,
    case when count(*) filter (where q.sales_credit_profile_id = pe.id
                                and q.final_outcome is not null and q.finalized_at < v_to) = 0
         then null
         else round(count(*) filter (where q.sales_credit_profile_id = pe.id
                                      and q.final_outcome = 'sold' and q.finalized_at < v_to)::numeric
                    / count(*) filter (where q.sales_credit_profile_id = pe.id
                                        and q.final_outcome is not null
                                        and q.finalized_at < v_to) * 100, 1) end,
    case when (count(*) filter (where q.assigned_profile_id = pe.id
                                 and q.created_at >= v_from and q.created_at < v_to)
               + (select count(*) from w where w.agent_profile_id = pe.id)) = 0
         then null
         else round((count(*) filter (where q.created_by_profile_id = pe.id and q.is_manual_quote
                                       and q.created_at >= v_from and q.created_at < v_to)
                     + (select count(*) from w where w.is_manual_workload
                          and (w.created_by_profile_id = pe.id or w.agent_profile_id = pe.id)))::numeric
                    / (count(*) filter (where q.assigned_profile_id = pe.id
                                         and q.created_at >= v_from and q.created_at < v_to)
                       + (select count(*) from w where w.agent_profile_id = pe.id)) * 100, 1) end,
    case when coalesce((select t.claims + t.passes from turns t where t.profile_id = pe.id), 0) = 0
         then null
         else round(coalesce((select m.missed_turns from missed m where m.profile_id = pe.id), 0)::numeric
                    / (select t.claims + t.passes from turns t where t.profile_id = pe.id) * 100, 1) end,

    -- The five populations, reported separately (Requirement 12.6).
    count(*) filter (where q.created_by_profile_id = pe.id)::bigint,
    count(*) filter (where q.claimed_by_profile_id = pe.id)::bigint,
    count(*) filter (where q.pricing_profile_id = pe.id)::bigint,
    count(*) filter (where q.sales_credit_profile_id = pe.id)::bigint,
    count(*) filter (where q.outcome_profile_id = pe.id)::bigint
  from people pe
  left join q on true
  group by pe.id, pe.display_name, pe.username, pe.role
  having count(*) filter (where q.assigned_profile_id = pe.id) > 0
      or count(*) filter (where q.pricing_profile_id = pe.id) > 0
      or count(*) filter (where q.sales_credit_profile_id = pe.id) > 0
      or count(*) filter (where q.created_by_profile_id = pe.id) > 0
      or (select count(*) from w where w.agent_profile_id = pe.id) > 0
  order by count(*) filter (where q.assigned_profile_id = pe.id) desc, pe.display_name;
end;
$$;

comment on function public.report_agent_rows(jsonb) is
  'One row per employee. Each column is counted against the credit role it measures rather than against a single agent field: volume by assigned agent, pricing by the price_sent actor, outcomes by the sales-credit owner frozen at finalization, manual quotes by whoever entered them. The last five columns report the five populations separately so the drawer can say how many quotes an employee created, claimed, priced, was credited with, and entered an outcome for. No composite score, by Requirement 12.3.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SOURCE ROWS
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_source_rows(p_filters jsonb default '{}'::jsonb)
returns table (
  dealer_id uuid,
  source_name text,
  quotes bigint,
  pricing_sent bigint,
  pending_pricing bigint,
  sold bigint,
  not_sold bigint,
  finalized bigint,
  conversion_rate numeric,
  median_time_to_pricing_minutes numeric,
  manual_quote_share_percent numeric,
  after_hours_share_percent numeric,
  missing_salesperson_count bigint,
  duplicate_count bigint,
  no_response_count bigint,
  median_days_pending numeric,
  source_change_count bigint
)
language plpgsql stable security definer set search_path = public
as $$
declare
  f        jsonb;
  v_from   timestamptz;
  v_to     timestamptz;
  v_cohort boolean;
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
    select * from public.reporting_filtered_quotes(f)
    where not v_cohort or (created_at >= v_from and created_at < v_to)
  )
  select
    q.dealer_id,
    -- A quote with no source is labelled, never omitted (Requirement 13.2).
    coalesce(q.dealer_name,
             case when q.dealer_id is null then 'No source recorded'
                  else 'Source not found' end) as source_name,
    count(*) filter (where q.created_at >= v_from and q.created_at < v_to)::bigint,
    count(*) filter (where q.first_pricing_sent_at >= v_from
                       and q.first_pricing_sent_at < v_to)::bigint,
    count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                       and not (q.first_pricing_sent_at is not null
                                and q.first_pricing_sent_at < v_to)
                       and q.created_at < v_to)::bigint,
    count(*) filter (where q.final_outcome = 'sold'
                       and q.finalized_at >= v_from and q.finalized_at < v_to)::bigint,
    count(*) filter (where q.final_outcome = 'not_sold'
                       and q.finalized_at >= v_from and q.finalized_at < v_to)::bigint,
    count(*) filter (where q.final_outcome is not null
                       and q.finalized_at >= v_from and q.finalized_at < v_to)::bigint,
    case when count(*) filter (where q.final_outcome is not null
                                and q.finalized_at >= v_from and q.finalized_at < v_to) = 0
         then null
         else round(count(*) filter (where q.final_outcome = 'sold'
                                      and q.finalized_at >= v_from and q.finalized_at < v_to)::numeric
                    / count(*) filter (where q.final_outcome is not null
                                        and q.finalized_at >= v_from
                                        and q.finalized_at < v_to) * 100, 1) end,
    round(percentile_cont(0.5) within group (
      order by extract(epoch from (q.first_pricing_sent_at - q.created_at)) / 60.0
    ) filter (where q.first_pricing_sent_at is not null)::numeric, 1),
    case when count(*) = 0 then null
         else round(count(*) filter (where q.is_manual_quote)::numeric / count(*) * 100, 1) end,
    case when count(*) = 0 then null
         else round(count(*) filter (where q.received_after_hours)::numeric / count(*) * 100, 1) end,
    count(*) filter (where q.salesperson_id is null)::bigint,
    count(*) filter (where q.is_duplicate_retry)::bigint,
    count(*) filter (where q.not_sold_reason = 'no_response')::bigint,
    round(percentile_cont(0.5) within group (
      order by extract(epoch from (v_to - q.first_pricing_sent_at)) / 86400.0
    ) filter (where q.first_pricing_sent_at is not null and q.final_outcome is null)::numeric, 1),
    sum(q.source_change_count)::bigint
  from q
  group by q.dealer_id, q.dealer_name
  order by count(*) filter (where q.created_at >= v_from and q.created_at < v_to) desc,
           coalesce(q.dealer_name, 'zzz');
end;
$$;

comment on function public.report_source_rows(jsonb) is
  'One row per source, including the two unnamed cases: a quote with a null dealer_id reports as "No source recorded" and a dealer_id that resolves to nothing reports as "Source not found". Neither is omitted, because a missing source is exactly what the Sources view exists to surface.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. DRILL-DOWN RECORDS
--
-- p_metric names the metric the number came from, and its predicate is applied to the
-- same filtered set the number was computed over. That is what makes a KPI and its
-- drawer agree by construction rather than by care.
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
    select * from public.reporting_filtered_quotes(f)
    where not v_cohort or (created_at >= v_from and created_at < v_to)
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
      when 'sold'            then q.final_outcome = 'sold'
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'not_sold'        then q.final_outcome = 'not_sold'
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'finalized'       then q.final_outcome is not null
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      -- Needs Attention keys (Requirement 11.5).
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
      when 'finalized_without_pricing' then q.finalized_without_pricing
                                  and q.finalized_at >= v_from and q.finalized_at < v_to
      when 'attribution_conflict' then q.attribution_conflict
      when 'manual_quotes'   then q.is_manual_quote
                                  and q.created_at >= v_from and q.created_at < v_to
      -- After-hours keys (Requirement 8.8).
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
    case when p_sort = 'created_at_asc'  then m.created_at end asc nulls last,
    case when p_sort = 'finalized_at_desc' then m.finalized_at end desc nulls last,
    case when p_sort = 'pricing_at_desc' then m.first_pricing_sent_at end desc nulls last,
    case when p_sort = 'customer_asc'    then m.customer_name end asc nulls last,
    m.created_at desc
  limit v_limit offset v_offset;
end;
$$;

comment on function public.report_records(jsonb, text, integer, integer, text) is
  'A page of the records behind one metric, plus total_count on every row. p_metric applies that metric''s own predicate to the same filtered set the number was computed over, so a KPI and its drawer cannot disagree (Requirement 10.1). Also accepts the Needs Attention and after-hours drill-down keys. p_limit is clamped to 500 so no caller can ask for the whole history.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. NEEDS ATTENTION
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
  with q as (select * from public.reporting_filtered_quotes(f)),
  w as (select * from public.reporting_filtered_workloads(f)
         where created_at >= v_from and created_at < v_to)
  select * from (
    select 'pending_overdue'::text, 'Pending Pricing overdue'::text,
           count(*) filter (where q.first_pricing_sent_at is not null
                             and q.final_outcome is null
                             and q.first_pricing_sent_at < v_to - interval '3 days')::bigint,
           'high'::text
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
  ) rows(condition_key, label, record_count, severity)
  order by case severity when 'high' then 1 when 'medium' then 2 else 3 end, label;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. AFTER-HOURS SUMMARY — the ten measures of Requirement 8.8
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_after_hours_summary(p_filters jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  f      jsonb;
  v_from timestamptz;
  v_to   timestamptz;
  v_row  record;
begin
  if not public.reporting_can_read() then
    return jsonb_build_object('authorized', false);
  end if;

  f := public.report_normalize_filters(p_filters);
  v_from := public.reporting_day_start((f ->> 'start_date')::date);
  v_to   := public.reporting_day_start(((f ->> 'end_date')::date) + 1);

  select
    count(*) filter (where q.received_after_hours
                      and q.created_at >= v_from and q.created_at < v_to) as received,
    count(*) filter (where q.worked_after_hours)                          as worked,
    count(*) filter (where q.finalized_after_hours
                      and q.finalized_at >= v_from and q.finalized_at < v_to) as finalized,
    count(*) filter (where q.manual_entry_after_hours
                      and q.created_at >= v_from and q.created_at < v_to) as manual_quotes,
    count(*) filter (where q.received_after_hours and q.final_outcome = 'sold')  as ah_sold,
    count(*) filter (where q.received_after_hours and q.final_outcome is not null) as ah_finalized,
    percentile_cont(0.5) within group (
      order by extract(epoch from (q.first_work_event_at - q.created_at)) / 60.0
    ) filter (where q.received_after_hours and q.first_work_event_at is not null)
                                                                          as median_wait_minutes,
    -- A quote received after hours whose first action fell on a later business day.
    count(*) filter (where q.received_after_hours
                      and q.first_work_event_at is not null
                      and (q.first_work_event_at at time zone public.reporting_timezone())::date
                          > (q.created_at at time zone public.reporting_timezone())::date)
                                                                          as waited_next_day
  into v_row
  from public.reporting_filtered_quotes(f) q;

  return jsonb_build_object(
    'authorized', true,
    'quotes_received_after_hours', v_row.received,
    'quotes_worked_after_hours', v_row.worked,
    'quotes_finalized_after_hours', v_row.finalized,
    'manual_quotes_after_hours', v_row.manual_quotes,
    'manual_workloads_after_hours', (
      select count(*) from public.reporting_filtered_workloads(f) w
      where w.manual_entry_after_hours and w.created_at >= v_from and w.created_at < v_to
    ),
    'after_hours_conversion_rate',
      case when v_row.ah_finalized = 0 then null
           else round((v_row.ah_sold::numeric / v_row.ah_finalized) * 100, 1) end,
    'median_wait_to_first_action_minutes',
      case when v_row.median_wait_minutes is null then null
           else round(v_row.median_wait_minutes::numeric, 1) end,
    'quotes_waiting_until_next_business_day', v_row.waited_next_day,
    'sources', (
      select coalesce(jsonb_agg(jsonb_build_object('source_name', s.name, 'quotes', s.n)
                                order by s.n desc), '[]'::jsonb)
      from (
        select coalesce(q.dealer_name, 'No source recorded') as name, count(*) as n
        from public.reporting_filtered_quotes(f) q
        where q.received_after_hours and q.created_at >= v_from and q.created_at < v_to
        group by coalesce(q.dealer_name, 'No source recorded')
      ) s
    ),
    'agents', (
      select coalesce(jsonb_agg(jsonb_build_object('agent_name', a.name, 'quotes', a.n)
                                order by a.n desc), '[]'::jsonb)
      from (
        select coalesce(p.display_name, 'Unknown') as name, count(*) as n
        from public.reporting_filtered_quotes(f) q
        left join public.profiles p on p.id = q.assigned_profile_id
        where q.worked_after_hours
        group by coalesce(p.display_name, 'Unknown')
      ) a
    )
  );
end;
$$;

comment on function public.report_after_hours_summary(jsonb) is
  'The ten after-hours measures of Requirement 8.8. quotes_worked_after_hours is deliberately not derived from quotes_received_after_hours: a quote that arrived at 22:00 and was worked at 09:30 the next morning counts in the first and not the second, which is the distinction the current After Hours report loses by filtering on creation only.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. RECONCILIATION — new metric against the legacy metric, same window
--
-- The legacy side is computed the way the browser computes it today, defects included:
-- Total Quotes counts a quote once per lifecycle table it appears in during the
-- window, and Pending Pricing ignores the date range entirely. Reproducing the defect
-- is the point. A difference that the new definitions intend is then distinguishable
-- from a difference that is a bug in the new query.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.report_reconciliation(p_start date, p_end date)
returns table (metric text, new_value numeric, legacy_value numeric, difference numeric, note text)
language plpgsql stable security definer set search_path = public
as $$
declare
  v_from   timestamptz := public.reporting_day_start(p_start);
  v_to     timestamptz := public.reporting_day_start(p_end + 1);
  f        jsonb;
begin
  if not public.can_manage_sales() then
    return;
  end if;

  f := public.report_normalize_filters(jsonb_build_object(
    'mode', 'activity',
    'start_date', to_char(p_start, 'YYYY-MM-DD'),
    'end_date', to_char(p_end, 'YYYY-MM-DD')
  ));

  return query
  with new_side as (select public.reporting_summary_for_window(f, p_start, p_end) as v),
  legacy as (
    select
      -- Legacy Total Quotes: the three-way union filtered on two different
      -- timestamps, counting a quote once per table it appears in.
      (select count(*) from public.work_items w
        where w.work_type in ('new_quote','requote')
          and w.created_at >= v_from and w.created_at < v_to)
      + (select count(*) from public.pending_pricing_quotes p
          where p.quote_created_at >= v_from and p.quote_created_at < v_to)
      + (select count(*) from public.quote_outcomes o
          where o.finalized_at >= v_from and o.finalized_at < v_to)  as total_quotes,
      (select count(*) from public.quote_outcomes o
        where lower(o.decision::text) = 'sold'
          and o.finalized_at >= v_from and o.finalized_at < v_to)    as sold,
      (select count(*) from public.quote_outcomes o
        where lower(o.decision::text) = 'not_sold'
          and o.finalized_at >= v_from and o.finalized_at < v_to)    as not_sold,
      -- Legacy Pending Pricing: every pending row, no date filter at all.
      (select count(*) from public.pending_pricing_quotes)           as pending
  )
  select 'Quotes Received',
         (n.v ->> 'quotes_received')::numeric, l.total_quotes::numeric,
         (n.v ->> 'quotes_received')::numeric - l.total_quotes,
         'Legacy counts a quote once per lifecycle table it appears in, on two different timestamps. New counts one per quote identity and excludes voided and duplicate records.'
    from new_side n, legacy l
  union all
  select 'Sold', (n.v ->> 'sold')::numeric, l.sold::numeric,
         (n.v ->> 'sold')::numeric - l.sold,
         'Both count by finalization date. A difference means a voided or duplicate record, or a quote holding more than one outcome row.'
    from new_side n, legacy l
  union all
  select 'Not Sold', (n.v ->> 'not_sold')::numeric, l.not_sold::numeric,
         (n.v ->> 'not_sold')::numeric - l.not_sold, 'As Sold.'
    from new_side n, legacy l
  union all
  select 'Pending Pricing', (n.v ->> 'pending_pricing')::numeric, l.pending::numeric,
         (n.v ->> 'pending_pricing')::numeric - l.pending,
         'Legacy ignores the date range entirely and counts every pending row in the database. New is an as-of-date count at the end of the selected period.'
    from new_side n, legacy l
  union all
  select 'Deleted quotes in period', null::numeric,
         (select count(*) from public.audit_log a
           where a.action = 'quote_deleted'
             and a.created_at >= v_from and a.created_at < v_to)::numeric,
         null::numeric,
         'Not a metric. manager_delete_quote hard-deletes from every quote table, so a deletion after a period ended shrinks that period''s totals. This count is how such a difference is explained.';
end;
$$;

comment on function public.report_reconciliation(date, date) is
  'New metric against legacy metric over the same window. The legacy side reproduces the current browser arithmetic including its defects, because a difference the new definitions intend must be distinguishable from a bug in the new query. Manager_Role only: this is a comparison of the agency''s own reporting, not an operational report.';

commit;
