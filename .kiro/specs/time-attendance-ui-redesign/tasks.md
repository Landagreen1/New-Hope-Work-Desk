# Implementation Plan: Time & Attendance UI Redesign

## Overview

The plan follows the design's six migration stages as its spine. Each stage is a separate forward-only migration and a separate commit; no released migration file is edited. Between stages, the pure domain layer is built first and property-tested before any server or screen code consumes it, so a rule is proven correct before four screens depend on it.

Ordering constraints that shape the sequence:

- **Domain before server before screens.** `domain/` has no I/O and no `Date.now()`, so its 30-odd properties are provable without a database. The server layer composes those functions; the screens render what the server returns and derive nothing.
- **The payroll parity harness gates migration stage 5.** Task 13 must produce a clean report across every `processed` and `paid` payroll period before task 14 writes `v1.9.4`. A non-empty report blocks the stage.
- **Cleanup is separate from behavioural work.** Task 24 removes `TimeClock.tsx`, `PTORequests.tsx`, `StaffingCoverage.tsx`, `AttendanceReports.tsx`, `/api/staffing`, and `/api/time-clock/reports` only after the replacement screens are wired and a reference scan is clean. Every sub-task in task 24 commits on its own, carrying no behavioural change.
- **All 47 correctness properties are covered**, one property-based test each, minimum 100 generated cases, placed next to the code they constrain.

Migration stages map to tasks: stage 1 → task 2, stage 2 → task 6, stage 3 → task 8, stage 4 → task 12, stage 5 → task 14, stage 6 → task 25 (deferred on Open Question 3).

## Tasks

- [x] 1. Test harness and domain foundations
  - [x] 1.1 Add the test script and jsdom test dependencies
    - Add `"test": "vitest --run"` to `package.json` scripts
    - Add pinned exact dev dependencies `jsdom` and `@testing-library/react`
    - Confirm `vitest.config.ts` resolves the `@` alias for `src/features/time-attendance`
    - _Requirements: 23.9_

  - [x] 1.2 Create the domain type module
    - `src/features/time-attendance/domain/types.ts`
    - `DerivedStatus` (twelve values), `ExceptionCode`, `AttendanceException`, `AttendancePolicy`, `ClockSessionInput`, `AttendanceInputs`, `DailyAttendanceRecord`
    - `evaluatedAt` is a required input field, never read from the clock
    - _Requirements: 3.3, 3.4, 12.8_

  - [x] 1.3 Implement work-date and zoned-instant conversion
    - `domain/work-date.ts`: `workDateOf(instant, timeZone)` via `Intl.DateTimeFormat('en-CA')`, `zonedToInstant(date, time, timeZone)` via the two-pass offset probe
    - Spring-forward gap resolves to the instant immediately after the transition, documented in the function comment
    - No date library; this is the single implementation of both conversions
    - _Requirements: 3.6, 3.7, 19.9, 19.10_

  - [x] 1.4 Create the shared property-test generators
    - `domain/__tests__/arbitraries.ts`
    - `clockSessionArb`, `nonOverlappingSessionSetArb`, `anySessionSetArb`, `instantArb` (clustered on midnight, both DST transitions, and scheduled boundaries), `scheduleArb` (same-day and overnight, end equal to start), `thresholdArb` (null, and warning below minimum), `dateRangeArb` (straddling 31 December, single day, all-weekend), `csvFieldArb` (commas, quotes, newlines, non-ASCII), `roleArb` drawn from `APP_ROLES`
    - _Requirements: 23.9_

  - [x]* 1.5 Write property test for work-date mapping
    - **Property 6: Work-date stability across process timezones**
    - Run under several `process.env.TZ` values; 200 iterations
    - **Validates: Requirements 3.6, 19.9, 19.10**

  - [x]* 1.6 Write property test for business-timezone conversion
    - **Property 7: Business-timezone schedule round trip**
    - 200 iterations; multi-year range covering both DST transitions
    - **Validates: Requirements 3.7**

- [x] 2. Migration stage 1 — attendance foundations
  - [x] 2.1 Write and apply `supabase/migrations/v1.9.0-attendance-foundations.sql`
    - `attendance_policy` (singleton), `attendance_closed_dates`, `attendance_notes` with the non-empty-note check, `attendance_day_reviews` with the composite primary key, `attendance_audit_log` with its three indexes
    - `attendance_audit_immutable()` trigger on update and delete; RLS granting select and insert only, with no update or delete policy
    - Header comment records the rollback path: `drop table` for the five new tables, no existing row touched
    - Touch no released migration file
    - _Requirements: 16.1, 16.2, 16.5, 23.1, 23.2, 23.8_

  - [x] 2.2 Add the row-retention verification script and run it for stage 1
    - `scripts/verify-attendance-row-retention.mjs` capturing counts in `time_clock_entries`, `time_clock_breaks`, `employee_schedules`, `pto_requests`, `pto_balances`, `payroll_periods`, `payroll_summaries`, `audit_log` before and after a migration
    - Reused by every later stage
    - _Requirements: 23.3_

  - [x] 2.3 Implement the policy loader and the permission and visibility seams
    - `server/policy.ts` loading `attendance_policy` and `staffing_thresholds` into `AttendancePolicy`
    - `server/visibility.ts` exporting `canAdministerAttendance`, `canReviewTeamAttendance`, `visibleProfileIds`
    - Add `attendanceAdministration` to the permission surface in `src/lib/permissions.ts`; keep the predicate `super_admin` only, and keep every `manager` check also accepting `super_admin`
    - _Requirements: 21.1, 21.2, 21.11, 21.12_

  - [x]* 2.4 Write property test for the permission surface
    - **Property 36: Permission decision table**
    - **Validates: Requirements 5.21, 7.11, 8.13, 11.11, 15.9, 17.8, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.11, 21.12, 21.15**

  - [x]* 2.5 Write integration tests for audit immutability and stage-1 policies
    - Attempt update and delete on `attendance_audit_log` as administrator and through a `security definer` path; assert both fail and the row is unchanged
    - _Requirements: 16.5, 21.10_

