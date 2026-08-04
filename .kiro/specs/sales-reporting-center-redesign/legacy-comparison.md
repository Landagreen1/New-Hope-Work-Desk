# Legacy Comparison

Phase 6 deliverable. New metrics against the legacy metrics they supersede, over one complete reporting period.

**Period:** 1–31 July 2026, the most recent complete calendar month, `America/New_York`.
**Run:** `public.report_reconciliation('2026-07-01', '2026-07-31')` on live Supabase, 3 August 2026.

The legacy side is computed in SQL using the arithmetic the browser uses today, defects included, so a difference the new definitions intend is distinguishable from a bug in the new query.

## Results

| Metric | New | Legacy | Difference |
| --- | --- | --- | --- |
| Quotes Received | 1,095 | 1,072 | **+23** |
| Sold | 518 | 518 | 0 |
| Not Sold | 534 | 534 | 0 |
| Pending Pricing | 1 | 60 | **−59** |
| Deleted quotes in period | — | 74 | not a metric |

Sold and Not Sold agree exactly. Both differences are explained below, and both turned out to be more consequential than the design predicted.

---

## Difference 1 — Quotes Received, +23

**Not the direction the design predicted.** The design expected the new figure to be lower or equal, on the grounds that it deduplicates. The decomposition shows why it is higher:

| Population | Count |
| --- | --- |
| Created in July **and** finalized in July | 1,052 |
| Created in July, finalized **after** July | 43 |
| Created **before** July, finalized in July | 0 |

- **New = 1,052 + 43 = 1,095.** Every quote created in July, counted once, by its creation date.
- **Legacy = 1,052 + 20 + 0 = 1,072.** Outcomes finalized in July (1,052), plus the 20 rows still sitting in `pending_pricing_quotes` whose `quote_created_at` fell in July, plus zero quote-typed `work_items` rows created in July.

The 23 missing from the legacy figure are **quotes created in July that were finalized in August**. Once such a quote finalizes, it leaves `pending_pricing_quotes` for `quote_outcomes`, and the legacy branch filters `quote_outcomes` on `finalized_at`. So the quote is no longer in the table the legacy July window looks at, and its outcome date is outside that window. It vanishes from July entirely.

**The consequence is worse than a 2% gap.** The legacy Total Quotes figure for a closed month is **not stable**. Ask for July on 31 July and you get one number; ask again in September and every quote that finalized after July has silently dropped out of it. Two managers running the same July report a month apart get different answers, and neither is told why.

The new figure is stable by construction: a quote created in July is counted in July's Quotes Received forever, whatever happens to it afterwards.

**Verdict:** the new figure is correct and the difference is a defect in the legacy metric, not a definition change.

---

## Difference 2 — "Pending Pricing" names two opposite populations

This is the finding that mattered most, and it required a code change rather than a note.

| Measure | As of 31 July | What it counts |
| --- | --- | --- |
| New **Pending Pricing** | **1** | Exists, not finalized, and **no** verified pricing sent |
| New **Awaiting Customer Decision** | **42** | **Has** been priced, no outcome yet |
| Legacy **Pending Pricing** card | **60** | Every row of `pending_pricing_quotes`, no date filter |

Both new figures are right. So is the legacy one. They are three different measurements sharing two words.

The authoritative definition says Pending Pricing is a quote that "has not had verified pricing sent". Exactly one quote met that at the end of July, and that is believable: the median time to pricing is 9.5 minutes, so almost nothing sits un-priced overnight.

But a quote lands in the table named `pending_pricing_quotes` **because pricing was sent** — it is waiting on the customer. The legacy card counts that table, undated. So the phrase "Pending Pricing" means *pricing not yet sent* in the new definitions and *pricing already sent* in the legacy report.

**A manager who has read "Pending Pricing: 60" for two years and now reads "Pending Pricing: 1" will conclude the new report is broken.** The definition is the one that was specified and it is not being changed, but shipping the number alone would have been a trap.

### What was changed

- `v1.12.10-reporting-awaiting-decision.sql` adds `awaiting_customer_decision` to the summary payload.
- The KPI card is labelled **Awaiting Pricing** rather than the bare "Pending Pricing", and carries the awaiting-customer-decision figure directly underneath it.
- The metric definition popover states the collision explicitly.
- The KPI ribbon stays at eight metrics, as Requirement 11.1 requires.

Both numbers are now on screen, each with its own words.

---

## Difference 3 — 74 quotes deleted during the period

Not a metric, and reported so that a future gap can be explained rather than investigated.

`manager_delete_quote` hard-deletes from `work_items`, `pending_pricing_quotes`, `quote_outcomes`, `quote_notes`, `quote_take_events`, `work_item_events`, and `user_notifications`. Only the `audit_log` row survives. 74 such deletions were recorded in July.

**Neither report can see a deleted quote.** A July total taken today is smaller than the same total taken on 31 July, by however many July quotes have been deleted since. That is a data-model limitation, recorded as data gap 3, and the `quote_deleted` audit count is the only way to account for it.

---

## Differences the design predicted that did not appear

| Predicted | Observed |
| --- | --- |
| Agent totals differ where an employee was renamed | Not observable: no rename occurred in the period. The new joins are by profile id regardless, so the risk is closed either way. |
| Time to accept often undefined where legacy showed zero | Confirmed structurally — `accepted_at` equal to creation is now nulled — but not quantified in this comparison because the legacy metric is a per-agent average rather than a total. |
| After-hours counts differ where a holiday falls in the window | No holidays or closures are configured yet, so the two agree. The seeded configuration reproduces the legacy Mon–Sat 08:30–17:30 window exactly, which is why. |
| Quotes Received lower than legacy | **Wrong direction.** See Difference 1. |

## Metrics retired rather than compared

| Metric | Reason |
| --- | --- |
| Efficiency (`finalized ÷ quotes`) | Divides an Operational Activity numerator by a Quote Cohort denominator. Replaced by the Quote Cohort funnel. |
| Agent 360 score | A single weighted composite of six measures, weights hard-coded in a component. Out of scope by requirement; the six measures are reported separately. |
| Source category (High value / Needs attention / Low value / Monitor) | Replaced by nine named conditions, each stating its threshold and the data that met it. |

## Additional live findings from the same run

| Finding | Count |
| --- | --- |
| Sold quotes with no verified pricing event | 153 |
| Attribution conflicts (sales credit ≠ outcome actor) | 73 |
| Manual quotes created within 30 minutes of a Sold outcome | 60 |
| Sold quotes with no notes | 58 |
| Manual quotes with no notes | 58 |
| Outcomes changed after finalization | 53 |
| Manual workloads with no notes | 75 |
| Duplicate customer/source quotes within 24 hours | 23 |
| Assignment method changed after creation | 10 |
| Pending pricing beyond 3 days with no follow-up | 5 |
| Queue claims joinable to their quote | **228 of 1,294 (17.6%)** |

The last row is a systemic gap, reported as one finding rather than 1,061 record flags. See `v1.12.9-fix-queue-mismatch-signal.sql`.

## Status of the legacy reports

All 24 remain in place, unchanged, under **Sales → Legacy Reports**. Every one now carries a banner naming the view that supersedes it, or stating that none does.

**Removal has not been requested and has not occurred.** It requires explicit approval from a profile holding Manager_Role, per Requirement 1.2 and 20.3.
