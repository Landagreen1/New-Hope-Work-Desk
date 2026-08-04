-- Verification of the reporting RPCs under a simulated session.
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Run with: node scripts/run-sql.mjs supabase/verification/v1.12-reporting-rpc-checks.sql
--
-- The Management API connects with no JWT, so auth.uid() is null and every reporting
-- function correctly refuses. That refusal is the behaviour Requirement 19.6 asks
-- for, but it also means the authorized paths cannot be checked without standing in
-- for a caller. request.jwt.claims is what auth.uid() reads, so setting it is how a
-- session is simulated.
--
-- Read-only apart from the session-local setting.

-- Stand in for a manager: osmarym.
select set_config(
  'request.jwt.claims',
  '{"sub":"5608dfc2-e63c-4f0d-beb4-12b41458aa50","role":"authenticated"}',
  false
) as simulated_session;

select
  public.can_manage_sales()      as can_manage_sales,
  public.reporting_can_read()    as can_read,
  public.reporting_self_scope()  as self_scope_should_be_null;

-- 1. Activity summary over the whole history must equal the fact counts.
with s as (
  select public.report_summary(
    $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
  ) as v
)
select
  'summary: received' as check_name,
  (s.v -> 'current' ->> 'quotes_received') as actual,
  (select count(*)::text from public.reporting_quote_facts where not is_excluded) as expected
from s
union all
select 'summary: sold',
       (s.v -> 'current' ->> 'sold'),
       (select count(*)::text from public.reporting_quote_facts
         where final_outcome = 'sold' and not is_excluded)
from s
union all
select 'summary: not sold',
       (s.v -> 'current' ->> 'not_sold'),
       (select count(*)::text from public.reporting_quote_facts
         where final_outcome = 'not_sold' and not is_excluded)
from s
union all
select 'summary: finalized equals sold plus not sold',
       (s.v -> 'current' ->> 'finalized'),
       ((s.v -> 'current' ->> 'sold')::int + (s.v -> 'current' ->> 'not_sold')::int)::text
from s
union all
select 'summary: pricing sent',
       (s.v -> 'current' ->> 'pricing_sent'),
       (select count(*)::text from public.reporting_quote_facts
         where first_pricing_sent_at is not null and not is_excluded)
from s
union all
select 'summary: authorized',
       (s.v ->> 'authorized'), 'true'
from s
union all
-- 2. The cohort funnel invariant.
select 'cohort: states sum to received',
       (public.report_lifecycle(
          $${"mode":"cohort","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
        ) ->> 'states_sum_to_received'),
       'true'
union all
select 'cohort: received equals all quotes',
       (public.report_lifecycle(
          $${"mode":"cohort","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
        ) ->> 'received'),
       (select count(*)::text from public.reporting_quote_facts where not is_excluded)
union all
-- 3. Cohort mode must never report more sold than the activity mode over the same
--    full window: a cohort sale is an activity sale whose quote was also created in
--    the window, and here the window covers everything.
select 'cohort sold equals activity sold over all time',
       (public.report_lifecycle(
          $${"mode":"cohort","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
        ) ->> 'sold'),
       (public.report_summary(
          $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
        ) -> 'current' ->> 'sold')
union all
-- 4. Filter options resolve.
select 'filter options: authorized',
       (public.report_filter_options() ->> 'authorized'), 'true'
union all
select 'filter options: dealers present',
       (jsonb_array_length(public.report_filter_options() -> 'dealers') > 0)::text, 'true'
union all
select 'filter options: salespeople carry a dealer',
       (public.report_filter_options() -> 'salespeople' -> 0 ? 'dealer_id')::text, 'true'
union all
-- 5. A dimension filter must reduce, never increase.
select 'filter: one dealer is a subset of all dealers',
       ((public.report_summary(
           ('{"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31","dealer_ids":["'
            || (select id::text from public.dealers order by name limit 1) || '"]}')::jsonb
         ) -> 'current' ->> 'quotes_received')::int
        <= (public.report_summary(
           $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
         ) -> 'current' ->> 'quotes_received')::int)::text,
       'true'
union all
-- 6. After-hours segment plus business-hours segment must partition the whole set.
select 'hours segments partition the quote set',
       ((public.report_summary(
           $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31","hours_segment":"business"}$$::jsonb
         ) -> 'current' ->> 'quotes_received')::int
        + (public.report_summary(
           $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31","hours_segment":"after"}$$::jsonb
         ) -> 'current' ->> 'quotes_received')::int)::text,
       (public.report_summary(
          $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
        ) -> 'current' ->> 'quotes_received')
order by 1;
