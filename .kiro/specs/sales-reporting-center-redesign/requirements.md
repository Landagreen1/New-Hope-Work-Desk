# Requirements Document

## Introduction

Replace the 24 overlapping sales reports currently rendered inside `src/components/work-desk-app.tsx` with one Sales Reporting Center containing exactly four views — Overview, Agents, Sources, and Review & Integrity — driven by a persistent global filter bar, a report-mode selector, and server-side aggregation.

The 24 existing reports stay reachable under a **Legacy Reports** heading until their values have been compared against the new center for at least one complete reporting period and a profile holding Manager_Role approves their removal.

After Hours becomes a global filter dimension applied to all four views instead of the single separate report it is today. Queue Health, Pass Behavior, Missed Turns, and Recovered Quotes are queue-operations reports rather than sales reports; they stay under Legacy Reports and are out of scope for the four primary views.

### Current-state audit (verified in this repository)

**Report surfaces.** Every sales report lives in `src/components/work-desk-app.tsx` (12,539 lines). The `ReportView` union declares 24 views (lines 268–292), `reportNavigationGroups` supplies their labels and descriptions in 6 groups (lines 294–500), and a flat `if` chain renders them (lines 8683–8795). Six clickable `SummaryCard` KPIs sit above the report library (lines 8514–8562): Total Quotes, New Quotes, Requotes, Sold, Not Sold, Pending Pricing. Date presets are Today / Yesterday / Last 7 Days / This Month (lines 6558–6569). Eight CSV export buttons sit below every report (lines 8797–8845).

**Aggregation.** All 24 reports are computed by one client-side `useMemo` named `reportData` (lines 6571–7452). Its only data source is `loadDashboardData()` in `src/lib/dashboard-data.ts` (lines 187–330), which issues 15 parallel unaggregated `.select()` calls with hard row caps: `work_items` 5,000, `pending_pricing_quotes` 5,000, `quote_outcomes` 10,000, `quote_notes` 20,000, `work_item_events` 30,000, `quote_take_events` 10,000, `turn_events` (pass only) 10,000. There is no server-side sales aggregation anywhere; the only server-aggregated reports in the repository are `src/app/api/commercial-quotes/reports/timing/route.ts` and `src/app/api/attendance/*`.

**The quote universe is a three-table union rebuilt in the browser.** A quote lives in `work_items` while active, moves to `pending_pricing_quotes` when pricing is sent, and moves to `quote_outcomes` when finalized. `reportData` unions the three (lines 6572–6656) but filters them on **different timestamps**: active and pending rows are filtered on creation date, outcome rows on finalization date. A `quote_reporting_feed` view performing the same union already exists in `supabase/schema.sql` (lines 942–990) and is not used by the UI.

**Known metric defects.**
- Three different numbers are all labeled "pending": the summary card uses `pendingPricing.length` and ignores the date range entirely, `reportData.pending` filters on `quote_created_at`, and `reportData.pendingInRange` filters on `price_sent_at`.
- `efficiency` is `finalized ÷ quotes` and `conversion` is `sold ÷ finalized`; both are displayed side by side without stating which denominator each uses.
- Agent rows are joined by **display-name string equality** (`item.agent === agent.name`, lines 6716 and 6742), so renaming an employee silently detaches their history.
- `accepted_at` is coalesced to `quote_created_at` for pending and outcome rows (`src/lib/dashboard-data.ts` lines 394 and 421), which silently reports "time to accept" as zero for every backfilled row.
- Duplicate detection is a client-side `customer|source` key collision count (lines 6946–6957).
- Manager intervention and activation credit are inferred by regular expression over `work_item_events.event_type` (`/assign|reassign|manager|delete|rotation/i` line 6959, `/activation/i` line 6962).
- `agentScorecards` publishes a single weighted composite score (lines 7181–7188: efficiency 0.22, conversion 0.22, note coverage 0.18, pricing speed 0.18, unaccepted 0.10, recoveries 0.10).

**After-hours logic.** `getEstTime` / `isAfterHours` / `isSunday` (lines 11007–11052) hard-code Monday–Saturday 08:30–17:30, treat Sunday as a separate mode, and know nothing about holidays or closures. `getEstTime` converts through `toLocaleString('en-US', { timeZone: 'America/New_York' })` and re-parses the result with `new Date(...)`, which is locale- and engine-dependent.

**Data model.** `work_items`, `pending_pricing_quotes`, and `quote_outcomes` each carry `customer_name`, `dealer_id`, `salesperson_id`, `work_type`, `original_owner_profile_id`, `assigned_profile_id`, `assignment_method`, `received_through`, and their own lifecycle timestamps. `work_items` alone carries `created_by`. `assignment_method` is the discriminator that separates queue claims from manual entry: `whatsapp_turn`, `ringcentral_turn` (also used by Customer Service intake claims so quote credit lands in `daily_agent_performance.ringcentral_quotes`), `workload_turn`, `manual_quote`, `manual_workload`, `update_log`, `payment_log`, `owner`, `manager_manual`, `customer_service`. `dealers` are sources and `dealer_salespeople` are salespeople. Supporting event tables: `work_item_events`, `quote_notes`, `quote_take_events`, `turn_events`, `cs_intake_events`, `audit_log`.

**There is no `priced_by` and no `sold_by` column.** Pricing credit and sale credit both currently resolve to `assigned_profile_id` on the row that happens to hold the quote. Only `work_item_events.actor_profile_id` records who actually performed an act.

**`quote_outcomes` has no unique constraint on `source_work_item_id`**, so one quote can hold more than one outcome row.

**Duplicates are real and carry no flag.** `.kiro/specs/rc-claim-duplicate-quote-fix/bugfix.md` documents a live defect in which claiming one RingCentral intake produces two quote records. Duplicate detection must therefore be derived, not read from a column.

**Permissions.** Report access today is UI-only: `src/components/app-sidebar.tsx` line 150 places `sales_reports` behind `permissions.manageSales`, and `src/components/role-workspace.tsx` lines 81–82 map it to the `reports` manager tab. Every underlying table is readable by any authenticated user — `supabase/schema.sql` lines 1027–1055 grant `select ... using (true)` on `profiles`, `dealers`, `rotation_state`, `work_items`, `pending_pricing_quotes`, `quote_outcomes`, and `turn_events`. Only `audit_log` is gated, by `public.is_manager()`.

