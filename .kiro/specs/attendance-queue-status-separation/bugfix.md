# Bugfix Requirements Document

## Introduction

Attendance status and sales-queue status are two different facts about an employee, and the Work Desk
stores them in one field. `public.profiles.availability` (`available` | `break` | `unavailable`) is the
authoritative input to rotation eligibility for WhatsApp, RingCentral and Additional Workload. Three
Time & Attendance endpoints write it as a side effect of a clock action, the Work Desk **My status**
control writes it as an explicit choice, `ensure_daily_availability_reset()` writes it at the
business-date rollover, and `admin_deactivate_profile()` writes it when a manager deletes a user account.
Nothing arbitrates between them, nothing records which of them acted, and the attendance endpoints
discard the result of the write.

Two consequences reach production. An employee who is deliberately Unavailable in the sales queues is
made queue-eligible again by ending a break, so live sales work is routed to someone who is not taking
it. An employee who clocks out without having been on a break stays Available and keeps holding
rotation turns after leaving for the day. Both are silent: the endpoints return HTTP success whether or
not the availability write succeeded, and no audit row exists anywhere that names the cause of an
availability change.

This bugfix separates the two concepts. Attendance status becomes `Clocked Out | Working | On Break`.
Sales queue status stays `Available | Break | Unavailable`. Whether an attendance action may move the
queue status becomes a manager-controlled per-agent setting that defaults to **manual** — no existing
agent gets attendance-driven queue changes as a result of the fix. Every queue-status change becomes
attributable to a named source. The scope is the coupling and its audit trail; the rotation algorithm,
the attendance calculations, payroll and the schedule system are not being redesigned.

### Verification basis

Read in the repository, and dumped read-only from live Supabase, for this document:

| Behavior | Source read |
|---|---|
| Clock-in, clock-out, manager punch edit | `src/app/api/time-clock/route.ts` |
| Break start, break end | `src/app/api/time-clock/breaks/route.ts` |
| Current attendance read | `src/app/api/time-clock/active/route.ts` |
| Client clock actions, in-flight guard | `src/features/time-attendance/shared/useClockAction.ts` |
| Employee-facing attendance panel | `src/features/time-attendance/today/MyDayPanel.tsx`, `TodayScreen.tsx` |
| **My status** control and `runRpc` | `src/components/work-desk-app.tsx` (~3450, ~3575, ~4429) |
| `set_my_availability`, `next_eligible_profile`, `advance_rotation`, `ensure_rotation_valid`, `pass_my_turn` | `supabase/migrations/v1.8.7-fix-rotation-integrity.sql` (latest repo definitions) |
| `ensure_daily_availability_reset` | `supabase/migrations/v0.9.8-stabilize-integrations.sql` (~1048) — confirmed byte-identical to the live body; `supabase/schema.sql` (~1712) is a stale, materially different lineage and must not be used |
| `admin_deactivate_profile(uuid, uuid, text)` | live body only — no `create function` exists anywhere in `supabase/`; dumped to `evidence/live-functions/` |
| User-account deletion endpoint | `src/app/api/admin/users/route.ts` (`DELETE` handler, ~419) |
| Audit tables | `supabase/schema.sql` (`audit_log`, `turn_events`), `supabase/migrations/v1.9.0-attendance-foundations.sql` (`attendance_audit_log`) |
| Attendance mutation functions | `supabase/migrations/v1.9.4-attendance-mutations.sql` |
| Live function bodies, availability-writer sweep, enums, absence checks | `.kiro/specs/attendance-queue-status-separation/evidence-report.md` and `evidence/` |

Findings that shape the criteria below:

- **Three** SQL paths write `profiles.availability`, not two: `set_my_availability(p_status)`,
  `ensure_daily_availability_reset()` and `public.admin_deactivate_profile(uuid, uuid, text)`. An earlier
  draft of this document claimed exactly two; the live sweep of every `public` function found the third.
  It was missed because it has no `create function` in `supabase/` at all — it exists only in live
  Supabase and is referenced from `v0.9.13-reconcile-renewal-security.sql`,
  `v0.9.13-renewal-security-verification.sql` and `supabase/verification/live-schema-inventory.sql`.
  It is called from the `DELETE` handler in `src/app/api/admin/users/route.ts:419`, sets
  `availability = 'unavailable'` alongside `is_active = false` and the three rotation enable flags, edits
  all three `rotation_state` rows directly via `next_eligible_profile` without going through
  `advance_rotation`, clears CS overflow routing in `work_desk_settings`, and audits to `audit_log` with
  `action = 'user_deleted'` — never to an availability event. Its own SQL guard is
  `role = 'manager' and is_active`, which excludes `super_admin`, and the live body contains **no**
  refusal to delete a `super_admin` target — the only such refusal is the 403 in the `DELETE` handler at
  `src/app/api/admin/users/route.ts`. An earlier draft of this document asserted that a function-level
  `super_admin` refusal existed and would be preserved; the full live-body dump disproves it.
