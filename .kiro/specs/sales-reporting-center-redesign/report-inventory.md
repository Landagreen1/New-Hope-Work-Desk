# Current Report Inventory

Phase 1 deliverable 1. Every sales report that exists today, what it displays, where each number comes from, and which timestamp it is counted by. Verified by reading the files; line numbers are from the state of the repository on branch `feature/sales-reporting-center` at commit `b34184c`.

## Where the reports live

| Concern | Location |
| --- | --- |
| The 24 report view identifiers | `src/components/work-desk-app.tsx` 268–292 |
| Their labels and descriptions | `src/components/work-desk-app.tsx` 294–500 (6 groups) |
| Date range state and presets | 584–590, 6558–6569 |
| Six KPI summary cards | 8514–8562 |
| KPI drill-down table | 2464–2596, invoked 8564–8571 |
| Report library navigation | 8573–8663 |
| View render chain | 8683–8795 |
| Eight CSV export buttons | 8797–8845 |
| The single aggregation memo | 6571–7452 (`reportData`, 880 lines) |
| Export handlers | 7461–7631 |
| Report components | 10211–12539 |
| After-hours helpers | 11007–11052 |
| The only data loader | `src/lib/dashboard-data.ts` 187–330 |

Every one of the 24 reports is a prop-driven presentational component. **No report queries the database.** All 24 read slices of one `useMemo` that reads one client-side fetch.

## The data loader

`loadDashboardData()` calls `ensure_daily_availability_reset` then issues 15 parallel unaggregated `.select()` calls. No filter is applied for the report date range — the full table is fetched and filtered in the browser.

| Table | Row cap | Order |
| --- | --- | --- |
| `profiles` (active only) | none | `rotation_position` |
| `dealers` | none | `name` |
| `dealer_salespeople` | none | `name` |
| `rotation_state` | none | — |
| `work_items` | **5,000** | `created_at` desc |
| `pending_pricing_quotes` | **5,000** | `price_sent_at` asc |
| `quote_outcomes` | **10,000** | `finalized_at` desc |
| `quote_notes` | **20,000** | `created_at` desc |
| `work_item_events` | **30,000** | `created_at` desc |
| `quote_take_events` | **10,000** | `taken_at` desc |
| `quote_take_timers` (active only) | none | `started_at` desc |
| `work_desk_settings` | 1 | — |
| `user_notifications` | **100** | `created_at` desc |
| `daily_agent_performance` (view) | none | — |
| `turn_events` where `action = 'pass'` | **10,000** | `created_at` desc |

Every cap truncates silently. Once `work_item_events` exceeds 30,000 rows, every timing, documentation, pricing-credit, and activation metric loses its oldest data with no error and no indication on screen.

## The quote universe

A quote physically moves between three tables: `work_items` while active, `pending_pricing_quotes` once pricing is sent, `quote_outcomes` once finalized. `reportData` unions the three in JavaScript (6572–6656).

| Branch | Source table | Date field filtered | Resulting `lifecycle` |
| --- | --- | --- | --- |
| `activeQuotes` | `work_items` where `work_type in (new_quote, requote)` | `created_at` | `Active` |
| `pending` | `pending_pricing_quotes` | `quote_created_at` | `Price Sent` |
| `outcomes` | `quote_outcomes` | **`finalized_at`** | `Sold` / `Not Sold` |

**The three branches use two different date bases.** Active and pending rows are selected by when the quote was created; outcome rows by when it was finalized. Every metric built on `quotes` therefore mixes a cohort denominator with activity numerators. A `quote_reporting_feed` view performing the same union with a consistent shape already exists in `supabase/schema.sql` 942–990 and is not used by any report.

## Metric definitions as currently implemented