- [x] 3. Attendance derivation domain
  - [x] 3.1 Implement the evaluation context and hours arithmetic
    - `domain/attendance.ts`: resolve scheduled instants through `zonedToInstant` in the business timezone, build session facts, classify break types against `policy.unpaidBreakTypes`
    - Session span floored at zero, open session measured to `evaluatedAt`, unpaid break minutes subtracted per session, paid break minutes reported and never subtracted
    - Scheduled hours derived once from the schedule row; late minutes from the earliest session only, floored at zero; early departure minutes against the configured tolerance
    - Overnight shift window when `shift_end <= shift_start`, with session attribution over `[shiftStart - 4h, shiftEnd + 4h]`
    - _Requirements: 3.2, 3.8, 3.9, 3.10, 3.11, 3.12, 3.17, 3.18, 19.8_

  - [x] 3.2 Implement the status rule matrix and the exception rules
    - `STATUS_RULES` as twelve ordered data entries with `id`, `status`, `description`, `holds(ctx)`, matching the Status Rule Matrix order exactly; rule 12 holds unconditionally
    - `EXCEPTION_RULES` evaluated independently with all matches collected, each carrying `ruleId` and a plain-language `ruleDescription`
    - `payrollBlocking` true for missing clock-out, missing clock-in on a scheduled date, and unapproved unscheduled work
    - Internally inconsistent data resolves to `needs_review` with the specific exception attached; the domain layer throws only for a malformed policy or an unknown timezone
    - _Requirements: 3.4, 3.5, 3.13, 12.8_

  - [x] 3.3 Implement range derivation, metric aggregation, and record-query shaping
    - `deriveDailyAttendance`, `deriveRange` producing at most one record per employee per work date
    - `aggregateMetrics` over a record set covering all fourteen Overview metrics, plus `recordQueryForMetric` returning the same query that produced the metric
    - `matchesRecordQuery` implementing the thirteen saved filters plus department, status, exception type, review status, and payroll-blocking filters, with one row key per employee and work date
    - _Requirements: 3.1, 3.2, 3.16, 12.3, 12.20, 13.3, 13.5_

  - [x]* 3.4 Write property test for status assignment
    - **Property 1: Status totality, precedence, and determinism**
    - **Validates: Requirements 3.1, 3.3, 3.4, 3.5**

  - [x]* 3.5 Write property test for exception attribution
    - **Property 2: Exception rule attribution**
    - **Validates: Requirements 3.13**

  - [x]* 3.6 Write property test for hours arithmetic
    - **Property 3: Hours arithmetic invariants**
    - 200 iterations
    - **Validates: Requirements 3.8, 3.9, 3.10**

  - [x]* 3.7 Write property test for late minutes
    - **Property 4: Late minutes monotonicity and grace boundary**
    - **Validates: Requirements 3.12**

  - [x]* 3.8 Write property test for session-count independence
    - **Property 5: Session-count invariance**
    - **Validates: Requirements 3.11, 3.17**

  - [x]* 3.9 Write property test for overnight shifts
    - **Property 8: Overnight shift attribution**
    - **Validates: Requirements 3.18**

  - [x]* 3.10 Write property test for payroll-blocking classification
    - **Property 9: Payroll-blocking classification**
    - **Validates: Requirements 12.8**

- [x] 4. Coverage domain
  - [x] 4.1 Implement threshold classification and interval partition
    - `domain/coverage.ts`: `classifyCoverage` as one ordered comparison returning `healthy` for a null threshold, plus `COVERAGE_SEVERITY`
    - `buildCoverageIntervals` collecting distinct start and end instants, pairing consecutive boundaries, computing the active set per pair, dropping empty pairs; absent profiles excluded from the active set but still contributing boundaries
    - _Requirements: 6.4, 6.9, 6.10, 6.11, 6.12, 8.9, 8.10, 8.11_

  - [x] 4.2 Implement projected and live coverage
    - `projectCoverage` as scheduled minus approved absences minus proposed absences, taking no clock data at all; reported available floored at zero with the raw shortfall retained
    - `liveCoverage` counting `working`, `on_break` excluded from working, `approved_time_off`, and missing as scheduled minus working minus on-break minus approved-off floored at zero, with the employee list behind each headcount
    - Per-department projection using the same expression restricted to the department roster
    - _Requirements: 6.2, 6.5, 6.6, 6.7, 6.8, 6.13, 6.14, 8.6, 8.7, 8.8, 19.4_

  - [x] 4.3 Implement ribbon state derivation
    - `deriveRibbonStates(startDate, closedDates, schedules, coverage)` returning seven consecutive dates, one state each, precedence Closed then No_Schedule then coverage status, with `at_minimum` presented as Warning
    - _Requirements: 18.2, 18.3, 18.4, 18.5, 18.6, 18.10_

  - [x]* 4.4 Write property test for coverage classification
    - **Property 10: Coverage status classification and severity monotonicity**
    - **Validates: Requirements 6.4, 6.9, 6.10, 6.11, 6.12, 6.13, 8.11**

  - [x]* 4.5 Write property test for live coverage headcounts
    - **Property 11: Live coverage headcount partition**
    - **Validates: Requirements 6.2, 6.5, 6.6, 6.7, 6.8, 6.14**

  - [x]* 4.6 Write property test for projection arithmetic
    - **Property 12: Projection identity, monotonicity, and department partition**
    - **Validates: Requirements 8.6, 8.8, 9.1, 9.2**

  - [x]* 4.7 Write property test for live and projected separation
    - **Property 13: Live and projected separation**
    - **Validates: Requirements 8.7, 9.6, 19.4**

  - [x]* 4.8 Write property test for interval partition
    - **Property 14: Coverage interval partition**
    - Generators include overlapping, nested, and identical windows
    - **Validates: Requirements 8.9, 8.10, 9.4, 9.5**

  - [x]* 4.9 Write property test for ribbon state derivation
    - **Property 15: Health ribbon totality, precedence, and agreement**
    - **Validates: Requirements 18.2, 18.3, 18.4, 18.5, 18.6, 18.10**