- `admin_deactivate_profile` carries two pre-conditions documented nowhere else, and they constrain any
  test of the deletion path: it raises when the target holds any `work_items` row with
  `status = 'active'`, and when the target holds any `pending_pricing_quotes` row. Any baseline capture or
  end-to-end test of the deletion path must seed a target with neither, or it fails on a raise unrelated to
  this fix.
- No manager-facing queue-status setter exists; `manager_set_rotation_eligibility` toggles the
  per-rotation enable flags, not availability.
- The live `ensure_daily_availability_reset()` is the `v0.9.8-stabilize-integrations.sql:1048` lineage,
  not the `supabase/schema.sql:1712` body. Live does three things schema.sql does not: it nulls all three
  `rotation_state.current_profile_id` pointers (bumping `version`), it marks every unread `turn` row in
  `user_notifications` read, and it carries **no** `availability <> 'unavailable'` predicate, so it
  rewrites every active agent rather than only those whose status actually changes.
- The role enum is `public.app_role`, not `role`. Its members are `agent`, `manager`,
  `customer_service`, `commercial`, `super_admin`, `commercial_supervisor`,
  `customer_service_supervisor`, `sales_supervisor`. Any SQL written against a type named `role` fails.
- `supabase/schema.sql` still carries the v0.7.2-lineage body of `set_my_availability`. The current
  definition is the one in `v1.8.7-fix-rotation-integrity.sql`, recorded as applied to production on
  2026-07-31 in `.kiro/specs/queue-rotation-integrity/evidence-report.md`.
- No existing audit table can carry an availability transition. `turn_events` records rotation-pointer
  moves (`rotation`, `action` constrained to `claim | pass | manual_change | auto_skip | daily_start`,
  previous/next profile) and never the availability value. `attendance_audit_log` is keyed to
  `entity_type` values `clock_entry | break | schedule | pto_request | review | payroll_period` and is
  written only by the manager correction, PTO and review functions. `audit_log` is generic and no
  availability path writes to it.
- The manager punch-edit path (`PATCH /api/time-clock` with `action: 'edit'`) and the v1.9.4 correction
  functions do not touch `profiles.availability` today. That is correct behavior and belongs to
  regression prevention, not to the fix.
- `profiles` has no queue-sync mode column, so attendance-driven availability writes currently apply to
  every employee unconditionally.

### Verified against live Supabase

- All ten function bodies this fix depends on were dumped from live with `pg_get_functiondef` and diffed
  against the latest repo definition. Nine of ten are byte-identical modulo `pg_get_functiondef`
  rendering only — signature collapsing, `set search_path` quoting, volatility/`security definer` line
  folding, and the dollar-quote tag. Nothing semantic differs.
- The v1.8.7 rotation stack is live exactly as `supabase/migrations/v1.8.7-fix-rotation-integrity.sql`
  has it: `set_my_availability`, `advance_rotation`, `ensure_rotation_valid`, `next_eligible_profile`,
  `is_rotation_eligible` and `manager_set_rotation_eligibility`. The role predicates were confirmed
  verbatim: `is_agent()` is `role = 'agent' and is_active`, `is_manager()` is
  `role in ('manager', 'super_admin') and is_active`, `can_manage_sales()` is
  `role in ('manager', 'sales_supervisor', 'super_admin') and is_active`.
- `ensure_daily_availability_reset` is the one exception: live matches
  `v0.9.8-stabilize-integrations.sql:1048`, not `supabase/schema.sql:1712`.
- None of the five live-only frontend RPCs named by the workspace queue-rotation rule
  (`claim_whatsapp_quote_v094`, `claim_ringcentral_quote_v094`, `start_quote_take_timer_v094`,
  `claim_timed_quote`, `steal_timed_quote`) writes `profiles.availability`. Only `steal_timed_quote`
  mentions it, and only as an eligibility read. The unaccounted writer was `admin_deactivate_profile`,
  not one of these.
- No trigger in `public` has a trigger function whose body mentions `availability`, and `public.profiles`
  has no RLS `UPDATE` policy, so every availability write passes through a `security definer` function or
  `service_role`.
