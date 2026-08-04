# Metric Definitions

Phase 1 deliverables 2, 3, and 4. The authoritative definition of every metric the Sales Reporting Center reports, the agent-credit rules, the after-hours rules, the integrity signal catalog, the data gaps, and the old-versus-new comparison.

These definitions are the contract. `src/features/reporting/definitions.ts` encodes them, `src/features/reporting/__tests__/` pins them, and the `v1.12.*` SQL is written to match them. Where a definition below disagrees with a current on-screen label, the definition below wins and `report-inventory.md` records what changed.

---

## 1. Foundations

### Quote identity

One reporting record per **Quote_Identity**, which is `work_items.id`, carried forward as `source_work_item_id` by `pending_pricing_quotes` and `quote_outcomes`.

A quote physically moves between the three tables, so its present row is found by precedence: **outcome → pending → active**. Where a quote holds more than one outcome record — possible, because `quote_outcomes` has no unique constraint on `source_work_item_id` — the record with the latest `finalized_at` is authoritative and every superseded record raises a Timing Conflict flag.

No metric counts a Quote_Identity more than once.

### The reporting window

`Reporting_Window` is an inclusive pair of calendar dates read in `Business_Timezone`, which is `attendance_policy.business_timezone` (`America/New_York`). `Report_End_Instant` is the last instant of the end date in that zone. Every as-of-date metric is evaluated at `Report_End_Instant`, never at "now".

That distinction is what makes a report for a closed period reproducible: asking for last month on the 3rd and on the 30th must give the same answer.

### Excluded records

No metric counts an **Excluded_Record**:

| Exclusion | How it is determined |
| --- | --- |
| Cancelled record | `work_items.status = 'cancelled'` |
| Duplicate_Retry | The quote is not the earliest quote linked to its `cs_intake_submissions` row, where that intake links to two or more quote records |
| Deleted record | Requires no clause. `manager_delete_quote` hard-deletes the row from every quote table; only an `audit_log` row with `action = 'quote_deleted'` survives |
| Intake that never became a quote | Not in the quote universe at all — an intake with no `work_item_id` produces no Quote_Fact |

Duplicate_Retry is **derived, not read**. The defect recorded in `.kiro/specs/rc-claim-duplicate-quote-fix/bugfix.md` produces two quote records from one intake with no flag on either, so a column-based rule would miss every real case.

A duplicate that is *not* intake-linked — the same customer and source quoted twice within a short window — is **not excluded**. A legitimate requote looks exactly like that. It raises a Duplicate Activity flag for review instead.

### Report modes

| Mode | Question it answers | Counting rule |
| --- | --- | --- |
| **Operational Activity** | What work happened during the period? | Each metric counts by the timestamp of the event it measures. A quote created last month and priced this month counts in this month's Pricing Sent. |
| **Quote Cohort** | What became of the quotes received during the period? | Every metric is restricted to quotes created inside the window, evaluated as of `Report_End_Instant`. |

The lifecycle funnel comes from Quote Cohort only. No displayed ratio may take its numerator from one mode and its denominator from the other — that is the defect behind the current `efficiency` metric, which divides an activity-counted numerator by a cohort-counted denominator.

Every metric on screen states which mode produced it and which timestamp it was counted by.

---

## 2. Metric definitions

### Quotes Received

A distinct Quote_Identity whose creation timestamp falls inside the Reporting_Window.

- Counted by: creation timestamp (`work_items.created_at` / `quote_created_at`).
- Mode: both. In Quote Cohort mode this is the cohort denominator.
- Excludes: Excluded_Records, workload records, intakes that produced no quote.

### Pricing Sent

A distinct Quote_Identity whose **First_Pricing_Sent_At** falls inside the Reporting_Window.

`First_Pricing_Sent_At` = the earlier of:
1. the `price_sent_at` column on the quote's pending or outcome row, and
2. the creation time of the quote's earliest `work_item_events` row with `event_type = 'price_sent'`.

A quote with neither is not counted. Pricing is never inferred from a note, from the quote's creation, from its outcome, or from a stored status value with no `price_sent_at` and no `price_sent` event.