- [x] 5. Checkpoint — domain layer proven
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Migration stage 2 — range indexes and open-record integrity
  - [x] 6.1 Write and apply `supabase/migrations/v1.9.1-attendance-indexes.sql`
    - `idx_time_clock_clock_in`, `idx_pto_requests_range`, `idx_pto_requests_approved_range`
    - Repair step reducing any pre-existing set of two or more open entries per profile to the earliest, setting `clock_out` to the later entry's `clock_in`, an `adjustment_reason` of `'v1.9.1 duplicate open entry repair'`, and one `attendance_audit_log` row per closure
    - Then `uniq_time_clock_open_entry` and `uniq_time_clock_open_break` partial unique indexes
    - Header comment records the rollback path; run the retention script from 2.2
    - _Requirements: 20.10, 20.11, 20.12, 23.1, 23.2, 23.3, 23.8_

  - [x] 6.2 Record the query plans for the new range queries
    - `explain (analyze, buffers)` output for the clock-entry, schedule, and time-off range queries under `supabase/verification/` alongside the migration
    - _Requirements: 20.13_

  - [x] 6.3 Harden the clock-in and break routes against unique violations
    - `/api/time-clock` POST and `/api/time-clock/breaks` POST catch the unique-violation code, read the existing open row, and return it as success with `already_open: true`
    - Replace the select-then-insert guard; keep the response contract otherwise unchanged
    - _Requirements: 4.20, 4.21_

  - [ ]* 6.4 Write integration test for concurrent clock-in
    - Fire two simultaneous clock-in requests; assert one open entry and both responses successful
    - _Requirements: 4.21_

- [x] 7. Attendance read services and endpoints
  - [x] 7.1 Implement the attendance-service read paths
    - `server/attendance-service.ts`: `getDay`, `getRecords`, `getMetrics`, `getTrends`
    - Each read resolves scope through `visibleProfileIds`, issues a fixed number of set-based range queries independent of roster size and range length, then calls `deriveRange`
    - `getRecords` caps at 100 rows; no per-employee and no per-date query anywhere
    - _Requirements: 3.14, 3.15, 12.4, 12.17, 12.19, 13.7, 14.2, 14.3, 14.6, 20.1, 20.2, 20.3, 20.8_

  - [x] 7.2 Implement the read route handlers and the shared error contract
    - `/api/attendance/day`, `/api/attendance/records`, `/api/attendance/metrics`, `/api/attendance/trends`
    - Shared response helper for the six failure shapes with stable `code` values (`reason_required`, `owner_cannot_decide`, `coverage_shortfall`, `already_clocked_in`, `stale_request_state`)
    - Authorise before touching data
    - _Requirements: 20.3, 20.8, 21.15, 22.16_

  - [ ]* 7.3 Write property test for metric and row agreement
    - **Property 29: Metric and row agreement**
    - **Validates: Requirements 5.3, 5.4, 5.5, 13.3, 13.4, 13.5, 14.2, 14.3, 14.4**

  - [ ]* 7.4 Write property test for query shaping
    - **Property 30: Query shaping**
    - **Validates: Requirements 5.9, 7.6, 7.7, 7.12, 12.3, 12.4, 12.17, 12.20, 16.7, 20.8**

  - [ ]* 7.5 Write property test for query-count independence
    - **Property 46: Query count independence**
    - Counting stub over the Supabase client; assert a constant outbound query count across roster sizes and range lengths
    - **Validates: Requirements 8.12, 13.7, 14.6, 17.9, 18.11, 20.1, 20.2, 20.3, 20.4, 20.5, 20.6, 20.7**

- [x] 8. Migration stage 3 — additive read policies
  - [x] 8.1 Write and apply `supabase/migrations/v1.9.2-attendance-reads.sql`
    - Additive select policies: own `payroll_summaries`, own `employee_payment_settings`, all-authenticated `staffing_thresholds`
    - No administrator capability moves; header comment records `drop policy` as the rollback; run the retention script
    - _Requirements: 21.13, 21.14, 23.1, 23.2, 23.3, 23.8_

  - [x] 8.2 Replace the default-settings fallback in `/api/payroll/settings`
    - Return an authorisation failure instead of a hardcoded default object with a null rate when no row is readable
    - _Requirements: 21.15_

  - [ ]* 8.3 Write integration tests for the restored self-reads
    - Employee reads own payroll summaries, own pay settings, and the staffing thresholds; assert policy outcomes per role
    - _Requirements: 21.10, 21.13, 21.14_

- [x] 9. Coverage service and endpoints
  - [x] 9.1 Implement the coverage-service
    - `server/coverage-service.ts`: `getCoverage(actor, q)` serving live single-date, projected month or fortnight, projected seven-date, and projected-with-proposed-absence from one implementation; `getImpact(actor, requestId)` as a thin wrapper passing the request ranges as the proposed absence
    - Whole displayed range in a single request; absences without employee names unless administration or the shared-calendar permission holds
    - _Requirements: 6.3, 8.12, 8.13, 9.1, 9.2, 9.6, 18.11, 20.4_

  - [x] 9.2 Implement `/api/coverage` and `/api/coverage/impact`
    - Per-date results carry an optional `unavailable: { reason }` rather than failing the whole range
    - _Requirements: 9.14, 22.16_

  - [ ]* 9.3 Write unit tests for partial projection results
    - A failing threshold lookup on one date leaves the rest of the range intact and states the reason for that date
    - _Requirements: 9.14_