| On-screen label | Line | Arithmetic | Counted by | Notes |
| --- | --- | --- | --- | --- |
| Total Quotes | 8516 | `quotes.length` | mixed | Union of the three branches; a quote counted once per branch it appears in during the window |
| New Quotes | 8523 | `work_type = 'new_quote'` | mixed | |
| Requotes | 8531 | `work_type = 'requote'` | mixed | Ignores `related_quote_source_work_item_id` |
| Sold | 8539 | `lifecycle = 'Sold'` | `finalized_at` | |
| Not Sold | 8547 | `lifecycle = 'Not Sold'` | `finalized_at` | Card's note displays **efficiency**, not a Not Sold rate |
| Pending Pricing | 8555 | `pendingPricing.length` | **no date filter** | Counts every pending row in the database regardless of the selected range |
| Efficiency | 6663 | `finalized ÷ quotes × 100` | mixed | Cohort denominator, activity numerator |
| Conversion | 6664 | `sold ÷ finalized × 100` | `finalized_at` | Correct as `Sold ÷ Finalized` |
| Assign → Take | 6678 | `assignedAt → acceptedAt` | — | `acceptedAt` is coalesced to creation for pending and outcome rows, so this reports 0 for backfilled rows |
| Take → Price | 6679 | `acceptedAt → priceSentAt` | — | |
| Take → Final | 6680 | `acceptedAt → finalizedAt` | — | |
| Price → Decision | 6681 | `priceSentAt → finalizedAt` | — | |
| Total Cycle | 6682 | `createdAt → finalizedAt` | — | |
| Agent 360 score | 7181–7188 | `efficiency×0.22 + conversion×0.22 + docCoverage×0.18 + max(0,100−(avgPrice÷60)×20)×0.18 + max(0,100−unaccepted×15)×0.10 + min(100,taken×20)×0.10` | mixed | Single composite; weights are literals in the component |
| Duplicate groups | 6946–6957 | count of `customer|source` keys appearing more than once | — | Case-folded string key; no time window; counts groups not records |
| Manager interventions | 6959 | `/assign|reassign|manager|delete|rotation/i` on `event_type` | `created_at` | Regex over an event-type string |
| Activation logs | 6962 | `/activation/i` on `event_type` | `created_at` | Regex |
| Sold without activation | 6964–6971 | Sold outcomes with no `/activation/i` event | **no date filter** | Scans all outcomes, not the window |

## Three different numbers named "pending"

| Value | Line | Definition |
| --- | --- | --- |
| `pendingPricing.length` | 8556 | Every pending row in the database. No date filter. This is the KPI card and the Funnel's pending value. |
| `reportData.pending` (per agent, per source, per channel) | 6656 | Pending rows whose **quote creation** date is in range. |
| `reportData.pendingInRange` | 6919 | Pending rows whose **price sent** date is in range. This is the Pending Follow-Up report. |

All three are labeled "Pending" or "Pending Pricing" on screen.

## Report-by-report

Group and label are as shown in the Report Library.

### Command Center

| Report | Component | Metrics displayed | Data |
| --- | --- | --- | --- |
| Executive Overview | `ExecutiveReport` 10211 | Volume by channel bar list; five most recent Not Sold; top five Not Sold reasons; top three agents with Quotes / Sold / Eff. / Conv. | `byChannel`, `notSoldRows`, `notSoldReasons`, `byAgent` |
| Not Sold Quotes | `NotSoldReport` 11682 | Not Sold count, Top Reason, No Response count, Avg Price to Decision; per-quote table with reason, timing, note count and latest note | `notSoldRows` (built from `outcomes` + `quote_notes`) |
| Daily Operations | `DailyOperationsReport` 11897 | Per day: Quotes, Sold, Not Sold, Pending, Recovered, Passes, Service | `dailyRows` 7296–7345. Quotes bucketed by **creation** day, recoveries by `takenAt`, passes by `created_at`, service by `created_at` |

### Sales

| Report | Component | Metrics displayed | Data |
| --- | --- | --- | --- |
| Sales Funnel | `FunnelReport` 11819 | Quote Volume, Finalized, Pending, Conversion; bars for Active / Price Sent / Sold / Not Sold as a share of `quotes.length` | `quotes`, `sold`, `notSold`, and `pendingPricing.length` — so the bar denominator and the Pending bar come from different populations |
| Source Intelligence | `SourceRiskReport` 12384 | Source table (Quotes, Finalized, Sold, Not Sold, Price Sent, Efficiency, Conversion); salesperson-by-source table; category label High value / Needs attention / Low value / Monitor; source and salesperson selects | `sourceRisk` 7199, `sourceSalespeople` 7217. Category thresholds are literals: `quotes>=10 && conversion>=60`, `quotes>=10 && conversion<50`, `quotes<5 && conversion<40` |
| Input Methods | `RankedReportTable` 10565 | Rank, Name, Quotes, Finalized, Sold, Not Sold, Price Sent, Efficiency, Conversion by `received_through` | `byChannel` from `group('channel')`. `received_through` is free text; null becomes `"Unknown"` |
| Quote Timing | `QuoteTimingReport` 10394 | Per agent: Quotes, Taken, and the five average durations; detail table of recent finalized quotes | `timingByAgent`, `timingRows` |