**Exports.** `downloadCsv` (lines 829–846) builds a CSV in the browser from the already-loaded rows. There is no Excel writer and no PDF generator in the repository and no export library in `package.json`.

**Tooling.** `npm test` runs `vitest --run`; `vitest.config.ts` sets `environment: 'node'`, so component tests need a `// @vitest-environment jsdom` docblock. There is **no `typecheck` script**; the type check is `npx tsc --noEmit`. Migrations are flat files named `v<semver>-<description>.sql`; the latest is `v1.11.6-zaira-ortiz-saturdays-only.sql`, so this feature's migrations begin at `v1.12.0`. Business-hours precedent exists in `attendance_policy.business_timezone` (default `America/New_York`) and `attendance_closed_dates` from `v1.9.0-attendance-foundations.sql`, and holiday precedent in `cancellation_settings.holidays date[]` from `v1.10.4-cancellation-settings.sql`. No shared business-hours utility exists.

**Missing repository DDL.** `cs_intake_submissions`, `cs_intake_events`, `cs_intake_drivers`, `cs_intake_vehicles`, `dealer_salespeople`, `work_desk_settings`, and `quote_take_timers` have no `create table` anywhere under `supabase/`; they exist only in live Supabase. Their live definitions must be dumped before the reporting data layer is written against them.

**Quote Log coverage gap.** The workspace Quote Log rule requires a Log action on every quote list. In the reports area `onOpenQuoteLog` is wired only to `NotSoldReport` (line 8688), `ReportDrillDownTable` (line 8569), and `AfterHoursReport` (line 8794). The other views that list quote rows — Quote Timing detail, Pending Follow-Up, Recovered Quotes detail, Activation & Sold Audit, Raw Activity, Source Intelligence, and Data Integrity — have no Log action.

---

## Glossary

- **Sales_Reporting_Center**: The single reporting surface containing the four Report_Views, the Report_Mode selector, and the global filter bar.
- **Report_View**: One of exactly four values: Overview, Agents, Sources, Review & Integrity.
- **Legacy_Reports**: The 24 pre-existing report views, retained unchanged under their own heading for comparison.
- **Report_Mode**: One of exactly two values: Operational Activity, Quote Cohort.
- **Reporting_Window**: The inclusive start and end calendar dates selected in the global filter bar, interpreted in Business_Timezone.
- **Report_End_Instant**: The last instant of the Reporting_Window's end date in Business_Timezone. Every as-of-date metric is evaluated at this instant.
- **Business_Timezone**: The value of `attendance_policy.business_timezone`, `America/New_York`.
- **Business_Hours_Settings**: The stored configuration of office opening time, office closing time, working days, Sunday handling, holidays, and special office closures.
- **Business_Hours**: An instant that falls on a Working_Day, at or after the opening time and before the closing time for that day, in Business_Timezone.
- **After_Hours**: An instant that is not within Business_Hours.
- **Working_Day**: A weekday enabled in Business_Hours_Settings that is neither a holiday nor a special office closure.
- **Hours_Segment**: One of All Hours, Business Hours, After Hours, Sunday.
- **After_Hours_Dimension**: One of Received After Hours, Worked After Hours, Finalized After Hours, Manual Entry After Hours.
- **Quote_Identity**: `work_items.id`, carried forward as `source_work_item_id` by `pending_pricing_quotes` and `quote_outcomes`. Exactly one Quote_Fact exists per Quote_Identity.
- **Quote_Fact**: One reporting record per Quote_Identity, carrying its attributes, its five lifecycle timestamps, its credit assignments, its after-hours flags, and its integrity indicators.
- **Workload_Fact**: One reporting record per non-quote work record.
- **Integrity_Flag**: One reporting record per detected discrepancy, carrying a Flag_Type, a severity, an explanation, its supporting evidence, and its Review_Status.
- **Flag_Type**: One of Needs Review, Attribution Conflict, Missing Documentation, Queue Mismatch, Manual Entry Pattern, Duplicate Activity, Timing Conflict.
- **Review_Status**: One of Open, Explained, Confirmed Data Issue, Dismissed.
- **Manual_Quote**: A quote whose stored assignment method is `manual_quote`.
- **Manual_Workload**: A Workload_Fact whose stored assignment method is `manual_workload`.
- **Requote**: A quote whose `work_type` is `requote`, or a quote carrying a non-null `related_quote_source_work_item_id`.
- **Excluded_Record**: A quote or workload record that no metric counts: a cancelled record, a Duplicate_Retry, or a record marked deleted.
- **Duplicate_Retry**: A quote record that is not the earliest quote record linked to a given `cs_intake_submissions` row, where two or more quote records share that link.
- **Credit_Role**: One of Created By, Claimed By, Assigned Agent, Pricing Employee, Outcome Employee, Sales_Credit_Owner.
- **Sales_Credit_Owner**: The single employee credited with a sale, defined by Requirement 6.
- **Report_Reader_Role**: A profile role for which `canManageSales` returns true — `manager`, `super_admin`, `sales_supervisor`.
- **Manager_Role**: A profile role for which `isBroadManagerRole` returns true — `manager` or `super_admin`.
- **Integrity_Reviewer_Role**: Report_Reader_Role. Recording a review decision is reserved to these roles. Byron confirmed on 2026-08-03 that sales supervisors may review flags, so this is the same set as Report_Reader_Role rather than the narrower Manager_Role.
- **Self_Scoped_Reader**: A profile that is not a Report_Reader_Role and may read only its own reporting records.

---

## Requirements

### Requirement 1: Legacy Reports preservation

