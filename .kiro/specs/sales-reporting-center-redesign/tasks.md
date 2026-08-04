# Implementation Plan: Sales Reporting Center

## Overview

Six phases on `feature/sales-reporting-center`, each ending in its own commit and its own verification run.

**Phase 1** is a hard gate. The report inventory, the authoritative metric definitions, the agent-credit rules, the after-hours rules, and the integrity signal catalog are written down and unit-tested as pure code before any UI or any migration exists. No Phase 3 task starts until Phase 1 is recorded complete.

**Phase 2** adds the reporting data layer: `v1.12.0`–`v1.12.7`, forward-only, no edits to applied migrations, no change to any object a Legacy_Report reads.

**Phases 3–5** build the four views on top of the RPCs.

**Phase 6** reconciles new against legacy for one complete reporting period. No Legacy_Report is removed in any phase.

Repository facts every task depends on:

- `npm test` is `vitest --run`. `npm run test:integration` runs `*.integration.test.*` with `.env.local` loaded.
- **There is no `typecheck` script.** The type check is `npx tsc --noEmit`.
- The build is `npm run build`.
- Migrations apply with `node --env-file=.env.local scripts/run-sql.mjs <file>`.
- The latest applied migration is `v1.11.6-zaira-ortiz-saturdays-only.sql`, so this feature starts at `v1.12.0`.
- `vitest.config.ts` sets `environment: 'node'`; a component test needs a `// @vitest-environment jsdom` docblock.
- Every role check admitting `manager` also admits `super_admin`.
- Every quote list gets a Log action opening `QuoteActivityModal` with that row's `source_work_item_id`.

---

## Tasks

- [x] 0. Branch setup
  - [x] 0.1 Record the pre-branch working tree
    - Run `git status --porcelain` and `git branch --show-current`; record the modified and untracked paths in the Verification Record below under "Pre-branch working tree"
    - Confirm no recorded path is inside `src/features/reporting`, `supabase/migrations/v1.12*`, or `.kiro/specs/sales-reporting-center-redesign`, so unrelated work is not mistaken for this feature's work
    - _Requirements: 20.6_

  - [x] 0.2 Create the branch carrying unrelated changes forward
    - `git switch -c feature/sales-reporting-center` with no stash and no checkout of tracked files
    - Re-run `git status --porcelain` and confirm the path list is unchanged from 0.1
    - Leave every unrelated change unstaged so no phase commit picks it up
    - _Requirements: 20.6_

---

### Phase 1 — Definitions and data audit

- [x] 1. Report inventory
  - [x] 1.1 Write `.kiro/specs/sales-reporting-center-redesign/report-inventory.md`
    - One entry per existing sales report: its `ReportView` id, its user-facing label, its component and line range, the metrics it displays with their exact on-screen labels, the tables and fields behind each metric, and the timestamp each metric is counted by
    - Record which metrics duplicate one another, which calculations run in the browser, and which reports ignore or inconsistently apply the selected date range
    - Record the fields that distinguish Manual Quote from Manual Workload, the fields holding source, salesperson, channel, and assignment method, and which user is credited for creation, assignment, pricing, sale, and outcome
    - Record the current after-hours logic, the current exports, and the current RLS and manager permissions
    - Treat no current metric label as automatically correct; name each label whose arithmetic does not match it
    - _Requirements: 20.1, 20.4_

- [x] 2. Metric definitions
  - [x] 2.1 Write `.kiro/specs/sales-reporting-center-redesign/metric-definitions.md`
    - The authoritative definition of Quotes Received, Pricing Sent, Pending Pricing, Sold, Not Sold, Finalized, Conversion Rate, Quote-to-Sale Rate, Median Time to Pricing, and the seven cohort states, each stating its timestamp, its Report_Mode, its denominator, and its exclusions
    - The agent-credit rules for all six Credit_Roles, each naming the column or event it resolves from
    - The after-hours rules: the four dimensions, the Business_Hours_Settings shape, Sunday handling, holidays, closures, and daylight-saving behavior
    - The integrity signal catalog: each signal's Flag_Type, severity, threshold key, and the evidence it must carry
    - The identified data gaps, each stating what cannot be answered from current data and what would close it
    - The old-versus-new metric comparison table naming each retired metric and the reason
    - _Requirements: 4.1–4.12, 5.1–5.7, 6.1–6.11, 8.1–8.8, 14.1–14.10, 20.1, 20.2, 20.4_