### People

| Report | Component | Metrics displayed | Data |
| --- | --- | --- | --- |
| Agent 360 | `AgentScorecardReport` 11959 | Rank, Agent, Score /100, Quotes, Sold, Conversion, Efficiency, Avg Price, Notes Coverage, Recovered, Open Load | `agentScorecards` |
| Agent Comparison | `AgentOperationsReport` 10294 | Agent, WA, RC, Manual, Workload, Payments, Passes, Finalized, Sold, Pending, Efficiency, Conversion | `byAgent` 6740. **The "Payments" column renders `row.updates`, which counts `update_log`, not payments** |
| Workload Capacity | `WorkloadCapacityReport` 12020 | Agent, Status, Active Quotes, Pending, Activations, Changes, Payments, Unaccepted, Total Load | `workloadByAgent` 7021. Present-state only; ignores the date range entirely |
| Documentation Quality | `DocumentationQualityReport` 12343 | Agent, Notes Written, Quotes, Quotes with Notes, Coverage % | `documentationByAgent` 7049. Notes attributed by **author display name**; coverage looks notes up by `quote.id`, which for pending and outcome rows is the lifecycle row id, not `source_work_item_id`, so those quotes never match a note |

### Queues — out of scope for the four new views, retained under Legacy Reports

| Report | Component | Metrics displayed | Data |
| --- | --- | --- | --- |
| Queue Health | `QueueHealthReport` 12076 | Per rotation: Current, Eligible, Available, Claims, Passes, Recovered, health label; plus the Customer Service overflow control | `queueHealth` 7113. Also writes settings — the only report with a write action |
| Recovered Quotes | `TakenQuotesReport` 10647 | Recovered Quotes, Avg Elapsed, Missed Turns, WhatsApp, RingCentral; per-agent and per-event tables | `takenRows`, `takenByAgent`, `takenSummary` from `quote_take_events` |
| Missed Turns | `MissedTurnsReport` 12243 | Missed Agent, Total, WhatsApp, RingCentral, Eventually Sold, Still Pending/Active | `missedByAgent` 7073, from `quote_take_events.skipped_profile_ids` |
| Pass Behavior | `PassBehaviorReport` 12297 | Agent, Passes, WhatsApp, RingCentral, Workload, Top Reasons | `passByAgent` 7094, from `turn_events` where `action = 'pass'` |

### Service

| Report | Component | Metrics displayed | Data |
| --- | --- | --- | --- |
| Pending Follow-Up | `FollowUpReport` 10873 | Sent today / 1 day waiting / 2+ days waiting; per-quote aging table | `pendingInRange` — filtered on `price_sent_at`, unlike every other pending number |
| Service Work | `ServiceControlReport` 12651 | Activations, Changes, Payments counts plus the raw activity table | `activationRows`, `changeRows`, `paymentRows` by `work_type` |
| Activation & Sold Audit | `ActivationAuditReport` 12693 | Sold Quotes, Activation Tasks, Activation Logs; activation table | **`outcomes` here is the full unfiltered `quoteOutcomes` prop, so "Sold Quotes" ignores the date range** |
| Raw Activity | `ServiceActivityReport` 10955 | Date, Customer, Type, Agent, Method, Status for non-quote work | `service` |
| After Hours | `AfterHoursReport` 11054 | Mode toggle After Hours / Sunday; agent and source selects; Incoming, Active, Sold, Not Sold, Pending Pricing, Avg Time to Price, conversion; agent and source breakdowns | `timingRows` filtered by `isAfterHours` or `isSunday` on **creation only** |

### Control

| Report | Component | Metrics displayed | Data |
| --- | --- | --- | --- |
| Needs Attention | `ExceptionCenterReport` 11738 | Exceptions, Critical, Warnings; table of Level / Area / Issue / Owner / Age | `exceptionItems` 6972, **capped at 100 rows**; sourced from present state, not the date range |
| Manager Actions | `ManagerInterventionReport` 12771 | Date, Action, Manager, Assigned Agent, Details | `managerInterventions` (regex over `event_type`); Details is raw JSON truncated to 160 characters |
| Data Integrity | `IntegrityReport` 12824 | Level, Issue, Detail for four issue kinds | `integrityIssues` 7346. No review state, no record links, no thresholds; "Price Sent without notes" capped at 20 |
| System Health | `SystemHealthReport` 12873 | Six pass/fail checks | `systemChecks` 7386. Three of the six are hard-coded `status: true` |

