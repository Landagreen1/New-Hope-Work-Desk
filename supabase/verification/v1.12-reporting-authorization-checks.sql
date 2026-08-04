-- Authorization checks for the reporting layer.
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 19.1, 19.2, 19.3, 19.6
-- Run with: node scripts/run-sql.mjs supabase/verification/v1.12-reporting-authorization-checks.sql
--
-- Three callers are stood in for: no session at all, a sales supervisor, and an ordinary
-- agent. request.jwt.claims is what auth.uid() reads, so setting it is how a session is
-- simulated.
--
-- Results are collected into a temporary table because the Management API returns only
-- the last statement's result, and the session has to change between the checks.
--
-- Read-only apart from the session-local setting and the temp table.

create temporary table if not exists reporting_auth_checks (
  seq serial, check_name text, actual text, expected text
) on commit preserve rows;

truncate reporting_auth_checks;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. No session. Requirement 19.6: zero rows, not an error.
-- ═══════════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims', '', false);

insert into reporting_auth_checks (check_name, actual, expected)
select 'no session: cannot read', public.reporting_can_read()::text, 'false'
union all
select 'no session: summary refuses',
       coalesce(public.report_summary('{}'::jsonb) ->> 'authorized', 'missing'), 'false'
union all
select 'no session: lifecycle refuses',
       coalesce(public.report_lifecycle('{}'::jsonb) ->> 'authorized', 'missing'), 'false'
union all
select 'no session: agent rows returns zero rows',
       (select count(*)::text from public.report_agent_rows('{}'::jsonb)), '0'
union all
select 'no session: source rows returns zero rows',
       (select count(*)::text from public.report_source_rows('{}'::jsonb)), '0'
union all
select 'no session: records returns zero rows',
       (select count(*)::text from public.report_records(
          '{}'::jsonb, 'quotes_received', 50, 0, 'created_at_desc')), '0'
union all
select 'no session: filtered quotes returns zero rows',
       (select count(*)::text from public.reporting_filtered_quotes('{}'::jsonb)), '0'
union all
select 'no session: review is refused',
       coalesce(public.report_integrity_review(
          (select id from public.reporting_integrity_flags order by id limit 1),
          'Dismissed', null) ->> 'success', 'missing'), 'false'
union all
select 'no session: detection does nothing',
       public.reporting_detect_integrity_flags()::text, '0';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. A sales supervisor. Byron confirmed on 2026-08-03 that supervisors may review.
-- ═══════════════════════════════════════════════════════════════════════════════
select set_config('request.jwt.claims',
  '{"sub":"540258c2-6da5-42b6-86b4-a05219eb52f5","role":"authenticated"}', false);

insert into reporting_auth_checks (check_name, actual, expected)
select 'supervisor: can manage sales', public.can_manage_sales()::text, 'true'
union all
select 'supervisor: no self scope, sees everything',
       coalesce(public.reporting_self_scope()::text, 'null'), 'null'
union all
select 'supervisor: summary is authorized',
       (public.report_summary('{}'::jsonb) ->> 'authorized'), 'true'
union all
-- Requirement 15.6: Explained requires a non-empty explanation.
select 'supervisor: Explained with blank text is refused',
       (public.report_integrity_review(
          (select id from public.reporting_integrity_flags where review_status = 'Open'
            order by id limit 1),
          'Explained', '   ') ->> 'success'), 'false'
union all
select 'supervisor: an invalid action is refused',
       (public.report_integrity_review(
          (select id from public.reporting_integrity_flags order by id limit 1),
          'Approved', 'text') ->> 'success'), 'false';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. An ordinary agent: a Self_Scoped_Reader. Requirement 19.3.
-- ═══════════════════════════════════════════════════════════════════════════════
-- The busiest agent, not the alphabetically first. The first active agent is a recent
-- hire with zero assigned quotes, and standing in for them would make the self-scope
-- check pass for the wrong reason: seeing nothing because there is nothing to see, rather
-- than because the scope is applied.
select set_config('request.jwt.claims',
  (select '{"sub":"' || p.id::text || '","role":"authenticated"}'
     from public.profiles p
    where p.role = 'agent' and p.is_active
    order by (select count(*) from public.reporting_quote_facts q
               where q.assigned_profile_id = p.id) desc,
             p.display_name
    limit 1),
  false);

insert into reporting_auth_checks (check_name, actual, expected)
select 'agent: can read', public.reporting_can_read()::text, 'true'
union all
select 'agent: cannot manage sales', public.can_manage_sales()::text, 'false'
union all
select 'agent: self scope is their own profile',
       (public.reporting_self_scope() = auth.uid())::text, 'true'
union all
select 'agent: sees fewer quotes than the whole agency',
       ((select count(*) from public.reporting_filtered_quotes('{}'::jsonb))
        < (select count(*) from public.reporting_quote_facts where not is_excluded))::text,
       'true'
union all
select 'agent: sees more than zero of their own quotes',
       ((select count(*) from public.reporting_filtered_quotes('{}'::jsonb)) > 0)::text,
       'true'
union all
select 'agent: review is refused', 
       (public.report_integrity_review(
          (select id from public.reporting_integrity_flags order by id limit 1),
          'Dismissed', null) ->> 'success'), 'false'
union all
select 'agent: manager explanation is hidden',
       (select coalesce(count(*) filter (where manager_explanation is not null), 0)::text
          from public.report_integrity_flags('{}'::jsonb, 'All Open Flags', 50, 0)), '0';

select set_config('request.jwt.claims', '', false);

select
  check_name,
  actual,
  expected,
  case when actual = expected then 'PASS' else 'FAIL' end as verdict
from reporting_auth_checks
order by case when actual = expected then 2 else 1 end, seq;