- [x] 10. Checkpoint — reads and coverage wired
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Time-off domain
  - [x] 11.1 Implement the working-day count and balance deltas
    - `domain/pto.ts`: `countWorkingDays(start, end, closedDates)` as the single implementation replacing both copies of `countWeekdays`; `workingDaysByYear`; `balanceDeltas(ptoType, ranges, closedDates, sign)` attributing each date to the calendar year containing that date; `PTO_TYPE_TO_BALANCE_FIELD`
    - Passing `sign: -1` produces the reversal deltas from the same function
    - _Requirements: 10.13, 10.14, 10.15, 10.16, 11.2, 19.8_

  - [x] 11.2 Implement decision mapping and the below-minimum guard
    - Map the eight decision options onto stored statuses; `approve_full` and `approve_with_coverage` to `approved`, `approve_partial` to `partially_approved`, `deny` to `denied`, `waitlist` to `waitlisted`, `suggest_dates` and `request_info` to `information_requested` with the payload distinguishing them
    - `evaluateApprovalGuard(shortfalls, escapes)` permitting the approval exactly when no shortfall exists or coverage is assigned, the shortfall is acknowledged, or an override reason with non-whitespace content is supplied
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 10.6, 10.7, 10.9, 10.10_

  - [x] 11.3 Implement submission disclosure, decision context, and request ordering
    - Shortfall as requested working days minus remaining balance floored at zero; short-notice flag true when the requested start is fewer than 14 calendar days after submission
    - `buildDecisionContext` producing the after-approval balance, notice days, nearby approved absences within 14 days, overlapping pending requests, and the available backup set
    - Default ordering placing pending before decided, plus the per-request coverage risk indicator as the worst status across the requested dates, and `matchesRequestQuery` for the six inbox filters with a 50-row page cap
    - _Requirements: 7.5, 7.6, 7.7, 7.8, 7.9, 7.12, 9.8, 9.9, 9.10, 9.11, 9.12, 11.4, 11.5_

  - [x] 11.4 Correct the time-off type and status vocabulary
    - `src/features/time-attendance/types.ts`: `PTOType` becomes the five values the database constraint accepts; `PTOStatus` gains `waitlisted`, `information_requested`, `partially_approved`
    - Remove `birthday` from the type and from any label map that could submit it
    - _Requirements: 10.20_

  - [ ]* 11.5 Write property test for the approval guard
    - **Property 16: Below-minimum approval guard**
    - **Validates: Requirements 10.9**

  - [ ]* 11.6 Write property test for the working-day count
    - **Property 18: Working-day agreement**
    - **Validates: Requirements 11.2**

  - [ ]* 11.7 Write property test for decision mapping and deltas
    - **Property 19: Decision status mapping and balance delta**
    - **Validates: Requirements 10.2, 10.4, 10.5, 10.6, 10.7, 10.13**

  - [ ]* 11.8 Write property test for year attribution
    - **Property 20: Year attribution**
    - **Validates: Requirements 10.15, 10.16**

  - [ ]* 11.9 Write property test for balance reversal
    - **Property 21: Reversal round trip**
    - **Validates: Requirements 10.14**

  - [ ]* 11.10 Write property test for cancellation eligibility
    - **Property 25: Request cancellation eligibility**
    - **Validates: Requirements 11.8, 11.9, 11.10**

  - [ ]* 11.11 Write property test for submission disclosure
    - **Property 26: Submission disclosure**
    - **Validates: Requirements 11.4, 11.5**

  - [ ]* 11.12 Write property test for the decision context
    - **Property 27: Request decision context**
    - **Validates: Requirements 9.8, 9.9, 9.10, 9.11, 9.12**

  - [ ]* 11.13 Write property test for request ordering and coverage risk
    - **Property 28: Request ordering and coverage risk**
    - **Validates: Requirements 7.8, 7.9**

- [x] 12. Migration stage 4 — time-off decisions
  - [x] 12.1 Write and apply `supabase/migrations/v1.9.3-pto-decisions.sql`
    - Extend the `pto_requests.status` check with `waitlisted`, `information_requested`, `partially_approved`; add `short_notice` and `working_days`
    - `pto_request_decisions` with `unique (request_id, idempotency_key)`; `pto_balance_ledger` with `unique (decision_id, year, balance_field)` and `idx_pto_ledger_profile_year`; `employee_schedules.coverage_for_request_id`
    - `pto_decide()` as `security definer`: assert the caller administers attendance, lock the request row `for update`, reject the request owner, validate that the supplied balance deltas sum to the working days implied by the approved ranges, upsert `pto_balances` then increment in place, insert the ledger rows, set the status, insert the audit row, return the applied state
    - Header comment records the rollback: map new statuses back to `pending`, restore the prior check constraint, drop the two tables and the function; run the retention script
    - _Requirements: 10.8, 10.11, 10.17, 10.18, 10.19, 23.1, 23.2, 23.3, 23.8_

  - [x] 12.2 Implement the pto-service
    - `server/pto-service.ts`: `listRequests`, `submitRequest` computing and storing the working-day count server-side, `cancelOwnRequest`, `decide`
    - `decide` computes deltas from stored rows only, never from a browser-supplied day count or balance; returns the recomputed projected coverage for every affected date alongside the decision
    - Coverage assignment creates or amends the covering employee's schedule row and links it through `coverage_for_request_id`
    - Stale status inside the lock returns `stale_request_state` with the current row
    - _Requirements: 10.3, 10.8, 10.12, 10.18, 10.19, 11.2, 11.6, 11.7, 11.9, 11.10_

  - [x] 12.3 Implement `/api/pto` and `/api/pto/decisions`
    - GET and POST on `/api/pto` for the inbox, employee submission, and cancel; POST on `/api/pto/decisions` for all eight options
    - A replayed idempotency key answers 200 with `applied: false`; a stale state answers 409 with the current row
    - Offer only the request types the database constraint accepts
    - _Requirements: 10.1, 10.17, 10.20, 11.1, 11.3, 11.6, 11.8_

  - [ ]* 12.4 Write property test for preview and commit agreement
    - **Property 17: Preview and commit agreement**
    - **Validates: Requirements 10.12**

  - [ ]* 12.5 Write property test for decision replay
    - **Property 22: Decision replay idempotence**
    - **Validates: Requirements 10.17**

  - [ ]* 12.6 Write property test for decision atomicity
    - **Property 23: Decision atomicity**
    - Model-based against an in-memory store with an injectable failure position
    - **Validates: Requirements 10.18**

  - [ ]* 12.7 Write property test for guard rejections
    - **Property 24: Guard rejections**
    - **Validates: Requirements 5.16, 10.3, 10.10, 10.19, 10.20, 12.13, 21.9**

  - [ ]* 12.8 Write integration tests for decision atomicity and coverage assignment
    - Force a constraint violation inside `pto_decide` and assert neither the status nor the balance moved; assign coverage for a date and assert the schedule row exists with `coverage_for_request_id` set
    - _Requirements: 10.8, 10.18_

- [x] 13. Payroll parity harness — gate for migration stage 5
  - [x] 13.1 Implement `legacy_parity` payroll inputs
    - `payrollInputs(period, mode)` in `server/attendance-service.ts`
    - `legacy_parity` reproduces the pre-redesign arithmetic exactly: sum of stored `total_hours` for closed entries only, `break_minutes` as break hours, whole `total_days` for every overlapping approved request, the period-average overtime cap, and two-decimal rounding at each stage
    - `recomputed` is implemented but not wired to any route
    - _Requirements: 2.4, 19.6_

  - [x] 13.2 Write the parity harness script
    - `scripts/verify-payroll-parity.mjs` reading every `payroll_periods` row with status `processed` or `paid`, recalculating through `legacy_parity`, and reporting any differing field against the stored `payroll_summaries` row
    - Exit non-zero on any difference; this report must be clean before task 14.1
    - _Requirements: 2.4, 23.5_

  - [x] 13.3 Wire `/api/payroll/calculate` to `legacy_parity`
    - Consume `payrollInputs` in `legacy_parity` mode; leave every output field and rounding boundary unchanged
    - _Requirements: 2.4, 2.6, 19.6_

  - [ ]* 13.4 Write property test for payroll parity
    - **Property 47: Payroll legacy parity**
    - Reference transcription of the Appendix A.5 formula in `__tests__/payroll-reference.ts`, annotated with the description it transcribes
    - **Validates: Requirements 2.4**