**User Story:** As a manager, I want the reports I use today to keep working while the new center is validated, so that no number I rely on disappears before I trust its replacement.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL present the 24 Legacy_Reports under a heading labeled "Legacy Reports", reachable from the Sales module, and SHALL retain for each of them the label, description, metrics, and record set the pre-redesign implementation displayed for identical input.
2. THE Sales_Reporting_Center SHALL exclude removals of, and behavioral changes to, every Legacy_Report view until a profile holding Manager_Role records approval of that removal.
3. THE Sales_Reporting_Center SHALL keep Queue Health, Pass Behavior, Missed Turns, and Recovered Quotes outside the four Report_Views and SHALL keep them reachable under Legacy_Reports.
4. WHEN a user selects a Legacy_Report, THE Sales_Reporting_Center SHALL indicate that the view is retained for comparison and SHALL name the Report_View that supersedes it, or state that no Report_View supersedes it.
5. THE Sales_Reporting_Center SHALL exclude changes to `src/lib/dashboard-data.ts` that remove a field or reduce a row limit any Legacy_Report reads.

---

### Requirement 2: Sales Reporting Center shell

**User Story:** As a manager, I want one reporting surface with four views, so that I stop hunting through a library of 24 reports to answer one question.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL present exactly four Report_Views, labeled Overview, Agents, Sources, and Review & Integrity, in that order.
2. WHEN a user opens the Sales_Reporting_Center without a Report_View named in the URL, THE Sales_Reporting_Center SHALL select Overview.
3. THE Sales_Reporting_Center SHALL render the global filter bar and the Report_Mode selector persistently, above the active Report_View, on every one of the four Report_Views.
4. WHEN a user switches Report_View, THE Sales_Reporting_Center SHALL retain the active Report_Mode, Reporting_Window, comparison setting, Hours_Segment, After_Hours_Dimension selection, and every dimension filter unchanged, and SHALL close the open Record_Drawer.
5. THE Sales_Reporting_Center SHALL reside in a dedicated reporting feature directory and SHALL add no report rendering, no report aggregation, and no report state to `src/components/work-desk-app.tsx`.
6. WHILE a Report_View is loading its first result set, THE Sales_Reporting_Center SHALL display a loading indicator in place of that view's content until the query returns data or returns an error.
7. IF a Report_View query returns an error, THEN THE Sales_Reporting_Center SHALL display a message naming the failed report query together with a retry control, and SHALL retain the active Report_Mode, Reporting_Window, and every filter unchanged.
8. WHEN a Report_View query returns zero records, THE Sales_Reporting_Center SHALL display an empty state that names the active Reporting_Window and the active filters and offers a control that clears every dimension filter.

---

### Requirement 3: Report modes

**User Story:** As a manager, I want to choose between "what work happened" and "what became of the quotes we received", so that a single number is never the accidental blend of both.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL offer exactly two Report_Modes, labeled Operational Activity and Quote Cohort, and SHALL select Operational Activity when no Report_Mode is named in the URL.
2. WHILE Report_Mode is Operational Activity, THE Sales_Reporting_Center SHALL count each metric by the timestamp of the event that metric measures, and SHALL count a quote in a metric independently of whether that quote was created inside the Reporting_Window.
3. WHILE Report_Mode is Quote Cohort, THE Sales_Reporting_Center SHALL restrict every metric to the set of quotes whose creation timestamp falls inside the Reporting_Window, and SHALL evaluate each of those quotes' progress as of the Report_End_Instant.
4. THE Sales_Reporting_Center SHALL compute the quote lifecycle funnel from Quote Cohort mode only, and SHALL exclude Operational Activity counts from every funnel denominator.
5. THE Sales_Reporting_Center SHALL display, adjacent to every metric, which Report_Mode produced it and which timestamp it was counted by.
6. THE Sales_Reporting_Center SHALL exclude any single displayed ratio whose numerator and denominator come from different Report_Modes.
7. WHEN a user switches Report_Mode, THE Sales_Reporting_Center SHALL retain the Reporting_Window, the Hours_Segment, and every dimension filter unchanged, and SHALL recompute every displayed metric.

---

### Requirement 4: Authoritative quote metric definitions

**User Story:** As a manager, I want each metric to have exactly one stated definition, so that two reports cannot disagree about the same word.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL count in **Quotes Received** each distinct Quote_Identity whose creation timestamp falls inside the Reporting_Window, SHALL count each Quote_Identity at most once, and SHALL exclude every Excluded_Record, every Workload_Fact, and every intake submission that produced no quote record.
2. THE Sales_Reporting_Center SHALL count in **Pricing Sent** each distinct Quote_Identity whose First_Pricing_Sent_At falls inside the Reporting_Window, SHALL derive First_Pricing_Sent_At as the earliest of the `price_sent_at` value held by the quote's lifecycle row and the creation time of its earliest `work_item_events` row whose `event_type` is `price_sent`, and SHALL exclude a quote from Pricing Sent when neither source exists.
3. THE Sales_Reporting_Center SHALL exclude from Pricing Sent every quote whose only evidence of pricing is a note, its creation, its outcome, or a stored status value unaccompanied by a `price_sent_at` value or a `price_sent` event.
4. THE Sales_Reporting_Center SHALL count in **Pending Pricing** each distinct Quote_Identity that, as of the Report_End_Instant, exists, is not finalized, has no First_Pricing_Sent_At at or before the Report_End_Instant, and is not an Excluded_Record, and SHALL count Pending Pricing independently of whether the quote was created inside the Reporting_Window.
5. THE Sales_Reporting_Center SHALL count in **Sold** each distinct Quote_Identity whose Final_Outcome is Sold and whose Finalized_At falls inside the Reporting_Window, SHALL count in **Not Sold** each distinct Quote_Identity whose Final_Outcome is Not Sold and whose Finalized_At falls inside the Reporting_Window, and SHALL report **Finalized** as the sum of Sold and Not Sold over the same Reporting_Window.
6. WHERE a Quote_Identity holds more than one outcome record, THE Sales_Reporting_Center SHALL take the outcome record with the latest finalization timestamp as the Final_Outcome and Finalized_At, SHALL count that Quote_Identity exactly once in Sold or Not Sold, and SHALL raise a Timing Conflict Integrity_Flag naming every superseded outcome record.
7. THE Sales_Reporting_Center SHALL compute **Conversion Rate** as Sold ÷ Finalized, SHALL display it as undefined when Finalized is zero, and SHALL exclude Quotes Received from its denominator.
8. WHERE Sold ÷ Quotes Received is displayed, THE Sales_Reporting_Center SHALL label it **Quote-to-Sale Rate**, and WHERE both ratios are displayed, THE Sales_Reporting_Center SHALL label them separately and state each denominator.
9. THE Sales_Reporting_Center SHALL compute **Median Time to Pricing** as the median of First_Pricing_Sent_At minus the creation timestamp over exactly the quotes counted in Pricing Sent under the active Report_Mode, and SHALL display it as undefined when that set is empty.
10. WHILE Report_Mode is Quote Cohort, THE Sales_Reporting_Center SHALL report, over the quotes counted in Quotes Received, the counts Accepted, Priced, Sold, Not Sold, Still Pending Pricing, Still Awaiting Customer Decision, and Still Active, each evaluated as of the Report_End_Instant, and SHALL count each quote in exactly one of Sold, Not Sold, Still Pending Pricing, Still Awaiting Customer Decision, and Still Active.
11. THE Sales_Reporting_Center SHALL treat a quote as Still Awaiting Customer Decision WHERE it has a First_Pricing_Sent_At at or before the Report_End_Instant and no Final_Outcome as of the Report_End_Instant.
12. THE Sales_Reporting_Center SHALL exclude an outcome recorded after the Report_End_Instant from every metric evaluated for that Reporting_Window.