- The bug-condition exploration test ran against live and produced **18 counterexamples with zero root
  causes refuted** — all nine hypothesized root causes are CONFIRMED, so every criterion above rests on an
  observed failure rather than a reading of the code. Notable confirmations: two concurrent clock-outs both
  answered HTTP 200 while a sequential retry answers HTTP 400, the same missing re-check surfacing with
  opposite symptoms, which is why 2.10 and 1.11 both exist; the daily reset changed 8 profiles and recorded
  nothing; and `time_clock_breaks.pre_break_queue_status` does not exist, so break-end has nothing to
  restore.

### Not verified in this session

- Production counts for the mismatch classes described below (clocked out but queue Available, clocked in
  but queue Unavailable, active break with queue Available, queue status Break with no active break,
  a queue status with no availability event, an ineligible current turn holder) are unknown until the
  diagnostic in 2.19 runs.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an employee clocks in THEN the system creates an open `time_clock_entries` row, does not write
`profiles.availability`, and returns only the clock entry, so an employee who is Unavailable in all three
rotations is fully clocked in with nothing in the response or the UI stating that they are not receiving
sales work.

1.2 WHEN an employee clocks out and no break was open THEN the system closes the entry and leaves
`profiles.availability` untouched, because `set_my_availability('unavailable')` is called only inside the
`if (onBreak)` branch, so a clocked-out agent remains `available`, remains rotation-eligible, and can keep
holding the current WhatsApp, RingCentral or Workload turn after leaving.

1.3 WHEN an employee starts a break THEN the system calls `set_my_availability('break')` unconditionally
and stores nothing about the prior value, so an agent who was `unavailable` is overwritten to `break` and
the pre-break status is unrecoverable.

1.4 WHEN an employee ends a break THEN the system calls `set_my_availability('available')`
unconditionally, so an agent who was `unavailable` before the break is made queue-eligible without any
action by that agent or a manager, and `set_my_availability`'s available branch may hand them the current
turn in all three rotations through `ensure_rotation_valid` or the daily-start path.

1.5 WHEN a break start, break end or clock-out invokes `set_my_availability` THEN the system discards the
RPC result (`await supabase.rpc(...)` with no error inspection), so `Agent permission required`,
`Active profile not found`, a lock timeout or any other failure returns HTTP 200/201 success while the
queue status is unchanged, and attendance and queue state diverge with no signal.

1.6 WHEN an attendance action needs both an attendance write and an availability write THEN the system
performs them as separate round trips that commit independently, so a failure after the attendance write
leaves the clock entry or break row changed and the queue status stale, with no compensating action and no
rollback.

1.7 WHEN any actor changes queue status THEN the system accepts writes to the single
`profiles.availability` field from the **My status** control, break start, break end, clock-out and the
daily reset with no precedence rule and no per-agent opt-in, so an explicit agent or manager choice is
silently overwritten by an unrelated attendance action and last writer wins.

1.8 WHEN `profiles.availability` changes THEN the system records no availability event anywhere: the
previous status, the new status, the cause, the acting user and the related clock entry or break are not
persisted by any path, so a status change cannot be attributed to the agent, a manager, an attendance
action, the daily reset or a repair.

1.9 WHEN the UI displays status THEN the system shows the **My status** control labelled `Available`,
`Break / Lunch` and `Unavailable` with no indication that those values govern sales-queue participation,
shows the attendance status separately in Time & Attendance, and shows the two nowhere together, so
`Available` is ambiguous and a clocked-in employee has no visible or actionable queue status.

1.10 WHEN two clock-out requests, or two break-end requests, run concurrently THEN both read the same open
entry or open break, both perform their unconditional update, and both call `set_my_availability`, so one
logical action produces two availability transitions and two rotation handoffs; the client-side in-flight
guard in `useClockAction` prevents only the same-tab double click, and neither route re-checks that the
row is still open before writing.

1.11 WHEN a repeated clock-out or break-end request arrives after the first has committed THEN the system
answers HTTP 400 (`Not clocked in.`, `No active break to end.`), while a repeated clock-in answers HTTP 200
with `already_open: true`, so retry semantics differ per action and a client cannot distinguish
"already applied" from "failed" for the queue-status portion.

### Expected Behavior (Correct)

2.1 WHEN an employee clocks in and their queue-status control mode is `attendance_assisted` THEN the system
SHALL record the clock-in, SHALL NOT change queue availability, SHALL return both the attendance status and
the queue availability read from the database, and SHALL surface an explicit `Join Sales Queues` action that
is the only path that sets queue availability to Available.

2.2 WHEN an employee clocks out and mode is `attendance_assisted` THEN the system SHALL set queue
availability to Unavailable whether or not a break was open, SHALL hand off or advance every rotation the
agent currently holds using the existing authoritative availability transition, and SHALL record the change
with source `attendance_clock_out`.

2.3 WHEN a break starts, mode is `attendance_assisted`, and queue availability is Available THEN the system
SHALL persist the pre-break queue status and SHALL set queue availability to Break.