- [x] 14. Migration stage 5 — attendance mutations
  - [x] 14.1 Write and apply `supabase/migrations/v1.9.4-attendance-mutations.sql`
    - Do not apply until the harness from 13.2 reports no differing field on any `processed` or `paid` period
    - `attendance_apply_correction()` and `attendance_mark_reviewed()` as `security definer`: assert the caller administers attendance, lock the target row `for update`, reject an empty reason where a reason is required, apply the change, insert the audit row as the last statement so its failure rolls the change back
    - `attendance_mark_reviewed` uses `insert ... on conflict (profile_id, work_date) do nothing`
    - Ships with its callers; header comment records `drop function` as the rollback; run the retention script
    - _Requirements: 12.15, 12.16, 16.6, 23.1, 23.2, 23.3, 23.5, 23.8_

  - [x] 14.2 Implement the correction, note, and review service paths
    - `applyCorrection` and `markReviewed` in `server/attendance-service.ts`: resolve the previous value and the covering payroll period, call the function once, then recompute the affected record from source rows after the transaction commits
    - A repeated correction returns the prior result with `applied: false` and still records a second audit entry
    - Corrections inside a `processed` or `paid` period are permitted and never recompute a stored summary; the audit entry carries `payroll_period_id`
    - _Requirements: 3.16, 5.17, 5.18, 12.14, 16.1, 16.2_

  - [x] 14.3 Implement the correction, note, and review endpoints
    - `/api/attendance/corrections`, `/api/attendance/notes`, `/api/attendance/reviews`
    - Require a reason of at least one non-whitespace character; return the recomputed `DailyAttendanceRecord`
    - _Requirements: 5.15, 5.16, 5.18, 12.12, 12.13, 12.14, 12.15, 21.9_

  - [ ]* 14.4 Write property test for audit completeness
    - **Property 34: Audit completeness**
    - **Validates: Requirements 5.17, 10.11, 16.1, 16.2**

  - [ ]* 14.5 Write property test for review idempotence
    - **Property 35: Review idempotence**
    - **Validates: Requirements 12.15, 12.16**

  - [ ]* 14.6 Write integration tests for recompute coupling and audit rollback
    - Apply a correction through the route then read the day and assert the changed status and hours; force the audit insert to fail inside `attendance_apply_correction` and assert the source row is unchanged
    - _Requirements: 3.16, 5.18, 12.14, 16.6_

- [x] 15. Checkpoint — every mutation path audited and atomic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 16. Navigation restructure
  - [x] 16.1 Rename and reorder the sub-navigation identifiers
    - `src/components/app-sidebar.tsx`: `ta_clock` to `ta_today`, `ta_pto` to `ta_timeoff`, `ta_reports` to `ta_review`, drop `ta_staffing`
    - Order Today, Schedule, Time Off & Coverage, then the administrator block Review, Payroll, Workforce behind one `attendanceAdministration` check
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_

  - [x] 16.2 Make navigation resolution module-aware and add the record target
    - `resolveNavigationForRole` falls back to the module's first sub-item before `getDefaultNavigation`, so any retired identifier resolves to Today without an error
    - Add `NavigationTarget` to `NavigationState`; thread it through `role-workspace.tsx` and `TimeAttendanceWorkspace.tsx` to the owning screen, resolved once on mount and then cleared
    - An unreadable or empty target renders the screen without the drawer and states why the record is unavailable
    - _Requirements: 1.7, 1.8, 1.9, 1.10, 1.11, 1.12_

  - [ ]* 16.3 Write property test for navigation resolution
    - **Property 37: Navigation resolution**
    - **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.10**

  - [ ]* 16.4 Write unit tests for navigation order, selection, and targets
    - Sub-navigation order for both role classes; each of the three screen selections; Review defaulting to Exceptions; a target reaching a screen; an unreadable target rendering without a drawer
    - _Requirements: 1.1, 1.7, 1.8, 1.9, 1.11, 1.12, 12.2_

- [x] 17. Shared presentation primitives
  - [x] 17.1 Implement the token table and the status components
    - `shared/tokens.ts` mapping the six colour roles to Neutral slate, Accent `#223f7a`, Healthy emerald, Warning amber, Critical rose, Pending violet
    - `statusToken` in `domain/presentation.ts` returning a role, a non-empty label, a non-empty icon name, and the surface and text classes for every status family
    - `shared/StatusPill.tsx` and `shared/CoverageBadge.tsx` rendering colour, label, and icon together; no screen composes a colour directly
    - _Requirements: 8.4, 12.9, 18.7, 22.5, 22.6, 22.13_

  - [x] 17.2 Implement SideDrawer
    - `shared/SideDrawer.tsx`: store `document.activeElement` on open, move focus to the first focusable node, confine Tab and Shift+Tab with wrap-around, restore focus on close, close on Escape, render as a full-width overlay below 768 pixels
    - The only drawer implementation in the module
    - _Requirements: 22.2, 22.3, 22.10, 22.11_

  - [x] 17.3 Implement the presentation rules for actions and alerts
    - `domain/presentation.ts`: `primaryClockAction` returning exactly one of clock in, start break, end break; `secondaryClockActions` returning clock out only in the open-session-no-break state; `primaryRowAction` as the exception-code lookup to one of the six row actions; `buildMyDayAlerts` deriving the six alert conditions from records
    - _Requirements: 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 12.6, 12.7, 22.4_

  - [x] 17.4 Implement the polling and async-resource hooks
    - `shared/useAttendancePoll.ts` at 60 seconds, pausing when `document.visibilityState` is hidden and refetching immediately on becoming visible
    - `useAsyncResource` exposing loading, empty with the active filters named, and failed with the reason and a retry control, as one wrapper for every screen
    - _Requirements: 4.4, 5.19, 5.20, 6.16, 22.14, 22.15, 22.16_

  - [ ]* 17.5 Write property test for primary-action selection
    - **Property 38: Exactly one primary action**
    - **Validates: Requirements 4.7, 4.8, 4.9, 4.10, 4.11, 12.6, 12.7, 22.4**

  - [ ]* 17.6 Write property test for alert derivation
    - **Property 39: My Day alert derivation**
    - **Validates: Requirements 4.12, 4.13, 4.14, 4.15, 4.16, 4.17**

  - [ ]* 17.7 Write property test for status token completeness
    - **Property 42: Status token completeness**
    - **Validates: Requirements 8.4, 12.9, 18.7, 22.5, 22.6, 22.7**

  - [ ]* 17.8 Write property test for status text contrast
    - **Property 43: Status text contrast**
    - **Validates: Requirements 22.13**

  - [ ]* 17.9 Write property test for drawer focus behaviour
    - **Property 45: Drawer focus round trip**
    - `// @vitest-environment jsdom`; generators include a non-focusable first child and a single-focusable-child drawer
    - **Validates: Requirements 22.10, 22.11**

