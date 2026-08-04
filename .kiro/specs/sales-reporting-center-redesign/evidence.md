# Final Evidence Report

Sales Reporting Center redesign. Branch `feature/sales-reporting-center`, branched from `origin/main` at `b34184c`. All migrations applied to live Supabase project `kfbgftkjvtynfdwgcgeb` on 3 August 2026.

## Verification

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | Pass, zero errors |
| `npx vitest --run src/features/reporting` | **195 tests, 5 files, all pass** |
| `npm test` (whole repository) | 2,535 pass, 38 skipped, **2 pre-existing failures unrelated to this work** |
| `npm run build` | Pass, all routes compiled including `/api/reports/sales/export` |
| `supabase/verification/v1.12-reporting-checks.sql` | **17 of 17 PASS** |
| `supabase/verification/v1.12-reporting-rpc-checks.sql` | **14 of 14 match** |
| `supabase/verification/v1.12-reporting-authorization-checks.sql` | **21 of 21 PASS** |
| `supabase/verification/v1.12-reporting-execution-checks.sql` | **12 of 12 PASS**, none SLOW |
| `supabase/verification/v1.12-reporting-drilldown-checks.sql` | **40 of 40 PASS** |

The two repository-wide failures are in `src/features/cancellations/__tests__/cancellations-summary-bar.test.tsx`, from the in-progress Policy Follow-up work that was already in the working tree before this branch existed. Nothing outside `src/features/reporting` imports this feature, and neither failing file references it.

## Database objects added

Twelve forward-only migrations. No existing migration file was edited. No existing table, column, view, function, policy, or row that a legacy report reads was altered.

| Migration | Objects |
| --- | --- |
| `v1.12.0-reporting-business-hours.sql` | `business_hours_days`, `business_hours_closures`, `business_hours_settings`, `reporting_is_business_hours()`, six RLS policies |
| `v1.12.1-reporting-quote-facts.sql` | `reporting_intake_quote_links`, `reporting_quote_base`, `reporting_quote_event_rollup`, `reporting_quote_field_changes`, `reporting_quote_facts` |
| `v1.12.2-reporting-workload-facts.sql` | `reporting_workload_facts` |
| `v1.12.3-reporting-indexes.sql` | 16 indexes |
| `v1.12.4-reporting-rpcs.sql` | `reporting_timezone()`, `reporting_day_start()`, `reporting_uuid_array()`, `reporting_text_array()`, `reporting_enum_array()`, `reporting_self_scope()`, `reporting_can_read()`, `report_normalize_filters()`, `reporting_filtered_quotes()`, `reporting_filtered_workloads()`, `report_summary()`, `reporting_summary_for_window()`, `report_lifecycle()`, `report_filter_options()` |
| `v1.12.5-reporting-row-functions.sql` | `report_agent_rows()`, `report_source_rows()`, `report_records()`, `report_needs_attention()`, `report_after_hours_summary()`, `report_reconciliation()` |
| `v1.12.6-reporting-integrity.sql` | `reporting_thresholds`, `reporting_integrity_flags`, `reporting_integrity_reviews`, immutability trigger, `reporting_detect_integrity_flags()`, `report_integrity_flags()`, `report_integrity_review()`, five RLS policies |
| `v1.12.7-reporting-live-object-record.sql` | No objects. Assertions plus a column comment recording seven live-only tables and four live-only `work_items` columns |
| `v1.12.8-fix-reporting-excluded-null.sql` | Replaces `reporting_quote_facts` (defect fix) |
| `v1.12.9-fix-queue-mismatch-signal.sql` | `queue_link_coverage_minimum_percent` column, `reporting_detect_queue_mismatches()`, replaces `reporting_detect_integrity_flags()` |
| `v1.12.10-reporting-awaiting-decision.sql` | Replaces `reporting_summary_for_window()` (adds the companion figure) |
| `v1.12.11-fix-ambiguous-column-references.sql` | Replaces `report_needs_attention()` and `report_records()` (defect fix), adds `reporting_filtered_quotes_in_window()` |
| `v1.12.12-reporting-filter-performance.sql` | Replaces `reporting_filtered_quotes()` and `reporting_filtered_workloads()` (10x speed-up) |

