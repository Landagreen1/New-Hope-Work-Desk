-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.16.4 — Specialty Quotes: reporting
--
-- Spec: sections 71-77.
-- Requires v1.16.3.
--
-- WHAT THIS CHANGES
--   Seven read-only aggregate functions. All of them are scoped the same way the
--   operational list is — `specialty_can_view_opportunity` per row — so a
--   Homeowners-only member's reports contain no trucking figures and a manager's
--   contain everything. None of them is a new source of truth: each aggregates the
--   same opportunity, carrier-market and activity rows the screens read.
--
--   Contribution is counted from recorded activity, never inferred from who is
--   assigned (spec sections 12, 73). Timing uses server timestamps only (74).
--   A carrier metric is emitted only where the underlying data exists — an average
--   response time is null rather than zero when nothing has been submitted (75).
--
-- WHAT THIS DELIBERATELY DOES NOT CHANGE
--   No commercial report, view or route.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

set local lock_timeout = '5s';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. PIPELINE  (spec section 71)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_pipeline(
  p_from date default null,
  p_to date default null,
  p_line_of_business text default 'all'
)
returns table (
  line_of_business text,
  stage text,
  stage_label text,
  stage_position integer,
  opportunity_count bigint,
  overdue_count bigint,
  stale_count bigint,
  unclaimed_count bigint,
  avg_age_days numeric,
  sold_premium_total numeric
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  select
    r.line_of_business,
    r.stage,
    max(r.stage_label)                                     as stage_label,
    max(r.stage_position)                                  as stage_position,
    count(*)::bigint                                       as opportunity_count,
    count(*) filter (where r.is_overdue)::bigint            as overdue_count,
    count(*) filter (where r.is_stale)::bigint              as stale_count,
    count(*) filter (where r.is_unclaimed)::bigint          as unclaimed_count,
    round(avg(extract(epoch from (
      coalesce(r.finalized_at, now()) - r.created_at)) / 86400.0)::numeric, 1) as avg_age_days,
    sum(coalesce(r.sold_premium, 0))                       as sold_premium_total
  from public.specialty_opportunity_rows r
  where public.specialty_can_view_opportunity(r.id)
    and (v_lob = 'all' or r.line_of_business = v_lob)
    and (p_from is null or r.created_at >= p_from::timestamptz)
    and (p_to is null or r.created_at < (p_to + 1)::timestamptz)
  group by r.line_of_business, r.stage;
end;
$fn$;

revoke execute on function public.specialty_report_pipeline(date, date, text) from public, anon;
grant execute on function public.specialty_report_pipeline(date, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. EMPLOYEE WORKLOAD  (spec section 72)
--
--    Primary assignments and their state. This is workload, which is a different
--    question from contribution below, and the two are reported separately on
--    purpose: assignment is accountability, not a record of who did the work.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_workload(
  p_line_of_business text default 'all'
)
returns table (
  profile_id uuid,
  display_name text,
  initials text,
  active_count bigint,
  information_needed_count bigint,
  marketing_count bigint,
  options_ready_count bigint,
  price_sent_count bigint,
  follow_up_count bigint,
  due_today_count bigint,
  overdue_count bigint,
  stale_count bigint,
  sold_count bigint,
  not_sold_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  with visible as (
    select r.*
    from public.specialty_opportunity_rows r
    where public.specialty_can_view_opportunity(r.id)
      and (v_lob = 'all' or r.line_of_business = v_lob)
  ),
  -- Every member of every team the reader can see, so an employee with no active
  -- work still appears with zeros rather than disappearing from the report.
  members as (
    select distinct p.id, p.display_name, p.initials
    from public.quoting_team_members m
    join public.profiles p on p.id = m.profile_id
    where m.is_active and p.is_active
      and (public.specialty_is_manager() or m.team_id in (
            select m2.team_id from public.quoting_team_members m2
            where m2.profile_id = auth.uid() and m2.is_active))
  )
  select
    mm.id, mm.display_name, mm.initials,
    count(v.id) filter (where v.result is null)::bigint,
    count(v.id) filter (where v.stage = 'information_needed')::bigint,
    count(v.id) filter (where v.stage = 'marketing')::bigint,
    count(v.id) filter (where v.stage = 'options_ready')::bigint,
    count(v.id) filter (where v.stage = 'price_sent')::bigint,
    count(v.id) filter (where v.stage = 'follow_up')::bigint,
    count(v.id) filter (where v.is_due_today)::bigint,
    count(v.id) filter (where v.is_overdue)::bigint,
    count(v.id) filter (where v.is_stale)::bigint,
    count(v.id) filter (where v.result = 'sold')::bigint,
    count(v.id) filter (where v.result = 'not_sold')::bigint
  from members mm
  left join visible v on v.primary_assignee_id = mm.id
  group by mm.id, mm.display_name, mm.initials
  order by count(v.id) filter (where v.result is null) desc, mm.display_name;
end;
$fn$;

revoke execute on function public.specialty_report_workload(text) from public, anon;
grant execute on function public.specialty_report_workload(text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CONTRIBUTION  (spec sections 12, 73)
--
--    Counted from public.specialty_activity, so Oscar's Canal submission on Jason's
--    quote is Oscar's. `primary_count` and `contributed_count` are separate columns
--    because they answer different questions and neither is a substitute.
--
--    Deliberately not framed as a productivity score: the counts are raw and
--    unweighted, which is what makes them useful as operational visibility.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_contributions(
  p_from date default null,
  p_to date default null,
  p_line_of_business text default 'all'
)
returns table (
  profile_id uuid,
  display_name text,
  initials text,
  primary_count bigint,
  contributed_count bigint,
  carrier_submissions bigint,
  carrier_quotes_recorded bigint,
  price_sent_actions bigint,
  notes_added bigint,
  information_requests bigint,
  results_recorded bigint,
  total_actions bigint,
  last_action_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  with visible as (
    select o.id, o.line_of_business, o.primary_assignee_id
    from public.specialty_opportunities o
    where public.specialty_can_view_opportunity(o.id)
      and (v_lob = 'all' or o.line_of_business = v_lob)
  ),
  acted as (
    select a.actor_profile_id as profile_id, a.opportunity_id, a.event_type, a.created_at
    from public.specialty_activity a
    join visible v on v.id = a.opportunity_id
    where a.actor_profile_id is not null
      and (p_from is null or a.created_at >= p_from::timestamptz)
      and (p_to is null or a.created_at < (p_to + 1)::timestamptz)
  ),
  people as (
    select distinct profile_id from acted
    union
    select distinct primary_assignee_id from visible where primary_assignee_id is not null
  )
  select
    pp.profile_id,
    pr.display_name,
    pr.initials,
    (select count(*) from visible v where v.primary_assignee_id = pp.profile_id)::bigint,
    (select count(distinct a.opportunity_id) from acted a where a.profile_id = pp.profile_id)::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id
       and a.event_type = 'carrier_submitted')::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id
       and a.event_type = 'carrier_quote_received')::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id
       and a.event_type = 'price_sent')::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id
       and a.event_type = 'note_added')::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id
       and a.event_type in ('information_requested', 'information_received', 'information_waived'))::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id
       and a.event_type = 'result_recorded')::bigint,
    (select count(*) from acted a where a.profile_id = pp.profile_id)::bigint,
    (select max(a.created_at) from acted a where a.profile_id = pp.profile_id)
  from people pp
  join public.profiles pr on pr.id = pp.profile_id
  order by (select count(*) from acted a where a.profile_id = pp.profile_id) desc, pr.display_name;