## Duplicated metrics

| Metric | Appears in |
| --- | --- |
| Sold count | KPI card, Executive, Not Sold, Funnel, Daily Operations, Agent Comparison, Agent 360, Source Intelligence, Input Methods, Activation Audit, After Hours — **11 places, and Activation Audit uses a different date basis than the other ten** |
| Conversion % | KPI card note, Executive, Funnel, Agent Comparison, Agent 360, Source Intelligence, Input Methods, After Hours |
| Efficiency % | Not Sold card note, Executive, Agent Comparison, Agent 360, Source Intelligence, Input Methods |
| Pending Pricing | KPI card, Funnel, Agent Comparison, Workload Capacity, Pending Follow-Up, After Hours — **three distinct definitions across the six** |
| Quote volume by agent | Agent Comparison, Agent 360, Quote Timing, Documentation Quality, Workload Capacity |
| Not Sold reasons | Executive, Not Sold |
| Recovered / missed turns | Recovered Quotes, Missed Turns, Queue Health, Daily Operations, Agent 360 |
| Note coverage | Documentation Quality, Data Integrity, Not Sold |
| Timing to pricing | Quote Timing (`accepted → price_sent`), After Hours (`accepted → price_sent`), agent self-performance (`created → price_sent`) — **two different definitions of the same words** |

## Reports that mishandle the selected date range

| Report | Behavior |
| --- | --- |
| Pending Pricing KPI card | No date filter at all |
| Sales Funnel | Pending bar has no date filter while the other three bars do |
| Workload Capacity | Present state only; the range has no effect |
| Needs Attention | Present state only, and capped at 100 rows |
| Activation & Sold Audit | "Sold Quotes" reads the unfiltered outcomes prop |
| Data Integrity | "Sold without activation" and "Price Sent without notes" scan all records, not the range |
| System Health | Not range-scoped by design, but presented alongside range-scoped reports |
| Pending Follow-Up | Uses `price_sent_at` where every other pending number uses `quote_created_at` |

## Field reference

### Manual Quote versus Manual Workload

`assignment_method` is the only discriminator, combined with `work_type` to separate quotes from workloads.

| Value | Meaning | Quote or workload |
| --- | --- | --- |
| `whatsapp_turn` | WhatsApp queue claim | quote |
| `ringcentral_turn` | RingCentral queue claim **and** Customer Service intake claim | quote |
| `workload_turn` | Additional Workload queue claim | workload |
| `manual_quote` | **Manual Quote** | quote |
| `manual_workload` | **Manual Workload** | workload |
| `update_log` | WhatsApp update logged | workload |
| `payment_log` | Payment logged | workload |
| `owner` | Owner-credited service item | workload |
| `manager_manual` | Manager assignment — consumes no turn | either |
| `customer_service` | Customer Service overflow | workload |

`work_type` in `(new_quote, requote)` is a quote; `activation`, `change`, `payment`, `whatsapp_update` are workloads (`isQuote`, lines 585–588). `src/lib/types.ts` 31–41 is the accurate enum list; `supabase/schema.sql` 27 is stale and omits `manual_workload`, `payment_log`, and `customer_service`.

Today's Agent Comparison "Manual" column counts only `manual_quote`. **No report anywhere counts `manual_workload`.**

### Source, salesperson, channel, assignment method

| Concept | Column | Resolution |
| --- | --- | --- |
| Source | `dealer_id` on all three lifecycle tables | `dealers.name`; null renders `"Direct / No source"`, unresolvable id renders `"Unknown source"` (`dashboard-data.ts` 359–361) |
| Salesperson | `salesperson_id` on all three lifecycle tables | `dealer_salespeople.name`; null renders `"Not recorded"`, unresolvable id renders `"Unknown salesperson"` |
| Channel | `received_through` | **Free text.** Null renders `"Unknown"`. No enum, no validation |
| Assignment method | `assignment_method` | Enum above |
| Intake channel | `cs_intake_submissions.intake_channel` | `ringcentral` or `manual`; separate from `received_through` |
| Not Sold reason | `quote_outcomes.not_sold_reason` + `not_sold_reason_other` | Five values: `price_too_high`, `chose_another_option`, `no_response`, `no_longer_needed`, `other` |