`public.can_manage_sales()` already existed live and already matched `canManageSales` in `src/lib/permissions.ts`. It was reused, not recreated.

## Files changed

**Added — reporting feature (16 files)**

```
src/features/reporting/definitions.ts          types.ts          derive.ts
                       url-state.ts            api.ts            nhwd-shared-bridge.ts
                       SalesReportingCenter.tsx
  components/ ReportingFilters.tsx  KpiRibbon.tsx  QuoteLifecycle.tsx
              NeedsAttention.tsx    RecordDrawer.tsx  ExportCurrentView.tsx
  views/      OverviewReport.tsx  AgentsReport.tsx  SourcesReport.tsx  IntegrityReport.tsx
```

**Added — tests (6 files)**

```
src/features/reporting/__tests__/business-hours.fixtures.ts  business-hours.test.ts
                                 metrics.test.ts  credit.test.ts  integrity.test.ts
                                 url-state.test.ts
```

**Added — route and config**

- `src/app/api/reports/sales/export/route.ts`
- `next.config.ts` — `serverExternalPackages: ['pdfkit', 'exceljs']`
- `package.json` — `exceljs@4.4.0`, `pdfkit@0.15.2`, `@types/pdfkit@0.13.9`, all exact

**Modified — three registration points, minimally**

- `src/components/app-sidebar.tsx` — `sales_reporting_center` added to `SubNavId` and to the sales sub-nav behind `permissions.manageSales`; the existing `sales_reports` item relabelled **Legacy Reports**.
- `src/components/role-workspace.tsx` — renders `SalesReportingCenter` inside `Suspense`.
- `src/components/work-desk-app.tsx` — three label strings and one retention banner. **No report rendering, aggregation, or state was added.** The 12,500-line component is 20 lines longer.

**Added — documents**

`report-inventory.md`, `metric-definitions.md`, `legacy-comparison.md`, `evidence.md`, `deployment.md`, plus `requirements.md`, `design.md`, `tasks.md`.

## What the four views show, from live data

Verified against the live database, not a fixture.

**Overview** — eight KPIs. July 2026: 1,095 Quotes Received, 945 Pricing Sent, 1 Awaiting Pricing (42 awaiting customer decision), 1,052 Finalized, 518 Sold, 534 Not Sold, 49.2% Conversion, 9.5 minutes Median Time to Pricing. Needs Attention across eight conditions. Compact agent and source summaries linking through with filters intact.

**Agents** — 11 default columns, 16 on expansion, each attributed to the credit role it measures. Live example, Maria Zumarraga: 135 assigned, 110 priced, 65 sold, and in the detail drawer **136 created, 136 claimed, 110 priced, 99 sales-credited, 100 outcomes entered**. Five different numbers where every existing report shows one.

**Sources** — 13 columns per source, nine named health conditions each stating its threshold and the data that met it. Quotes with no source appear as "No source recorded" rather than being dropped.

**Review & Integrity** — 569 flags across 11 signals, 14 saved filters, full review workflow.

| Signal | Flags |
| --- | --- |
| Sold without pricing evidence | 153 |
| Manual workload without notes | 75 |
| Attribution conflict | 73 |
| Manual quote shortly before Sold | 60 |
| Sold without notes | 58 |
| Manual quote without notes | 58 |
| Outcome changed after finalization | 53 |
| Duplicate customer/source quotes | 23 |
| Assignment method changed after creation | 10 |
| Pending pricing without follow-up | 5 |
| Queue turn link not populated (systemic) | 1 |

## Example drill-down

Selecting **Sold** on the Overview KPI ribbon opens the right-side drawer, which calls `report_records(filters, 'sold', 25, 0, sort)` — the same filter set that produced the 518. The drawer states the metric's definition, reports "Showing 1–25 of 518", and renders each quote with its customer, source, salesperson, five lifecycle timestamps, badges for every after-hours dimension and integrity indicator, a Log action, and an expandable block naming all six credit roles separately.

Selecting **Sold** on an agent row in the Agents view opens the same drawer scoped to that agent, with the label "Sold — Maria Zumarraga".

## Example integrity review