- Counted by: `First_Pricing_Sent_At`.
- Mode: Operational Activity counts by the event date. Quote Cohort counts cohort quotes priced by `Report_End_Instant`.

### Pending Pricing

A distinct Quote_Identity that, as of `Report_End_Instant`:
- exists,
- is not finalized,
- has no `First_Pricing_Sent_At` at or before that instant, and
- is not an Excluded_Record.

**This is an as-of-date metric.** It is not a count of records created during the window. This is the single largest departure from current behavior: today's KPI card counts every pending row in the database with no date filter at all, and two other numbers named "Pending" use two further definitions.

- Counted by: existence and state at `Report_End_Instant`.
- Mode: identical in both modes except that Quote Cohort restricts it to cohort quotes.

### Sold / Not Sold / Finalized

- **Sold** — a distinct Quote_Identity whose Final_Outcome is `sold` and whose `Finalized_At` falls inside the Reporting_Window.
- **Not Sold** — the same with Final_Outcome `not_sold`.
- **Finalized** — Sold + Not Sold over the same window.

Final_Outcome and `Finalized_At` come from the outcome record with the latest `finalized_at`. An outcome recorded after `Report_End_Instant` is excluded from that window entirely.

- Counted by: `finalized_at`.

### Conversion Rate

`Sold ÷ Finalized`.

Undefined — rendered as an em dash, never as zero — when Finalized is zero. Quotes Received is never its denominator.

### Quote-to-Sale Rate

`Sold ÷ Quotes Received`.

A separate metric with a separate label. Where both ratios appear, each states its own denominator. These are different questions: Conversion Rate asks how well the team closes decided quotes; Quote-to-Sale Rate asks how much of the intake turns into business. Presenting either under the other's name is the ambiguity this separation exists to remove.

### Median Time to Pricing

The median of `First_Pricing_Sent_At − creation timestamp`, over exactly the quotes counted in Pricing Sent under the active mode.

Median rather than mean, because a handful of quotes priced days late drags a mean far from the typical experience. Undefined when the set is empty.

The current code has two conflicting versions of this idea: manager reports measure `accepted → price_sent`, the agent self-performance strip measures `created → price_sent`. **`created → price_sent` is authoritative** — it is the interval the customer actually waits. `accepted → price_sent` is retained as a separate expandable measure named Time from Acceptance to Pricing.

### Cohort states

In Quote Cohort mode, every quote in Quotes Received is assigned to **exactly one** state as of `Report_End_Instant`:

| State | Condition at `Report_End_Instant` |
| --- | --- |
| Sold | Final_Outcome is `sold` |
| Not Sold | Final_Outcome is `not_sold` |
| Still Awaiting Customer Decision | Has `First_Pricing_Sent_At`, no Final_Outcome |
| Still Pending Pricing | No `First_Pricing_Sent_At`, has been accepted |
| Still Active | No `First_Pricing_Sent_At`, not yet accepted |

Plus two cumulative progression counts that are *not* mutually exclusive with the above and are labeled as progression, not as state:

- **Accepted** — has an `accepted_at` distinct from its creation timestamp, or an `accepted` event.
- **Priced** — has a `First_Pricing_Sent_At` at or before `Report_End_Instant`.

The funnel reads Received → Accepted → Priced → Finalized. The five states below it sum to Received. Both are shown as counts and as percentages of Received, and no funnel graphic hides a value.

### Record classification

| Classification | Rule |
| --- | --- |
| Manual Quote | `assignment_method = 'manual_quote'`. Nothing else. Not inferred from a missing source, salesperson, or channel |
| Manual Workload | Not a quote, and `assignment_method = 'manual_workload'`. Never includes a workload turn, a quote, a CS intake claim, or an automatically created service task |
| Queue Workload | Not a quote, and `assignment_method = 'workload_turn'` |
| Requote | `work_type = 'requote'` or `related_quote_source_work_item_id is not null` |
| New Quote | Any quote that is not a Requote |
| CS intake quote | A `cs_intake_submissions` row links to this Quote_Identity. Reported separately from assignment method; the stored assignment method stays `ringcentral_turn` |
| Walk-in | CS intake quote whose `is_walk_in` is true. Whether its claim consumed a turn is read from `consumed_turn` in the audit detail; an out-of-turn walk-in claim is excluded from every missed-turn and turn-count metric |

