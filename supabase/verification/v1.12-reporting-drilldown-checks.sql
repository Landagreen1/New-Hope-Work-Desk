-- Drill-down checks: every metric key the interface can open, and every saved filter.
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 10.1, 15.1
-- Run with: node scripts/run-sql.mjs supabase/verification/v1.12-reporting-drilldown-checks.sql
--
-- Requirement 10.1 says every KPI, table number and integrity count opens the exact
-- underlying records. That promise is only as good as report_records accepting every key
-- the interface sends, so every key is exercised here.
--
-- It matters because report_records shipped raising "column reference \"created_at\" is
-- ambiguous" on all of them: not one number in the report could be opened, and nothing in
-- the earlier verification noticed, because an anonymous probe returns before the query
-- runs.
--
-- Split from the execution checks so neither file exceeds the API gateway timeout.

select set_config('request.jwt.claims',
  '{"sub":"5608dfc2-e63c-4f0d-beb4-12b41458aa50","role":"authenticated"}', false)
  as simulated_manager_session;

create temporary table if not exists reporting_drilldown_checks (
  seq serial, target text, verdict text
) on commit preserve rows;
truncate reporting_drilldown_checks;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Every metric key the KPI ribbon, the lifecycle, Needs Attention, the after-hours
-- summary and the agent and source tables can open.
-- ═══════════════════════════════════════════════════════════════════════════════
do $records$
declare
  m text;
  v_n bigint;
  v_filters jsonb := '{"mode":"activity","start_date":"2026-07-28","end_date":"2026-08-03"}';
begin
  foreach m in array array[
    -- KPI ribbon and lifecycle
    'quotes_received', 'pricing_sent', 'pending_pricing', 'awaiting_customer_decision',
    'sold', 'not_sold', 'finalized',
    -- Needs Attention
    'pending_overdue', 'awaiting_follow_up', 'missing_source', 'missing_salesperson',
    'missing_not_sold_reason', 'manual_needs_review', 'attribution_conflict',
    'finalized_without_pricing',
    -- Overview manual and after-hours cards
    'manual_quotes', 'received_after_hours', 'worked_after_hours',
    'finalized_after_hours', 'manual_entry_after_hours',
    -- Fallback
    'all'
  ] loop
    begin
      select count(*) into v_n
        from public.report_records(v_filters, m, 25, 0, 'created_at_desc');
      insert into reporting_drilldown_checks(target, verdict)
        values ('metric: ' || m, 'OK, ' || v_n || ' rows on page 1');
    exception when others then
      insert into reporting_drilldown_checks(target, verdict)
        values ('metric: ' || m, 'RAISED: ' || sqlerrm);
    end;
  end loop;
end
$records$;

-- Every sort order the drawer and the tables can request.
do $sorts$
declare
  s text;
  v_n bigint;
  v_filters jsonb := '{"mode":"activity","start_date":"2026-07-28","end_date":"2026-08-03"}';
begin
  foreach s in array array[
    'created_at_desc', 'created_at_asc', 'finalized_at_desc', 'pricing_at_desc',
    'customer_asc'
  ] loop
    begin
      select count(*) into v_n
        from public.report_records(v_filters, 'quotes_received', 25, 0, s);
      insert into reporting_drilldown_checks(target, verdict)
        values ('sort: ' || s, 'OK, ' || v_n || ' rows');
    exception when others then
      insert into reporting_drilldown_checks(target, verdict)
        values ('sort: ' || s, 'RAISED: ' || sqlerrm);
    end;
  end loop;
end
$sorts$;

-- All fourteen saved review filters.
do $flags$
declare
  fl text;
  v_n bigint;
begin
  foreach fl in array array[
    'All Open Flags', 'High Priority', 'Manual Quote Review', 'Manual Workload Review',
    'Queue Mismatch', 'Missing Documentation', 'Attribution Conflict',
    'Duplicate Activity', 'Timing Conflict', 'Finalized Without Pricing',
    'Not Sold Without Reason', 'Explained', 'Confirmed Data Issue', 'Dismissed'
  ] loop
    begin
      select count(*) into v_n
        from public.report_integrity_flags('{}'::jsonb, fl, 25, 0);
      insert into reporting_drilldown_checks(target, verdict)
        values ('saved filter: ' || fl, 'OK, ' || v_n || ' rows');
    exception when others then
      insert into reporting_drilldown_checks(target, verdict)
        values ('saved filter: ' || fl, 'RAISED: ' || sqlerrm);
    end;
  end loop;
end
$flags$;

select
  target,
  verdict,
  case when verdict like 'RAISED%' then 'FAIL' else 'PASS' end as result
from reporting_drilldown_checks
order by case when verdict like 'RAISED%' then 1 else 2 end, seq;