---

### Requirement 5: Record classification

**User Story:** As a manager, I want Manual Quotes, Manual Workloads, requotes, and queue claims counted as distinct things, so that manual entry is visible rather than blended into queue activity.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL classify a quote as a Manual_Quote WHERE and only WHERE its stored assignment method is `manual_quote`, and SHALL exclude a missing source, a missing salesperson, and a missing channel from that determination.
2. THE Sales_Reporting_Center SHALL classify a work record as a Manual_Workload WHERE and only WHERE it is not a quote and its stored assignment method is `manual_workload`.
3. THE Sales_Reporting_Center SHALL report Manual_Quote counts and Manual_Workload counts as separate metrics, and SHALL exclude from both of them workload turn assignments, quotes, Customer Service intake claims, and automatically created service tasks.
4. THE Sales_Reporting_Center SHALL classify a quote as a Requote WHERE its `work_type` is `requote` or its `related_quote_source_work_item_id` is non-null, and SHALL classify every other quote as a New Quote.
5. THE Sales_Reporting_Center SHALL classify a quote as a Customer Service intake quote WHERE a `cs_intake_submissions` row links to its Quote_Identity, SHALL report that classification separately from its assignment method, and SHALL keep its assignment method value as stored.
6. THE Sales_Reporting_Center SHALL report the assignment method of every Quote_Fact and Workload_Fact using the stored value, and SHALL exclude derivation of assignment method from any other field.
7. THE Sales_Reporting_Center SHALL treat a walk-in intake quote as a Customer Service intake quote whose assignment method is `ringcentral_turn`, SHALL report whether its claim consumed a rotation turn using the `consumed_turn` value recorded in its audit detail, and SHALL exclude an out-of-turn walk-in claim from every missed-turn and turn-count metric.

---

### Requirement 6: Agent credit rules

**User Story:** As a manager, I want to see who created, claimed, priced, sold, and closed each quote, so that one "agent" column stops standing in for five different people.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL record on every Quote_Fact six distinct Credit_Roles — Created By, Claimed By, Assigned Agent, Pricing Employee, Outcome Employee, and Sales_Credit_Owner — each holding a profile identifier or null.
2. THE Sales_Reporting_Center SHALL resolve Created By from `work_items.created_by`.
3. THE Sales_Reporting_Center SHALL resolve Claimed By from the actor of the quote's earliest `accepted` event, and WHERE no such event exists, from the assigned profile of the quote's earliest `assigned` event, and WHERE neither exists, as null.
4. THE Sales_Reporting_Center SHALL resolve Assigned Agent from the `assigned_profile_id` held by the quote's current lifecycle row.
5. THE Sales_Reporting_Center SHALL resolve Pricing Employee from the actor of the quote's earliest `price_sent` event, and WHERE no such event exists and a `price_sent_at` value exists, as null accompanied by a Missing Documentation Integrity_Flag.
6. THE Sales_Reporting_Center SHALL resolve Outcome Employee from the actor of the `sold` or `not_sold` event that corresponds to the Final_Outcome, and WHERE no such event exists, as null.
7. THE Sales_Reporting_Center SHALL resolve Sales_Credit_Owner as the Assigned Agent held by the quote's outcome record at the moment of finalization, SHALL keep that value unchanged when the assigned agent changes after finalization, and SHALL report every such later change as a distinct field-change record.
8. WHERE Sales_Credit_Owner and Outcome Employee differ, THE Sales_Reporting_Center SHALL report both and SHALL raise an Attribution Conflict Integrity_Flag.
9. THE Sales_Reporting_Center SHALL join every reporting record to an employee by profile identifier, and SHALL exclude joining reporting records to employees by display name.
10. THE Sales_Reporting_Center SHALL attribute a metric to the Credit_Role that metric measures, SHALL state that Credit_Role wherever the metric is displayed, and SHALL exclude attributing pricing, sale, and outcome metrics to a single undifferentiated agent field.
11. THE Sales_Reporting_Center SHALL report the Original Owner of every quote whose current assigned agent differs from its `original_owner_profile_id`.

---

### Requirement 7: Business hours configuration

**User Story:** As a manager, I want to configure the office hours, closures, and holidays the reports use, so that after-hours numbers stay correct when the schedule changes.

#### Acceptance Criteria