- [x] 18. Today screen
  - [x] 18.1 Implement TodayScreen and My Day
    - `today/TodayScreen.tsx` routing to My Day or Team Today on the administration predicate
    - `today/MyDayPanel.tsx` rendering the scheduled span and hours, derived status, first clock-in, live worked hours, paid and unpaid break minutes, expected clock-out, one primary action, and the alert list as visible text
    - `today/MyDayHistory.tsx` for at least the preceding 14 dates, subordinate to today's shift
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 4.18, 4.19, 4.20, 5.21, 22.1, 22.7_

  - [x] 18.2 Implement Team Today
    - `TeamTodayHeader.tsx` as the administrator's own compact clock control; `TeamTodaySummary.tsx` with the eight counters as selectable controls that set a `RecordQuery` rather than filtering client-side, with the active filter shown and a clear control; `TeamTodayTable.tsx` with one row per employee scheduled or clocked in today and filters for department, status, and exception type
    - Primary content area given to team attendance, not to the signed-in user's clock
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.19_

  - [x] 18.3 Implement the Live Coverage panel and the employee day drawer
    - `LiveCoveragePanel.tsx` with one compact row per department, the seven headcounts and status, a drawer listing the employees behind each headcount, and a label distinguishing current operational coverage from the projection used for leave decisions
    - `EmployeeDayDrawer.tsx` with today's shift, the ordered timeline, raw clock and break events, derived status, exceptions with the rule that produced each, manager notes, 14-date history, audit entries, and the five administrator actions
    - _Requirements: 6.1, 6.2, 6.14, 6.15, 6.16, 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 5.18_

  - [ ]* 18.4 Write unit tests for clock failure, load states, and polling
    - A failed clock action showing its reason with the displayed state unchanged; a failed team read showing a retry; loading and empty states; fake timers proving a refetch inside 60 seconds and a pause while the document is hidden
    - _Requirements: 4.20, 5.19, 5.20, 6.16, 22.14, 22.15, 22.16_

- [x] 19. Time Off & Coverage screen
  - [x] 19.1 Implement the screen layout and the Request Inbox
    - `timeoff/TimeOffCoverageScreen.tsx`: three panes at 1280 pixels and above, stacked below, drawer as a full-width overlay below 768 pixels
    - `RequestInbox.tsx` with one compact row per request carrying all twelve named fields, the six filters, the four status filter values, pending-before-decided default order, and 50-row pages; non-administrators see only their own requests
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.11, 7.12_

  - [x] 19.2 Implement the Coverage Calendar and the date drawer
    - `CoverageCalendar.tsx` with a monthly and a two-week view, one status indicator and at most four numbers per date cell, status conveyed by label or icon as well as colour, and the whole displayed range fetched in one request
    - `CoverageDateDrawer.tsx` with the scheduled employees, approved absences, pending requests, and the interval breakdown; required coverage lives here rather than in the cell
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.12, 8.13_

  - [x] 19.3 Implement the decision drawer, the impact preview, and the guard
    - `RequestDecisionDrawer.tsx` with the requester context, balances before and after, notice days, nearby absences, overlapping pending requests, backup employees, notes, audit entries, and all eight decision options
    - `ApprovalImpactPreview.tsx` showing projected available, required, and status per requested date, and per interval where a date carries more than one distinct boundary; an unavailable projection states its reason
    - The below-minimum guard blocks the approval until coverage is assigned, the shortfall is acknowledged, or an override reason is supplied
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 10.1, 10.3, 10.9, 10.10_

  - [x] 19.4 Implement the employee request composer
    - `RequestComposer.tsx` offering only the accepted request types, showing remaining balance per type, disclosing a shortfall while still allowing submission, disclosing the short-notice condition, listing the signed-in employee's requests in all five states with the reviewer response, and offering cancel for pending and waitlisted requests
    - _Requirements: 11.1, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.11, 10.20_

  - [ ]* 19.5 Write responsive snapshot tests
    - Each screen at 360, 768, 1024, and 1440 pixels, covering the three-pane arrangement above 1280 pixels, the stacked arrangement below it, and the full-width drawer below 768 pixels
    - _Requirements: 7.1, 7.2, 7.3, 22.3, 22.8_

