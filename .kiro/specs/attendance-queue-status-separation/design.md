# Attendance / Queue Status Separation Bugfix Design

## Overview

`public.profiles.availability` is one field carrying two unrelated facts: whether an employee is at work,
and whether an agent is taking sales work. Three Time & Attendance HTTP routes write it as a side effect
of a clock action, the Work Desk **My status** control writes it as an explicit choice,
`ensure_daily_availability_reset()` writes it at the business-date rollover, and
`admin_deactivate_profile()` writes it when a manager deletes a user account. Nothing arbitrates between
those writers, nothing records which of them acted, and the attendance routes throw the result of the
write away.

**Three** SQL paths write `profiles.availability`, not two. An earlier draft of this design said two; the
live sweep in `evidence-report.md` § 1.4 found the third:

| Writer | Repo source | Edits `rotation_state` | Audits |
|---|---|---|---|
| `set_my_availability(availability_status)` | `v1.8.7-fix-rotation-integrity.sql:525`, live-identical | yes, via `ensure_rotation_valid` / `advance_rotation` | nothing |
| `ensure_daily_availability_reset()` | `v0.9.8-stabilize-integrations.sql:1048`, live-identical — **not** `supabase/schema.sql:1712` | yes, nulls all three pointers directly | nothing |
| `public.admin_deactivate_profile(uuid, uuid, text)` | **none — live body only** | yes, per rotation via `next_eligible_profile`, directly | `audit_log`, `action = 'user_deleted'` |

`admin_deactivate_profile` has no `create function` anywhere in `supabase/`. It is referenced from
`v0.9.13-reconcile-renewal-security.sql`, `v0.9.13-renewal-security-verification.sql` and
`supabase/verification/live-schema-inventory.sql`, and is called from the `DELETE` handler at
`src/app/api/admin/users/route.ts:419`. It sets `availability = 'unavailable'` alongside `is_active = false`
and all three rotation enable flags, hands off every rotation the target holds by updating `rotation_state`
directly, clears CS overflow routing in `work_desk_settings`, and audits only to `audit_log` — never to an
availability event. Its own guard is `role = 'manager' and is_active`, which excludes `super_admin`.

The fix separates the two facts without redesigning either system:

1. **A per-agent opt-in gate.** `profiles.queue_status_mode` (`manual | attendance_assisted`) decides
   whether an attendance action may move queue status at all. The migration defaults every existing
   profile to `manual`, so shipping the fix removes attendance-driven queue changes for everyone and
   turns them back on only where a manager asks for them.
2. **One authoritative transition per attendance action.** Four new `security definer` functions replace
   the multi-round-trip route bodies. Each one locks the attendance record, applies the attendance
   change, applies the permitted queue change **through the existing `set_my_availability`**, writes one
   audit event, and returns both statuses — in one transaction that rolls back whole.
3. **Memory of the pre-break queue status.** `time_clock_breaks.pre_break_queue_status` records what the
   agent was before the break so break-end restores it instead of forcing `available`.
4. **An audit table that can carry an availability transition.** `public.availability_events`, append-only,
   naming the previous status, the new status, the source, the actor, and the related clock entry or break.
5. **A UI that names which status it is showing.** Attendance status and sales-queue status become two
   separately labelled values, and the bare word `Available` stops standing alone.
6. **Coverage of all three writers, not just the attendance paths.** `ensure_daily_availability_reset()`
   and `admin_deactivate_profile()` are recreated from their **live** bodies with one availability event
   added each, so requirement 2.12 holds for every writer of the field and the diagnostic never flags a
   daily reset or a deleted user as an unattributable change. Their existing direct `rotation_state`
   behavior is reproduced exactly, not rerouted.

The rotation algorithm, the eligibility predicate, the attendance calculations, payroll and the schedule
system are not touched. Every attendance-driven queue change still goes through `set_my_availability`, so
this fix **adds no new advancement path**. That is the claim, and it is deliberately weaker than "all
advancement goes through `advance_rotation`": three pre-existing functions —
`ensure_daily_availability_reset`, `admin_deactivate_profile` and `take_quote_turn` — edit `rotation_state`
directly today. They are an explicit allow-list this fix preserves as-is.

### Verification status

Everything this design depends on was read in the repository and dumped read-only from live Supabase; see
`evidence-report.md` and `evidence/`.

- All ten live function bodies were dumped with `pg_get_functiondef` and diffed against the latest repo
  definition. Nine of ten are byte-identical modulo `pg_get_functiondef` rendering only — signature
  collapsing, `set search_path` quoting, volatility / `security definer` line folding, and the dollar-quote
  tag. Nothing semantic differs.
- The v1.8.7 rotation stack is live exactly as `supabase/migrations/v1.8.7-fix-rotation-integrity.sql` has
  it: `set_my_availability`, `advance_rotation`, `ensure_rotation_valid`, `next_eligible_profile`,
  `is_rotation_eligible`, `manager_set_rotation_eligibility`.
- The three role predicates were confirmed verbatim: `is_agent()` is `role = 'agent' and is_active` (agent
  only), `is_manager()` is `role in ('manager', 'super_admin') and is_active`, `can_manage_sales()` is
  `role in ('manager', 'sales_supervisor', 'super_admin') and is_active`.
- `ensure_daily_availability_reset` is the one exception: live matches
  `v0.9.8-stabilize-integrations.sql:1048`, not `supabase/schema.sql:1712`.
- None of the five live-only `_v094`-era RPCs named by the workspace queue-rotation rule
  (`claim_whatsapp_quote_v094`, `claim_ringcentral_quote_v094`, `start_quote_take_timer_v094`,
  `claim_timed_quote`, `steal_timed_quote`) writes `profiles.availability`. Only `steal_timed_quote`
  mentions it, and only as an eligibility read. The unaccounted writer was `admin_deactivate_profile`.
- No trigger in `public` has a body mentioning `availability`, and `public.profiles` has no RLS `UPDATE`
  policy, so every availability write passes through a `security definer` function or `service_role`.
- All six objects the migration introduces are confirmed absent from live, so `v1.12.13` is purely additive.
- `admin_deactivate_profile`'s **full** live body and ACL were dumped in task 1.1 to
  `evidence/live-functions/admin_deactivate_profile.sql` (4,139 bytes) and
  `evidence/live-functions/admin_deactivate_profile.grants.json`. Two things the full body settles: it
  contains **no** refusal to delete a `super_admin` target — the only such refusal is the route's 403 — and
  it carries two undocumented pre-conditions, an active `work_items` row and any `pending_pricing_quotes`
  row, either of which makes it raise. Its eight refusals and its exact posture are transcribed into Fix
  Implementation item 12.
- The bug-condition exploration test ran against live and produced **18 counterexamples with zero root
  causes refuted**: all nine hypothesized root causes are CONFIRMED, so this design rests on observed
  failures rather than on a reading of the code. Three findings sharpen it:
  - Two concurrent clock-outs both answered **HTTP 200**, while a sequential retry answers **HTTP 400**.
    One missing re-check, opposite symptoms — which is why both 2.10 and 1.11 exist, and why the
    idempotency guard in item 7 step 3 has to handle both shapes, not just the retry.
  - The daily reset changed **8** profiles and recorded nothing anywhere, so item 11's per-changed-profile
    event count has a measured baseline to reproduce.
  - `time_clock_breaks.pre_break_queue_status` does not exist, confirming there is nowhere to store the
    pre-break value today and that item 3 is adding the column rather than reusing one.

Only the **production mismatch counts** remain unknown — clocked out but queue Available, clocked in but
queue Unavailable, active break with queue Available, queue status Break with no active break, a queue
status with no availability event, an ineligible current turn holder. Those stay unknown until the 2.19
diagnostic runs.

## Glossary

- **Bug_Condition (C)**: the condition that triggers the bug — an attendance action silently deciding, or
  silently failing to decide, sales-queue participation, and any queue-status change that leaves no audit
  trail. Formalized as `isBugCondition(X)` in Bug Details.
- **Property (P)**: the desired behavior — attendance status and queue status are two separately reported
  facts; an attendance action moves queue status only where a manager has opted the agent in; every change
  is attributable; nothing is reported as an unqualified success unless it committed.
- **Preservation**: the attendance figures, the resulting queue availability, the rotation pointers and the
  `turn_events` rows produced for every input outside the bug condition, which must be byte-for-byte what
  they are today.