Manual Quote and Manual Workload are reported as two separate metrics everywhere. No current report counts `manual_workload` at all.

---

## 3. Agent credit rules

Six credit roles per quote. A single "agent" field cannot answer five different questions, and today it is asked all five.

| Credit_Role | Resolved from | Null when |
| --- | --- | --- |
| **Created By** | `work_items.created_by` | The `work_items` row is gone (quote already finalized and the row deleted from `work_items` by the lifecycle move) |
| **Claimed By** | Actor of the earliest `accepted` event; failing that, the assigned profile of the earliest `assigned` event | Neither event exists |
| **Assigned Agent** | `assigned_profile_id` on the quote's current lifecycle row | Never — this column is `not null` |
| **Pricing Employee** | Actor of the earliest `price_sent` event | No such event. If a `price_sent_at` value exists without one, this stays null and a Missing Documentation flag is raised |
| **Outcome Employee** | Actor of the `sold` or `not_sold` event matching the Final_Outcome | No such event |
| **Sales_Credit_Owner** | The assigned profile held by the outcome record at finalization | The quote is not finalized |

Rules that follow:

1. **Sales_Credit_Owner is frozen at finalization.** A later reassignment does not move the sale. It is reported as a field change instead. Today a manager reassigning a sold quote silently moves the sale to the new agent.
2. **Where Sales_Credit_Owner and Outcome Employee differ, both are reported and an Attribution Conflict flag is raised.** One employee entering another's outcome is not misconduct; it is a fact management should be able to see.
3. **Every join is by profile id.** No reporting join uses a display name. Five current aggregations join by display name, so renaming an employee detaches their history.
4. **A metric is attributed to the credit role it measures**, and the view states which role. Quotes Received is Assigned Agent. Pricing Sent is Pricing Employee. Sold is Sales_Credit_Owner. Manual Quotes is Created By.
5. **Original Owner is reported wherever the current assigned agent differs from `original_owner_profile_id`**, so a reassignment is visible rather than invisible.

The agent detail drawer reports the five populations separately: quotes the employee created, claimed, priced, was credited with selling, and entered an outcome for. A single number labeled "quotes" cannot distinguish them.

---

## 4. After-hours rules

### Business hours configuration

Stored, never hard-coded. Today `isAfterHours` carries `510` and `1050` as literals inside a function.

| Setting | Storage | Seed |
| --- | --- | --- |
| Timezone | `attendance_policy.business_timezone` — reused, not duplicated | `America/New_York` |
| Working day, opening time, closing time | `business_hours_days`, one row per weekday | Mon–Sat working, `08:30`–`17:30` |
| Sunday handling | `business_hours_settings.sunday_is_working_day` | false |
| Holidays | `business_hours_closures` with `closure_kind = 'holiday'` | empty |
| Special closures | `business_hours_closures` with `closure_kind = 'special_closure'` | empty |

The seed reproduces today's hard-coded behavior exactly, so the first legacy comparison starts from parity and any difference it reports is a definition difference rather than a settings difference.

### Classification

An instant is **Business_Hours** when, converted to `Business_Timezone`:
- its date is not a holiday and not a special closure,
- its weekday is a working day, and
- its wall-clock time is `>= opens_at` and `< closes_at`.

Opening inclusive, closing exclusive. Everything else is **After_Hours**. A holiday or closure date is After_Hours all day regardless of the time. Sunday is additionally classified as Sunday for the Sunday Hours_Segment, and is Business_Hours or After_Hours according to `sunday_is_working_day`.

Timezone conversion is done by `Intl.DateTimeFormat(...).formatToParts` with `hourCycle: 'h23'` in TypeScript and by `at time zone` in SQL. Neither re-parses a formatted date string, which is what the current `getEstTime` does and why it is fragile at daylight-saving boundaries. Both implementations run the same fixture corpus in tests so they cannot drift.

### The four dimensions

Four independent flags per record. One after-hours flag cannot answer four different questions.