1. THE Business_Hours_Settings SHALL store, per weekday, whether that weekday is a working day, the office opening time, and the office closing time, and SHALL store the list of holidays and the list of special office closures as calendar dates.
2. THE Business_Hours_Settings SHALL store its times as wall-clock times interpreted in Business_Timezone, and SHALL exclude storing an offset in place of Business_Timezone.
3. THE Sales_Reporting_Center SHALL read Business_Hours_Settings from stored configuration, and SHALL exclude hard-coded opening times, closing times, working days, and holiday dates from every report component and every reporting query.
4. THE Sales_Reporting_Center SHALL permit a profile holding Manager_Role to change every value in Business_Hours_Settings, and SHALL refuse such a change from every other role.
10. THE Business_Hours_Settings SHALL be seeded with Monday through Saturday as working days opening at 08:30 and closing at 17:30, with Sunday not a working day, and SHALL classify every instant outside that window as After_Hours.
5. THE Sales_Reporting_Center SHALL store Sunday handling as its own setting, and SHALL classify an instant that falls on a Sunday as Sunday in addition to classifying it as Business_Hours or After_Hours according to that setting.
6. THE Sales_Reporting_Center SHALL classify an instant falling on a holiday or a special office closure as After_Hours regardless of the time of day.
7. WHEN Business_Hours_Settings changes, THE Sales_Reporting_Center SHALL apply the changed values to every subsequently computed report, SHALL record the change with the changing profile and the change time, and SHALL exclude silently altering a previously exported report without stating that the settings changed.
8. THE Sales_Reporting_Center SHALL classify an instant correctly across a daylight-saving transition in Business_Timezone, including an instant on the day a transition occurs.
9. THE Sales_Reporting_Center SHALL treat the opening time as inclusive and the closing time as exclusive when classifying an instant as Business_Hours.

---

### Requirement 8: After-hours dimensions

**User Story:** As a manager, I want after-hours receiving separated from after-hours working, so that a quote that arrived at midnight and was priced at 9 a.m. is not reported as after-hours work.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL compute four independent After_Hours_Dimensions per Quote_Fact: Received After Hours, Worked After Hours, Finalized After Hours, and Manual Entry After Hours, and SHALL exclude deriving any of them from a single stored after-hours flag.
2. THE Sales_Reporting_Center SHALL set Received After Hours WHERE the quote's creation timestamp is After_Hours.
3. THE Sales_Reporting_Center SHALL set Worked After Hours WHERE at least one of the quote's claim, acceptance, note, pricing, follow-up, or other recorded work events occurred After_Hours, and SHALL exclude the quote's creation timestamp from that determination.
4. THE Sales_Reporting_Center SHALL set Finalized After Hours WHERE the quote's Finalized_At is After_Hours.
5. THE Sales_Reporting_Center SHALL set Manual Entry After Hours WHERE the record is a Manual_Quote or a Manual_Workload and its creation timestamp is After_Hours.
6. THE Sales_Reporting_Center SHALL exclude classifying a quote as after-hours work solely because Received After Hours is set.
7. WHEN a user selects an Hours_Segment or an After_Hours_Dimension, THE Sales_Reporting_Center SHALL apply that selection to all four Report_Views, and SHALL exclude presenting after-hours activity as a separate Report_View.
8. THE Sales_Reporting_Center SHALL present an After-Hours summary reporting quotes received after hours, quotes worked after hours, quotes finalized after hours, Manual_Quotes entered after hours, Manual_Workloads entered after hours, after-hours Conversion Rate, median wait until first recorded action, the count of quotes whose first recorded action occurred on a later Working_Day, the sources producing after-hours quotes, and the employees performing after-hours work.

---

### Requirement 9: Global filters and URL state

**User Story:** As a manager, I want to share a filtered report as a link and have Back work, so that a report I found is a report I can send.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL offer these Reporting_Window presets: Today, Yesterday, Last 7 days, Current week, Previous week, Current month, Previous month, and Custom range.
2. THE Sales_Reporting_Center SHALL offer a comparison setting that, while enabled, computes every KPI over the previous period of equal length immediately preceding the Reporting_Window.
3. THE Sales_Reporting_Center SHALL offer dimension filters for agent, team, source, salesperson, input channel, New Quote or Requote, assignment method, quote status, and outcome, and SHALL permit more than one dimension filter to be active at the same time.
4. THE Sales_Reporting_Center SHALL offer the Hours_Segment values All Hours, Business Hours, After Hours, and Sunday, and the After_Hours_Dimension selections Received After Hours, Worked After Hours, Finalized After Hours, and Manual Entry After Hours.
5. WHEN a source filter is selected, THE Sales_Reporting_Center SHALL restrict the salesperson filter options to the salespeople belonging to that source, and WHEN the source filter is cleared, THE Sales_Reporting_Center SHALL clear a salesperson selection that does not belong to the remaining source scope.
6. THE Sales_Reporting_Center SHALL encode the active Report_View, Report_Mode, Reporting_Window, comparison setting, Hours_Segment, After_Hours_Dimension selection, every dimension filter, sort column, sort direction, and pagination position in the URL.
7. WHEN a user reloads the page, THE Sales_Reporting_Center SHALL restore every value named in criterion 6 from the URL, and WHEN a user activates browser Back, THE Sales_Reporting_Center SHALL restore the immediately preceding filter state without a full page reload.
8. WHEN a second user opens a URL produced by criterion 6, THE Sales_Reporting_Center SHALL render the same Report_View, Report_Mode, and filter state, and SHALL restrict the records shown to those that second user is permitted to read.
9. WHEN a user changes a filter, THE Sales_Reporting_Center SHALL debounce the resulting report query, and SHALL exclude issuing one report query per keystroke for a typed filter value.
10. IF the URL names a Report_View, Report_Mode, Hours_Segment, After_Hours_Dimension, or filter value this build does not offer, THEN THE Sales_Reporting_Center SHALL drop that value, SHALL apply the default for it, and SHALL state which values were dropped.

---

### Requirement 10: Drill-down to underlying records