2.4 WHEN a break starts, mode is `attendance_assisted`, and queue availability is Unavailable THEN the
system SHALL persist the pre-break queue status, SHALL leave queue availability Unavailable, and SHALL NOT
write Break, so an agent who is not queue-eligible never becomes queue-eligible through a break.

2.5 WHEN a break ends, mode is `attendance_assisted`, and a stored pre-break queue status exists THEN the
system SHALL restore exactly that stored status — Available restores Available, Unavailable restores
Unavailable — and SHALL NOT force Available.

2.6 WHEN a break ends, mode is `attendance_assisted`, and no stored pre-break queue status exists THEN the
system SHALL set queue availability to Unavailable and SHALL surface the explicit `Join Sales Queues`
action.

2.7 WHEN an attendance action attempts a queue-availability change THEN the system SHALL inspect the value
returned by every database call, and on failure SHALL return a warning naming which portion failed, SHALL
re-read and return both the attendance status and the queue status from the database, and SHALL NOT report
unqualified success.

2.8 WHEN an attendance action is permitted to change queue availability THEN the system SHALL apply it as
one authoritative server-side transition that validates the authenticated employee, locks the active
attendance record where applicable, locks or safely updates the profile availability row, applies the
attendance change, applies the permitted queue-status change, runs the existing queue handoff and recovery
behavior, writes exactly one availability audit event, returns both the attendance status and the queue
status, and rolls the whole operation back if any required database change fails.

2.9 WHEN mode is `manual` THEN clock-in, clock-out, break start, break end and manager attendance
corrections SHALL NOT change queue availability, and only an explicit agent My Status action, an explicit
manager queue-status action, or an authorized queue-maintenance function (daily reset, rotation repair) SHALL
be able to change it.

2.10 WHEN a duplicate or concurrent clock-out, break-end, or queue-status request arrives for the same
employee and the same logical action THEN the system SHALL apply at most one availability transition, SHALL
write at most one availability audit event, SHALL perform at most one rotation handoff, and SHALL answer the
losing request with the committed state rather than a contradictory status.

2.11 WHEN a manager configures an agent THEN the system SHALL expose a per-agent queue-status control mode
with the values `manual` and `attendance_assisted`, SHALL restrict changing it to manager and super_admin,
SHALL record the mode change, and the migration that introduces it SHALL default every existing profile to
`manual` and SHALL NOT enable attendance synchronization for any existing user.

2.12 WHEN queue availability changes for any reason THEN the system SHALL record exactly one availability
event carrying the agent, the previous status, the new status, the source, the acting user, the related
time-clock entry when applicable, the related break entry when applicable, the timestamp, and a
reason/metadata payload; the supported sources SHALL include at least `manual_agent`, `manual_manager`,
`attendance_clock_out`, `attendance_break_start`, `attendance_break_end`, `daily_reset`,
`system_repair` and `user_deactivated`. `user_deactivated` covers the account-deletion path in
`admin_deactivate_profile` and SHALL be distinct from `manual_manager`, because the actor is deleting an
account rather than setting a queue status; collapsing the two would make a deletion indistinguishable
from a deliberate manager queue-status change in the audit trail.

2.13 WHEN no existing audit table can carry the fields in 2.12 THEN the system SHALL add them in a new
forward-only migration and SHALL NOT alter any historical migration file.

2.14 WHEN the UI shows an employee's state THEN the system SHALL display attendance status and sales-queue
status as two separately labelled values, for example `Attendance: Working` and `Sales Queues: Unavailable`,
and SHALL NOT display the bare word `Available` without identifying which of the two it refers to.

2.15 WHEN an employee is clocked in and queue availability is not Available THEN the system SHALL display
`You are clocked in, but you are not currently receiving sales work.` with `Join Sales Queues` as the primary
action.

2.16 WHEN an employee clocks out and mode is `attendance_assisted` THEN the system SHALL display
`You have been clocked out and removed from the sales queues.`

2.17 WHEN an employee clocks out, mode is `manual`, and queue availability is still Available THEN the
system SHALL leave queue availability unchanged, SHALL display `You are clocked out but still marked
Available in Sales Queues.`, and SHALL offer an explicit `Set Unavailable` action.

2.18 WHEN a transition completes or a realtime refresh fires THEN the system SHALL display the attendance
status and queue status as read back from the database and SHALL NOT display an optimistically assumed
status.