- [x] 20. Review Center and exports
  - [x] 20.1 Implement CSV writing and file naming
    - `domain/csv.ts`: `toCsv` enclosing every field in double quotes, doubling embedded quotes, emitting the header from the column definitions, preserving the given row order, and emitting the header alone for an empty row set
    - `exportFileName` including the active range dates and every active filter value, with no character illegal in a file name
    - _Requirements: 15.4, 15.5, 15.6, 15.8_

  - [x] 20.2 Implement the export-service and `/api/attendance/export`
    - `server/export-service.ts` reusing the same service reads the screens use with paging removed, for all six view shapes
    - Pay-rate and pay-amount columns filtered out before `toCsv` for non-administrator requests
    - _Requirements: 15.1, 15.2, 15.3, 15.7, 15.9_

  - [x] 20.3 Implement ReviewCenter, ExceptionQueue, and ExceptionDrawer
    - `ReviewCenter.tsx` with the five views in order and Exceptions active by default
    - `ExceptionQueue.tsx` with the thirteen saved filters, one row per employee per work date with all ten named fields, one primary action per row from the lookup, payroll-blocking shown by label or icon as well as colour, a date-range control defaulting to the current pay period, 100-row pages, and windowed virtualisation above 100 rows
    - `ExceptionDrawer.tsx` with the schedule, raw events, break timeline, calculated hours, the rule behind each exception, payroll impact, notes, previous corrections, audit entries, and the four correction controls
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.9, 12.10, 12.11, 12.12, 12.13, 12.14, 12.17, 12.18, 12.19, 12.20_

  - [x] 20.4 Implement the Overview, Trends, Exports, and Audit Log views
    - `OverviewView.tsx` with the seven date presets, the six filters, the fourteen metrics as selectable controls each carrying an accessible name stating label and value, drill-down handing the Exception Queue the same `RecordQuery`, the active range and filters displayed, and an empty state naming the filters
    - `EmployeeTrendsView.tsx` with the twelve values, the per-date scheduled-versus-worked comparison, drill-down on every displayed value, and no chart lacking a drill-down or a stated action
    - `ExportsView.tsx` triggering the six exports; `AuditLogView.tsx` with the recorded fields, the four filters, and 100-row pages, plus `/api/attendance/audit`
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 15.1, 16.3, 16.4, 16.7_

  - [ ]* 20.5 Write property test for CSV serialisation
    - **Property 32: CSV serialisation round trip**
    - Test-local RFC 4180 reader in `__tests__/csv-reader.ts`, itself checked against fixed fixtures
    - **Validates: Requirements 15.4, 15.5, 15.6, 15.8**

  - [ ]* 20.6 Write property test for export and view agreement
    - **Property 33: Export and view agreement**
    - **Validates: Requirements 15.2, 15.3, 15.7**

  - [ ]* 20.7 Write property test for metric control accessible names
    - **Property 44: Metric control accessible name**
    - **Validates: Requirements 13.6, 22.12**

  - [ ]* 20.8 Write unit tests for virtualisation and the memory bound
    - A 5,000-record set rendering a bounded node count; a 180-day load retaining at most 90 days of detail
    - _Requirements: 12.18, 20.9_

- [x] 21. Cross-cutting controls
  - [x] 21.1 Implement inbox aggregation
    - `domain/inbox.ts`: `buildInbox` keyed `${recordKind}:${recordId}` so a record qualifying under several categories collapses to one item carrying the highest-severity category, sorted by severity then age with payroll-blocking and critical coverage first, each item carrying category, subject, and reason
    - _Requirements: 17.3, 17.4, 17.5, 17.7_

  - [x] 21.2 Implement `/api/attendance/inbox` and mount the inbox on every screen
    - Whole item set in a single request; non-administrators see only their own items
    - `shared/NeedsAttentionInbox.tsx` showing an unresolved count, opening a compact list, and navigating through `NavigationTarget` to the owning screen with the record's drawer open; resolved items disappear on the next refresh
    - Mounted on Today, Schedule, Time Off & Coverage, Review, Payroll, and Workforce
    - _Requirements: 17.1, 17.2, 17.6, 17.8, 17.9, 17.10, 1.11_

  - [x] 21.3 Mount the Health Ribbon on the three screens
    - `shared/HealthRibbon.tsx` consuming `deriveRibbonStates` over the shared coverage endpoint, conveying each state by label or icon as well as colour, expanding a selected date to scheduled staffing, approved time off, pending requests, missing shifts, overtime risk, and per-department coverage, and adding the exception records for the current or a past date
    - Mounted on Today, Schedule, and Time Off & Coverage from the same endpoint, so the three cannot disagree
    - _Requirements: 18.1, 18.7, 18.8, 18.9, 18.10, 18.11_

  - [ ]* 21.4 Write property test for inbox aggregation
    - **Property 31: Needs Attention aggregation**
    - **Validates: Requirements 17.3, 17.4, 17.5, 17.7, 17.10**

  - [ ]* 21.5 Write property test for collection rendering completeness
    - **Property 40: Collection rendering completeness**
    - `// @vitest-environment jsdom`
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.18, 4.19, 5.7, 5.8, 6.1, 6.2, 7.4, 7.5, 8.2, 8.3, 12.5**

  - [ ]* 21.6 Write property test for detail panel completeness
    - **Property 41: Detail panel completeness**
    - `// @vitest-environment jsdom`
    - **Validates: Requirements 5.11, 5.12, 5.13, 5.14, 9.3, 9.7, 12.11**

- [x] 22. Preserved screens and workspace wiring
  - [x] 22.1 Rewire TimeAttendanceWorkspace to the six sections
    - Route `ta_today`, `ta_schedule`, `ta_timeoff`, `ta_review`, `ta_payroll`, `ta_workforce` to TodayScreen, ScheduleManager, TimeOffCoverageScreen, ReviewCenter, the payroll pair, and WorkforceAdmin
    - Gate Review, Payroll, and Workforce behind the administration predicate; pass `NavigationTarget` to the owning screen
    - _Requirements: 1.2, 1.3, 1.4, 1.7, 1.8, 1.9_

  - [x] 22.2 Update ScheduleManager for the shared timezone helper and batch template application
    - Replace the hardcoded Guayaquil and Tegucigalpa offsets with the single display helper over `profiles.timezone`
    - `/api/schedules` POST accepts an array body; template application submits the whole set in one request
    - Week grid, week navigation, add, delete, and template behaviour otherwise unchanged
    - _Requirements: 2.1, 2.5, 19.9, 20.7_

  - [x] 22.3 Move the payroll export to the server
    - `PayrollProcessor.tsx` calls the export endpoint in place of the browser-built CSV; every calculation, period selection, review, process, lock, and history behaviour unchanged
    - _Requirements: 2.2, 2.5, 15.1, 15.4_

  - [x] 22.4 Add the attendance-policy editor to WorkforceAdmin
    - Editor for grace period, early-departure tolerance, missing-clock-out tolerance, break-overrun minutes, and unpaid break types, writing `attendance_policy`
    - Pay-rate, PTO-balance, and clock-entry editing unchanged; pay settings and balances each fetched for all listed employees in one request
    - _Requirements: 2.3, 2.5, 20.5, 20.6_

  - [ ]* 22.5 Write regression tests for the preserved controls
    - Schedule week grid, navigation, add, delete, and template controls; payroll period selection, calculate, review, process, lock, history, and export controls; workforce pay-rate, balance, and clock-entry editors
    - _Requirements: 2.1, 2.2, 2.3_

  - [ ]* 22.6 Write keyboard reachability tests
    - Tab reachability and Enter or Space activation across every screen's controls, plus an accessible name on every interactive control, status indicator, and metric control
    - _Requirements: 22.9, 22.12_