- **Attendance status**: `Clocked Out | Working | On Break`, derived from `time_clock_entries` and
  `time_clock_breaks`. Applies to every employee.
- **Sales-queue status**: `profiles.availability` ∈ `available | break | unavailable`. The authoritative
  input to rotation eligibility. Meaningful only for `role = 'agent'`, because
  `is_rotation_eligible(profile, rotation)` requires it.
- **Queue-status control mode**: the new `profiles.queue_status_mode`. `manual` means only an explicit
  agent action, an explicit manager action, or an authorized queue-maintenance function may change queue
  status. `attendance_assisted` additionally lets clock-out, break-start and break-end change it.
- **`set_my_availability(p_status)`**: `supabase/migrations/v1.8.7-fix-rotation-integrity.sql`, section 8.
  The only self-service SQL path that writes `profiles.availability`. Writes the profile row, then walks
  all three `rotation_state` rows in `kind` order under `for update`, repairing or starting a rotation on
  the `available` branch and handing off held turns through `advance_rotation` otherwise. Requires
  `is_agent()`. Writes no availability audit row.
- **`is_agent()`**: `select exists(... role = 'agent' and is_active)`. Agent role only — not
  `customer_service`, not `commercial`, not `manager`, not `super_admin`. Confirmed verbatim against live.
- **`ensure_daily_availability_reset()`**: the live body is the
  `supabase/migrations/v0.9.8-stabilize-integrations.sql:1048` lineage with
  `search_path = public, pg_temp`, **not** the materially different `supabase/schema.sql:1712` body. Under
  `pg_advisory_xact_lock(707200072)`, once per Eastern business date, it does three things: marks every
  `is_active` agent Unavailable **with no `availability <> 'unavailable'` predicate**, so it rewrites every
  active agent rather than only those that change; nulls all three `rotation_state.current_profile_id`
  pointers with `version = version + 1` and `updated_by = null`; and marks every unread `user_notifications`
  row of `notification_type = 'turn'` read.
- **`admin_deactivate_profile(p_profile_id uuid, p_manager_id uuid, p_reason text)`**: the third writer of
  `profiles.availability`. Live body only — no `create function` exists in `supabase/`. Called from the
  `DELETE` handler at `src/app/api/admin/users/route.ts:419` when a manager deletes a user account. Sets
  `is_active = false`, `availability = 'unavailable'`, all three rotation enable flags false and
  `updated_at = now()`; hands off each rotation the target holds with a **direct**
  `update rotation_state set current_profile_id = next_eligible_profile(...)`, not through
  `advance_rotation`; clears CS overflow routing in `work_desk_settings`; writes one `audit_log` row with
  `action = 'user_deleted'`. Caller guard is `role = 'manager' and is_active` — `super_admin` excluded. Its
  live body contains **no** refusal to delete a `super_admin` **target**; the only such refusal is the 403 in
  the `DELETE` handler. What it does refuse, among the eight refusals enumerated in Fix Implementation item
  12, is deleting the **final active Manager**.
- **`public.app_role`**: the role enum, and the correct type name. Members: `agent`, `manager`,
  `customer_service`, `commercial`, `super_admin`, `commercial_supervisor`,
  `customer_service_supervisor`, `sales_supervisor`. `profiles.role` is
  `app_role not null default 'agent'::app_role`. There is no type named `role`; SQL written against one
  fails.
- **Source**: the named cause of a queue-status change — `manual_agent`, `manual_manager`,
  `attendance_clock_out`, `attendance_break_start`, `attendance_break_end`, `daily_reset`,
  `system_repair`, `user_deactivated`. Eight members. `user_deactivated` is the account-deletion path and
  is deliberately distinct from `manual_manager`, because the actor is deleting an account rather than
  setting a queue status (2.12).

## Bug Details

### Bug Condition

The bug manifests whenever an attendance action and a sales-queue decision are entangled in the single
`profiles.availability` field. Concretely, five distinct defects live in that entanglement: clock-out
writes `unavailable` only when a break happened to be open; break-start overwrites a deliberate
`unavailable` and keeps no record of it; break-end forces `available` regardless of what came before;
every attendance-driven write applies to every employee with no opt-in; and the result of every such write
is discarded, so a refused or timed-out call returns HTTP success. A sixth defect spans all writers: no
availability transition is recorded anywhere, by any path.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type StatusTransitionRequest
    X.action        IN {clock_in, clock_out, break_start, break_end, manager_correction, my_status,
                       user_deleted, daily_reset}
                       -- user_deleted = admin_deactivate_profile
                       -- daily_reset  = ensure_daily_availability_reset; carried in the domain so
                       --                Property 3's exemption for it is well-typed
    X.mode          IN {manual, attendance_assisted}   -- absent in F; every agent behaves as assisted
    X.queue         IN {available, break, unavailable}  -- profiles.availability before the action
    X.preBreak      IN {available, break, unavailable, none}
    X.hadOpenBreak  : boolean
    X.concurrent    : boolean                           -- duplicate or racing request
  OUTPUT: boolean

  -- C1: clocked in but not queue-available, with nothing said about it
  C1 := X.action = clock_in AND X.queue <> available

  -- C2: clock-out with no open break never writes Unavailable
  C2 := X.action = clock_out AND X.queue = available AND NOT X.hadOpenBreak

  -- C3: break start overwrites a deliberate Unavailable and loses the prior value
  C3 := X.action = break_start AND X.queue <> available

  -- C4: break end forces Available regardless of the pre-break status
  C4 := X.action = break_end AND X.preBreak <> available

  -- C5: an attendance action changes queue status for an agent whose required
  --     default mode is manual
  C5 := X.action IN {clock_out, break_start, break_end} AND X.mode = manual

  -- C6: attendance committed, availability call failed, HTTP success returned
  C6 := X.action IN {clock_out, break_start, break_end}
        AND attendanceWriteSucceeds(X) AND availabilityCallFails(X)

  -- C7: duplicate or concurrent request applies the transition twice
  C7 := X.action IN {clock_out, break_end} AND X.concurrent

  -- C8: no availability event is recorded for ANY queue-status change, across
  --     ALL THREE writers of profiles.availability: set_my_availability,
  --     ensure_daily_availability_reset, admin_deactivate_profile
  C8 := changesQueueAvailability(F, X)

  RETURN C1 OR C2 OR C3 OR C4 OR C5 OR C6 OR C7 OR C8
