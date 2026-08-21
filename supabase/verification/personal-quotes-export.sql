-- New Hope Work Desk — personal quotes CSV export, day one to now
--
-- HOW TO GET THE CSV
--   Supabase Dashboard -> SQL Editor -> paste query 1 -> Run -> "Download CSV".
--   Or from this repo:  node scripts/query-sql.mjs "select * from public.personal_quotes_export where not is_excluded order by quote_created_at_utc"
--
-- Requires migration supabase/migrations/v1.20.1-personal-quotes-csv-export.sql.
--
-- The view is security_invoker, so an agent running it sees only the rows their RLS
-- policies allow. Run it in the SQL editor or with the service role to get the full
-- history.


-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE EXPORT — this is the one to download
--
-- Voided, cancelled and duplicate-retry quotes are filtered out here. They are not
-- deleted from the view; run query 4 to see them.
-- ═══════════════════════════════════════════════════════════════════════════════
select
  customer_name            as "Customer",
  source                   as "Source",
  quote_type               as "Type",
  work_type                as "New / Requote",
  quote_created_date       as "Quote Created",
  quote_created_at_local   as "Quote Created (time)",
  current_status           as "Status",
  not_sold_reason          as "Not Sold Reason",
  not_sold_reason_detail   as "Not Sold Detail",
  decided_date             as "Date Sold / Not Sold",
  price_sent_date          as "Price Sent (pending pricing)",
  assigned_agent           as "Agent Assigned",
  line_of_business         as "Line of Business",
  is_cs_intake             as "From CS Intake",
  is_walk_in               as "Walk-In",
  received_through         as "Received Through",
  source_salesperson       as "Dealer Salesperson",
  created_by               as "Logged By",
  outcome_recorded_by      as "Outcome Recorded By",
  minutes_to_price_sent    as "Minutes To Price Sent",
  days_to_decision         as "Days To Decision",
  quote_id                 as "Quote ID"
from public.personal_quotes_export
where not is_excluded
order by quote_created_at_utc;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. NARROWER CUTS — uncomment the one you want
-- ═══════════════════════════════════════════════════════════════════════════════

-- A date range instead of all history (local business dates, inclusive):
-- select * from public.personal_quotes_export
-- where not is_excluded
--   and quote_created_date between date '2026-07-01' and date '2026-07-31'
-- order by quote_created_at_utc;

-- Strict personal lines only — drops the commercial_auto CS intakes that ride the
-- personal queue. Quotes with no intake have a null line_of_business and are kept:
-- select * from public.personal_quotes_export
-- where not is_excluded
--   and line_of_business is distinct from 'commercial_auto'
-- order by quote_created_at_utc;

-- Only what is still open (nothing decided yet):
-- select * from public.personal_quotes_export
-- where not is_excluded and current_status in ('Pending Pricing', 'Working')
-- order by quote_created_at_utc;

-- One agent:
-- select * from public.personal_quotes_export
-- where not is_excluded and assigned_agent = 'Maria Trujillo'
-- order by quote_created_at_utc;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. SANITY CHECKS — run these before trusting a download
-- ═══════════════════════════════════════════════════════════════════════════════

-- Totals by status. Should sum to the exported row count.
select current_status, count(*) as quotes
from public.personal_quotes_export
where not is_excluded
group by 1
order by 2 desc;

-- Type mix, and the earliest quote in the system (this is "day one").
select
  count(*)                        as quotes,
  min(quote_created_date)         as first_quote_date,
  max(quote_created_date)         as last_quote_date,
  count(distinct assigned_agent)  as agents
from public.personal_quotes_export
where not is_excluded;

select quote_type, count(*) as quotes
from public.personal_quotes_export
where not is_excluded
group by 1
order by 2 desc;

-- Not-sold reasons. The category pivots; the detail is free text under 'Other'.
select not_sold_reason, count(*) as quotes
from public.personal_quotes_export
where current_status = 'Not Sold'
group by 1
order by 2 desc;

-- Reconcile against the raw lifecycle tables. The three counts on the right must
-- match the three lifecycle_stage counts on the left, or a quote has been lost or
-- duplicated between the tables and the view.
select
  (select count(*) from public.personal_quotes_export where lifecycle_stage = 'active')          as view_active,
  (select count(*) from public.work_items where work_type in ('new_quote','requote'))            as raw_work_items,
  (select count(*) from public.personal_quotes_export where lifecycle_stage = 'pending_pricing') as view_pending,
  (select count(*) from public.pending_pricing_quotes)                                          as raw_pending,
  (select count(*) from public.personal_quotes_export where lifecycle_stage = 'finalized')       as view_finalized,
  (select count(distinct source_work_item_id) from public.quote_outcomes)                        as raw_outcomes;


-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. WHAT THE EXPORT LEFT OUT, and why
--
-- Nothing is hidden — these rows are in the view with is_excluded = true. Check
-- this list before reporting a total, so an excluded quote is a decision rather
-- than a surprise.
-- ═══════════════════════════════════════════════════════════════════════════════
select
  customer_name,
  quote_created_date,
  current_status,
  assigned_agent,
  exclusion_reason
from public.personal_quotes_export
where is_excluded
order by quote_created_at_utc;