- [x] 3. Definitions module
  - [x] 3.1 Create `src/features/reporting/types.ts`
    - `ReportView`, `ReportMode`, `HoursSegment`, `AfterHoursDimension`, `CreditRole`, `MetricId`, `IntegrityFlagType`, `ReviewStatus`, `ReportFilters`, `QuoteFactRow`, `WorkloadFactRow`, `AgentReportRow`, `SourceReportRow`, `IntegrityFlag`, `BusinessHoursSettings`
    - _Requirements: 2.1, 3.1, 9.3, 9.4, 17.2, 17.3_

  - [x] 3.2 Create `src/features/reporting/definitions.ts`
    - No React import, no `getSupabase()`, no `.rpc(`, no `Date.now()` outside a named clock helper
    - Export `METRIC_DEFINITIONS`, `REPORT_VIEWS`, `REPORT_MODES`, `HOURS_SEGMENTS`, `AFTER_HOURS_DIMENSIONS`, `CREDIT_ROLES`, `INTEGRITY_FLAG_TYPES`, `INTEGRITY_SIGNALS`, `DEFAULT_INTEGRITY_THRESHOLDS`, `SOURCE_HEALTH_CONDITIONS`, `LEGACY_REPORT_MAP`
    - Export `resolveBusinessDate`, `classifyInstant`, `afterHoursDimensions`, `resolveCreditRoles`, `metricDenominatorLabel`, `isExcludedRecord`, `classifyCohortState`
    - `classifyInstant` reads `Intl.DateTimeFormat(...).formatToParts` with `hourCycle: 'h23'` and never re-parses a formatted string; opening time inclusive, closing time exclusive; a holiday or closure date is After_Hours all day
    - `METRIC_DEFINITIONS` carries for every metric an id, label, prose definition, `countedBy` timestamp, `mode`, `denominator`, and `creditRole`, so no metric can be displayed without its definition and denominator
    - `LEGACY_REPORT_MAP` maps each of the 24 legacy views to its superseding Report_View or to `null` with a retirement reason
    - _Requirements: 3.5, 4.7, 4.8, 4.10, 4.11, 5.1, 5.2, 5.4, 6.1–6.6, 7.5, 7.6, 7.8, 7.9, 8.1–8.6, 14.2, 14.4, 13.4, 13.5, 1.4_

  - [x] 3.3 Write `src/features/reporting/__tests__/business-hours.fixtures.ts` and `business-hours.test.ts`
    - A shared corpus of instants with expected classifications, reused later by the SQL parity test
    - Cover: a weekday inside hours; exactly at the opening minute; exactly at the closing minute; a weekday before opening; a weekday after closing; Saturday inside and outside hours; Sunday with `sunday_is_working_day` false and true; a holiday at midday; a special closure at midday; both daylight-saving transition days in `America/New_York`; an instant one second either side of a boundary
    - _Requirements: 7.5, 7.6, 7.8, 7.9, 8.2_

  - [x] 3.4 Write `src/features/reporting/__tests__/metrics.test.ts`
    - Quote created inside the window; created before the window but priced inside it; created before the window but sold inside it; pending as of period end; finalized after period end
    - Conversion Rate denominator is Finalized and is undefined at zero; Quote-to-Sale Rate is separately labeled with its own denominator
    - Duplicate retry excluded; cancelled record excluded; a quote with two outcome records counted once from the latest
    - Manual Quote, Manual Workload, Requote, intake claim, and queue claim each classified from the stored assignment method alone
    - Every cohort state assigns each quote to exactly one of Sold, Not Sold, Still Pending Pricing, Still Awaiting Customer Decision, Still Active
    - _Requirements: 4.1–4.12, 5.1–5.6_

  - [x] 3.5 Write `src/features/reporting/__tests__/credit.test.ts`
    - Created by one employee and priced by another; assigned to one and sold by another; manager changes the assigned agent; source or salesperson changed after creation; sales credit differing from the outcome actor
    - A quote whose `price_sent_at` exists with no `price_sent` event yields a null Pricing Employee and a Missing Documentation signal
    - Every join is by profile id; no assertion depends on a display name
    - _Requirements: 6.2–6.11, 16.2, 16.5_

  - [x] 3.6 Write `src/features/reporting/__tests__/integrity.test.ts`
    - Each signal at, just below, and just above its configured threshold
    - A record that is merely manual raises no flag
    - The non-consuming assignment paths raise no Queue Mismatch for a missing turn event
    - Explained, Confirmed Data Issue, Dismissed, and Reopened transitions; a re-detected signal retains its Review_Status and its earlier explanation
    - _Requirements: 14.2–14.10, 15.5, 15.6_

  - [x] 3.7 Phase 1 verification and commit
    - Run `npx tsc --noEmit`, `npm test`; record both results in the Verification Record
    - Commit `feat(reporting): document sales metric definitions and credit rules`, staging only the spec documents and `src/features/reporting/**`
    - Do not start Phase 3 until this task is recorded complete
    - _Requirements: 20.5_