**User Story:** As a manager, I want to click any number and see exactly the records behind it, so that I never have to trust a total I cannot open.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL make every KPI value, every table cell holding a count, and every Integrity_Flag count selectable, and WHEN one is selected, SHALL open a Record_Drawer anchored to the right edge of the viewport listing exactly the records that produced that value.
2. THE Sales_Reporting_Center SHALL exclude navigating away from the active Report_View in order to explain a displayed value.
3. THE Record_Drawer SHALL display, for a selected quote or workload record: its identifying information, its source, its salesperson, its assignment history, its event timeline, its pricing activity, its outcome, its notes, its recorded field changes, and its Integrity_Flags.
4. THE Record_Drawer SHALL present a Log action for every quote row it lists, opening the Quote Activity timeline for that row's `source_work_item_id`.
5. THE Sales_Reporting_Center SHALL present a Log action for every quote row listed in any of the four Report_Views, for every role permitted to see that row.
6. THE Record_Drawer SHALL apply the same Reporting_Window, Report_Mode, Hours_Segment, and dimension filters that produced the selected value, and SHALL state the definition of the metric it was opened from.
7. THE Record_Drawer SHALL paginate its record list, and SHALL report the total record count matching the selection alongside the page being shown.
8. WHEN the Record_Drawer is closed, THE Sales_Reporting_Center SHALL leave the active Report_View, Report_Mode, and every filter unchanged.

---

### Requirement 11: Overview view

**User Story:** As a manager, I want one screen that answers how many quotes came in, how many sold, how many are stuck, and what needs attention.

#### Acceptance Criteria

1. THE Overview Report_View SHALL present a KPI ribbon of at most eight metrics, being exactly Quotes Received, Pricing Sent, Pending Pricing, Finalized, Sold, Not Sold, Conversion Rate, and Median Time to Pricing.
2. THE Overview Report_View SHALL display for each KPI its exact value, its definition, and — while the comparison setting is enabled — its change against the previous comparable period, and SHALL make each KPI selectable per Requirement 10.
3. WHILE Report_Mode is Quote Cohort, THE Overview Report_View SHALL present the lifecycle progression Received, Accepted, Priced, Finalized together with Sold, Not Sold, Pending Pricing, Awaiting Customer Decision, and Still Active, each as a count and as a percentage of Quotes Received.
4. THE Overview Report_View SHALL display every lifecycle value as a legible number, and SHALL exclude a graphic that presents a lifecycle stage without its value.
5. THE Overview Report_View SHALL present a Needs Attention summary counting: Pending Pricing overdue, awaiting customer follow-up, missing source, missing salesperson, missing Not Sold reason, manual records needing review, quote and queue mismatches, and finalized records without pricing evidence.
6. WHEN a Needs Attention count is selected, THE Overview Report_View SHALL open the Record_Drawer on exactly the records that count comprises.
7. THE Overview Report_View SHALL present compact summaries of top agents by quote volume, top agents by Sold, sources with the highest volume, sources with the highest Conversion Rate, sources with the most missing attribution, Manual_Quote and Manual_Workload totals, and after-hours volume.
8. WHEN a compact summary is selected, THE Overview Report_View SHALL open the Agents or Sources Report_View with the active Report_Mode, Reporting_Window, Hours_Segment, and dimension filters unchanged.

---

### Requirement 12: Agents view

**User Story:** As a manager, I want one agent table I can expand, so that comparing employees does not mean opening four separate reports.

#### Acceptance Criteria

1. THE Agents Report_View SHALL present one row per employee in one table whose default columns are exactly Agent, Quotes Received, Pricing Sent, Pending Pricing, Sold, Not Sold, Conversion, Manual Quotes, Manual Workloads, After-Hours Activity, and Median Time to Pricing.
2. THE Agents Report_View SHALL offer these additional columns on expansion: New Quotes, Requotes, Intake Queue claims, WhatsApp claims, Workload queue claims, Passes, Missed turns, Recovered quotes, Notes coverage, Follow-ups overdue, Sold without pricing evidence, Not Sold without reason, Quotes per scheduled hour, Sales per 100 finalized quotes, Manual records per 100 total activities, and Missed turns per 100 eligible turns.
3. THE Agents Report_View SHALL exclude a composite agent score, and SHALL display each measure separately.
4. THE Agents Report_View SHALL permit sorting by any displayed column and SHALL encode the sort column and direction in the URL.
5. WHEN an employee row is selected, THE Agents Report_View SHALL open an agent detail drawer presenting that employee's KPI summary, quote lifecycle, source mix, assignment-method mix, Manual_Quote history, Manual_Workload history, after-hours activity, pending work, Not Sold reasons, Integrity_Flags, and underlying records.
6. THE agent detail drawer SHALL report separately the quotes the employee created, the quotes the employee claimed, the quotes the employee priced, the sales credited to the employee, and the outcomes the employee entered.
7. THE Agents Report_View SHALL compute Quotes per scheduled hour from the employee's scheduled hours held in `employee_schedules` over the Reporting_Window, and SHALL display it as undefined when those scheduled hours are zero or absent.
8. THE Agents Report_View SHALL display a rate metric as undefined when its denominator is zero, and SHALL exclude displaying zero in place of an undefined rate.

---

### Requirement 13: Sources view

**User Story:** As a manager, I want source, dealership, salesperson, and input-method performance in one place, so that I can tell which sources deserve more attention.

#### Acceptance Criteria

1. THE Sources Report_View SHALL present one row per source whose columns are exactly Source, Quotes, Pricing Sent, Pending Pricing, Sold, Not Sold, Conversion, Median Time to Pricing, Manual Quote Share, After-Hours Share, Missing Salesperson Count, Duplicate Count, and Integrity Flags.
2. THE Sources Report_View SHALL report a quote with no source under an explicit label distinguishing "no source recorded" from "source not found", and SHALL exclude omitting such quotes from the table.
3. WHEN a source row is expanded, THE Sources Report_View SHALL present the salespeople under that source, the employees handling that source, the input channels, the New Quote and Requote split, the assignment methods, the Not Sold reasons, the manual-entry percentage, the after-hours volume, the quote timing, the missing fields, and the underlying records.
4. THE Sources Report_View SHALL present source health as named conditions, each stating the data that caused it, and SHALL exclude a single composite source score.
5. THE Sources Report_View SHALL detect at least these conditions: high volume with low conversion, high Pending Pricing aging, high No Response rate, high missing-salesperson rate, high manual-entry rate, sudden volume decline, sudden source reassignment, high duplicate frequency, and strong conversion with low volume.
6. THE Sources Report_View SHALL evaluate every threshold in criterion 5 against stored configurable values, and SHALL state the threshold that a displayed condition met.
7. THE Sources Report_View SHALL link every source and salesperson value to the Record_Drawer for its underlying records.