2.19 WHEN a manager or super_admin runs the production diagnostic THEN the system SHALL provide a read-only
query listing, for every active agent, the current attendance state, the open clock entry, the active break,
the current sales-queue availability, the queue-sync mode, the current WhatsApp turn, the current
RingCentral turn, the current Workload turn, the most recent availability event, the most recent attendance
event, and the mismatches requiring review, flagging at least: clocked out but queue Available; clocked in
but queue Unavailable; active break but queue Available; no active break but queue status Break; a queue
status change with no audit source; and a current queue holder who is not queue-eligible.

2.20 WHEN a manager or super_admin deletes a user account through `admin_deactivate_profile` THEN the
system SHALL record exactly one availability event carrying the deleted agent, the previous queue status
read before the write, `unavailable` as the new status, source `user_deactivated`, and the acting manager
as the actor — so that requirement 2.12 holds for every writer of `profiles.availability`, not only the
attendance and My Status paths, and the 2.19 diagnostic never flags a deleted user as a queue status
change with no audit source.

2.21 WHEN `admin_deactivate_profile` evaluates whether the caller may deactivate a profile THEN the
recreated function SHALL admit `super_admin` in addition to `manager`, per the workspace super-admin
parity rule, by widening the guard to `role in ('manager', 'super_admin') and is_active`. The live guard
is `role = 'manager' and is_active`, and the live body contains **no** refusal to delete a `super_admin`
target — the only refusal on a `super_admin` target is the 403 in the `DELETE` handler at
`src/app/api/admin/users/route.ts`, so there is no such function-level guard to preserve. The recreated
function SHALL therefore ADD a function-level refusal when the target's role is `super_admin`, per 2.22,
applying to a `manager` caller and a `super_admin` caller alike, so that widening the caller guard narrows
rather than widens the set of deletable accounts. The route's existing 403 SHALL remain in place, making
the two checks defense in depth rather than a single point of enforcement.

2.22 WHEN the target of `admin_deactivate_profile` has role `super_admin` THEN the function SHALL raise
and SHALL NOT deactivate the profile, regardless of the caller's role. The function is granted `EXECUTE`
to `authenticated` (`evidence/live-functions/admin_deactivate_profile.grants.json`), so any manager can
call the RPC directly today and delete a `super_admin`, bypassing the route's 403 entirely; the workspace
super-admin rule states that super admin accounts cannot be deleted by anyone, including other super
admins. This refusal closes that direct-RPC bypass. It is a deliberate addition rather than a preserved
behavior, and it only ever refuses more, never less.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN any queue-status change occurs THEN the system SHALL CONTINUE TO treat WhatsApp, RingCentral and
Additional Workload as three independent rotations, so a change in one never alters the other two.

3.2 WHEN rotation eligibility is evaluated THEN the system SHALL CONTINUE TO require `is_active`,
`role = 'agent'`, `availability = 'available'`, the rotation's enable flag, and a non-null rotation
position, with `profiles.availability` remaining the authoritative queue-status field.

3.3 WHEN exactly one eligible agent exists in a rotation THEN the system SHALL CONTINUE TO leave that
rotation assigned to that agent after an action rather than nulling it.

3.4 WHEN the next eligible agent is resolved THEN the system SHALL CONTINUE TO wrap from the highest
position back to the lowest through `next_eligible_profile`, with the wraparound in `ORDER BY`.

3.5 WHEN a rotation is null or points at an ineligible agent and an eligible agent becomes available THEN
the system SHALL CONTINUE TO recover that rotation automatically through the existing
`ensure_rotation_valid` and `set_my_availability` recovery paths.

3.6 WHEN an agent holding a turn becomes unavailable or on break THEN the system SHALL CONTINUE TO hand the
turn to the next eligible agent through the existing `advance_rotation` path, writing exactly one
`turn_events` row per rotation changed.

3.7 WHEN a queue-consuming action runs THEN the system SHALL CONTINUE TO use the advancement
implementation that action uses today, and this fix SHALL NOT add a new advancement path:
attendance-driven queue changes go through `set_my_availability` or one authoritative replacement for it,
never by editing individual rotations. This is scoped to paths the fix introduces. Three functions already
edit `rotation_state` directly rather than through `advance_rotation` — `ensure_daily_availability_reset`,
`admin_deactivate_profile` and `take_quote_turn` — and they are an explicit allow-list that this fix
preserves as-is; a requirement that all advancement pass through `advance_rotation` would be false against
live today and would fail on unfixed and fixed code alike.

3.8 WHEN Pass, Recover, timed-quote take, WhatsApp claim, RingCentral claim, Customer Service intake claim,
walk-in claim on turn and out of turn, and Workload claim run THEN the system SHALL CONTINUE TO behave
exactly as documented today, including the walk-in out-of-turn exception that leaves
`rotation_state.current_profile_id`, `rotation_state.version` and `turn_events` untouched.