---

### Phase 2 — Reporting data layer

- [ ] 4. Live object capture
  - [ ] 4.1 Dump the live definitions of the seven objects with no repository DDL
    - `cs_intake_submissions`, `cs_intake_events`, `cs_intake_drivers`, `cs_intake_vehicles`, `dealer_salespeople`, `work_desk_settings`, `quote_take_timers`
    - Write them into `supabase/migrations/v1.12.7-reporting-live-object-dump.sql` as `create table if not exists` so the file is a no-op against production
    - Compare each repository function definition this feature reads against the live definition before relying on it
    - _Requirements: 17.9_

- [ ] 5. Business hours
  - [ ] 5.1 Write `supabase/migrations/v1.12.0-reporting-business-hours.sql`
    - `business_hours_days`, `business_hours_closures`, `business_hours_settings` per the design
    - Seed weekdays 1–6 as working `08:30`–`17:30` and weekday 0 as non-working, reproducing today's hard-coded behavior so the Phase 6 comparison starts from parity
    - `reporting_is_business_hours(timestamptz)`, `security definer`, reading `attendance_policy.business_timezone`; no second copy of the timezone
    - RLS: authenticated read; write reserved to `manager` and `super_admin`
    - Record the rollback statements in a header comment
    - _Requirements: 7.1–7.9, 17.7, 20.6_

  - [ ] 5.2 Write `src/features/reporting/__tests__/business-hours-parity.integration.test.ts`
    - Run the `business-hours.fixtures.ts` corpus against `reporting_is_business_hours` and assert it agrees with `classifyInstant` on every case
    - _Requirements: 7.3, 7.8_

- [ ] 6. Fact views
  - [ ] 6.1 Write `supabase/migrations/v1.12.1-reporting-quote-facts.sql`
    - `reporting_quote_base` resolving one row per Quote_Identity with outcome → pending → active precedence, `accepted_at_raw` nulled when equal to the creation timestamp, and `outcome_record_count` carried forward
    - `reporting_quote_event_rollup` supplying First_Pricing_Sent_At, the four credit actors, the assignment event count, and the after-hours work flag
    - `reporting_quote_facts` joining base, rollup, notes, take events, and intake links, exposing every field named in Requirement 17.2
    - `is_duplicate_retry` derived from the intake link, not read from a column
    - _Requirements: 4.2, 4.6, 5.1–5.7, 6.1–6.11, 8.1–8.5, 16.5, 17.1, 17.2_

  - [ ] 6.2 Write `supabase/migrations/v1.12.2-reporting-workload-facts.sql`
    - `reporting_workload_facts`, one row per non-quote work record, with `is_manual_workload` and `is_queue_workload` as separate flags and every field named in Requirement 17.3
    - _Requirements: 5.2, 5.3, 17.3_

  - [ ] 6.3 Write `supabase/migrations/v1.12.3-reporting-indexes.sql`
    - The indexes listed in the design; skip the six that already exist in `schema.sql`
    - _Requirements: 17.6_