### Timestamps per quote

| Stage | `work_items` | `pending_pricing_quotes` | `quote_outcomes` |
| --- | --- | --- | --- |
| Created | `created_at` | `quote_created_at` | `quote_created_at` |
| Assigned | `assigned_at` | `assigned_at` | `assigned_at` |
| Accepted | `accepted_at` | `accepted_at` (coalesced on read) | `accepted_at` (coalesced on read) |
| Pricing sent | — | `price_sent_at` | `price_sent_at` |
| Finalized | — | — | `finalized_at` |
| Completed | `completed_at` | — | — |

Also `work_item_events` with `event_type = 'price_sent'` carries the pricing instant and, unlike the column, its actor. The agent self-performance strip (3172–3190) uses the earliest such event; no manager report does.

### Who is credited

| Credit | Column | Present in reports |
| --- | --- | --- |
| Created | `work_items.created_by` | **Never used by any report** |
| Assigned | `assigned_profile_id` | Every report; this is "the agent" everywhere |
| Prior owner | `original_owner_profile_id` | Not Sold export only |
| Actor of an event | `work_item_events.actor_profile_id` | Manager Actions only |
| Note author | `quote_notes.author_profile_id` | Documentation Quality, by display name |
| Recovering agent | `quote_take_events.taker_profile_id` | Recovered Quotes |
| Missed agents | `quote_take_events.skipped_profile_ids` | Missed Turns |
| Intake creator / claimer | `cs_intake_submissions.created_by` / `claimed_by` | Not used by any sales report |

**There is no `priced_by` column and no `sold_by` column.** Pricing credit and sale credit both resolve to whichever `assigned_profile_id` the current lifecycle row holds. Where a manager reassigns a quote after it was sold, the sale silently moves to the new agent.

Agent joins are by display-name string in `timingByAgent` (6716), `byAgent` (6742), `documentationByAgent` (7051), `sourceSalespeople` (7280), and the After Hours filters. Renaming an employee detaches their history.

## Current after-hours logic

`getEstTime` / `isAfterHours` / `isSunday`, lines 11014–11036.

- `getEstTime` formats the instant with `toLocaleString('en-US', { timeZone: 'America/New_York' })` and re-parses the resulting string with `new Date(...)`. The parse depends on the host's locale output and is not guaranteed across engines.
- `isAfterHours` returns false for Sunday, and for Monday–Saturday returns true when minutes-of-day is `< 510` (08:30) or `>= 1050` (17:30). Both literals are in the function.
- `isSunday` returns true for day-of-week 0.
- No holiday awareness. No office-closure awareness. Not configurable.
- `AfterHoursReport` filters on the **creation** timestamp only, so a quote received at 22:00 and worked at 09:30 the next morning is reported as after-hours activity across every one of its metrics.
- The report's "Avg Time to Price" uses `accepted → price_sent` while its label reads "From acceptance to pricing" — consistent here, but inconsistent with the agent self-performance metric of the same name, which uses `created → price_sent`.

Business-hours infrastructure exists elsewhere and is not used by any report: `attendance_policy.business_timezone` (default `America/New_York`) and `attendance_closed_dates` from `v1.9.0-attendance-foundations.sql`, `cancellation_settings.holidays date[]` from `v1.10.4-cancellation-settings.sql`, `employee_schedules`, and `schedule_templates` from `v1.11.3-schedule-templates.sql`.

## Current exports

`csvEscape` 824, `downloadCsv` 829. Client-side only: a `Blob`, an object URL, and a synthetic `<a download>` click. Headers come from `Object.keys(rows[0])`, so an empty result exports nothing and a first row missing an optional field drops that column for every row.