---

### Requirement 14: Integrity flag detection

**User Story:** As a manager, I want objective discrepancies surfaced with their evidence, so that I can investigate reporting accuracy without accusing anyone.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL store one Integrity_Flag per detected discrepancy, carrying its related quote or workload, its Flag_Type, its severity, a human-readable explanation, its supporting timestamps, its supporting assignment data, its detection date, its Review_Status, its reviewing profile, its review date, its manager explanation, and its resolution.
2. THE Sales_Reporting_Center SHALL name every Flag_Type using one of the seven neutral values in the Glossary, and SHALL exclude language asserting that an employee acted dishonestly from every Flag_Type, explanation, and label.
3. THE Sales_Reporting_Center SHALL detect these manual-activity signals: Manual_Quote rate materially above the team baseline, Manual_Workload rate materially above the team baseline, a Manual_Quote created within a configured interval before a Sold outcome, a Manual_Workload created with no notes, a manual record created after the related work had already been recorded, repeated use of an unknown or missing source, and a manual record created while the employee was an eligible current agent in a normal queue.
4. THE Sales_Reporting_Center SHALL evaluate every threshold in criterion 3 against stored configurable values, and SHALL exclude raising an Integrity_Flag solely because a record's assignment method is manual.
5. THE Sales_Reporting_Center SHALL reconcile the chain turn event → assigned work → quote or workload → pricing or completion → outcome, and SHALL detect: a queue claim with no linked quote or workload, a quote whose assignment method names a queue with no matching turn event, one turn event linked to more than one quote, a rotation advance with no created work record, a quote with no valid assignment history, and an assignment method changed after creation.
6. THE Sales_Reporting_Center SHALL exclude from criterion 5 the non-consuming assignment paths — `cs_intake_manager_assign`, manual logging, reassignment, and an out-of-turn walk-in claim — and SHALL treat the absence of a turn event for those paths as expected.
7. THE Sales_Reporting_Center SHALL detect these documentation signals: a Sold quote with no verified pricing event, a Sold quote with no note, a Not Sold quote with no reason, a Pending Pricing quote with no follow-up, an outcome changed after finalization, a source changed after finalization, a salesperson changed after finalization, and more than one quote for the same customer and source within a configured interval.
8. THE Sales_Reporting_Center SHALL report these activity patterns without assigning a Flag_Type that asserts misconduct: high pass rate, high missed-turn rate, high recovery rate, work recorded in clusters near the end of a day, work recorded in clusters near the end of a Reporting_Window, quote volume inconsistent with scheduled working hours, and manual activity disproportionately occurring After_Hours.
9. THE Sales_Reporting_Center SHALL make every Integrity_Flag count selectable and SHALL open the Record_Drawer on exactly the flagged records it comprises.
10. THE Sales_Reporting_Center SHALL detect each discrepancy at most once per related record per Flag_Type, and SHALL retain an existing Integrity_Flag's Review_Status when the same discrepancy is detected again.

---

### Requirement 15: Review & Integrity workflow

**User Story:** As a manager, I want a review queue with an audit trail, so that a discrepancy that has been explained stays explained.

#### Acceptance Criteria

1. THE Review & Integrity Report_View SHALL offer these saved filters: All Open Flags, High Priority, Manual Quote Review, Manual Workload Review, Queue Mismatch, Missing Documentation, Attribution Conflict, Duplicate Activity, Timing Conflict, Finalized Without Pricing, Not Sold Without Reason, Explained, Confirmed Data Issue, and Dismissed.
2. THE Review & Integrity Report_View SHALL permit a profile holding Integrity_Reviewer_Role to open the evidence, view the audit history, view the related quote, view the related queue event, add an explanation, mark Explained, mark Confirmed Data Issue, Dismiss, and Reopen.
3. THE Review & Integrity Report_View SHALL refuse every action named in criterion 2 from a profile not holding Integrity_Reviewer_Role, and SHALL leave the Integrity_Flag unchanged when it refuses.
4. WHEN a review action is recorded, THE Review & Integrity Report_View SHALL append an immutable review history entry carrying the acting profile, the action, the resulting Review_Status, the explanation text, and the action time, and SHALL retain every earlier entry.
5. WHEN an Integrity_Flag is Reopened, THE Review & Integrity Report_View SHALL set its Review_Status to Open, SHALL retain its earlier review history entries, and SHALL retain the explanation recorded before it was reopened.
6. THE Review & Integrity Report_View SHALL require a non-empty explanation for Explained and for Confirmed Data Issue, and SHALL refuse those two actions when the explanation is empty.
7. THE Review & Integrity Report_View SHALL exclude from every reader not holding Integrity_Reviewer_Role the manager explanations and the review history of Integrity_Flags.
8. THE Review & Integrity Report_View SHALL present, for each listed Integrity_Flag, the data that caused it, and SHALL exclude presenting a flag without its supporting evidence.

---

### Requirement 16: Historical accuracy

**User Story:** As a manager, I want last month's report to keep saying what it said, so that a field someone edits today does not rewrite history.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL compute a metric for a past Reporting_Window from the event timestamps and audit history recorded at that time, and SHALL exclude recomputing a past Reporting_Window from a field's present value where an audit record of its earlier value exists.
2. THE Sales_Reporting_Center SHALL expose, for source, salesperson, assignment, final outcome, and assigned agent, whether that field was changed after the quote's creation, and WHERE it was, the change time and the changing profile.
3. THE Sales_Reporting_Center SHALL count a field change that occurred after finalization as a distinct reportable condition, and SHALL exclude such a change from altering the Sold, Not Sold, and Finalized counts of the Reporting_Window in which the quote was finalized.
4. WHERE no audit record of a field's earlier value exists, THE Sales_Reporting_Center SHALL use the present value, and SHALL state that the value is not historically preserved.
5. THE Sales_Reporting_Center SHALL report the Source-change count and the Salesperson-change count of every Quote_Fact.

---

### Requirement 17: Reporting data layer