- [ ] 7. Read RPCs
  - [ ] 7.1 Write `supabase/migrations/v1.12.4-reporting-rpcs.sql`
    - `can_manage_sales()` mirroring `canManageSales`, admitting `manager`, `super_admin`, `sales_supervisor`
    - `report_normalize_filters(jsonb)` dropping unknown keys, clamping limits, and defaulting absent values
    - `report_filter_options`, `report_summary`, `report_lifecycle`, `report_needs_attention`, `report_agent_rows`, `report_source_rows`, `report_source_detail`, `report_after_hours_summary`, `report_records`
    - Every function `security definer`, `set search_path = public`, returning zero rows for an unauthorized caller and restricting a Self_Scoped_Reader to rows in which it holds a Credit_Role
    - `report_records` returns `total_count` alongside the page
    - _Requirements: 3.2, 3.3, 4.1–4.12, 9.1–9.5, 10.7, 11.1–11.7, 12.1, 12.2, 12.7, 13.1–13.3, 17.1, 17.4, 17.5, 19.1, 19.3, 19.5, 19.6, 19.8_

  - [ ] 7.2 Write `src/features/reporting/api.ts`
    - One exported function per RPC; no component calls `supabase.rpc` directly
    - _Requirements: 17.1, 17.4_

  - [ ] 7.3 Write `src/features/reporting/__tests__/reporting-rpc.integration.test.ts`
    - Every metric total equals the length of its own `report_records` result for the same filters
    - Pagination returns disjoint pages that sum to `total_count`
    - An `agent` caller receives only rows in which it holds a Credit_Role; a `commercial` caller receives zero rows
    - _Requirements: 10.7, 17.4, 19.3, 19.6_

- [ ] 8. Integrity storage and detection
  - [ ] 8.1 Write `supabase/migrations/v1.12.5-reporting-integrity.sql`
    - `reporting_thresholds` singleton whose columns match `DEFAULT_INTEGRITY_THRESHOLDS`
    - `reporting_integrity_flags` with `unique (subject_kind, subject_id, signal_key)`
    - `reporting_integrity_reviews`, append-only, with a trigger refusing `update` and `delete`
    - `reporting_detect_integrity_flags()` upserting without ever writing `review_status`, `reviewed_by`, `reviewed_at`, or `manager_explanation`
    - No literal threshold anywhere in the file
    - _Requirements: 14.1–14.10, 15.4, 15.5_

  - [ ] 8.2 Write `supabase/migrations/v1.12.6-reporting-integrity-rpcs.sql`
    - `report_integrity_flags` and `report_integrity_review`; the review function additionally requires `is_manager()`
    - RLS on both integrity tables; manager explanations and review history unreadable by a non-Manager_Role profile
    - _Requirements: 15.1–15.8, 19.2, 19.4, 19.6, 19.8_

- [ ] 9. Phase 2 verification and commit
  - [ ] 9.1 Apply, verify, and commit
    - Apply `v1.12.0`–`v1.12.7` in order with `scripts/run-sql.mjs`; record each result
    - Run `npx tsc --noEmit`, `npm test`, `npm run test:integration`, `npm run build`
    - Confirm every Legacy_Report still renders and its numbers are unchanged
    - Commit `feat(reporting): add sales reporting data layer`
    - _Requirements: 1.5, 17.7, 17.8, 20.5_

---

### Phase 3 — Overview

- [ ] 10. Shell, filters, and URL state
  - [ ] 10.1 Create `src/features/reporting/url-state.ts` and its test
    - `parseReportUrl` validating against the closed sets in `definitions.ts`, returning defaults and the list of dropped keys
    - `writeReportUrl` producing a stable key order
    - Test round-trip stability, unknown-value dropping, and sort and pagination persistence
    - _Requirements: 9.6, 9.7, 9.10_

  - [ ] 10.2 Create `ReportingFilters.tsx` and `ReportModeSelector.tsx`
    - The eight window presets, the comparison toggle, the nine dimension filters, the four Hours_Segments, the four After_Hours_Dimensions
    - Source and salesperson linked: selecting a source restricts salesperson options; clearing a source clears an out-of-scope salesperson
    - Filter changes debounced; filter option lists cached
    - _Requirements: 3.1, 3.7, 9.1–9.5, 9.9, 17.5_

  - [ ] 10.3 Create `SalesReportingCenter.tsx`
    - Four views in order, Overview default, persistent filter bar and mode selector, view switch retaining mode and filters and closing the drawer, loading indicator, error state with retry, empty state naming the window and filters
    - _Requirements: 2.1–2.8, 3.7_

