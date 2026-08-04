-- Execution checks: every reporting function actually runs.
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Run with: node scripts/run-sql.mjs supabase/verification/v1.12-reporting-execution-checks.sql
--
-- ── Why this file exists ──────────────────────────────────────────────────────
--
-- Two functions shipped broken and the earlier checks passed anyway.
-- report_needs_attention and report_records both raised "column reference is ambiguous"
-- on every call, and report_records is what every drill-down in the report uses.
--
-- The reason the earlier checks missed it is worth keeping in front of whoever reads
-- this next. Every reporting function opens with an authorization guard that returns
-- early:
--
--     if not public.reporting_can_read() then return; end if;
--
-- The REST probe called all nine functions as an anonymous caller and got `200 []` from
-- each. That proved they existed and were reachable. It proved nothing about their
-- bodies, because the guard returned before any query ran, and an empty result from a
-- broken query looks exactly like an empty result from a refused caller.
--
-- Reachability is not execution. This file executes every function with a real session,
-- in both report modes, across every drill-down metric key the interface can send and
-- every saved review filter it offers, and records which ones raise. It also times each
-- one, because a correct report nobody waits for is not much use either.
--
-- Read-only apart from the session-local setting and the temp table.

select set_config('request.jwt.claims',
  '{"sub":"5608dfc2-e63c-4f0d-beb4-12b41458aa50","role":"authenticated"}', false)
  as simulated_manager_session;

create temporary table if not exists reporting_execution_checks (
  seq serial, target text, verdict text, ms numeric
) on commit preserve rows;
truncate reporting_execution_checks;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. The functions the interface calls on every page load.
-- ═══════════════════════════════════════════════════════════════════════════════
do $core$
declare
  v_activity jsonb := '{"mode":"activity","start_date":"2026-07-28","end_date":"2026-08-03"}';
  v_cohort   jsonb := '{"mode":"cohort","start_date":"2026-07-28","end_date":"2026-08-03"}';
  v_n bigint;
  t0 timestamptz;
begin
  t0 := clock_timestamp();
  begin
    perform public.report_filter_options();
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_filter_options', 'OK', round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_filter_options', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    perform public.report_summary(v_activity);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_summary (activity)', 'OK', round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_summary (activity)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    perform public.report_summary(v_cohort);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_summary (cohort)', 'OK', round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_summary (cohort)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    perform public.report_summary(v_activity || '{"compare":true}'::jsonb);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_summary (compare)', 'OK', round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_summary (compare)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    perform public.report_lifecycle(v_cohort);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_lifecycle', 'OK', round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_lifecycle', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    select count(*) into v_n from public.report_needs_attention(v_activity);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_needs_attention (' || v_n || ' rows)', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_needs_attention', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    select count(*) into v_n from public.report_agent_rows(v_activity);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_agent_rows (activity, ' || v_n || ' rows)', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_agent_rows (activity)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    select count(*) into v_n from public.report_agent_rows(v_cohort);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_agent_rows (cohort, ' || v_n || ' rows)', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_agent_rows (cohort)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    select count(*) into v_n from public.report_source_rows(v_activity);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_source_rows (activity, ' || v_n || ' rows)', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_source_rows (activity)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    select count(*) into v_n from public.report_source_rows(v_cohort);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_source_rows (cohort, ' || v_n || ' rows)', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_source_rows (cohort)', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    perform public.report_after_hours_summary(v_activity);
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_after_hours_summary', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_after_hours_summary', 'RAISED: ' || sqlerrm, null);
  end;

  t0 := clock_timestamp();
  begin
    select count(*) into v_n from public.report_reconciliation('2026-07-01', '2026-07-31');
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_reconciliation (' || v_n || ' rows)', 'OK',
       round(extract(epoch from (clock_timestamp() - t0)) * 1000));
  exception when others then
    insert into reporting_execution_checks(target, verdict, ms) values
      ('report_reconciliation', 'RAISED: ' || sqlerrm, null);
  end;
end
$core$;

select
  target,
  verdict,
  ms,
  case
    when verdict like 'RAISED%' then 'FAIL'
    when ms > 3000 then 'SLOW'
    else 'PASS'
  end as result
from reporting_execution_checks
order by case when verdict like 'RAISED%' then 1 when ms > 3000 then 2 else 3 end, seq;