3.9 WHEN a new Eastern business day starts THEN `ensure_daily_availability_reset()` SHALL CONTINUE TO
perform all three of its live effects exactly once under its advisory `pg_advisory_xact_lock(707200072)`,
because this fix recreates the function: it SHALL CONTINUE TO set `availability = 'unavailable'` for every
`is_active` agent, it SHALL CONTINUE TO null all three `rotation_state.current_profile_id` pointers with
`version = version + 1` and `updated_by = null`, and it SHALL CONTINUE TO mark every unread
`user_notifications` row of `notification_type = 'turn'` read. The recreation SHALL be taken from the live
body (the `v0.9.8-stabilize-integrations.sql:1048` lineage, `search_path = public, pg_temp`) and SHALL NOT
be taken from `supabase/schema.sql:1712`, which omits the rotation nulling and the notification clearing.
The observable end state SHALL be unchanged even though the live statement carries no
`availability <> 'unavailable'` predicate and so rewrites agents already Unavailable; identifying the rows
that genuinely changed, in order to emit one `daily_reset` availability event per changed profile, SHALL
NOT alter that end state. The daily-start behavior for the first eligible agent to become Available SHALL
CONTINUE TO apply.

3.10 WHEN an agent uses the **My status** control THEN the system SHALL CONTINUE TO change queue
availability immediately, surface any returned error to the agent, and refresh live data from the database.

3.11 WHEN a manager or super_admin edits a historical clock-in, clock-out or break THEN the system SHALL
CONTINUE TO leave the employee's current queue availability untouched in both modes, and SHALL CONTINUE TO
write the correction to `attendance_audit_log`.

3.12 WHEN attendance figures are produced THEN the system SHALL CONTINUE TO calculate worked hours,
`total_hours`, the paid short/personal versus unpaid lunch break split, `break_minutes`, derived status and
the alert list exactly as today, from the single authoritative attendance calculation.

3.13 WHEN a second clock-in or a second break start races the first THEN the system SHALL CONTINUE TO be
protected by `uniq_time_clock_open_entry` and `uniq_time_clock_open_break` and SHALL CONTINUE TO answer the
losing request with the open row it lost to.

3.14 WHEN a clock action fails THEN the client SHALL CONTINUE TO leave the displayed figures unchanged and
SHALL CONTINUE TO refuse a second submission while one is in flight.

3.15 WHEN audit rows are written THEN `attendance_audit_log` SHALL CONTINUE TO be append-only under
`attendance_audit_immutable()`, `turn_events` SHALL CONTINUE TO record every rotation change using its
existing `claim | pass | manual_change | auto_skip | daily_start` vocabulary, and no historical migration
file SHALL be edited.

3.16 WHEN a profile is created THEN the system SHALL CONTINUE TO set `availability` to `unavailable` on
insert.

3.17 WHEN a manager or super_admin deletes a user account THEN the recreated `admin_deactivate_profile`
SHALL CONTINUE TO behave identically to the live body, transcribed from
`evidence/live-functions/admin_deactivate_profile.sql`, in every respect other than the three additions
named at the end of this clause. Specifically:

- it SHALL CONTINUE TO raise on each of its eight existing refusals, with the same conditions: a null
  `p_profile_id` or `p_manager_id`; a blank reason (`nullif(btrim(p_reason), '') is null`);
  self-deletion (`p_profile_id = p_manager_id`); a caller who is not `role = 'manager' and is_active`
  (widened to include `super_admin` by 2.21, otherwise unchanged); a target that is not `is_active`, read
  `for update`; the **final active Manager** (`if v_target.role = 'manager'` and `v_active_managers <= 1`),
  which SHALL CONTINUE TO be refused; a target holding any `work_items` row with `status = 'active'`; and a
  target holding any `pending_pricing_quotes` row;
- it SHALL CONTINUE TO set `is_active = false`, `availability = 'unavailable'`, `whatsapp_active = false`,
  `ringcentral_active = false`, `workload_active = false` and `updated_at = now()` on the target profile;
- for each of `whatsapp`, `ringcentral` and `workload` it SHALL CONTINUE TO perform the **direct**
  `update rotation_state set current_profile_id = next_eligible_profile(<kind>,
  v_target.<kind>_position), version = version + 1, updated_at = now(), updated_by = p_manager_id`, each
  guarded by its existing `if exists (select 1 from public.rotation_state where kind = <kind> and
  current_profile_id = p_profile_id)`, rather than being rerouted through `advance_rotation`;
- it SHALL CONTINUE TO clear CS overflow routing with `customer_service_overflow_enabled = false`,
  `customer_service_profile_id = null`, `updated_at = now()`, `updated_by = p_manager_id`, scoped to
  `where singleton_id = true and customer_service_profile_id = p_profile_id`;