**User Story:** As a manager, I want reports that stay fast as the data grows, so that opening the center does not download the agency's history.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL compute every aggregate in database views, database functions, or server-side reporting services, and SHALL exclude computing a displayed aggregate in the browser from unaggregated records.
2. THE Sales_Reporting_Center SHALL produce one Quote_Fact per Quote_Identity carrying at least: quote identifier, customer, source, salesperson, channel, New Quote or Requote, assignment method, Manual_Quote flag, Customer Service intake flag, the six Credit_Roles, created timestamp, claimed timestamp, accepted timestamp, First_Pricing_Sent_At, Finalized_At, current status, Final_Outcome, Not Sold reason, notes count, attachment count, follow-up count, source-change count, salesperson-change count, Received After Hours, Worked After Hours, Finalized After Hours, and its record integrity indicators.
3. THE Sales_Reporting_Center SHALL produce one Workload_Fact per workload record carrying at least: workload identifier, workload type, related quote where one exists, agent, created by, assignment method, Manual_Workload flag, Queue Workload flag, created timestamp, accepted timestamp, completed timestamp, notes count, evidence count, after-hours flag, and current status.
4. THE Sales_Reporting_Center SHALL request detail records in pages, and SHALL exclude loading the full operational history into the browser.
5. THE Sales_Reporting_Center SHALL cache filter option lists and SHALL exclude re-querying a filter option list on every filter change.
6. THE Sales_Reporting_Center SHALL add indexes supporting queries by quote creation date, first pricing date, finalized date, assigned agent, source, salesperson, assignment method, outcome, workload date, and Integrity_Flag Review_Status.
7. THE Sales_Reporting_Center SHALL deliver every database change as a new forward-only migration, and SHALL exclude edits to migration files already applied to the deployed database.
8. THE Sales_Reporting_Center SHALL leave every existing table, column, view, and database function that a Legacy_Report reads unchanged.
9. WHERE a live database object the reporting data layer depends on has no `create` statement under `supabase/`, THE Sales_Reporting_Center SHALL record that object's live definition in the repository before a reporting query is written against it.

---

### Requirement 18: Export

**User Story:** As a manager, I want one export that matches what is on my screen, so that a spreadsheet and the report never disagree.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL present exactly one export control, labeled "Export Current View", and SHALL exclude per-report export controls from the four Report_Views.
2. THE Sales_Reporting_Center SHALL offer these export formats: Summary CSV, Underlying records CSV, Excel workbook, and PDF snapshot.
3. THE Sales_Reporting_Center SHALL produce every export from the active Report_View, the active Report_Mode, the active Reporting_Window, the active Hours_Segment, every active dimension filter, and the active sort order.
4. THE Sales_Reporting_Center SHALL produce export totals equal to the totals displayed on screen for the same Report_View, Report_Mode, and filter state.
5. THE Sales_Reporting_Center SHALL restrict the records and columns in an export to those the requesting profile is permitted to read on screen.
6. THE Sales_Reporting_Center SHALL state in every export the Report_View, Report_Mode, Reporting_Window, Hours_Segment, and dimension filters that produced it, together with the generation time in Business_Timezone.
7. IF an export exceeds the configured maximum record count, THEN THE Sales_Reporting_Center SHALL refuse the export, SHALL state the limit and the matching record count, and SHALL leave the on-screen report unchanged.

---

### Requirement 19: Permissions

**User Story:** As a manager, I want reporting access to match each role's remit, so that an agent cannot read another employee's review.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL grant a profile holding Report_Reader_Role access to all four Report_Views.
2. THE Sales_Reporting_Center SHALL reserve every Integrity_Flag review action to a profile holding Integrity_Reviewer_Role.
3. WHERE current product permissions grant a Self_Scoped_Reader a performance report, THE Sales_Reporting_Center SHALL restrict that reader's reporting records to those in which that reader holds a Credit_Role.
4. THE Sales_Reporting_Center SHALL exclude from every Self_Scoped_Reader: other employees' Integrity_Flags and reviews, manager explanations, payroll and schedule information beyond that reader's own scheduled hours, and private management notes.
5. THE Sales_Reporting_Center SHALL authorize every reporting query in server-side code, and SHALL exclude relying on the absence of a navigation entry as the authorization for a reporting query.
6. IF a profile requests a Report_View or a reporting query it is not permitted to read, THEN THE Sales_Reporting_Center SHALL refuse the request, SHALL return zero reporting records, and SHALL record no change to any Integrity_Flag.
7. THE Sales_Reporting_Center SHALL apply to every export the same authorization it applies to the corresponding on-screen report.
8. THE Sales_Reporting_Center SHALL evaluate every role check that admits `manager` as also admitting `super_admin`.

---

### Requirement 20: Validation against the legacy reports

**User Story:** As a manager, I want the new numbers reconciled against the old ones before the old reports go away, so that a difference is explained rather than discovered.

#### Acceptance Criteria

1. THE Sales_Reporting_Center SHALL produce, for at least one complete reporting period, a comparison of each new metric against the Legacy_Report metric it supersedes, stating both values and the difference.
2. THE Sales_Reporting_Center SHALL record, for every material difference found by criterion 1, which definition changed, which timestamp changed, and which records the two metrics counted differently.
3. THE Sales_Reporting_Center SHALL retain every Legacy_Report until the comparison required by criterion 1 is recorded and a profile holding Manager_Role records approval of removal.
4. THE Sales_Reporting_Center SHALL name, for every Legacy_Report metric that the new definitions retire rather than replace, the reason it was retired.
5. THE Sales_Reporting_Center SHALL pass `npx tsc --noEmit`, `npm test`, and `npm run build` with zero errors before each implementation phase is recorded as complete.
6. THE Sales_Reporting_Center SHALL exclude an automatic deployment, and SHALL record the deployment steps and the rollback steps for every migration it adds.
7. THE Sales_Reporting_Center SHALL record a final evidence report naming the files changed, the database objects changed, the tests run, the build result, the four Report_Views as displayed, example drill-downs, an example integrity review, an example after-hours filter, the known limitations, and the remaining data gaps.