| Dimension | Set when |
| --- | --- |
| **Received After Hours** | The quote's creation timestamp is After_Hours |
| **Worked After Hours** | At least one claim, acceptance, note, pricing, follow-up, or other recorded work event is After_Hours. **The creation timestamp is excluded from this determination** |
| **Finalized After Hours** | `Finalized_At` is After_Hours |
| **Manual Entry After Hours** | The record is a Manual Quote or Manual Workload and its creation timestamp is After_Hours |

**A quote is never classified as after-hours work solely because it was received after hours.** A quote that arrives at 22:00 and is worked at 09:30 the next morning is Received After Hours and not Worked After Hours. Today's After Hours report filters on creation only, so every one of its metrics reports that quote as after-hours activity.

After Hours is a global filter across all four views, not a view of its own. The After-Hours summary reports: quotes received after hours, quotes worked after hours, quotes finalized after hours, Manual Quotes entered after hours, Manual Workloads entered after hours, after-hours Conversion Rate, median wait until first recorded action, quotes whose first action fell on a later Working_Day, sources producing after-hours quotes, and employees performing after-hours work.

---

## 5. Integrity signals

Every flag carries one of seven neutral **Flag_Types**: Needs Review, Attribution Conflict, Missing Documentation, Queue Mismatch, Manual Entry Pattern, Duplicate Activity, Timing Conflict.

No flag type, explanation, or label asserts that an employee acted dishonestly. The purpose is to show a discrepancy management can investigate. Every flag carries the evidence that produced it; a flag without its evidence is not shown.

Thresholds live in `reporting_thresholds` and mirror `DEFAULT_INTEGRITY_THRESHOLDS`. No threshold is a literal in SQL or in a component.

### Manual activity

| Signal key | Flag_Type | Threshold | Default |
| --- | --- | --- | --- |
| `manual_quote_rate_above_baseline` | Manual Entry Pattern | Percentage points above the team median manual-quote rate, with a minimum record count | 20 pts, min 10 records |
| `manual_workload_rate_above_baseline` | Manual Entry Pattern | Same, for manual workloads | 20 pts, min 10 records |
| `manual_quote_shortly_before_sold` | Timing Conflict | Minutes between manual quote creation and a Sold outcome | 30 minutes |
| `manual_workload_without_notes` | Missing Documentation | Note count | 0 notes |
| `manual_record_after_related_work` | Timing Conflict | Manual record created after an event on the related record | any |
| `repeated_unknown_source` | Needs Review | Count of manual records with no source in the window | 5 |
| `manual_while_queue_eligible` | Queue Mismatch | Manual record created while the employee held an eligible current turn | any |

**A record is never flagged solely for being manual.** Manual entry is a legitimate workflow. Only a rate materially above the team baseline, or a manual record combined with another condition, raises a flag.

### Queue reconciliation

The chain verified is: turn event → assigned work → quote or workload → pricing or completion → outcome.

| Signal key | Flag_Type |
| --- | --- |
| `queue_claim_without_work_record` | Queue Mismatch |
| `queue_assigned_without_turn_event` | Queue Mismatch |
| `turn_linked_to_multiple_quotes` | Duplicate Activity |
| `rotation_advanced_without_work_record` | Queue Mismatch |
| `quote_without_assignment_history` | Queue Mismatch |
| `assignment_method_changed_after_creation` | Attribution Conflict |

Excluded from `queue_assigned_without_turn_event`, because these paths legitimately consume no turn: `cs_intake_manager_assign`, `manager_reassign_work_item`, `manager_reassign_pending_pricing`, `log_manual_quote`, `log_whatsapp_update`, `workload_reassign`, `workload_void`, and an out-of-turn walk-in claim. For these, the absence of a turn event is expected and flagging it would be noise.

### Documentation