- it SHALL CONTINUE TO write its single `audit_log` row with `actor_profile_id = p_manager_id`,
  `action = 'user_deleted'`, `entity_type = 'profile'`, `entity_id = p_profile_id`,
  `old_value = to_jsonb(v_target)`,
  `new_value = jsonb_build_object('is_active', false, 'availability', 'unavailable')` and
  `reason = btrim(p_reason)`.

The additions are exactly three: the one `user_deactivated` availability event required by 2.20, the
widened caller guard required by 2.21, and the new `super_admin` target refusal required by 2.22. The
`super_admin` target refusal is an addition and not a preservation, because the live body has no such
refusal to preserve.

3.18 WHEN `admin_deactivate_profile` is recreated THEN the system SHALL CONTINUE TO expose it with its live
posture: signature `(p_profile_id uuid, p_manager_id uuid, p_reason text)`, `returns void`,
`language plpgsql`, `security definer`, `set search_path to 'public'` (**not** `public, pg_temp`), volatile,
owner `postgres`, and `EXECUTE` granted to `postgres`, `service_role` and `authenticated`; and exactly one
overload SHALL CONTINUE TO exist live, as exactly one exists today. The recreation SHALL be written as
`create or replace function` so those three grants survive — `pg_get_functiondef` emits no grants, so a
`drop`/`create` would silently drop them and break the `DELETE` route for `authenticated` callers.

### Bug Condition

**F** is the current behavior of the clock-in, clock-out, break-start and break-end paths together with
`set_my_availability`, plus the two other live writers of `profiles.availability`:
`ensure_daily_availability_reset()` and `admin_deactivate_profile(uuid, uuid, text)`. **F'** is the
behavior after the fix.

An input `X` is one attendance or status request in its full pre-state: the employee, the action, the
queue-status control mode, the attendance state, the current queue availability, the stored pre-break queue
status, the rotations the employee currently holds, and whether the request is a duplicate or concurrent
with another.

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type StatusTransitionRequest
    X.action        ∈ {clock_in, clock_out, break_start, break_end, manager_correction, my_status,
                       user_deleted}                   // user_deleted = admin_deactivate_profile
    X.mode          ∈ {manual, attendance_assisted}   // absent in F; every agent behaves as assisted
    X.queue         ∈ {available, break, unavailable} // profiles.availability before the action
    X.preBreak      ∈ {available, break, unavailable, none}
    X.hadOpenBreak  : boolean
    X.concurrent    : boolean                          // duplicate or racing request
  OUTPUT: boolean

  // C1 — clock-in leaves the employee clocked in but not queue-available, unsignalled
  C1 ← X.action = clock_in AND X.queue ≠ available

  // C2 — clock-out with no open break never writes Unavailable
  C2 ← X.action = clock_out AND X.queue = available AND NOT X.hadOpenBreak

  // C3 — break start overwrites a deliberate Unavailable and loses the prior value
  C3 ← X.action = break_start AND X.queue ≠ available

  // C4 — break end forces Available regardless of the pre-break status
  C4 ← X.action = break_end AND X.preBreak ≠ available

  // C5 — competing writer: an attendance action changes queue status for an agent
  //      whose required default mode is manual
  C5 ← X.action ∈ {clock_out, break_start, break_end} AND X.mode = manual

  // C6 — swallowed error: attendance committed, availability RPC failed, HTTP success returned
  C6 ← X.action ∈ {clock_out, break_start, break_end}
       AND attendanceWriteSucceeds(X) AND availabilityCallFails(X)

  // C7 — duplicate or concurrent request applies the transition twice
  C7 ← X.action ∈ {clock_out, break_end} AND X.concurrent

  // C8 — audit gap: no availability event is recorded for ANY queue-status change,
  //      across ALL THREE writers of profiles.availability:
  //        set_my_availability, ensure_daily_availability_reset, admin_deactivate_profile
  C8 ← changesQueueAvailability(F, X)

  RETURN C1 OR C2 OR C3 OR C4 OR C5 OR C6 OR C7 OR C8