- [ ] 11. KPI ribbon, lifecycle, Needs Attention, drawer, export
  - [ ] 11.1 Create `KpiRibbon.tsx` and `MetricDefinitionPopover.tsx`
    - Exactly the eight metrics of Requirement 11.1, each showing its exact value, its definition, its comparison delta when enabled, and each selectable
    - A rate with a zero denominator renders as undefined, never as zero
    - Conversion Rate and Quote-to-Sale Rate each state their denominator
    - _Requirements: 4.7, 4.8, 4.9, 11.1, 11.2, 12.8, 3.5_

  - [ ] 11.2 Create `QuoteLifecycle.tsx`
    - Cohort progression Received → Accepted → Priced → Finalized plus Sold, Not Sold, Pending Pricing, Awaiting Customer Decision, Still Active, each as a count and a percentage, every value legible
    - _Requirements: 3.4, 4.10, 4.11, 11.3, 11.4_

  - [ ] 11.3 Create `NeedsAttention.tsx`
    - The eight conditions of Requirement 11.5, each count selectable into the drawer
    - _Requirements: 11.5, 11.6_

  - [ ] 11.4 Create `RecordDrawer.tsx`
    - Right-anchored, paginated, reporting total matching count, stating the metric definition, applying the same filters that produced the number
    - Per quote row: identifying information, source, salesperson, assignment history, timeline, pricing activity, outcome, notes, field changes, integrity flags
    - A Log action on every quote row opening `QuoteActivityModal` with that row's `source_work_item_id`
    - _Requirements: 10.1–10.8, 16.2_

  - [ ] 11.5 Create `OverviewReport.tsx` and the compact summaries
    - Top agents by volume and by Sold, sources by volume and by conversion, sources with most missing attribution, Manual Quote and Manual Workload totals, after-hours volume; each linking to Agents or Sources with filters unchanged
    - _Requirements: 11.7, 11.8_

  - [ ] 11.6 Create `ExportCurrentView.tsx` and `POST /api/reports/sales/export`
    - One control; Summary CSV and Underlying records CSV in this phase
    - The route re-runs the same RPCs server-side, applies the same authorization, and writes a header stating view, mode, window, hours segment, filters, and generation time in Business_Timezone
    - Refuse beyond the configured maximum record count, stating the limit and the matching count
    - _Requirements: 18.1, 18.3–18.7, 19.7_

  - [ ] 11.7 Register the Reporting Center and relabel the legacy tab
    - `app-sidebar.tsx`: add `sales_reporting_center` to `SubNavId` and a nav item behind `permissions.manageSales`; relabel the existing `sales_reports` item to "Legacy Reports"
    - `role-workspace.tsx`: render `SalesReportingCenter` for the new identifier inside `Suspense`; leave `sales_reports` mapped to the `reports` manager tab
    - `work-desk-app.tsx`: change the Reports tab label to "Legacy Reports" and nothing else
    - Each legacy view states that it is retained for comparison and names its superseding view from `LEGACY_REPORT_MAP`
    - _Requirements: 1.1–1.5, 2.5, 19.1_

  - [ ] 11.8 Phase 3 verification and commit
    - `npx tsc --noEmit`, `npm test`, `npm run build`; confirm export totals equal on-screen totals for three filter states
    - Commit `feat(reporting): add reporting center overview and drill-down`
    - _Requirements: 18.4, 20.5_

---

### Phase 4 — Agents and Sources

- [ ] 12. Agents view
  - [ ] 12.1 Create `AgentsReport.tsx`
    - One expandable table, the eleven default columns and the sixteen expandable columns, sortable with sort in the URL, no composite score
    - Quotes per scheduled hour from `employee_schedules`, undefined when scheduled hours are zero or absent
    - _Requirements: 12.1–12.4, 12.7, 12.8_

  - [ ] 12.2 Create the agent detail drawer
    - KPI summary, lifecycle, source mix, assignment-method mix, Manual Quote history, Manual Workload history, after-hours activity, pending work, Not Sold reasons, integrity flags, underlying records
    - Quotes created, claimed, priced, credited, and outcome-entered reported separately
    - _Requirements: 12.5, 12.6, 6.10_

- [ ] 13. Sources view
  - [ ] 13.1 Create `SourcesReport.tsx`
    - The thirteen columns of Requirement 13.1; a quote with no source labeled distinctly from a source that cannot be found, and never omitted
    - _Requirements: 13.1, 13.2_

  - [ ] 13.2 Add the source expansion and health conditions
    - The eleven breakdowns of Requirement 13.3; the nine named conditions of Requirement 13.5 with their configured thresholds stated and their causing data shown; no composite score
    - _Requirements: 13.3–13.7_