END FUNCTION
```

`C8` holds for every input that changes queue availability, including a legitimate **My status** change.
That is deliberate: the missing audit trail is a defect of all availability writes, not only of the
attendance-driven ones. The writer set `C8` ranges over has **three** members, so
`X.action = user_deleted` satisfies `C8` and account deletion is in scope for the fix (2.20, 2.21).
Because `C8` swallows the whole change-producing input space, preservation
checking is stated over observable behavior — attendance figures, resulting queue availability, rotation
pointers, `turn_events` rows — and the new audit event is treated as an additive record rather than a
behavior change.

### Examples

- **C2, clock-out with no break.** Agent is `available` and holds the WhatsApp turn. They clock out at
  17:00 without having taken a break. Expected: removed from the queues, WhatsApp handed to the next
  eligible agent. Actual: `set_my_availability` is never called, because the call sits inside
  `if (onBreak)`. The agent stays `available`, stays eligible, and keeps holding the WhatsApp turn
  overnight until the next business-date reset.

- **C3 + C4, break laundering a deliberate Unavailable.** Agent sets **My status** to `Unavailable` to
  finish paperwork. They then start a lunch break: `set_my_availability('break')` overwrites
  `unavailable`, and nothing records that `unavailable` was the prior value. They end the break:
  `set_my_availability('available')` fires unconditionally. Expected: still `Unavailable`. Actual:
  `available`, rotation-eligible, and `set_my_availability`'s available branch may hand them the current
  turn in all three rotations through `ensure_rotation_valid` or the daily-start path. Live sales work is
  routed to someone who is not taking it.

- **C6, verified and requiring no race.** `set_my_availability` opens with
  `if not public.is_agent() then raise exception 'Agent permission required'`, and `is_agent()` is
  `role = 'agent'` only. `POST /api/time-clock/breaks` and `PATCH /api/time-clock/breaks` call it with
  `await supabase.rpc(...)` and never inspect the result. So for every `customer_service`, `commercial`,
  `manager`, `super_admin` and supervisor employee, every break start and every break end raises inside
  Postgres, is discarded by the route, and returns HTTP 201 / 200. This is not an edge case: it is the
  guaranteed behavior for every non-agent employee, every break, every day.

- **C7, double clock-out.** Two clock-out requests from two tabs both read the same open entry, both run
  the unconditional `update ... where id = activeEntry.id`, and both proceed. Neither route re-checks that
  the row is still open after reading it. With a break open, both call
  `set_my_availability('unavailable')`, producing two availability transitions and up to two rotation
  handoffs for one logical action. `useClockAction`'s `inFlightRef` guard stops only the same-tab double
  click.

- **C1, edge case — the fix is disclosure, not a state change.** Agent is `unavailable` from yesterday's
  reset and clocks in. Expected after the fix: clock-in still does not touch queue status, but the
  response and the UI state plainly that the agent is clocked in and not receiving sales work, and offer
  `Join Sales Queues`. Actual today: HTTP 201 with only the clock entry, and no queue status anywhere in
  the attendance UI.

- **C8, audit gap.** No table can carry an availability transition. `turn_events` records rotation-pointer
  moves — `rotation`, `action` constrained to `claim | pass | manual_change | auto_skip | daily_start`,
  previous and next profile — and never the availability value. `attendance_audit_log.entity_type` is
  keyed to `clock_entry | break | schedule | pto_request | review | payroll_period` and is written only by
  the v1.9.4 correction, PTO and review functions. `audit_log` is generic and no availability path writes
  to it.

- **C8 via `user_deleted`, the writer the earlier draft missed.** A manager deletes an agent who is
  `available` and holds the RingCentral turn. `admin_deactivate_profile` writes
  `availability = 'unavailable'`, hands RingCentral to the next eligible agent, and records the deletion in
  `audit_log` as `user_deleted` — with the availability change visible only as a field inside
  `new_value`, not as an availability transition with a previous status, a source and an actor. So the
  2.19 diagnostic's "a queue status with no availability event" class would flag every deleted user
  forever. This is why the fix recreates that function too, with source `user_deactivated`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**

- The three rotations stay independent; a change in one never alters the other two (3.1).
- Rotation eligibility keeps its five conditions — `is_active`, `role = 'agent'`,
  `availability = 'available'`, the rotation enable flag, a non-null rotation position — with
  `profiles.availability` remaining the authoritative queue-status field (3.2).
- A sole eligible agent keeps the rotation rather than nulling it (3.3), and `next_eligible_profile` keeps
  wrapping from the highest position to the lowest in `ORDER BY` (3.4).
- Null and ineligible pointers keep recovering through `ensure_rotation_valid` and `set_my_availability`
  (3.5); a held turn keeps handing off through `advance_rotation` with exactly one `turn_events` row per
  rotation changed (3.6).
- This fix adds **no new advancement path**: `advancementPathsIn(F') ⊆ advancementPathsIn(F)`. Every path
  the fix introduces advances through `set_my_availability`, never by editing a rotation directly. The
  three pre-existing direct editors — `ensure_daily_availability_reset`, `admin_deactivate_profile` and
  `take_quote_turn` — are an explicit allow-list preserved exactly as they are; the stronger claim that all
  advancement passes through `advance_rotation` is already false against live and is not the claim being
  made (3.7).
- Pass, Recover, timed-quote take, WhatsApp claim, RingCentral claim, CS intake claim, walk-in claim on
  turn and out of turn, and Workload claim behave exactly as documented today, including the walk-in
  out-of-turn exception that leaves `rotation_state.current_profile_id`, `rotation_state.version` and
  `turn_events` untouched (3.8).
- `ensure_daily_availability_reset()` keeps performing **all three** of its live effects exactly once per
  business date under `pg_advisory_xact_lock(707200072)` — marking every `is_active` agent Unavailable,
  nulling all three `rotation_state.current_profile_id` pointers with `version = version + 1` and
  `updated_by = null`, and marking every unread `turn` row in `user_notifications` read — and the
  daily-start behavior for the first eligible agent to become Available keeps applying (3.9). The
  observable end state is unchanged even though identifying the genuinely changed rows, in order to emit
  one `daily_reset` event per changed profile, changes the row count the statement touches.
- The **My status** control keeps changing queue availability immediately, keeps surfacing returned errors
  to the agent, and keeps refreshing live data from the database (3.10).
- Manager punch and break edits keep leaving current queue availability untouched in both modes, and keep
  writing to `attendance_audit_log` (3.11).
- Worked hours, `total_hours`, the paid short/personal versus unpaid lunch split, `break_minutes`, derived
  status and the alert list keep coming from the single authoritative attendance calculation, unchanged
  (3.12).
- `uniq_time_clock_open_entry` and `uniq_time_clock_open_break` keep protecting the second clock-in and the
  second break-start, and the losing request keeps receiving the open row it lost to (3.13).
- A failed clock action keeps the displayed figures unchanged and keeps refusing a second submission while
  one is in flight (3.14).
- `attendance_audit_log` stays append-only under `attendance_audit_immutable()`, `turn_events` keeps its
  existing `claim | pass | manual_change | auto_skip | daily_start` vocabulary, and no historical
  migration file is edited (3.15).
- Profile insert keeps setting `availability` to `unavailable` (3.16).
- `admin_deactivate_profile` keeps behaving byte-identically to the live body in every respect other than
  its three additions: the same eight refusals — including the **final active Manager** refusal — the same
  profile flag writes, the same three **direct** `rotation_state` handoffs through `next_eligible_profile`
  under their `if exists` guards, the same `work_desk_settings` overflow clearing, and the same single
  `audit_log` row with `action = 'user_deleted'`. It keeps its live posture as well: the same signature,
  `returns void`, `security definer`, `set search_path to 'public'`, and the three `EXECUTE` grants, which
  survive only because the recreation is a `create or replace` (3.17, 3.18). There is **no** function-level
  refusal to delete a `super_admin` **target** to preserve — the live body has none, and the earlier draft
  of this design was wrong to say otherwise. The fix adds that refusal deliberately (2.22), which is the one
  place the recreated function refuses **more** than live and never less, so widening the caller guard to
  admit `super_admin` narrows rather than widens the set of deletable accounts (2.21).

**Scope:**

All inputs that do NOT entangle an attendance action with a queue decision are completely unaffected. This
includes:

- Every quote-claiming, pass, timed-quote and walk-in path in the rotation system.
- Manager punch edits and the v1.9.4 correction, PTO and review functions.
- Every attendance calculation, export, payroll figure and schedule.
- The daily reset's rotation and notification behavior — all three live effects stay; the only addition is
  an audit row per profile it actually changed.
- The account-deletion path's eight refusals, its profile flags, its three direct rotation handoffs, its
  `work_desk_settings` clearing and its `audit_log` row — the only additions are one `user_deactivated`
  availability event, a caller guard that admits `super_admin`, and a new refusal when the **target** is a
  `super_admin`.

**Note:** the expected correct behavior for buggy inputs is defined in Correctness Properties, Property 1.
This section states only what must not change.

## Hypothesized Root Cause

1. **One field carrying two facts.** `profiles.availability` is simultaneously the sales-queue status and,
   by side effect, an attendance signal. There is no second field, so any writer of one fact necessarily
   overwrites the other. Everything below follows from this.

2. **Conditional coupling in clock-out.** `src/app/api/time-clock/route.ts` calls
   `set_my_availability('unavailable')` inside `if (onBreak)`. The condition is a leftover from treating
   `break` as the state that needs clearing, when the state that needs clearing is "in the rotation".
   Clock-out without a break — the common case — writes nothing.

3. **Unconditional coupling in break start and break end, with no memory.**
   `src/app/api/time-clock/breaks/route.ts` calls `set_my_availability('break')` on start and
   `set_my_availability('available')` on end, both unconditional, and stores nothing about the prior
   value. `available` on break end is an assumption, not a restore. There is nowhere to put the prior
   value: `time_clock_breaks` has no column for it.

4. **Discarded RPC results.** All three call sites are bare `await supabase.rpc(...)`. `supabase-js`
   returns `{ data, error }` and never throws, so `Agent permission required`, `Active profile not found`,
   a `rotation_state` lock timeout and every other failure are invisible. Combined with root cause 5, the
   HTTP layer reports success for a state it never verified. The `is_agent()` restriction makes this
   deterministic rather than occasional for every non-agent employee.

5. **Independent round trips instead of one transaction.** Each route performs three to five separate
   Supabase calls, each its own transaction. Nothing is atomic, so a failure after the attendance write
   leaves the clock entry or break row changed and the queue status stale, with no compensating action.

6. **No arbitration and no opt-in.** Six writers — **My status**, break start, break end, clock-out, the
   daily reset and account deletion — write the same field with no precedence rule. `profiles` has no
   queue-sync mode column, so attendance-driven writes apply to every employee unconditionally. Last
   writer wins.

7. **No audit table capable of carrying an availability transition.** `turn_events` models rotation
   pointers, `attendance_audit_log.entity_type` has no availability member and its writers are the v1.9.4
   correction functions, and `audit_log` has no availability writer. So no path can attribute a change even
   if it wanted to.

8. **Read-then-write with no re-check.** Both routes read the open entry or open break, then update by id
   without re-asserting that the row is still open. Two concurrent requests both pass and both act. The
   partial unique indexes protect opening a second entry or break; nothing protects closing one twice.

9. **UI vocabulary conflates the two facts.** The **My status** control is labelled `Available`,
   `Break / Lunch`, `Unavailable` with no mention of sales queues; Time & Attendance shows attendance
   status; the two never appear together. `Available` is ambiguous, and a clocked-in employee has no
   visible or actionable queue status.

## Correctness Properties

Property 1: Bug Condition - Attendance never silently decides queue participation

_For any_ status-transition request where the bug condition holds (`isBugCondition` returns true), the
fixed system SHALL report both the attendance status and the sales-queue status as read back from the
database; SHALL leave queue status unchanged when the mode is `manual` and the action is not an explicit
status action; SHALL, when the mode is `attendance_assisted`, leave clock-in's queue status unchanged while
offering `Join Sales Queues`, set clock-out to Unavailable and release every rotation the agent holds,
record the pre-break queue status on break start and move to Break only from Available, and restore
exactly the stored pre-break status on break end or fall back to Unavailable when none was stored; SHALL
roll the whole operation back and name the failed portion rather than report unqualified success when any
required database change fails; SHALL write exactly one availability event carrying the previous status,
the new status, a supported source, a non-null actor and the related attendance record for every change it
makes; and SHALL apply at most one transition, one event and one rotation handoff for a duplicate or
concurrent request. _For any_ account deletion, the fixed system SHALL additionally write exactly one
availability event with source `user_deactivated`, `unavailable` as the new status, the previous status as
read before the write and the acting manager as the actor; SHALL admit a `super_admin` caller as well as a
`manager`; and SHALL refuse the deletion outright when the **target's** role is `super_admin`, whatever the
caller's role, closing the direct-RPC bypass around the route's 403.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.12, 2.20, 2.21, 2.22**

Property 2: Preservation - Behavior outside the bug condition is untouched

_For any_ status-transition request where the bug condition does NOT hold (`isBugCondition` returns
false), the fixed system SHALL produce the same attendance figures, the same resulting queue availability,
the same rotation pointers and the same `turn_events` rows as the original system, preserving the
attendance calculation, the authoritative queue-status field, rotation independence, sole-eligible-agent
retention, wraparound and whichever handoff path that input uses today — `advance_rotation` for the
`set_my_availability` family, the direct edit for the daily reset and for account deletion. The new
availability event is an additive record and is excluded from the comparison.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 3.12, 3.15, 3.17, 3.18**

Property 3: Preservation - Rotation invariants hold for every input, buggy or not

_For any_ status-transition request, buggy or not, the rotation state after the fixed system has run SHALL
satisfy every standing rotation invariant: each of the three rotations is either unchanged or is one the
request legitimately affects; a non-null current agent is rotation-eligible; no rotation is null while an
eligible agent exists for it, **except for the daily reset, which is explicitly exempt from that clause**;
and the set of advancement paths in the fixed system SHALL be a subset of the set in the original —
`advancementPathsIn(F') ⊆ advancementPathsIn(F)` — every member of which is either `advance_rotation` or
one of the three pre-existing direct editors `ensure_daily_availability_reset`, `admin_deactivate_profile`
and `take_quote_turn`.

**Validates: Requirements 3.1, 3.2, 3.5, 3.7, 3.9**

#### Why the fourth clause is stated as a subset, not as `advance_rotation`

The earlier wording — "every advancement went through `advance_rotation` rather than a direct rotation
edit" — is **already false against live**. `ensure_daily_availability_reset` nulls all three pointers
directly, `admin_deactivate_profile` updates each held rotation directly through `next_eligible_profile`,
and `take_quote_turn` updates `rotation_state` directly. A test of the original clause fails on unfixed
**and** fixed code, so it proves nothing about the fix. The subset form is the claim the fix can actually
honor and the one worth testing: whatever direct editing exists, this change does not add to it.

#### Resolving the daily-reset tension with clause three

Requirement 3.9 requires the daily reset to null all three rotation pointers. Clause three asserts
`NOT (state[k].current IS NULL AND existsEligibleAgent(k))` for every input. Those two conflict if the
daily reset is ever in the `X` domain, so a decision is needed rather than an accident.

**Decision: exempt the daily reset explicitly, and assert a replacement post-condition for it.** For
`X = daily reset`, clause three is not evaluated; instead the reset must satisfy: all three pointers are
null **and** no eligible agent exists for any rotation, since the same transaction has just marked every
`is_active` agent Unavailable. Clause three then applies unchanged to every other input.

Two reasons for the exemption over the alternative of scoping the invariant to "post-reset steady state".
First, the alternative is not evaluable: nothing marks the end of a reset window except the first
subsequent `available` write, so a test harness cannot tell whether the state it is looking at is inside
the window or outside it. The exemption names a specific input and is decidable. Second, the exemption is
narrower than it looks — the reset's two effects are in one transaction, and once it commits there are zero
eligible agents, so the invariant is not actually violated at the commit boundary. The exemption exists to
keep the spec internally consistent and to stop a harness that reads `rotation_state` between the reset's
two statements, or a future extension of the reset, from reporting a false violation. Recovery is
unchanged: the first agent to go Available repairs the pointers through `set_my_availability`'s
daily-start path (3.5).

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct, the fix is one forward-only migration — which also recreates
the two pre-existing availability writers from their **live** bodies — four rewritten route bodies, one
changed frontend RPC call, and two UI panels. No historical migration file is edited (2.13, 3.15).

#### 1. Schema — `supabase/migrations/v1.12.13-attendance-queue-status-separation.sql`

New forward-only migration; latest existing is `v1.12.12-reporting-filter-performance.sql`.

1. **`public.queue_status_mode` enum** — `manual`, `attendance_assisted`.

2. **`profiles.queue_status_mode`** — `not null default 'manual'`. Additive and defaulted, so every
   existing profile lands on `manual` and no existing user gets attendance synchronization (2.11).

3. **`time_clock_breaks.pre_break_queue_status public.availability_status null`** — the pre-break queue
   status, scoped to the break row so it cannot leak across days or across breaks. Null means "not
   recorded", which is what every historical row and every `manual`-mode break will carry, and is the
   input to the 2.6 fallback.

4. **`public.availability_events`** — the audit table 2.12 and 2.13 require, because no existing table can
   carry the fields:

   | Column | Type | Notes |
   |---|---|---|
   | `id` | uuid pk | `gen_random_uuid()` |
   | `profile_id` | uuid not null → `profiles(id)` | the affected employee |
   | `previous_status` | `availability_status` | null only for a synthetic backfill row |
   | `new_status` | `availability_status` not null | |
   | `source` | text not null | check in the **eight** sources of 2.12: `manual_agent`, `manual_manager`, `attendance_clock_out`, `attendance_break_start`, `attendance_break_end`, `daily_reset`, `system_repair`, `user_deactivated` |
   | `actor_profile_id` | uuid not null → `profiles(id)` | who caused it; the employee themselves for self-service and for the daily reset, the acting manager for `user_deactivated` |
   | `clock_entry_id` | uuid → `time_clock_entries(id)` | when the cause was a clock action |
   | `break_id` | uuid → `time_clock_breaks(id)` | when the cause was a break action |
   | `reason` | text | free text |
   | `metadata` | jsonb not null default `'{}'` | mode, held rotations, `already_applied`, and similar |
   | `created_at` | timestamptz not null default `now()` | |

   Indexes on `(profile_id, created_at desc)`, `(created_at desc)` and `(source, created_at desc)`.
   Append-only the same way `attendance_audit_log` is: a `before update or delete` trigger that raises,
   plus RLS with select and insert policies only and no update or delete policy. Select is granted to the
   employee for their own rows and to manager and super_admin for all rows.

5. **`public.record_availability_event(...)`** — the single insert point, `security definer`. Every writer
   below goes through it so the eight-source vocabulary and the "exactly one row per change" rule live in
   one place.

6. **`public.apply_queue_status(p_profile_id, p_new_status, p_source, p_actor, p_clock_entry_id, p_break_id, p_reason, p_metadata)`**
   → `availability_status`. The shared queue-status transition, `security definer`:

   - `select availability into v_prev from profiles where id = p_profile_id for update`.
   - If `v_prev = p_new_status`, return `v_prev` with no write, no event and no handoff. This is the
     idempotency point for 2.10: a duplicate request that reaches here finds the value already applied.
   - Otherwise `perform public.set_my_availability(p_new_status)` — the existing authoritative transition,
     which owns the profile write, the deterministic `rotation_state` lock order, the `ensure_rotation_valid`
     recovery, the `advance_rotation` handoff and the `turn_events` rows. No rotation is ever edited
     directly (3.7).
   - Re-read `availability`, call `record_availability_event`, return the value.

   `set_my_availability` derives its subject from `auth.uid()`, so `apply_queue_status` is usable only for
   the calling employee's own profile. The manager path (item 9) therefore does its own profile write and
   its own repair call rather than reusing this helper; that is stated there.

7. **Four attendance transition functions**, `security definer`, `set search_path = public`, each returning
   `jsonb` shaped `{ attendance_status, queue_status, queue_status_mode, entry, break, already_applied, changed_queue }`:

   - `public.attendance_clock_in(p_status text default 'available')`
   - `public.attendance_clock_out()`
   - `public.attendance_break_start(p_break_type text default 'lunch')`
   - `public.attendance_break_end()`

   Every one of them, in this fixed lock order — `time_clock_entries` → `time_clock_breaks` → `profiles` →
   `rotation_state` — so no pair can deadlock:

   1. Resolve `auth.uid()` to an active profile; raise if absent.
   2. Read `queue_status_mode` and `role`.
   3. Lock the relevant attendance row `for update` and **re-assert its state after the lock**: clock-out
      and break-end require the row to still be open. If it is not, the request lost a race or is a retry:
      return the committed state with `already_applied: true` rather than the current HTTP 400 (2.10, 1.11).
      Clock-in and break-start keep relying on `uniq_time_clock_open_entry` and `uniq_time_clock_open_break`
      and keep answering the loser with the open row (3.13).
   4. Apply the attendance change with the arithmetic exactly as the routes compute it today —
      `total_hours` from clock-out minus clock-in minus `break_minutes`, `break_minutes` incremented for
      `lunch` only, `clock_status` transitions unchanged (3.12).
   5. Decide the queue portion:
      - `role <> 'agent'::public.app_role` → no queue portion at all. Queue status is meaningless for a
        non-agent, and
        `set_my_availability` would refuse. This is the deterministic C6 case, fixed by not making the call.
      - `queue_status_mode = 'manual'` → no queue portion (2.9).
      - `attendance_assisted` → the per-action rule:
        - `clock_in`: no queue change. Set `offers_join_sales_queues` when queue status is not `available` (2.1).
        - `clock_out`: `apply_queue_status(..., 'unavailable', 'attendance_clock_out', ...)` whether or not a
          break was open — the `if (onBreak)` condition is gone (2.2).
        - `break_start`: write `pre_break_queue_status := v_queue` on the break row, then
          `apply_queue_status(..., 'break', 'attendance_break_start', ...)` **only when** `v_queue = 'available'`.
          Any other value is left alone, so an agent who is not queue-eligible never becomes eligible
          through a break (2.3, 2.4).
        - `break_end`: read `pre_break_queue_status` from the break row being closed.
          Non-null → `apply_queue_status(..., that value, 'attendance_break_end', ...)`, so Available
          restores Available and Unavailable restores Unavailable (2.5). Null → `unavailable`, and the
          response offers `Join Sales Queues` (2.6).
   6. Re-read both statuses from the database and return them. Nothing in the payload is assumed (2.18).

   Because each function is one transaction, a failure in any required step rolls back the attendance
   change too. There is no half-applied outcome to warn about, which is how 2.7 and 2.8 are satisfied
   together (1.6 disappears).

8. **`public.set_my_queue_status(p_status public.availability_status, p_reason text default null)`** — the
   explicit agent action. `perform apply_queue_status(auth.uid(), p_status, 'manual_agent', auth.uid(), null, null, p_reason, ...)`
   and return the resulting status. This is what closes the `manual_agent` half of C8 and it keeps the
   **My status** control's immediate change, surfaced errors and live refresh (3.10).

9. **`public.manager_set_queue_status(p_profile_id uuid, p_status public.availability_status, p_reason text)`** —
   the explicit manager action 2.9 and 2.17 refer to and which does not exist today. Guarded by
   `public.can_manage_sales()` — `manager`, `sales_supervisor`, `super_admin` — the same predicate
   `manager_set_rotation_eligibility` uses, so the two manager queue controls agree on who may use them. A
   reason is required, also matching that function. Because `set_my_availability` acts on `auth.uid()`, this function
   writes the target's `availability` itself and then calls `ensure_rotation_valid(kind, actor)` for each of
   the three rotations under the same `order by kind for update` lock order, plus `advance_rotation` when the
   target holds a rotation and is no longer eligible — the same two primitives `set_my_availability` uses,
   not a new advancement path (3.7). One `manual_manager` event.

10. **`public.manager_set_queue_status_mode(p_profile_id uuid, p_mode public.queue_status_mode, p_reason text)`** —
    guarded by `public.is_manager()`, which is `manager` and `super_admin` exactly, because 2.11 restricts
    the mode change to those two roles and `can_manage_sales()` would additionally admit
    `sales_supervisor`. Reason required, recorded in `audit_log` with the old and new mode. It changes no
    availability and writes no `availability_events` row (2.11).

11. **`ensure_daily_availability_reset()` gains one insert — recreated from the LIVE body.** An earlier
    draft of this item said to recreate it from `supabase/schema.sql` (~1710). That is wrong and would
    introduce a queue-integrity regression. The live body is the
    `v0.9.8-stabilize-integrations.sql:1048` lineage with `search_path = public, pg_temp`, and it does three
    things the schema.sql body does not:

    | | live (`v0.9.8` lineage) | `supabase/schema.sql:1712` |
    |---|---|---|
    | profile predicate | `where role::text = 'agent' and is_active` | `... and availability <> 'unavailable'` |
    | rotation pointers | **nulls all three** — `current_profile_id = null, version = version + 1, updated_at = now(), updated_by = null` for `whatsapp`, `ringcentral`, `workload` | absent |
    | turn notifications | **marks read** — `user_notifications set read_at = now() where notification_type = 'turn' and read_at is null` | absent |
    | `search_path` | `public, pg_temp` | `public` |

    Recreating from schema.sql would silently drop the rotation nulling and the notification clearing, so
    the fix itself would break queue integrity. The migration therefore carries the **live** body verbatim —
    `returns boolean`, `pg_advisory_xact_lock(707200072)`, the `availability_day_state` singleton
    insert-then-`for update` read, the business-date advance, the `true` / `false` return, all three
    effects, and `search_path = public, pg_temp` — plus one addition: a
    `record_availability_event(..., 'daily_reset', ...)` row for each profile whose `availability` actually
    changed. Actor is the profile itself, because the reset has no human actor. This is the `daily_reset`
    half of C8.

    **Emitting one event per genuinely-changed profile.** The live statement has no
    `availability <> 'unavailable'` predicate, so it rewrites every active agent including those already
    Unavailable, and its row count cannot be used to identify what changed. Use an explicit
    `update ... where role::text = 'agent' and is_active and availability <> 'unavailable' returning id,
    availability` — or an equivalent CTE that captures the pre-state and then performs the unpredicated
    update — and emit one event per returned row. Either shape leaves the observable end state identical:
    the rows excluded are exactly those already holding the value being written. The migration comment MUST
    state that this changes the number of rows the statement touches while leaving the end state unchanged,
    so a future reader does not mistake it for a behavior change (3.9).

12. **`admin_deactivate_profile(uuid, uuid, text)` recreated from the LIVE body, with two additions.** This
    is the third writer of `profiles.availability` and the reason 2.20 and 2.21 exist. There is no
    `create function` for it anywhere in `supabase/`, so the migration is the first repo definition of it
    and must be transcribed from the live dump — including its `security definer` posture, `search_path`,
    volatility and `grant` list, which are reproduced from `evidence/live-functions/`. (The task-1 dumper
    captured its signature, `security definer` flag and availability lines in
    `evidence/live-availability-scan.json`; extend `scripts/dump-live-functions.mjs` to write its full body
    to `evidence/live-functions/admin_deactivate_profile.sql` before transcribing.)

    Byte-identical to live except for exactly two additions:

    - **One `record_availability_event(..., 'user_deactivated', ...)` call.** The previous status is read
      **before** the profile write — `select availability into v_prev ...`, or taken from the `v_target`
      row the function already loads — the new status is `unavailable`, the source is `user_deactivated`,
      and the actor is `p_manager_id`, the acting manager. Exactly one event, whether or not the target held
      a rotation (2.20, 2.12).
    - **A widened caller guard.** The live guard is `role = 'manager' and is_active`. It becomes
      `role in ('manager', 'super_admin') and is_active`, per the workspace super-admin parity rule (2.21).
      The role type is `public.app_role`; there is no type named `role`. The function's existing refusal to
      delete a `super_admin` **target** is preserved unchanged, as is the same refusal in the `DELETE`
      handler at `src/app/api/admin/users/route.ts`, so the caller guard widens without widening the set of
      deletable accounts.

    Everything else is reproduced exactly: the profile update setting `is_active = false`,
    `availability = 'unavailable'`, `whatsapp_active`, `ringcentral_active` and `workload_active` false and
    `updated_at = now()`; the per-rotation handoff
    `update rotation_state set current_profile_id = next_eligible_profile(<kind>, v_target.<kind>_position),
    version = version + 1, updated_at = now(), updated_by = p_manager_id` for each of `whatsapp`,
    `ringcentral` and `workload` the target holds; the `work_desk_settings` CS overflow clearing; and the one
    `audit_log` row with `action = 'user_deleted'`, `entity_type = 'profile'`,
    `old_value = to_jsonb(v_target)` and
    `new_value = jsonb_build_object('is_active', false, 'availability', 'unavailable')`.

    **Its direct `rotation_state` handoff stays exactly as-is.** Do NOT reroute it through
    `advance_rotation` and do NOT route it through `apply_queue_status`: `set_my_availability` acts on
    `auth.uid()` and would refuse for a non-agent caller and act on the wrong profile for an agent one.
    Rerouting would also be a new advancement path and would write `turn_events` rows this path does not
    write today, breaking Property 3 and 3.17. This is a deliberate exception, matching the allow-list in
    Property 3 (3.7, 3.17).

13. **`system_repair` has a writer only where a repair happens.** The source is in the check constraint and
    is used by the one-off reconciliation statement in this migration, if the 2.19 diagnostic finds rows to
    repair. No new repair function is invented here.

14. **Grants.** `authenticated, service_role` on the four attendance functions and `set_my_queue_status`;
    `authenticated, service_role` on the two manager functions, which enforce their own role check;
    `service_role` only on `record_availability_event` and `apply_queue_status`, which are internal. The two
    recreated functions keep the grants they have live — reproduce them from the live dump rather than
    guessing, because `create or replace function` preserves existing grants but a `drop`/`create` would
    silently drop them.

#### 2. HTTP routes

**`src/app/api/time-clock/route.ts`**

- `POST` becomes one `rpc('attendance_clock_in', { p_status })` call. The unique-violation branch moves into
  SQL; the route keeps returning `already_open` from the payload so the client contract holds.
- `PATCH` with `action: 'clock_out'` becomes one `rpc('attendance_clock_out')`. The manual break-closing
  update, the `total_hours` arithmetic and the `if (onBreak)` availability call all move into SQL and the
  condition is dropped.
- `PATCH` with `action: 'edit'` is untouched. It does not write availability today and must not start
  (3.11).
- Every `rpc` result's `error` is inspected. On error: re-read both statuses via the same read
  `/api/time-clock/active` uses, and answer with `{ error, failed_portion, attendance_status, queue_status }`
  where `failed_portion` is `'attendance'` or `'queue_status'`, resolved from the SQLSTATE and message the
  function raised (2.7).

**`src/app/api/time-clock/breaks/route.ts`**

- `POST` becomes one `rpc('attendance_break_start', { p_break_type })`; `PATCH` becomes one
  `rpc('attendance_break_end')`. The `clock_status` updates, the `break_minutes` arithmetic and both
  `set_my_availability` calls move into SQL. Same error handling as above.

**`src/app/api/time-clock/active/route.ts`**

- Additionally returns `queue_status`, `queue_status_mode` and `is_agent`, so every panel can render the
  two labelled values from a database read rather than an assumption (2.14, 2.18).

**`src/app/api/admin/users/route.ts`**

- `PATCH` accepts `queue_status_mode` and forwards it to `manager_set_queue_status_mode`. The route is
  already guarded by `canAdministerUsers`, which admits manager and super_admin (2.11).
- `DELETE` is untouched. It keeps its own-account refusal, its 403 on a `super_admin` target, its auth ban,
  its `admin_deactivate_profile` call at line 419 and its ban-rollback on RPC failure. The availability
  event is added inside the function, not in the route, so the deletion stays one transaction (2.20, 3.17).

#### 3. Client

**`src/features/time-attendance/shared/useClockAction.ts`**

- `onRecorded` receives the response payload so callers render the returned statuses instead of refetching
  blind. The `inFlightRef` guard, the mounted guard and the failure handling stay exactly as they are
  (3.14).

**`src/features/time-attendance/today/MyDayPanel.tsx` and `TodayScreen.tsx`**

- Two separately labelled values: `Attendance: Clocked Out | Working | On Break` and, for agents only,
  `Sales Queues: Available | Break | Unavailable`. The bare word `Available` never stands alone (2.14).
- Clocked in and queue status not `available` → `You are clocked in, but you are not currently receiving
  sales work.` with `Join Sales Queues` as the primary action, calling `set_my_queue_status('available')`
  (2.15).
- Clock-out in `attendance_assisted` → `You have been clocked out and removed from the sales queues.` (2.16).
- Clock-out in `manual` with queue status still `available` → `You are clocked out but still marked
  Available in Sales Queues.` with a `Set Unavailable` action (2.17).
- Every rendered value comes from the response or the next `/api/time-clock/active` read (2.18).

**`src/components/work-desk-app.tsx`**

- `handleAvailability` calls `set_my_queue_status` instead of `set_my_availability`, so the agent's own
  changes are audited. Behavior, toast and refresh are otherwise unchanged (3.10).
- The control and its toast are relabelled to name sales queues — `Sales Queues: Available`,
  `Sales Queues: Break / Lunch`, `Sales Queues: Unavailable` (2.14).

#### 4. Diagnostic

`.kiro/specs/attendance-queue-status-separation/diagnostics/attendance-queue-diagnostic.sql`, read-only,
following the shape of `.kiro/specs/queue-rotation-integrity/diagnostics/production-queue-diagnostic.sql`.
One row per active agent with attendance state, open clock entry, active break, queue availability, queue
sync mode, the current WhatsApp / RingCentral / Workload holder, the latest `availability_events` row, the
latest `attendance_audit_log` row, and a `mismatches` array flagging: clocked out but queue Available;
clocked in but queue Unavailable; active break but queue Available; no active break but queue status Break;
a queue status with no `availability_events` row; and a current queue holder who is not
`is_rotation_eligible` (2.19).

### Deliberately not changed

- `advance_rotation`, `ensure_rotation_valid`, `next_eligible_profile`, `is_rotation_eligible`,
  `rotation_position_of`, `pass_my_turn`, `take_quote_turn` and every claim function. `take_quote_turn`
  edits `rotation_state` directly and stays that way; it is on the Property 3 allow-list.
- The attendance calculation in `src/features/time-attendance/domain/attendance.ts` and everything reading
  it.
- The v1.9.4 correction, PTO and review functions, and `attendance_audit_log`.
- Payroll, schedules, thresholds and coverage.
- The behavior of the two recreated functions. `ensure_daily_availability_reset` and
  `admin_deactivate_profile` are recreated only because a `create or replace` is the only way to add their
  availability event; their live logic, including both direct `rotation_state` edits, is reproduced rather
  than revised. The one substantive change beyond the events is the widened caller guard on
  `admin_deactivate_profile` (2.21).

## Testing Strategy

### Validation Approach

Two phases. First surface counterexamples on the unfixed code, to confirm or refute each root cause. Then
verify the fix produces the expected behavior for buggy inputs and leaves everything else byte-for-byte
identical.

Available tooling: `vitest` (`npm test`, single run) with `fast-check` for property-based tests, and
`npm run test:integration` for the `*.integration.test.ts` files that run against a real Supabase using
`.env.local`. The existing `src/features/time-attendance/domain/__tests__/arbitraries.ts` supplies
attendance arbitraries to build on, and
`src/features/time-attendance/server/__tests__/audit-immutability.integration.test.ts` is the pattern for
proving an audit table append-only.

Queue behavior cannot be validated by a passing build or by unit tests over route handlers alone. The
rotation assertions in Property 3 need the integration harness against real `rotation_state`,
`turn_events` and `profiles` rows.

### Exploratory Bug Condition Checking

**Goal**: surface counterexamples that demonstrate the bug BEFORE implementing the fix, and confirm or
refute the nine hypothesized root causes. A refuted hypothesis sends us back to re-hypothesize.

**Test Plan**: drive the four unfixed routes against seeded attendance and rotation state, then read
`profiles.availability`, `rotation_state` and `turn_events` directly and assert what should have happened.
Run before any code changes.

**Test Cases**:

1. **Clock-out with no break leaves the agent in the queue** — seed an available agent holding the WhatsApp
   turn, clock out with no break, assert `availability = 'unavailable'` and the WhatsApp turn moved (will
   fail on unfixed code; confirms root cause 2).
2. **Break end launders a deliberate Unavailable** — set `unavailable`, start a break, end it, assert still
   `unavailable` (will fail on unfixed code; confirms root causes 3 and 1).
3. **Break start overwrites Unavailable and loses it** — set `unavailable`, start a break, assert the
   pre-break value is recoverable from somewhere (will fail on unfixed code; confirms root cause 3).
4. **Non-agent break start reports success while nothing happened** — a `customer_service` employee starts a
   break, assert the response is not an unqualified success given that `set_my_availability` raised
   `Agent permission required` (will fail on unfixed code; confirms root causes 4 and 5, and that C6 needs
   no race).
5. **Two concurrent clock-outs produce two transitions** — fire two clock-outs at one open entry with a
   break open, count availability transitions and `turn_events` rows, assert one of each (will fail on
   unfixed code; confirms root cause 8).
6. **No audit row exists for any change** — perform a **My status** change, a break start, a break end, a
   clock-out, a daily reset and a user deletion, then assert each availability transition is attributable in
   some table with a previous status, a new status, a source and an actor. The deletion writes `audit_log`
   as `user_deleted` with the new availability buried in `new_value` and no previous status, which does not
   satisfy 2.12 (will fail on unfixed code; confirms root cause 7 and the third-writer finding).
7. **Clock-in says nothing about queue status** — clock in while `unavailable`, assert the response carries a
   queue status (will fail on unfixed code; confirms root cause 9).
8. **Edge case — retry semantics differ per action** — repeat clock-in, clock-out and break-end after each
   has committed, assert all three answer with the committed state; today clock-in answers 200
   `already_open: true` while the other two answer HTTP 400 (may fail on unfixed code; confirms 1.11).

**Expected Counterexamples**:

- `availability` still `available` after a break-less clock-out, WhatsApp turn still held.
- `availability = 'available'` after a break that started from `unavailable`, and possibly a fresh
  `turn_events` row handing that agent a turn they never asked for.
- HTTP 201 from `POST /api/time-clock/breaks` for a non-agent while Postgres raised `Agent permission
  required`.
- Two availability transitions and up to two `turn_events` rows for one logical clock-out.
- Zero rows in `turn_events`, `attendance_audit_log` and `audit_log` naming any availability transition.
- Possible causes: the single-field design, the `if (onBreak)` condition, the unconditional `'available'`
  on break end, discarded `{ error }` results, per-call transactions, no opt-in gate, no capable audit
  table, and read-then-write with no re-check.

### Fix Checking

**Goal**: verify that for all inputs where the bug condition holds, the fixed system produces the expected
behavior.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  result := F'(X)

  ASSERT result.attendanceStatus IN {clocked_out, working, on_break}
  ASSERT result.queueStatus      IN {available, break, unavailable}
  ASSERT result.attendanceStatus = readAttendanceFromDatabase(X.employee)
  ASSERT result.queueStatus      = readAvailabilityFromDatabase(X.employee)

  IF X.mode = manual AND X.action <> my_status THEN
    ASSERT result.queueStatus = X.queue                                    -- 2.9
  END IF

  IF X.mode = attendance_assisted THEN
    CASE X.action OF
      clock_in:    ASSERT result.queueStatus = X.queue
                   AND result.offersJoinSalesQueues                        -- 2.1
      clock_out:   ASSERT result.queueStatus = unavailable
                   AND NOT holdsAnyTurn(X.employee)                        -- 2.2
      break_start: ASSERT result.savedPreBreak = X.queue
                   AND result.queueStatus =
                       (IF X.queue = available THEN break ELSE X.queue)     -- 2.3, 2.4
      break_end:   ASSERT result.queueStatus =
                       (IF X.preBreak = none THEN unavailable ELSE X.preBreak) -- 2.5, 2.6
    END CASE
  END IF

  IF anyRequiredDatabaseChangeFailed(X) THEN
    ASSERT rolledBack(result) OR (result.warning NAMES failedPortion(X))
    ASSERT NOT reportsUnqualifiedSuccess(result)                           -- 2.7, 2.8
  END IF

  IF changesQueueAvailability(F', X) THEN
    ASSERT countAvailabilityEvents(X) = 1
    ASSERT event.previousStatus = X.queue
    ASSERT event.newStatus      = result.queueStatus
    ASSERT event.source IN {manual_agent, manual_manager, attendance_clock_out,
                            attendance_break_start, attendance_break_end,
                            daily_reset, system_repair, user_deactivated}
    IF X.action = user_deleted THEN
      ASSERT event.source    = user_deactivated                            -- 2.20
      ASSERT event.newStatus = unavailable
      ASSERT event.actor     = actingManagerOf(X)                          -- 2.20
    END IF
    ASSERT event.actor IS NOT NULL
    ASSERT relatedAttendanceEntryRecorded(event, X)                        -- 2.12
  END IF

  IF X.concurrent THEN
    ASSERT countAvailabilityTransitions(X) = 1
    ASSERT countAvailabilityEvents(X)      = 1
    ASSERT countTurnHandoffs(X)            <= 1                            -- 2.10
  END IF
END FOR
```

### Preservation Checking

**Goal**: verify that for all inputs where the bug condition does NOT hold, the fixed system produces the
same result as the original.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT attendanceFigures(F'(X)) = attendanceFigures(F(X))   -- 3.12
  ASSERT queueAvailability(F'(X)) = queueAvailability(F(X))   -- 3.2
  ASSERT rotationPointers(F'(X))  = rotationPointers(F(X))    -- 3.1, 3.3, 3.4, 3.6
  ASSERT turnEventsWritten(F'(X)) = turnEventsWritten(F(X))   -- 3.15
END FOR

FOR ALL X DO
  state := rotationStateAfter(F'(X))

  FOR EACH k IN {whatsapp, ringcentral, workload} DO
    ASSERT state[k] = rotationStateBefore(X)[k]
        OR k IN rotationsLegitimatelyAffectedBy(X)             -- 3.1
    ASSERT state[k].current IS NULL
        OR isRotationEligible(state[k].current, k)             -- 3.2

    -- Daily reset is explicitly exempt from the null-with-eligible-agent clause,
    -- because 3.9 requires it to null all three pointers. Its replacement
    -- post-condition is asserted instead. See Correctness Properties, Property 3.
    IF X.action <> daily_reset THEN
      ASSERT NOT (state[k].current IS NULL
                  AND existsEligibleAgent(k))                  -- 3.5
    ELSE
      ASSERT state[k].current IS NULL
         AND NOT existsEligibleAgent(k)                        -- 3.9
    END IF

    -- 3.7 — "this fix adds no new advancement path", NOT "all advancement goes
    --        through advance_rotation". The stronger form is ALREADY FALSE against
    --        live and would fail on unfixed and fixed code alike, because three
    --        pre-existing functions edit rotation_state directly today:
    --          ensure_daily_availability_reset  — nulls all three pointers
    --          admin_deactivate_profile         — per-rotation next_eligible_profile update
    --          take_quote_turn                  — direct rotation_state update
    --        Those three are an explicit allow-list, unchanged by this fix.
    ASSERT advancementPathsIn(F') ⊆ advancementPathsIn(F)
    ASSERT EVERY p IN advancementPathsIn(F') SATISFIES
             p = advance_rotation
             OR p IN {ensure_daily_availability_reset,
                      admin_deactivate_profile,
                      take_quote_turn}                         -- 3.7
  END FOR
END FOR
```

**Testing Approach**: property-based testing is right for preservation checking here because the input
space is a product of six independent dimensions — action, mode, queue status, pre-break status, whether a
break is open, and whether the request is concurrent — which is far too large to enumerate by hand, and
because the assertions are equalities between two versions of the same system rather than fixed expected
values. `fast-check` is already a dev dependency and the attendance arbitraries already exist.

**Test Plan**: capture the unfixed behavior for non-bug-condition inputs first — the attendance figures, the
resulting availability, the rotation pointers and the `turn_events` rows — then write property-based tests
that assert the fixed system reproduces exactly those. The captured baseline is the oracle, so the tests
cannot drift into asserting what the fix happens to do.

**Test Cases**:

1. **Attendance arithmetic** — observe `total_hours`, `break_minutes` and the paid/unpaid split on unfixed
   code across generated shift shapes, then assert the fixed functions produce identical figures. This is
   the highest-risk part of the change, because the arithmetic moves from TypeScript into SQL.
2. **Manager punch edit** — observe that `PATCH /api/time-clock` with `action: 'edit'` leaves current
   availability untouched and writes `attendance_audit_log`, then assert it still does, in both modes (3.11).
3. **My status control** — observe the immediate change, the surfaced error and the refresh on unfixed code,
   then assert `set_my_queue_status` matches, with the audit row as the only addition (3.10).
4. **Second clock-in and second break start** — observe the unique-index rejection and the open row returned
   to the loser, then assert unchanged (3.13).
5. **Daily reset preserves all three of its live effects** — observe, on unfixed code, all three: every
   `is_active` agent marked Unavailable once under `pg_advisory_xact_lock(707200072)`; all three
   `rotation_state.current_profile_id` pointers nulled with `version` incremented and `updated_by` nulled;
   and every unread `user_notifications` row of `notification_type = 'turn'` marked read. Then assert all
   three are identical after the fix, with only the `daily_reset` events added. Seed the run with at least
   one agent already Unavailable, to prove that narrowing the changed-row identification does not change the
   end state and that no `daily_reset` event is emitted for a profile whose value did not move. Also assert
   the daily-start behavior for the first agent to become Available afterwards (3.9).
6. **Claim, pass, timed quote, recover, walk-in on turn and out of turn** — observe rotation pointers,
   versions and `turn_events` on unfixed code, then assert identical. The walk-in out-of-turn case must
   still leave `current_profile_id`, `version` and `turn_events` untouched (3.8).
7. **Failed clock action on the client** — observe that displayed figures do not move and a second
   submission is refused while one is in flight, then assert unchanged (3.14).
8. **`admin_deactivate_profile` deletion path** — on unfixed code, delete an agent who is `available` and
   holds at least one rotation, and capture the whole observable outcome: `is_active`, `availability`, the
   three rotation enable flags and `updated_at` on the profile; `current_profile_id`, `version`,
   `updated_at` and `updated_by` for all three `rotation_state` rows, including the two the target did not
   hold, which must not move; the `work_desk_settings` CS overflow columns; the single `audit_log` row with
   its `action`, `entity_type`, `old_value` and `new_value`; and the absence of `turn_events` rows for this
   path. Then assert every one of those is identical after the fix, with the single `user_deactivated`
   availability event as the **only** addition. Run it once with the target holding all three rotations and
   once holding none (3.17, 2.20).
9. **Widened caller guard, unchanged deletable set** — assert a `super_admin` caller can now invoke
   `admin_deactivate_profile` successfully where it previously raised, that a `manager` caller still can,
   that a caller with any other role still cannot, and that a `super_admin` **target** is still refused —
   both by the function and by the 403 in the `DELETE` handler — for a `manager` and a `super_admin`
   caller alike. Widening the caller guard must not widen the set of deletable accounts (2.21).

### Unit Tests

- The per-action queue decision as a pure decision table: action × mode × queue status × pre-break status →
  expected new queue status and expected source. Every cell of 2.1 through 2.6 and 2.9, including
  `role <> 'agent'`.
- The `failed_portion` mapping from a raised SQLSTATE and message to `'attendance'` or `'queue_status'`,
  including the unmapped fallback (2.7).
- The message selection of 2.15, 2.16 and 2.17 from attendance status, queue status and mode.
- The two-label rendering of 2.14, including the assertion that no rendered string is the bare word
  `Available`, and that the queue line is absent for non-agents.
- `already_applied` handling: a retried clock-out and a retried break-end answer with committed state
  rather than an error (2.10, 1.11).

### Property-Based Tests

- **Property 1** over generated `StatusTransitionRequest` values restricted to `isBugCondition`, asserting
  the full Fix Checking block above.
- **Property 2** over generated requests restricted to `NOT isBugCondition`, comparing against the captured
  unfixed baseline.
- **Property 3** over all generated requests, asserting the four rotation invariants after every
  transition — including that a rotation the request does not legitimately affect is bit-identical, which is
  the standing three-independent-rotations rule (3.1). The generator must include `daily_reset` and
  `user_deleted` as actions, so the daily-reset exemption and its replacement post-condition are both
  exercised and the deletion path's two untouched rotations are checked. The fourth clause is asserted as
  the subset relation over advancement paths, never as "every advancement used `advance_rotation`", which is
  false against live and fails on unfixed and fixed code alike.
- Idempotency: for any request, applying it twice produces the same final state, one availability event and
  at most one turn handoff (2.10).
- Mode-gate totality: for any request with `mode = manual` and any action other than an explicit status
  action, queue status is unchanged (2.9).

### Integration Tests

- Against real Supabase: the full clock-in → join queues → break start → break end → clock-out flow in
  both modes, asserting `profiles.availability`, `rotation_state`, `turn_events` and `availability_events`
  after each step.
- One, two and three eligible agents; wraparound; all agents unavailable; recovery when an agent becomes
  available; a null current agent; an ineligible current agent — driven through attendance actions in
  `attendance_assisted` mode, per the queue-rotation validation requirements.
- Simultaneous clock-out and claim, simultaneous break-end and pass, and a browser double-click on each of
  clock-out and break-end, asserting one transition, one event and at most one handoff.
- Rollback: force the queue portion to fail inside `attendance_clock_out` and assert the clock entry is
  still open, no `availability_events` row exists, and the response names `queue_status` as the failed
  portion (2.7, 2.8).
- `availability_events` append-only: update and delete are refused on the security-definer path and under
  RLS, following the existing `audit-immutability.integration.test.ts` pattern (2.13, 3.15).
- Migration default: after the migration, every pre-existing profile reads `queue_status_mode = 'manual'`
  and no attendance action changes any queue status until a manager opts an agent in (2.11).
- Account deletion end to end through the `DELETE` route: one `user_deactivated` availability event, the
  three rotation rows exactly as the unfixed baseline left them, one `audit_log` row, no `turn_events` row,
  and the auth ban rolled back with no availability event written when the RPC raises (2.20, 3.17).
- The `source` check constraint accepts all eight members and rejects a ninth, so `user_deactivated` is
  writable and the vocabulary stays closed (2.12).
- The 2.19 diagnostic runs read-only against production-shaped data and produces the six mismatch classes,
  and a user deleted after the fix is not flagged as a queue status with no availability event (2.19, 2.20).