END FUNCTION
```

`C8` holds for every input that changes queue availability, including a legitimate **My status** change.
That is deliberate: the missing audit trail is a defect of all availability writes, not only of the
attendance-driven ones. The writer set `C8` ranges over has **three** members, not two: alongside
`set_my_availability` and `ensure_daily_availability_reset`, the account-deletion path
`admin_deactivate_profile(uuid, uuid, text)` is a third writer, so `X.action = user_deleted` satisfies
`C8` and is in scope for the fix per 2.20, 2.21 and 2.22. Preservation checking is therefore stated over
observable behavior — attendance figures, resulting queue availability, and rotation outcomes — with the
new audit event treated as an additive record rather than a behavior change.

```pascal
// Property: Fix Checking — attendance never silently decides queue participation
FOR ALL X WHERE isBugCondition(X) DO
  result ← F'(X)

  ASSERT result.attendanceStatus ∈ {clocked_out, working, on_break}
  ASSERT result.queueStatus      ∈ {available, break, unavailable}
  ASSERT result.attendanceStatus = readAttendanceFromDatabase(X.employee)
  ASSERT result.queueStatus      = readAvailabilityFromDatabase(X.employee)

  IF X.mode = manual AND X.action ≠ my_status THEN
    ASSERT result.queueStatus = X.queue                       // 2.9
  END IF

  IF X.mode = attendance_assisted THEN
    CASE X.action OF
      clock_in:     ASSERT result.queueStatus = X.queue
                    AND result.offersJoinSalesQueues            // 2.1
      clock_out:    ASSERT result.queueStatus = unavailable
                    AND NOT holdsAnyTurn(X.employee)            // 2.2
      break_start:  ASSERT result.savedPreBreak = X.queue
                    AND result.queueStatus =
                        (IF X.queue = available THEN break ELSE X.queue)   // 2.3, 2.4
      break_end:    ASSERT result.queueStatus =
                        (IF X.preBreak = none THEN unavailable ELSE X.preBreak)  // 2.5, 2.6
    END CASE
  END IF

  IF anyRequiredDatabaseChangeFailed(X) THEN
    ASSERT rolledBack(result) OR (result.warning NAMES failedPortion(X))
    ASSERT NOT reportsUnqualifiedSuccess(result)                // 2.7, 2.8
  END IF

  IF changesQueueAvailability(F', X) THEN
    ASSERT countAvailabilityEvents(X) = 1
    ASSERT event.previousStatus = X.queue
    ASSERT event.newStatus      = result.queueStatus
    ASSERT event.source ∈ {manual_agent, manual_manager, attendance_clock_out,
                           attendance_break_start, attendance_break_end,
                           daily_reset, system_repair, user_deactivated}
    IF X.action = user_deleted THEN
      ASSERT event.source = user_deactivated                     // 2.20
      ASSERT event.newStatus = unavailable
    END IF
    ASSERT event.actor IS NOT NULL
    ASSERT relatedAttendanceEntryRecorded(event, X)              // 2.12
  END IF

  IF X.concurrent THEN
    ASSERT countAvailabilityTransitions(X) = 1
    ASSERT countAvailabilityEvents(X)      = 1
    ASSERT countTurnHandoffs(X)            ≤ 1                  // 2.10
  END IF
END FOR
```

```pascal
// Property: Preservation Checking — everything outside the bug condition is untouched
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT attendanceFigures(F'(X))  = attendanceFigures(F(X))    // 3.12
  ASSERT queueAvailability(F'(X))  = queueAvailability(F(X))     // 3.2
  ASSERT rotationPointers(F'(X))   = rotationPointers(F(X))      // 3.1, 3.3, 3.4, 3.6
  ASSERT turnEventsWritten(F'(X))  = turnEventsWritten(F(X))     // 3.15
END FOR

// Property: Preservation Checking — rotation invariants hold for every input, buggy or not
FOR ALL X DO
  state ← rotationStateAfter(F'(X))

  FOR EACH k IN {whatsapp, ringcentral, workload} DO
    ASSERT state[k] = rotationStateBefore(X)[k]
        OR k ∈ rotationsLegitimatelyAffectedBy(X)                // 3.1
    ASSERT state[k].current IS NULL
        OR isRotationEligible(state[k].current, k)               // 3.2
    ASSERT NOT (state[k].current IS NULL
                AND existsEligibleAgent(k))                      // 3.5

    // 3.7 — "this fix adds no new advancement path", NOT "all advancement goes
    //        through advance_rotation". The stronger form is ALREADY FALSE against
    //        live and would fail on unfixed and fixed code alike, because three
    //        pre-existing functions edit rotation_state directly today:
    //          ensure_daily_availability_reset  — nulls all three pointers
    //          admin_deactivate_profile         — per-rotation next_eligible_profile update
    //          take_quote_turn                  — direct rotation_state update
    //        Those three are an explicit allow-list, unchanged by this fix.
    ASSERT advancementPathsIn(F') ⊆ advancementPathsIn(F)
    ASSERT EVERY p IN advancementPathsIn(F') SATISFIES
             p = advance_rotation
             OR p ∈ {ensure_daily_availability_reset,
                     admin_deactivate_profile,
                     take_quote_turn}                            // 3.7
  END FOR
END FOR
```