- [ ] 14. Excel and PDF export
  - [ ] 14.1 Obtain approval for the two export dependencies
    - `exceljs` and `pdfkit`, pinned to exact versions; do not install before a profile holding Manager_Role approves
    - _Requirements: 18.2_

  - [ ] 14.2 Add the Excel workbook and PDF snapshot formats
    - Both produced by the same route from the same RPC results as the CSV formats, carrying the same header and the same authorization
    - _Requirements: 18.2–18.7, 19.7_

- [ ] 15. Phase 4 verification and commit
  - [ ] 15.1 Verify and commit
    - `npx tsc --noEmit`, `npm test`, `npm run build`
    - Commit `feat(reporting): add agent and source reporting views`
    - _Requirements: 20.5_

---

### Phase 5 — Review & Integrity and After Hours

- [ ] 16. Review & Integrity view
  - [ ] 16.1 Create `IntegrityReport.tsx`
    - The fourteen saved filters, paginated, each flag listed with the data that caused it
    - _Requirements: 15.1, 15.8, 14.9_

  - [ ] 16.2 Add the review workflow
    - Open evidence, view audit history, view related quote, view related queue event, add explanation, mark Explained, Confirm Data Issue, Dismiss, Reopen
    - Explained and Confirmed Data Issue require a non-empty explanation
    - Every action appends an immutable history entry; a non-Manager_Role profile is refused and the flag is unchanged
    - _Requirements: 15.2–15.7, 19.2, 19.4_

- [ ] 17. After-hours reporting
  - [ ] 17.1 Apply the Hours_Segment and After_Hours_Dimension filters to all four views
    - Confirm no view has its own after-hours mode toggle and no after-hours Report_View exists
    - _Requirements: 8.7_

  - [ ] 17.2 Add the After-Hours summary
    - The ten measures of Requirement 8.8, each selectable into the drawer
    - _Requirements: 8.8, 10.1_

  - [ ] 17.3 Add the Business Hours settings screen
    - Per-weekday working flag and times, Sunday handling, holidays, special closures; writable only by a Manager_Role profile; every change recorded with the changing profile and time
    - _Requirements: 7.1, 7.2, 7.4, 7.5, 7.7_

- [ ] 18. Historical accuracy surfacing
  - [ ] 18.1 Report field changes and their timing
    - Expose for source, salesperson, assignment, outcome, and assigned agent whether the field changed after creation, with the change time and changing profile; state where a value is not historically preserved
    - Count a post-finalization change as its own condition without altering that period's Sold, Not Sold, or Finalized counts
    - _Requirements: 16.1–16.5_

- [ ] 19. Phase 5 verification and commit
  - [ ] 19.1 Verify and commit
    - `npx tsc --noEmit`, `npm test`, `npm run test:integration`, `npm run build`
    - Commit `feat(reporting): add integrity review and after-hours reporting`
    - _Requirements: 20.5_

---

### Phase 6 — Legacy comparison

- [ ] 20. Reconciliation
  - [ ] 20.1 Add `report_reconciliation(p_start, p_end)`
    - Compute each new metric and its legacy counterpart over the same window, returning both values, the difference, and the ids of records counted differently
    - Compute the legacy side using the legacy rules as they run in production, including their defects, so an intended difference is distinguishable from a new bug
    - _Requirements: 20.1, 20.2_

  - [ ] 20.2 Run the comparison over one complete reporting period and write `legacy-comparison.md`
    - Every material difference with the metric, both values, the definition that changed, the timestamp that changed, and the differing record ids
    - Confirm or correct each difference predicted in the design's comparison table
    - Count the `audit_log` rows with `action = 'quote_deleted'` in the period, since a deletion after the period ended changes that period's totals
    - _Requirements: 20.1, 20.2, 20.4, 16.1, 16.4_

  - [ ] 20.3 Confirm every Legacy_Report is retained
    - Confirm all 24 views still render with unchanged numbers and that no removal has occurred
    - Record that removal awaits explicit Manager_Role approval
    - _Requirements: 1.1, 1.2, 1.3, 20.3_

- [ ] 21. Deployment, rollback, and evidence
  - [ ] 21.1 Write the deployment and rollback steps
    - Migration order, the verification query after each, and the rollback statements for `v1.12.0`–`v1.12.7`
    - No automatic deployment
    - _Requirements: 17.7, 20.6_

  - [ ] 21.2 Write the final evidence report
    - Files changed, database objects changed, tests run, build result, the four views as displayed, example drill-downs, an example integrity review, an example after-hours filter, known limitations, remaining data gaps
    - _Requirements: 20.7_

  - [ ] 21.3 Final verification and commit
    - `npx tsc --noEmit`, `npm test`, `npm run test:integration`, `npm run build`
    - Commit `docs(reporting): record legacy comparison and evidence`
    - _Requirements: 20.5_