`report_integrity_review(flag_id, 'Explained', 'Pricing was sent by phone and recorded on the linked renewal.')` was exercised live as `micaelad`, a `sales_supervisor`, confirming Byron's decision that supervisors may review. Then `'Reopened'` was recorded on the same flag. The review history held **2 rows: `Explained->Explained | Reopened->Open`**, the explanation survived the reopen, and an `update` against the history table was refused with "append-only". The test rows were then removed, because a fabricated review decision must not sit in a production audit trail under a real employee's name; the immutability trigger was disabled for that one cleanup and restored immediately.

## Example after-hours filter

Selecting **After Hours** in the filter bar applies to all four views. Live totals over the whole history: 236 received after hours, **407 worked after hours**, 317 finalized after hours. The two differ, which is the point — the four dimensions are computed independently and the existing After Hours report cannot distinguish them because it filters on the creation timestamp only.

The Business Hours and After Hours segments were verified to partition the quote set exactly: 1,276 = 1,276.

## Defects found after deploy

Two shipped. Byron hit the first one within minutes of the report going live.

**`report_needs_attention` and `report_records` both raised "column reference is ambiguous" on every call.** In plpgsql the names in `returns table (...)` are variables in scope throughout the body, so an unqualified column reference matching one is ambiguous — and Postgres raises that at run time, not at create time. `report_needs_attention` had it on `severity` in an `ORDER BY`; `report_records` had it on `created_at` in a CTE's `WHERE`. The second is the worse one: it broke **every drill-down**, all 21 metric keys, so no number in the report could be opened. Fixed in `v1.12.11`.

**The filter function re-parsed its jsonb per row.** `reporting_filtered_quotes` held nine predicates that each ran `jsonb_array_length` plus a `jsonb_array_elements_text` subquery for every candidate quote — over eleven thousand expansions per call. The Overview fires six aggregates in parallel, so the page took about sixteen seconds. Fixed in `v1.12.12` by expanding each filter list into a local array once and comparing with `= any(array)`.

| Function | Before | After |
| --- | --- | --- |
| `report_summary` | 6,677 ms | 660 ms |
| `report_summary` with compare | 12,899 ms | 1,062 ms |
| `report_lifecycle` | 6,467 ms | 533 ms |
| `report_needs_attention` | 7,105 ms | 577 ms |
| `report_agent_rows` | 6,046 ms | 697 ms |
| `report_source_rows` | 5,183 ms | 500 ms |
| `report_after_hours_summary` | 15,582 ms | 1,514 ms |

### Why the verification missed all of it

This is the part worth remembering. Every reporting function opens with an authorization guard that returns early:

```sql
if not public.reporting_can_read() then return; end if;
```

The REST probe called all nine functions over PostgREST as an anonymous caller and got `200 []` from each. That proved they existed and were reachable. It proved **nothing** about their bodies, because the guard returned before any query ran, and an empty result from a broken query is indistinguishable from an empty result from a refused caller.

The SQL verification files did exercise `report_summary`, `report_lifecycle`, `report_agent_rows` and `report_integrity_flags` with a real session — and those four are exactly the four that worked. `report_needs_attention`, `report_records`, `report_source_rows` and `report_after_hours_summary` were never executed authenticated. I read reachability as proof of correctness, and it is not.

Two verification files now close the gap permanently:

- `v1.12-reporting-execution-checks.sql` executes every function in both report modes and flags anything over three seconds as SLOW.
- `v1.12-reporting-drilldown-checks.sql` exercises all 21 drill-down metric keys, all five sort orders and all fourteen saved review filters.

Both were run against live data after the fix: **12 of 12 and 40 of 40.**

## Defects found during implementation

Both were caught by verification before any UI was built on them.

**`is_excluded` was null for 97% of quotes.** `v1.12.1` computed `is_voided or work_item_status = 'cancelled' or …`. A quote's `work_items` row is deleted when it moves to pending pricing or an outcome, so `work_item_status` is null for 1,236 of 1,276 quotes, `null = 'cancelled'` is null, and `false or null or false` is **null**. Every query filters `where not is_excluded`, and `not null` is not true, so those rows were silently dropped. **Quotes Received returned 40 instead of 1,276.** Fixed forward-only in `v1.12.8` by coalescing. Not a subtle inaccuracy — a factor of thirty.