| Signal key | Flag_Type | Threshold |
| --- | --- | --- |
| `sold_without_pricing_evidence` | Missing Documentation | — |
| `sold_without_notes` | Missing Documentation | — |
| `not_sold_without_reason` | Missing Documentation | — |
| `pending_pricing_without_follow_up` | Missing Documentation | days without a note or follow-up, default 3 |
| `outcome_changed_after_finalization` | Timing Conflict | — |
| `source_changed_after_finalization` | Attribution Conflict | — |
| `salesperson_changed_after_finalization` | Attribution Conflict | — |
| `duplicate_customer_source_quotes` | Duplicate Activity | hours between two quotes for the same customer and source, default 24 |

### Activity patterns

Reported with Flag_Type **Needs Review** only. None of these is misconduct on its own, and none is given a Flag_Type that implies it is.

| Signal key | Threshold | Default |
| --- | --- | --- |
| `high_pass_rate` | Passes per 100 eligible turns | 30 |
| `high_missed_turn_rate` | Missed turns per 100 eligible turns | 20 |
| `high_recovery_rate` | Recoveries per 100 claims | 25 |
| `end_of_day_clustering` | Share of a day's records created in the final hour | 50% |
| `end_of_period_clustering` | Share of a window's records created on its final day | 40% |
| `volume_inconsistent_with_schedule` | Quotes per scheduled hour above or below the team band | 2× / 0.25× |
| `manual_activity_skewed_after_hours` | Share of an employee's manual records created After_Hours | 60% |

### Review workflow

`Review_Status` is Open, Explained, Confirmed Data Issue, or Dismissed. Explained and Confirmed Data Issue require a non-empty explanation.

Every action appends an immutable row to `reporting_integrity_reviews` carrying the acting profile, the action, the resulting status, the explanation, and the time. Reopening sets the status to Open and retains every earlier entry including the explanation recorded before the reopen. Re-detecting the same signal on the same record updates the explanation, evidence, and severity but never the review status — an explained discrepancy stays explained.

Recording a review decision is reserved to `manager` and `super_admin`. Manager explanations and review history are unreadable by every other role.

---

## 6. Data gaps

Recorded so no metric silently claims precision it does not have.

| # | Gap | Consequence | What would close it |
| --- | --- | --- | --- |
| 1 | No `priced_by` and no `sold_by` column | Pricing and sale credit must be reconstructed from `work_item_events.actor_profile_id`. Where the event is absent, the credit role is null | Columns on the outcome and pending rows, written at the moment of the action |
| 2 | No audit action for a source or salesperson change | A source edited outside a reassignment leaves no trace, so the change count is a floor, not a total | A trigger on the three quote tables writing `source_changed` / `salesperson_changed` to `audit_log` |
| 3 | `manager_delete_quote` hard-deletes | A closed period's totals shrink when one of its quotes is deleted afterwards | Soft delete, or reconstruct from the `quote_deleted` audit row. Reconciliation counts these rows so the difference is explainable |
| 4 | `quote_outcomes` has no unique constraint on `source_work_item_id` | One quote can hold several outcome records | A unique constraint, after the existing duplicates are resolved |
| 5 | `received_through` is free text | Channel grouping depends on whatever was typed; the current report shows `"Unknown"` for null | An enum or a lookup table, with a mapping migration |
| 6 | Duplicate quotes carry no marker | Duplicate_Retry has to be derived from the intake link, so a duplicate created by a path with no intake link is invisible to the exclusion | Fixing the duplicate-creation defect, plus a `merged_into_id` on the Work Desk quote tables like the one `operational_quotes` already has |
| 7 | `accepted_at` was backfilled from `quote_created_at` | Time-to-accept is unknowable for backfilled rows. Reported as undefined rather than as zero | Nothing recoverable; the data is gone |
| 8 | Seven live tables have no repository DDL | The reporting layer cannot be reviewed against the schema it queries | Task 4.1: dump the live definitions into `v1.12.7` |
| 9 | Follow-up and attachment counts have no dedicated storage for quotes | Follow-up count is approximated from `quote_notes`; attachment count is zero until quote attachments exist | Quote attachment and follow-up tables, as the renewals module already has |
| 10 | `employee_schedules` coverage is incomplete for some employees | Quotes per scheduled hour is undefined for them rather than wrong | Schedule coverage for every active employee |
| 11 | Team membership has no column | The team filter must be derived from role and department | A team column on `profiles`, or a teams table |

---

