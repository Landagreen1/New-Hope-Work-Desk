-- Verification queries for the Sales Reporting Center data layer (v1.12.*).
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Run with: node scripts/run-sql.mjs supabase/verification/v1.12-reporting-checks.sql
--
-- Read-only apart from the session-local setting. Every check returns a verdict column
-- so a failure is visible without having to interpret the numbers.
--
-- The Management API connects with no JWT, so auth.uid() is null and the reporting
-- functions correctly refuse. That refusal is the behaviour Requirement 19.6 asks for,
-- and it also means the three checks that call a reporting function would report FAIL for
-- the right reason. request.jwt.claims is what auth.uid() reads, so a manager session is
-- stood in for here. Authorization itself is checked in
-- v1.12-reporting-rpc-checks.sql.
select set_config(
  'request.jwt.claims',
  '{"sub":"5608dfc2-e63c-4f0d-beb4-12b41458aa50","role":"authenticated"}',
  false
) as simulated_manager_session;

with

-- 1. Identity: exactly one fact row per quote, and the total matches the three
--    lifecycle tables added together.
identity as (
  select
    'identity: one fact row per quote' as check_name,
    (select count(*) from public.reporting_quote_facts)::text as actual,
    ((select count(*) from public.work_items where work_type in ('new_quote','requote'))
     + (select count(*) from public.pending_pricing_quotes)
     + (select count(*) from public.quote_outcomes))::text as expected
),
no_dupes as (
  select 'identity: zero duplicated quote ids' as check_name,
         (select count(*) from (
            select quote_id from public.reporting_quote_facts
            group by quote_id having count(*) > 1) s)::text as actual,
         '0' as expected
),

-- 2. Outcomes: the fact view must not invent or lose a decision.
outcomes as (
  select 'outcomes: sold matches quote_outcomes' as check_name,
         (select count(*) from public.reporting_quote_facts where final_outcome = 'sold')::text,
         (select count(*) from public.quote_outcomes where lower(decision::text) = 'sold')::text
),
outcomes_ns as (
  select 'outcomes: not sold matches quote_outcomes' as check_name,
         (select count(*) from public.reporting_quote_facts where final_outcome = 'not_sold')::text,
         (select count(*) from public.quote_outcomes where lower(decision::text) = 'not_sold')::text
),

-- 3. Pricing: first_pricing_sent_at must be the earlier of the column and the event,
--    so the count can never be lower than either source alone.
pricing as (
  select 'pricing: fact count is at least the event count' as check_name,
         (select count(*) from public.reporting_quote_facts
           where first_pricing_sent_at is not null)::text,
         (select count(distinct source_work_item_id) from public.work_item_events
           where event_type = 'price_sent')::text
),