| Button | Handler | File name | Scope |
| --- | --- | --- | --- |
| All Quote Data | `exportAllQuotes` 7461 | `quotes-{start}-to-{end}.csv` | 20 columns; all five timestamps and five minute deltas |
| Not Sold Quotes | `exportNotSoldQuotes` 7494 | `not-sold-quotes-…csv` | 22 columns including the latest note |
| Quote Timing | `exportTimingReport` 7597 | `quote-timing-…csv` | Per-agent averages |
| Recovered Quotes | `exportTakenReport` 7613 | `recovered-quotes-…csv` | Per take event |
| Pending Pricing | `exportPendingPricing` 7523 | `pending-pricing-{today}.csv` | **All pending rows; ignores the date range** |
| Agent Performance | `exportAgentReport` 7539 | `agent-performance-…csv` | `byAgent` |
| Source Performance | `exportSourceReport` 7561 | `source-salesperson-performance-…csv` | `sourceSalespeople` |
| Service Activity | `exportServiceActivity` 7581 | `service-activity-…csv` | `service` |

No Excel writer, no PDF generator, no export dependency in `package.json`. The `ExportButton` subtitle reads "CSV / Excel" but every file produced is CSV. No export states the filters that produced it.

## Current permissions

| Layer | Behavior |
| --- | --- |
| Navigation | `app-sidebar.tsx` 150 places `sales_reports` behind `permissions.manageSales` — `manager`, `super_admin`, `sales_supervisor`. Non-managers get `sales_performance` instead (line 162) |
| Tab routing | `role-workspace.tsx` 81–82 map `sales_reports` to the `reports` manager tab; 188 passes `forceManagerTab` only when `permissions.manageSales` |
| Database | `schema.sql` 1027–1055: `select … using (true)` for `authenticated` on `profiles`, `dealers`, `rotation_state`, `daily_rotation_starts`, `work_items`, `pending_pricing_quotes`, `quote_outcomes`, `turn_events`. Only `audit_log` is gated, by `public.is_manager()` |

**Report authorization is entirely UI-level.** Any authenticated user can read every table behind every report directly. `is_manager()` was patched to admit `super_admin` in `v1.3.3-fix-is-manager-for-super-admin.sql`.

## Audit coverage

`audit_log` actions relevant to quotes, from the migrations:

| Action | Entity type | Old value | New value |
| --- | --- | --- | --- |
| `manager_created_assigned_quote` | `work_item` | — | full row |
| `work_item_reassigned` | `work_item` | full row | full row |
| `pending_pricing_reassigned` | `pending_pricing_quote` | full row | full row |
| `quote_moved_to_pending_pricing` | `pending_pricing_quote` | — | full row |
| `quote_note_added` | `quote` | — | note row |
| `quote_deleted` | `quote` | full row | — |
| `rotation_eligibility_changed` | `profile` | full row | full row |
| `queue_order_changed` | `rotation` | — | rotation + ids |

Consequences for historical accuracy:

- **A source or salesperson change has no audit action of its own.** It is visible only when it rides inside the `old_value`/`new_value` pair of a `work_item_reassigned` or `pending_pricing_reassigned` record. A source edited by any other path leaves no trace.
- **A manager quote delete is a hard delete.** `manager_delete_quote` (`v1.1.1-fix-intake-work-item-fk.sql` 113–158) deletes from `work_items`, `pending_pricing_quotes`, `quote_outcomes`, `quote_notes`, `quote_take_events`, `work_item_events`, and `user_notifications`. Only the `audit_log` row survives. A report for a closed period therefore shrinks when a quote in it is deleted, and the `audit_log` row is the only way to explain the difference.

## Quote Log coverage

The workspace standard requires a Log action on every quote list. In the reports area `onOpenQuoteLog` is wired to exactly three places: `NotSoldReport` (8688), `ReportDrillDownTable` (8569), and `AfterHoursReport` (8794). The other views that list quotes — Quote Timing detail, Pending Follow-Up, Recovered Quotes detail, Activation Audit, Raw Activity, Source Intelligence, Data Integrity — have no Log action.

## Reports outside this feature's scope

Recorded so they are not confused with sales reports: `src/features/commercial/CommercialReports.tsx`, `CommercialTimingReport.tsx`, `CommercialCommissionReport.tsx`, `CommercialCommissionReview.tsx`, and `src/app/api/commercial-quotes/reports/timing/route.ts` (the only server-aggregated sales-adjacent report in the repository); the attendance surfaces `HealthRibbon.tsx`, `TeamTodaySummary.tsx`, and `/api/attendance/{metrics,trends,export}`; `CancellationPaymentReport.tsx`; and the legacy parallel modules `src/features/quotes/metrics.ts` and `src/features/quotes/reporting.ts`, which read `operational_quotes` and `customer_intakes` rather than the Work Desk quote tables.