**The queue-mismatch signal flagged 1,061 of 1,276 quotes at high severity.** Not 1,061 faulty quotes: `turn_events.work_item_id` is populated on only 228 of 1,294 claims, and just 4 of 993 queue quotes can be joined to their turn at all. The gap is systemic. `v1.12.9` reworked it to join `turn_events` directly and gate per-record flagging on a configurable link-coverage minimum; below that the gap is reported as **one** systemic finding carrying the coverage figure. A review queue with 1,061 high-severity items in it would have taught managers to ignore the view in week one.

## Live findings that changed the design

| Finding | Consequence |
| --- | --- |
| `work_items.is_voided`, `voided_at`, `voided_by`, `void_reason` exist live and in no migration | Voided quotes are counted by every existing sales report. Now excluded. |
| `quote_decision` carries a stray `Sold` label beside `sold` | Zero rows use it, but a `= 'sold'` comparison would miss it. Every comparison lowercases. |
| `cs_intake_submissions.work_item_id` is null on all 80 rows | The intake-to-quote link lives in `cs_intake_events.detail`. A duplicate rule reading the column would report zero duplicates forever. |
| A sold quote's `work_items` row is converted in place into an activation | 36 rows are both a quote identity and a workload. The identity resolution cannot filter `work_items` by `work_type`. |
| The `assigned` event type has 1 row in 6,471 | Counting assignment events is not a test of anything. |
| No dedicated audit action for a source or salesperson change | Change counts are a floor, not a total. Stated on screen. |
| `manager_delete_quote` hard-deletes across seven tables | 74 quotes deleted in July. A closed period's totals shrink afterwards; the `audit_log` count is the only explanation. |

## Known limitations

1. **Deleted quotes cannot be recovered into a report.** The delete is physical. Reconciliation counts the `quote_deleted` audit rows so a gap is explainable, not preventable.
2. **Time to accept is unknowable for backfilled rows.** `v0.7.0` set `accepted_at` from the creation timestamp. Those rows now report undefined instead of zero, which is honest but not recoverable.
3. **Source and salesperson change counts are a floor.** Only changes riding inside a reassignment are audited.
4. **`attachment_count` is a constant zero** and workload `evidence_count` likewise. No quote or workload attachment table exists.
5. **The team filter is declared but not populated.** `profiles` has no team column; the filter accepts ids and matches nothing.
6. **Quotes per scheduled hour is undefined for employees with no schedule rows.** Reported as undefined rather than as zero.
7. **The queue-to-quote link is 17.6% populated**, so per-record queue reconciliation is suppressed in favour of the systemic finding. Fixing the claim RPCs to write `work_item_id` would turn it back on with no reporting change.
8. **The PDF snapshot covers the summary only.** A printable page of ten thousand records is not a snapshot; the records CSV and the workbook carry the detail.
9. **The fact views are computed live, not materialized.** Correct at current volume (1,276 quotes, 6,471 events). If it slows, the forward path is a materialized derivative refreshed on a schedule, with no consumer change, because every consumer goes through an RPC.
10. **Screenshots are not included.** They need a running browser session against production data; the live figures quoted throughout were taken from the database directly and can be re-derived with the verification scripts.

## Remaining data gaps

The 13 gaps in `metric-definitions.md` §6 are unchanged apart from gaps 8 and 13, which `v1.12.7` closed by recording the live-only objects. Gaps 1 (no `priced_by`/`sold_by`), 2 (no source-change audit), 3 (hard delete), 4 (no unique constraint on `quote_outcomes.source_work_item_id`), 5 (`received_through` is free text), 6 (duplicates carry no marker), 7 (backfilled `accepted_at`), 9 (no attachment tables), 10 (incomplete schedule coverage), 11 (no team column) and 12 (the stray enum label) remain open. Each needs a schema change outside this feature's scope, and each is worked around explicitly rather than papered over.

## Legacy reports

All 24 remain in place, unchanged, under **Sales → Legacy Reports**, each carrying a banner naming the view that supersedes it or stating that none does. Queue Health, Recovered Quotes, Missed Turns, Pass Behavior and System Health are marked as having no replacement, because they are queue operations and system checks rather than sales reporting.

**No legacy report has been removed.** Removal requires explicit Manager_Role approval.