-- 4. Cohort states are mutually exclusive and sum to received.
cohort as (
  select 'cohort: states sum to received' as check_name,
         (public.report_lifecycle(
            $${"mode":"cohort","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
          ) ->> 'states_sum_to_received') as actual,
         'true' as expected
),

-- 5. Summary totals must equal the drawer they open. Activity mode, whole history.
summary_all as (
  select
    'summary: activity sold equals fact count' as check_name,
    (public.report_summary(
       $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
     ) -> 'current' ->> 'sold') as actual,
    (select count(*) from public.reporting_quote_facts
      where final_outcome = 'sold' and not is_excluded)::text as expected
),
summary_received as (
  select
    'summary: activity received equals fact count' as check_name,
    (public.report_summary(
       $${"mode":"activity","start_date":"2020-01-01","end_date":"2030-12-31"}$$::jsonb
     ) -> 'current' ->> 'quotes_received') as actual,
    (select count(*) from public.reporting_quote_facts where not is_excluded)::text as expected
),

-- 6. Conversion Rate must be null, never zero, when nothing was finalized.
conversion_null as (
  select
    'conversion: null not zero on an empty window' as check_name,
    coalesce(
      public.report_summary(
        $${"mode":"activity","start_date":"1999-01-01","end_date":"1999-01-02"}$$::jsonb
      ) -> 'current' ->> 'conversion_rate',
      'null') as actual,
    'null' as expected
),

-- 7. Normalization: a reversed range is swapped, a bad enum is dropped.
normalize_swap as (
  select 'normalize: reversed range is swapped' as check_name,
         (public.report_normalize_filters(
            $${"start_date":"2026-07-31","end_date":"2026-07-01"}$$::jsonb
          ) ->> 'start_date'),
         '2026-07-01'
),
normalize_drop as (
  select 'normalize: unknown hours segment falls back to all' as check_name,
         (public.report_normalize_filters(
            $${"hours_segment":"nonsense"}$$::jsonb) ->> 'hours_segment'),
         'all'
),
normalize_dims as (
  select 'normalize: unknown after-hours dimension is dropped' as check_name,
         (public.report_normalize_filters(
            $${"after_hours_dimensions":["received","bogus"]}$$::jsonb
          ) -> 'after_hours_dimensions')::text,
         '["received"]'
),
normalize_uuid as (
  select 'normalize: malformed uuid is dropped' as check_name,
         (public.report_normalize_filters(
            $${"dealer_ids":["not-a-uuid"]}$$::jsonb) -> 'dealer_ids')::text,
         '[]'
),

-- 8. Business hours: the SQL classifier must agree with the TypeScript corpus.
hours as (
  select 'business hours: zero mismatches on the shared corpus' as check_name,
         (select count(*)::text from (values
            ('2026-08-03T14:00:00Z'::timestamptz, true),
            ('2026-08-03T12:30:00Z'::timestamptz, true),
            ('2026-08-03T12:29:00Z'::timestamptz, false),
            ('2026-08-03T21:29:00Z'::timestamptz, true),
            ('2026-08-03T21:30:00Z'::timestamptz, false),
            ('2026-08-04T02:00:00Z'::timestamptz, false),
            ('2026-08-01T14:00:00Z'::timestamptz, true),
            ('2026-08-01T22:00:00Z'::timestamptz, false),
            ('2026-08-02T16:00:00Z'::timestamptz, false),
            ('2026-03-06T13:30:00Z'::timestamptz, true),
            ('2026-03-09T12:30:00Z'::timestamptz, true),
            ('2026-10-30T12:30:00Z'::timestamptz, true),
            ('2026-11-02T13:30:00Z'::timestamptz, true),
            ('2026-08-03T04:00:00Z'::timestamptz, false)
          ) as c(at, expected)
          where public.reporting_is_business_hours(c.at) is distinct from c.expected),
         '0'
),

-- 9. After-hours dimensions are independent: worked must not equal received.
dimensions as (
  select 'after hours: worked differs from received' as check_name,
         (select case when count(*) filter (where worked_after_hours)
                        <> count(*) filter (where received_after_hours)
                      then 'independent' else 'identical' end
            from public.reporting_quote_facts),
         'independent'
),

-- 10. Workloads: manual and queue never overlap.
workloads as (
  select 'workload: manual and queue are disjoint' as check_name,
         (select count(*)::text from public.reporting_workload_facts
           where is_manual_workload and is_queue_workload),
         '0'
),
workload_total as (
  select 'workload: total matches non-quote work items' as check_name,
         (select count(*)::text from public.reporting_workload_facts),
         (select count(*)::text from public.work_items
           where work_type not in ('new_quote','requote'))
),

all_checks as (
  select * from identity
  union all select * from no_dupes
  union all select * from outcomes
  union all select * from outcomes_ns
  union all select * from pricing
  union all select * from cohort
  union all select * from summary_all
  union all select * from summary_received
  union all select * from conversion_null
  union all select * from normalize_swap
  union all select * from normalize_drop
  union all select * from normalize_dims
  union all select * from normalize_uuid
  union all select * from hours
  union all select * from dimensions
  union all select * from workloads
  union all select * from workload_total
)
select
  check_name,
  actual,
  expected,
  case when actual = expected then 'PASS' else 'FAIL' end as verdict
from all_checks
order by verdict desc, check_name;