## 7. Old versus new

The full reconciliation runs in Phase 6. These are the differences the audit predicts, recorded now so Phase 6 verifies rather than discovers them.

| Current metric | Disposition | New definition | Expected difference |
| --- | --- | --- | --- |
| Total Quotes | Redefined | Quotes Received | New value ≤ old. Old counts a quote once per lifecycle table it appears in during the window; new counts one per Quote_Identity and excludes Duplicate_Retry and cancelled records |
| New Quotes / Requotes | Redefined | New Quote / Requote | Requote count may rise: new rule also counts a non-null `related_quote_source_work_item_id` |
| Sold / Not Sold | Retained | Sold / Not Sold | Unchanged, except where a quote holds several outcome records |
| Pending Pricing | Redefined | Pending Pricing as of `Report_End_Instant` | **Materially different.** Old KPI ignores the date range entirely; the other two "pending" numbers use two further bases |
| Conversion | Retained | Conversion Rate | Unchanged |
| Efficiency (`finalized ÷ quotes`) | **Retired** | — | Mixes a cohort denominator with activity numerators. Replaced by the Quote Cohort funnel, which answers the same question without the mixed denominator |
| Agent 360 score | **Retired** | — | Out of scope by requirement. The six underlying measures are reported separately |
| Source category (High value / Needs attention / Low value / Monitor) | **Retired** | Source health conditions | Replaced by nine named conditions, each stating its threshold and its causing data |
| Avg Assign → Take | Redefined | Time from Assignment to Acceptance | Often undefined where the old value was zero, because `accepted_at` is no longer coalesced to creation |
| Avg Take → Price | Retained as expandable | Time from Acceptance to Pricing | Unchanged |
| Avg time to price (agent strip) | Promoted | Median Time to Pricing | Median rather than mean, and `created → price_sent` is now the authoritative interval |
| Duplicate groups | Redefined | Duplicate Activity flags | Old counts case-folded `customer|source` key collisions with no time window; new is per record, windowed, reviewable, and separates intake-linked retries from look-alike requotes |
| Manager interventions | Redefined | Assignment and field-change records | Old is a regex over an event-type string; new reads the audit records |
| Sold without activation | Redefined | `sold_without_pricing_evidence` | Old is a regex over event types and ignores the date range |
| Data Integrity issues | Redefined | Integrity_Flags with review state | Old has no review state, no record links, and no thresholds |
| System Health checks | Retained under Legacy Reports | — | Three of six are hard-coded `status: true`; not a sales metric |
| Manual (Agent Comparison) | Redefined | Manual Quotes | Old counts `manual_quote` only. Manual Workloads become a second, separate metric that no current report has |
| Payments (Agent Comparison) | **Corrected** | WhatsApp Updates | The column labeled Payments renders `update_log` counts. The new Agents view reports them under their real name |
| After-hours counts | Redefined | Four After_Hours_Dimensions | New values differ where a holiday or closure falls in the window, and where a quote was received after hours but worked during business hours |
| Note coverage | Corrected | Notes coverage | Old looks notes up by the lifecycle row id for pending and outcome rows rather than by `source_work_item_id`, so those quotes never match a note. New keys on Quote_Identity throughout |

### Legacy view mapping

Encoded as `LEGACY_REPORT_MAP` in `definitions.ts` and shown on each legacy view.

| Legacy view | Superseded by |
| --- | --- |
| Executive Overview, Sales Funnel, Needs Attention | Overview |
| Agent Comparison, Agent 360, Workload Capacity, Documentation Quality | Agents |
| Source Intelligence, Input Methods | Sources |
| Data Integrity, Manager Actions | Review & Integrity |
| Not Sold Quotes, Quote Timing, Daily Operations, Pending Follow-Up, Raw Activity, Service Work, Activation & Sold Audit | Overview, via drill-down and the Needs Attention summary |
| After Hours | The global After Hours filter across all four views |
| Queue Health, Recovered Quotes, Missed Turns, Pass Behavior | Nothing. Queue operations, not sales reporting. Retained under Legacy Reports |
| System Health | Nothing. Not a sales metric. Retained under Legacy Reports |