end;
$fn$;

revoke execute on function public.specialty_report_contributions(date, date, text) from public, anon;
grant execute on function public.specialty_report_contributions(date, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. PIPELINE TIMING  (spec section 74)
--
--    Every interval is between two server-stamped columns. A null stamp produces a
--    null interval and is excluded from the average rather than counted as zero.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_timing(
  p_from date default null,
  p_to date default null,
  p_line_of_business text default 'all'
)
returns table (
  line_of_business text,
  measured_count bigint,
  avg_submitted_to_claimed_hours numeric,
  avg_claimed_to_ready_hours numeric,
  avg_ready_to_first_submission_hours numeric,
  avg_first_submission_to_first_quote_hours numeric,
  avg_first_quote_to_price_sent_hours numeric,
  avg_price_sent_to_decision_hours numeric,
  avg_intake_to_decision_days numeric
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  with visible as (
    select o.*, s.submitted_at as intake_submitted_at
    from public.specialty_opportunities o
    left join public.cs_intake_submissions s on s.id = o.source_intake_id
    where public.specialty_can_view_opportunity(o.id)
      and (v_lob = 'all' or o.line_of_business = v_lob)
      and (p_from is null or o.created_at >= p_from::timestamptz)
      and (p_to is null or o.created_at < (p_to + 1)::timestamptz)
  )
  select
    v.line_of_business,
    count(*)::bigint,
    round(avg(extract(epoch from (v.claimed_at - coalesce(v.intake_submitted_at, v.created_at))) / 3600.0)::numeric, 1),
    round(avg(extract(epoch from (v.ready_to_market_at - v.claimed_at)) / 3600.0)::numeric, 1),
    round(avg(extract(epoch from (v.first_submission_at - v.ready_to_market_at)) / 3600.0)::numeric, 1),
    round(avg(extract(epoch from (v.first_quote_at - v.first_submission_at)) / 3600.0)::numeric, 1),
    round(avg(extract(epoch from (v.price_sent_at - v.first_quote_at)) / 3600.0)::numeric, 1),
    round(avg(extract(epoch from (v.finalized_at - v.price_sent_at)) / 3600.0)::numeric, 1),
    round(avg(extract(epoch from (v.finalized_at - coalesce(v.intake_submitted_at, v.created_at))) / 86400.0)::numeric, 1)
  from visible v
  group by v.line_of_business;
end;
$fn$;

revoke execute on function public.specialty_report_timing(date, date, text) from public, anon;
grant execute on function public.specialty_report_timing(date, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. CARRIER PERFORMANCE  (spec section 75)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_carrier_performance(
  p_from date default null,
  p_to date default null,
  p_line_of_business text default 'all'
)
returns table (
  carrier_id uuid,
  carrier_name text,
  submissions bigint,
  quotes_received bigint,
  declines bigint,
  more_info_requests bigint,
  not_competitive bigint,
  withdrawn bigint,
  still_waiting bigint,
  quote_rate numeric,
  avg_response_hours numeric,
  bound_count bigint,
  bind_rate numeric,
  avg_quoted_premium numeric,
  avg_sold_premium numeric
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  with visible_markets as (
    select m.*, o.line_of_business, o.bound_carrier_id, o.sold_premium, o.result
    from public.specialty_carrier_markets m
    join public.specialty_opportunities o on o.id = m.opportunity_id
    where public.specialty_can_view_opportunity(o.id)
      and (v_lob = 'all' or o.line_of_business = v_lob)
      and (p_from is null or m.created_at >= p_from::timestamptz)
      and (p_to is null or m.created_at < (p_to + 1)::timestamptz)
  )
  select
    c.id,
    c.name,
    count(*) filter (where vm.submitted_at is not null)::bigint            as submissions,
    count(*) filter (where vm.quote_received_at is not null)::bigint       as quotes_received,
    count(*) filter (where vm.status = 'declined')::bigint                 as declines,
    count(*) filter (where vm.info_requested is not null)::bigint          as more_info_requests,
    count(*) filter (where vm.status = 'not_competitive')::bigint          as not_competitive,
    count(*) filter (where vm.status = 'withdrawn')::bigint                as withdrawn,
    count(*) filter (where vm.status in ('submitted', 'waiting', 'more_info_needed'))::bigint as still_waiting,
    -- Rates are computed only where the denominator exists. Zero submissions gives
    -- null, not 0%, because "we have never tried them" is not "they never quote".
    case when count(*) filter (where vm.submitted_at is not null) > 0
      then round(100.0 * count(*) filter (where vm.quote_received_at is not null)
                 / count(*) filter (where vm.submitted_at is not null), 1)
    end                                                                    as quote_rate,
    case when count(*) filter (where vm.submitted_at is not null and vm.quote_received_at is not null) > 0
      then round(avg(extract(epoch from (vm.quote_received_at - vm.submitted_at)) / 3600.0)
                 filter (where vm.submitted_at is not null and vm.quote_received_at is not null)::numeric, 1)
    end                                                                    as avg_response_hours,
    count(*) filter (where vm.bound_carrier_id = c.id and vm.result = 'sold')::bigint as bound_count,
    case when count(*) filter (where vm.quote_received_at is not null) > 0
      then round(100.0 * count(*) filter (where vm.bound_carrier_id = c.id and vm.result = 'sold')
                 / count(*) filter (where vm.quote_received_at is not null), 1)
    end                                                                    as bind_rate,
    round(avg(vm.premium) filter (where vm.status = 'quote_received')::numeric, 2) as avg_quoted_premium,
    round(avg(vm.sold_premium) filter (where vm.bound_carrier_id = c.id
                                         and vm.result = 'sold')::numeric, 2)      as avg_sold_premium
  from visible_markets vm
  join public.specialty_carriers c on c.id = vm.carrier_id
  group by c.id, c.name
  order by count(*) filter (where vm.submitted_at is not null) desc, c.name;
end;
$fn$;

revoke execute on function public.specialty_report_carrier_performance(date, date, text) from public, anon;
grant execute on function public.specialty_report_carrier_performance(date, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. LOST BUSINESS  (spec section 76)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_lost_business(
  p_from date default null,
  p_to date default null,
  p_line_of_business text default 'all'
)
returns table (
  opportunity_id uuid,
  reference text,
  display_name text,
  line_of_business text,
  lost_reason text,
  lost_reason_note text,
  primary_assignee_id uuid,
  assignee_name text,
  recorded_by_name text,
  finalized_at timestamptz,
  markets_submitted bigint,
  markets_quoted bigint,
  best_premium numeric,
  carriers_offered text,
  intake_source text,
  days_to_decision numeric
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  select
    r.id, r.reference, r.display_name, r.line_of_business,
    r.lost_reason, r.lost_reason_note,
    r.primary_assignee_id, r.assignee_name,
    recorder.display_name,
    r.finalized_at,
    r.markets_submitted, r.markets_quoted, r.best_premium,
    (select string_agg(c.name || case when m.premium is not null
                                      then ' ($' || to_char(m.premium, 'FM999,999,990') || ')'
                                      else '' end, ', ' order by c.name)
       from public.specialty_carrier_markets m
       join public.specialty_carriers c on c.id = m.carrier_id
       where m.opportunity_id = r.id and m.status = 'quote_received'),
    coalesce(r.source, 'unknown'),
    round(extract(epoch from (r.finalized_at - r.created_at)) / 86400.0, 1)
  from public.specialty_opportunity_rows r
  left join public.specialty_opportunities o on o.id = r.id
  left join public.profiles recorder on recorder.id = o.result_recorded_by
  where public.specialty_can_view_opportunity(r.id)
    and r.result = 'not_sold'
    and (v_lob = 'all' or r.line_of_business = v_lob)
    and (p_from is null or r.finalized_at >= p_from::timestamptz)
    and (p_to is null or r.finalized_at < (p_to + 1)::timestamptz)
  order by r.finalized_at desc;
end;
$fn$;

revoke execute on function public.specialty_report_lost_business(date, date, text) from public, anon;
grant execute on function public.specialty_report_lost_business(date, date, text) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. AGING AND ATTENTION  (spec section 77)
--
--    The six things that go wrong, each with the rows behind it. One query so the
--    manager view does not fire six.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.specialty_report_attention(
  p_line_of_business text default 'all',
  p_limit_per_bucket integer default 25
)
returns table (
  bucket text,
  bucket_label text,
  opportunity_id uuid,
  reference text,
  display_name text,
  line_of_business text,
  stage text,
  stage_label text,
  assignee_name text,
  next_action text,
  next_action_due timestamptz,
  age_days numeric,
  detail text
)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_lob text := lower(coalesce(nullif(btrim(p_line_of_business), ''), 'all'));
  v_limit integer := least(greatest(coalesce(p_limit_per_bucket, 25), 1), 200);
begin
  if not public.specialty_can_view_reports() then
    raise exception 'Specialty reporting is not available for your account.' using errcode = '42501';
  end if;

  return query
  with visible as (
    select r.*
    from public.specialty_opportunity_rows r
    where public.specialty_can_view_opportunity(r.id)
      and (v_lob = 'all' or r.line_of_business = v_lob)
      and r.result is null
  ),
  flagged as (
    -- Unclaimed for more than four working-ish hours.
    select 'unclaimed'::text as bucket, 'Unclaimed too long'::text as bucket_label,
           v.*, 'Waiting ' || round(extract(epoch from (now() - v.created_at)) / 3600.0, 1) || 'h for someone to claim' as detail
    from visible v
    where v.is_unclaimed and v.created_at < now() - interval '4 hours'
    union all
    -- Information Needed with nothing having moved for three days.
    select 'information_stalled', 'Information Needed too long', v.*,
           coalesce(v.open_information_labels, 'No items listed')
    from visible v
    where v.stage = 'information_needed' and v.last_activity_at < now() - interval '3 days'
    union all
    -- A carrier has been sitting on a submission for a week.
    select 'carrier_waiting', 'Carrier waiting too long', v.*,
           v.markets_waiting || ' market(s) awaiting a carrier response'
    from visible v
    where v.markets_waiting > 0
      and exists (select 1 from public.specialty_carrier_markets m
                  where m.opportunity_id = v.id
                    and m.status in ('submitted', 'waiting')
                    and m.submitted_at < now() - interval '7 days')
    union all
    -- We have prices and the customer does not.
    select 'options_not_sent', 'Options ready but not sent', v.*,
           v.markets_quoted || ' quote(s) received, nothing sent to the customer yet'
    from visible v
    where v.markets_quoted > 0 and v.price_sent_at is null
    union all
    -- Priced, and the follow-up is late.
    select 'followup_overdue', 'Price sent with overdue follow-up', v.*,
           coalesce(v.next_action, 'No next action set')
    from visible v
    where v.price_sent_at is not null
      and (v.is_overdue or v.next_action_due is null)
    union all
    -- Nothing at all has happened for a week.
    select 'stale', 'No recent activity', v.*,
           'Last activity ' || round(extract(epoch from (now() - v.last_activity_at)) / 86400.0, 1) || ' days ago'
    from visible v
    where v.is_stale
  ),
  ranked as (
    select f.*, row_number() over (partition by f.bucket
             order by f.next_action_due asc nulls last, f.last_activity_at asc) as rn
    from flagged f
  )
  select
    rk.bucket, rk.bucket_label, rk.id, rk.reference, rk.display_name,
    rk.line_of_business, rk.stage, rk.stage_label, rk.assignee_name,
    rk.next_action, rk.next_action_due,
    round(extract(epoch from (now() - rk.created_at)) / 86400.0, 1),
    rk.detail
  from ranked rk
  where rk.rn <= v_limit
  order by rk.bucket, rk.rn;
end;
$fn$;

revoke execute on function public.specialty_report_attention(text, integer) from public, anon;
grant execute on function public.specialty_report_attention(text, integer) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════

do $post$
declare
  v_missing text;
begin
  select string_agg(f.name, ', ' order by f.name) into v_missing
    from (values ('specialty_report_pipeline'), ('specialty_report_workload'),
                 ('specialty_report_contributions'), ('specialty_report_timing'),
                 ('specialty_report_carrier_performance'),
                 ('specialty_report_lost_business'), ('specialty_report_attention')) as f(name)
   where not exists (
     select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = f.name and p.prosecdef);
  if v_missing is not null then
    raise exception 'v1.16.4 missing report function(s): %', v_missing using hint = 'Rolling back.';
  end if;

  -- Every report must be gated. A missing gate would expose another team's figures.
  select string_agg(p.proname, ', ') into v_missing
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname like 'specialty\_report\_%'
     and pg_get_functiondef(p.oid) not like '%specialty_can_view_reports()%';
  if v_missing is not null then
    raise exception 'v1.16.4 left ungated report function(s): %', v_missing using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

select count(*) as report_functions_expect_7
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'specialty\_report\_%';