---

## Verification Record

### Pre-branch working tree

Recorded at task 0.1, on `feature/renewals-cancellations` at commit `b34184c` (identical to `origin/main`):

```
 M .kiro/specs/policy-follow-up-renewals-cancellations/tasks.md
 M .kiro/specs/time-attendance-ui-redesign/tasks.md
 M .kiro/specs/time-attendance-ui-redesign/tasks.meta.json
?? .kiro/specs/policy-follow-up-renewals-cancellations/.config.kiro
?? .kiro/specs/policy-follow-up-renewals-cancellations/design.md
?? .kiro/specs/policy-follow-up-renewals-cancellations/requirements.md
?? .kiro/specs/policy-follow-up-renewals-cancellations/tasks.meta.json
?? .kiro/specs/rc-claim-duplicate-quote-fix/
?? .kiro/tmp-verify.sql
?? supabase/migrations/v1.11.3-schedule-templates.sql
?? supabase/migrations/v1.11.4-saturday-1000-open-and-diana-1500.sql
?? supabase/migrations/v1.11.5-aug3-clockin-0830-repair.sql
?? supabase/migrations/v1.11.6-zaira-ortiz-saturdays-only.sql
```

No path is inside `src/features/reporting`, `supabase/migrations/v1.12*`, or this spec directory. Every one is unrelated to this feature and is left unstaged.

### Phase results

| Phase | `npx tsc --noEmit` | `npm test` | `npm run build` | Commit |
| --- | --- | --- | --- | --- |
| 1 | pass, 0 errors | 157/157 reporting tests pass; 2,496 pass repo-wide with 3 pre-existing failures unrelated to this feature | pass | `feat(reporting): document sales metric definitions and credit rules` |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| 6 | | | | |

### Phase 1 verification detail

- `npx tsc --noEmit` — exit 0, no diagnostics.
- `npx vitest --run src/features/reporting` — 4 files, **157 tests, all passing**.
- `npm test` — 2,496 passing, 38 skipped, **3 failing in 2 files that this feature does not touch**:
  - `src/features/cancellations/__tests__/cancellations-summary-bar.test.tsx` (2), from the in-progress `policy-follow-up-renewals-cancellations` work already present in the working tree before this branch.
  - `src/features/quotes/__tests__/duplicate-validation.test.ts` (1), a `fast-check` property on a 500-character reason limit.
  - Confirmed unrelated: nothing outside `src/features/reporting` imports it, and neither failing file references it. This feature's only additions are two new untracked directories.
- `npm run build` — pass, all routes compiled.

### Phase 1 correction to the audit

The initial audit recorded **23** report views. The `ReportView` union in
`src/components/work-desk-app.tsx` lines 268–292 declares **24**, and
`reportNavigationGroups` confirms it: Command Center 3, Sales 4, People 4, Queues 4,
Service 5, Control 4. Every document in this spec says 24, and `LEGACY_REPORT_MAP`
holds 24 entries with a test asserting the count.

### Phase 1 decisions carried forward

1. **Report_Reader_Role is `canManageSales`** — `manager`, `super_admin`, `sales_supervisor` — because `sales_supervisor` reaches the Reports tab today and narrowing it would be an unrequested regression. Integrity **review actions** are narrower: `manager` and `super_admin` only, matching "Integrity review actions must be manager-only". Changing that is one line in the `report_integrity_review` guard.
2. **Business_Timezone is not duplicated.** It is read from the existing `attendance_policy.business_timezone`. A second copy would be a second answer to when the office is open.
3. **Business hours seed to today's hard-coded window** (Mon–Sat 08:30–17:30, Sunday closed) so the Phase 6 comparison starts from parity.
4. **Excel and PDF export need two new dependencies** (`exceljs`, `pdfkit`, pinned). Task 14.1 gates Phase 4 on approval. Phase 3 ships both CSV formats with no new dependency.
5. **`created → price_sent` is the authoritative pricing interval**, not `accepted → price_sent`. The repository currently has both under the same name.