- [x] 23. Checkpoint — full experience wired, nothing removed yet
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 24. Cleanup — remove the superseded components and routes
  - Every sub-task in this task commits on its own and carries no behavioural change, per Requirement 23, criterion 7.

  - [x] 24.1 Add the reference-scan check
    - Script asserting no source file references `TimeClock`, `PTORequests`, `StaffingCoverage`, `AttendanceReports`, `ta_clock`, `ta_pto`, `ta_staffing`, `ta_reports`, `/api/staffing`, or `/api/time-clock/reports`
    - Run it first to confirm the four components and two routes are already unreferenced; resolve any remaining reference before deleting anything
    - _Requirements: 23.6_

  - [x] 24.2 Delete the four superseded components
    - Remove `TimeClock.tsx`, `PTORequests.tsx`, `StaffingCoverage.tsx`, `AttendanceReports.tsx`
    - Deletion only; no behavioural edit in this commit
    - _Requirements: 23.6, 23.7_

  - [x] 24.3 Delete `/api/staffing` and `/api/time-clock/reports`
    - Deletion only, in its own commit
    - _Requirements: 23.6, 23.7_

  - [-] 24.4 Remove the retired section mappings and vocabulary remnants
    - Retired section strings in `role-workspace.tsx` and `TimeAttendanceWorkspace.tsx`, and any `birthday` label or mapping left after 11.4
    - _Requirements: 23.6, 23.7_

  - [ ]* 24.5 Wire the reference scan into the test suite
    - Smoke test failing on any reference to a removed component, identifier, or route
    - _Requirements: 23.6_

  - [ ]* 24.6 Write the single-implementation scan
    - Assert each rule name is exported from exactly one domain module, and that no file under `today/`, `timeoff/`, `review/`, or `shared/` re-implements a derivation
    - _Requirements: 3.14, 3.15, 19.1, 19.2, 19.3, 19.5, 19.7, 19.8, 19.9, 19.10, 22.1_

  - [ ]* 24.7 Write the schema presence and migration hygiene checks
    - The nine preserved tables and the five new tables exist; the new indexes exist; no released migration file has changed
    - _Requirements: 2.7, 20.10, 20.11, 20.12, 23.1, 23.2_

- [ ] 25. Migration stage 6 — staffing thresholds (deferred)
  - Blocked on Appendix B, Open Question 3. Do not start until the intended minimum and warning staffing per department, day of week, and time slot are supplied. Until then, unconfigured departments correctly report required as unconfigured with status Healthy, which 4.1 already handles.

  - [~] 25.1 Write and apply the staffing-thresholds seed migration
    - `supabase/migrations/v1.9.5-staffing-thresholds-seed.sql` seeding `staffing_thresholds` for every department, day of week, and time slot from the supplied answers
    - Header comment records the rollback; run the retention script
    - _Requirements: 6.3, 23.1, 23.2, 23.3, 23.8_

  - [~] 25.2 Add the threshold editor to WorkforceAdmin
    - Editor over `staffing_thresholds` for minimum staff and warning threshold per department, day of week, and time slot
    - _Requirements: 2.3, 2.5, 6.3_

- [~] 26. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Sub-tasks marked with `*` are test and verification work and can be skipped for a faster path, but skipping them removes the evidence for Requirement 23, criterion 9.
- Every property test carries the repository's existing tag convention: `// Feature: time-attendance-ui-redesign, Property N: {title}` followed by `**Validates: Requirements X.Y**`. Minimum 100 generated cases, 200 for the arithmetic and timezone properties.
- The 47 correctness properties are distributed as follows: domain foundations 2 (tasks 1), permissions 1 (task 2), attendance derivation 7 (task 3), coverage 6 (task 4), reads and aggregation 3 (task 7), time-off domain 9 (task 11), time-off decisions 4 (task 12), payroll parity 1 (task 13), audit and review 2 (task 14), navigation 1 (task 16), presentation primitives 5 (task 17), review and export 3 (task 20), cross-cutting controls 3 (task 21).
- Task 13 gates task 14. Task 14.1 must not be applied while the parity harness reports any differing field on a `processed` or `paid` period.
- Task 24 is the only task that deletes anything, and it runs after task 22 wires the replacement screens.
- Switching `payrollInputs` from `legacy_parity` to `recomputed` is out of scope. It is the separately approved payroll rule change described in Requirement 2, criterion 6.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "2.1"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.2"] },
    { "id": 2, "tasks": ["1.5", "1.6", "2.3", "3.1", "6.1"] },
    { "id": 3, "tasks": ["2.4", "2.5", "3.2", "4.1", "6.2", "8.1"] },
    { "id": 4, "tasks": ["3.3", "4.2", "6.3", "8.2", "8.3", "11.1"] },
    { "id": 5, "tasks": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9", "3.10", "4.3", "6.4", "11.2", "11.4"] },
    { "id": 6, "tasks": ["4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "7.1", "11.3", "12.1"] },
    { "id": 7, "tasks": ["7.2", "9.1", "11.5", "11.6", "11.7", "11.8", "11.9", "11.10", "11.11", "11.12", "11.13", "16.1"] },
    { "id": 8, "tasks": ["7.3", "7.4", "7.5", "9.2", "12.2", "16.2", "17.1", "17.2", "17.4"] },
    { "id": 9, "tasks": ["9.3", "12.3", "13.1", "17.3", "20.1"] },
    { "id": 10, "tasks": ["12.4", "12.5", "12.6", "12.7", "12.8", "13.2", "13.3", "17.5", "17.6", "17.7", "17.8", "17.9", "20.2"] },
    { "id": 11, "tasks": ["13.4", "14.1", "16.3", "16.4", "18.1", "19.1", "20.3"] },
    { "id": 12, "tasks": ["14.2", "18.2", "19.2", "20.4"] },
    { "id": 13, "tasks": ["14.3", "19.3", "20.5", "20.6", "20.7", "20.8"] },
    { "id": 14, "tasks": ["14.4", "14.5", "14.6", "18.3", "19.4", "21.1", "22.2", "22.3", "22.4"] },
    { "id": 15, "tasks": ["18.4", "19.5", "21.2", "22.1"] },
    { "id": 16, "tasks": ["21.3", "21.4", "22.5", "22.6"] },
    { "id": 17, "tasks": ["21.5", "21.6", "24.1"] },
    { "id": 18, "tasks": ["24.2", "24.3"] },
    { "id": 19, "tasks": ["24.4"] },
    { "id": 20, "tasks": ["24.5", "24.6", "24.7"] },
    { "id": 21, "tasks": ["25.1"] },
    { "id": 22, "tasks": ["25.2"] }
  ]
}
```
