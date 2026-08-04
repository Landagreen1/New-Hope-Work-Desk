-- New Hope Work Desk v1.12.10 — add Awaiting Customer Decision to the summary
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 4.4, 4.11, 11.2, 20.2
-- Extends: v1.12.4-reporting-rpcs.sql (forward-only; that file is not edited)
--
-- ── Why this exists: "Pending Pricing" means two opposite things ───────────────
--
-- The Phase 6 reconciliation over July 2026 returned:
--
--   Pending Pricing   new 1    legacy 60
--
-- Both numbers are right, and they measure opposite populations.
--
-- The authoritative definition says Pending Pricing is a quote that "has not had
-- verified pricing sent". As of 31 July exactly one quote met that: the team's median
-- time to pricing is around ten minutes, so almost nothing sits un-priced overnight.
--
-- The legacy card counts every row of the table named `pending_pricing_quotes`, and a
-- quote lands in that table precisely BECAUSE pricing was sent — it is waiting on the
-- customer. So the legacy 60 is the "priced, no outcome yet" population, which the
-- authoritative definitions call Awaiting Customer Decision. Measured the same way, that
-- figure was 42 at the end of July.
--
-- A manager who has read "Pending Pricing: 60" for two years and now reads
-- "Pending Pricing: 1" will conclude the new report is broken. The definition is not
-- changing — it is the one that was specified — but the second figure has to be on
-- screen next to it, or the first one is a trap.
--
-- This migration adds awaiting_customer_decision to the summary payload so the KPI card
-- can carry both. The KPI ribbon stays at eight metrics.
--
-- ROLLBACK: re-apply reporting_summary_for_window from v1.12.4. Doing so removes the
-- companion figure and restores the trap.

begin;

create or replace function public.reporting_summary_for_window(
  p_filters jsonb, p_start date, p_end date
)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_mode        text := p_filters ->> 'mode';
  v_from        timestamptz := public.reporting_day_start(p_start);
  v_to          timestamptz := public.reporting_day_start(p_end + 1);
  v_received    bigint;
  v_pricing     bigint;
  v_pending     bigint;
  v_awaiting    bigint;
  v_sold        bigint;
  v_not_sold    bigint;
  v_median      numeric;
begin
  if v_mode = 'cohort' then
    select
      count(*),
      count(*) filter (where q.first_pricing_sent_at is not null
                         and q.first_pricing_sent_at < v_to),
      -- Pending Pricing: exists, not finalized, and NO verified pricing sent.
      count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                         and not (q.first_pricing_sent_at is not null
                                  and q.first_pricing_sent_at < v_to)),
      -- Awaiting Customer Decision: priced, and no outcome yet. This is what the
      -- legacy "Pending Pricing" card actually counted.
      count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                         and q.first_pricing_sent_at is not null
                         and q.first_pricing_sent_at < v_to),
      count(*) filter (where q.final_outcome = 'sold'     and q.finalized_at < v_to),
      count(*) filter (where q.final_outcome = 'not_sold' and q.finalized_at < v_to),
      percentile_cont(0.5) within group (
        order by extract(epoch from (q.first_pricing_sent_at - q.created_at)) / 60.0
      ) filter (where q.first_pricing_sent_at is not null and q.first_pricing_sent_at < v_to)
    into v_received, v_pricing, v_pending, v_awaiting, v_sold, v_not_sold, v_median
    from public.reporting_filtered_quotes(p_filters) q
    where q.created_at >= v_from and q.created_at < v_to;
  else
    select
      count(*) filter (where q.created_at >= v_from and q.created_at < v_to),
      count(*) filter (where q.first_pricing_sent_at >= v_from
                         and q.first_pricing_sent_at < v_to),
      count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                         and not (q.first_pricing_sent_at is not null
                                  and q.first_pricing_sent_at < v_to)
                         and q.created_at < v_to),
      count(*) filter (where not (q.final_outcome is not null and q.finalized_at < v_to)
                         and q.first_pricing_sent_at is not null
                         and q.first_pricing_sent_at < v_to
                         and q.created_at < v_to),
      count(*) filter (where q.final_outcome = 'sold'
                         and q.finalized_at >= v_from and q.finalized_at < v_to),
      count(*) filter (where q.final_outcome = 'not_sold'
                         and q.finalized_at >= v_from and q.finalized_at < v_to),
      percentile_cont(0.5) within group (
        order by extract(epoch from (q.first_pricing_sent_at - q.created_at)) / 60.0
      ) filter (where q.first_pricing_sent_at >= v_from and q.first_pricing_sent_at < v_to)
    into v_received, v_pricing, v_pending, v_awaiting, v_sold, v_not_sold, v_median
    from public.reporting_filtered_quotes(p_filters) q;
  end if;

  return jsonb_build_object(
    'quotes_received', v_received,
    'pricing_sent', v_pricing,
    'pending_pricing', v_pending,
    'awaiting_customer_decision', v_awaiting,
    'sold', v_sold,
    'not_sold', v_not_sold,
    'finalized', v_sold + v_not_sold,
    'conversion_rate', case when (v_sold + v_not_sold) = 0 then null
                            else round((v_sold::numeric / (v_sold + v_not_sold)) * 100, 1) end,
    'quote_to_sale_rate', case when v_received = 0 then null
                               else round((v_sold::numeric / v_received) * 100, 1) end,
    'median_time_to_pricing_minutes', case when v_median is null then null
                                           else round(v_median, 1) end
  );
end;
$$;

comment on function public.reporting_summary_for_window(jsonb, date, date) is
  'The eight KPIs over one window, plus awaiting_customer_decision as a companion to pending_pricing. The two are opposite populations that have shared the name "Pending Pricing": pending_pricing is a quote with NO verified pricing sent, awaiting_customer_decision is a quote that HAS been priced and is waiting on the customer. The legacy report''s "Pending Pricing" card counted the second one, undated. Over July 2026: 1 and 42 respectively, against a legacy figure of 60. Both must be on screen or the first is a trap.';

commit;
