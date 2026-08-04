# Implementation Plan

Branch: `fix/attendance-queue-status-sync`. Work in order — tasks 2 and 3 must run against unfixed code
before anything in tasks 4 onward is written. No deployment task is included: the migration is applied by
Byron in the Supabase SQL Editor after task 10 is green.

Design references below point at `design.md` § Fix Implementation items 1–14, and at the Bug Condition,
Preservation Requirements and Correctness Properties sections.

Task 1 is complete and fired its stop condition. Its sub-task 1.1 is the one piece of evidence still
outstanding, and it blocks task 4.6.

**Core pass, scoped down by Byron to ship sooner.** Built and applied to live: 4.1, 4.2, 4.3, 5.1, 5.2, 5.3,
`manager_set_queue_status_mode` out of 5.4, the grants half of 4.5, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3 and 9.4.
Deferred and left unchecked with a note on each: 3, 4.4, 4.5's reconciliation, 4.6,
`manager_set_queue_status` out of 5.4, 8, 9.2, 9.3, 9.5, and 10's test clauses. Task 9.1 was re-run and is
not yet green — 4 of 23 assertions fail, two of them because 4.4 and 4.6 are deferred and two because the
test asserts an availability event for a zero-delta transition that 2.12 does not ask for. Every deferral and
its consequence is listed in `evidence-report.md` § "Deferred out of the core pass".

---

- [x] 1. Dump and audit the live definitions before writing anything
  - **PREREQUISITE**: nothing in tasks 4–7 may be authored until this completes. Per the workspace
    queue-rotation rule, `supabase/schema.sql` is not the live logic and later migrations may not be either
  - Create the branch `fix/attendance-queue-status-sync` off the current HEAD
  - Dump the live bodies with `pg_get_functiondef` into
    `.kiro/specs/attendance-queue-status-separation/evidence/live-functions/`, using the existing
    `scripts/query-sql.mjs` pattern: `set_my_availability`, `ensure_daily_availability_reset`,
    `advance_rotation`, `ensure_rotation_valid`, `next_eligible_profile`, `is_rotation_eligible`,
    `is_agent`, `is_manager`, `can_manage_sales`, `manager_set_rotation_eligibility`
  - Diff each live body against the repo definition it is supposed to match:
    `v1.8.7-fix-rotation-integrity.sql` for `set_my_availability` and the rotation helpers,
    `supabase/schema.sql` (~1710) for `ensure_daily_availability_reset`. Record every difference — the new
    migration must recreate `ensure_daily_availability_reset` from the **live** body plus the audit insert.
    The diff settled which body that is: the live one is the `v0.9.8-stabilize-integrations.sql:1048`
    lineage, and `supabase/schema.sql:1712` is stale and materially different, so 4.4 is written from v0.9.8
    and not from schema.sql
  - Enumerate every live routine that writes `profiles.availability`, by scanning
    `pg_get_functiondef` output for all functions in `public` for the string `availability`. This closes the
    "Not verified in this session" gap: the frontend calls `claim_whatsapp_quote_v094`,
    `claim_ringcentral_quote_v094`, `start_quote_take_timer_v094`, `claim_timed_quote` and
    `steal_timed_quote`, which have no `create function` anywhere in `supabase/`
  - Confirm the live `availability_status` and `public.app_role` enum members — the role enum is
    `public.app_role`, not `role`; SQL written against a type named `role` fails — and confirm
    `availability_events`, `queue_status_mode` and `time_clock_breaks.pre_break_queue_status` do not
    already exist
  - Record the findings in `.kiro/specs/attendance-queue-status-separation/evidence-report.md`. If a live
    writer of `profiles.availability` is found that the design does not account for, stop and report it
    before continuing
  - **OUTCOME — this task fired its stop condition.** The live sweep found a **third** writer of
    `profiles.availability` that the design did not account for:
    `public.admin_deactivate_profile(uuid, uuid, text)`, which has no `create function` anywhere in
    `supabase/` and exists only in live. It also found that the live `ensure_daily_availability_reset()` is
    the `v0.9.8-stabilize-integrations.sql:1048` lineage, not the `supabase/schema.sql:1712` body this task
    was originally written against. Both are recorded in `evidence-report.md` § 1.3 and § 1.4, and they are
    the reason for the corrections in 1.1, 4.2, 4.4, 4.6, 9.3, 9.5, the `public.app_role` naming fix and
    the restated Property 3 clause below
  - _Design: Fix Implementation item 11, "Verification basis", "Not verified in this session"_
  - _Requirements: 3.7, 3.9, 3.15_

  - [x] 1.1 Extend the dumper to capture the full `admin_deactivate_profile` body
    - **PREREQUISITE for task 4.6**: there is no `create function` for `admin_deactivate_profile` anywhere
      in `supabase/`, so the live dump is the only source 4.6 can transcribe from. 4.6 may not be authored
      until this completes
    - Task 1 captured only its signature, its `security definer` flag and the lines of its body that
      mention `availability`, in `evidence/live-availability-scan.json`. That is not enough to recreate it
    - Add `admin_deactivate_profile` to the `targets` array in `scripts/dump-live-functions.mjs` and re-run
      `node scripts/dump-live-functions.mjs`, writing the full `pg_get_functiondef` output to
      `evidence/live-functions/admin_deactivate_profile.sql` with the existing capture header. The script is
      read-only and re-runnable; re-dumping the other ten is harmless
    - The dump must carry the **complete body**, the `security definer` flag, the `search_path` setting, the
      volatility and the full argument list with names and types
    - `pg_get_functiondef` does not emit grants, so also capture the ACL — `p.proacl` from `pg_proc`, or the
      `information_schema.role_routine_grants` rows for the function — into
      `evidence/live-functions/admin_deactivate_profile.grants.json`. A `drop`/`create` in 4.6 would
      silently drop grants that `create or replace` preserves, so the live grant list has to be on record
    - Confirm there is exactly one overload live, so 4.6 replaces rather than shadows
    - Record the dump path and the captured posture in `evidence-report.md`
    - _Design: Fix Implementation item 12, "the task-1 dumper captured its signature, `security definer` flag and availability lines … extend `scripts/dump-live-functions.mjs` to write its full body"_
    - _Bug_Condition: C8 — the third writer of `profiles.availability`_
    - _Expected_Behavior: 2.20, 2.21 — both are unimplementable without the live body_
    - _Preservation: 3.17 byte-identical recreation requires a byte-accurate source_
    - _Requirements: 2.20, 2.21, 3.17_
    - **OUTCOME.** Complete. `evidence/live-functions/admin_deactivate_profile.sql` (4,139 bytes) and
      `evidence/live-functions/admin_deactivate_profile.grants.json` captured; exactly one overload live;
      `security definer`, `search_path = 'public'`, volatile, owner `postgres`, EXECUTE to `postgres`,
      `service_role` and `authenticated`. Recorded in `evidence-report.md` § "Task 1.1". Two plan
      corrections fell out of the full body: the function has **no** `super_admin` target refusal (only the
      route does — it refuses deleting the final active Manager instead), and it raises when the target
      holds an active work item or a Pending Pricing quote. **Task 4.6 is unblocked.**

- [x] 2. Write bug condition exploration test
  - **Property 1: Bug Condition** - Attendance never silently decides queue participation
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after
    implementation (task 9.1)
  - **GOAL**: Surface counterexamples that demonstrate the bug exists and confirm or refute the nine
    hypothesized root causes. A refuted hypothesis sends us back to re-hypothesize before task 4
  - **Scoped PBT Approach**: the eight cases below are deterministic, so scope the property to those
    concrete inputs rather than generating freely. `X.mode` does not exist yet on unfixed code, so the
    mode dimension is exercised as `attendance_assisted` only (today every agent behaves as assisted);
    the `manual` half of the property is generated in task 9
  - Create `src/features/time-attendance/server/__tests__/queue-status-bug-condition.integration.test.ts`
    driving the four unfixed routes against seeded attendance and rotation state, then reading
    `profiles.availability`, `rotation_state`, `turn_events`, `attendance_audit_log` and `audit_log`
    directly. Run with `npm run test:integration`
  - Case C2 — seed an available agent holding the WhatsApp turn, clock out with no break open, assert
    `availability = 'unavailable'` and the WhatsApp turn moved. Confirms root cause 2
  - Case C4 — set `unavailable` via **My status**, start a break, end it, assert still `unavailable`.
    Confirms root causes 3 and 1
  - Case C3 — set `unavailable`, start a break, assert the pre-break value is recoverable from somewhere.
    Confirms root cause 3
  - Case C6 — a `customer_service` employee starts a break; assert the response is not an unqualified
    success given that `set_my_availability` raised `Agent permission required`. This needs no race:
    `is_agent()` is `role = 'agent'` only. Confirms root causes 4 and 5
  - Case C7 — fire two clock-outs at one open entry with a break open; count availability transitions and
    `turn_events` rows, assert one of each. Confirms root cause 8
  - Case C8 — perform a **My status** change, a break start, a break end, a clock-out, a **daily reset**
    and a **user deletion**, then assert each availability transition is attributable in some table with a
    previous status, a new status, a named source and an actor. Confirms root cause 7 and the third-writer
    finding of `evidence-report.md` § 1.4. All six writers, not four:
    - Daily reset — drive `ensure_daily_availability_reset()` by rolling `availability_day_state` back to a
      prior business date, then assert that the availability transitions it causes are named nowhere. It
      rewrites every `is_active` agent to `unavailable` and records nothing, so no table attributes it
    - User deletion — delete an agent who is `available` through the `DELETE` handler at
      `src/app/api/admin/users/route.ts`, which calls `admin_deactivate_profile`. Assert the one `audit_log`
      row exists with `action = 'user_deleted'` and the new availability buried inside `new_value`, and
      assert it is **not** an availability event: no previous status, no source from the 2.12 vocabulary, no
      availability semantics. It does not satisfy 2.12
    - Neither the reset nor the deletion is attributable as an availability transition today. Proving that
      is the point of the case
  - Case C1 — clock in while `unavailable`, assert the response carries a queue status and offers
    `Join Sales Queues`. Confirms root cause 9
  - Edge case 1.11 — repeat clock-in, clock-out and break-end after each has committed; assert all three
    answer with the committed state. Today clock-in answers 200 `already_open: true` while the other two
    answer HTTP 400
  - Run the test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document every counterexample in `evidence-report.md`: `availability` still `available` after a
    break-less clock-out with the WhatsApp turn still held; `available` after a break that started from
    `unavailable`, possibly with a fresh `turn_events` row handing that agent a turn they never asked for;
    HTTP 201 from `POST /api/time-clock/breaks` for a non-agent while Postgres raised; two transitions and
    up to two `turn_events` rows for one logical clock-out; zero audit rows naming any availability
    transition, including for the daily reset and for a user deletion whose only trace is an `audit_log`
    row with no previous status and no source
  - Mark this task complete when the test is written, run, and the failures are documented
  - _Design: Bug Condition (`isBugCondition`), Exploratory Bug Condition Checking, Fix Checking_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11_
  - **OUTCOME — the test fails as required: `18 failed | 5 passed (23)` on `npm run test:integration`.**
    All 18 counterexamples are tabulated in `evidence-report.md` § "Task 2", each mapped to the root cause
    it confirms. **No hypothesized root cause was refuted**, so task 4 may proceed. Highlights: a break-less
    clock-out left `availability = 'available'` with the WhatsApp turn still held; a break that started from
    `unavailable` ended `available`; `time_clock_breaks.pre_break_queue_status` does not exist, so nothing
    can be restored; a `customer_service` break start answered HTTP 201 while `set_my_availability` raised
    `Agent permission required`; two concurrent clock-outs for one open entry **both** answered HTTP 200
    while sequential retries answer HTTP 400; and zero rows in any table attribute any of the six
    availability writers, including a daily reset that changed 8 profiles and a user deletion whose only
    trace is an `audit_log` row with `action = 'user_deleted'`. The three route payloads carry no queue
    status at all. Note for task 10: `npm run test:integration` also fails the pre-existing, unrelated
    `src/features/cancellations/__tests__/audit-immutability.integration.test.ts` on a live check constraint

- [ ] 3. Write preservation baseline tests (BEFORE implementing fix)
  - **DEFERRED out of the core pass** by Byron, to ship sooner: the task 2 exploration test is the gate
    instead. **This one cannot be picked up later as written** — it is an observation of UNFIXED code, and
    the fix has landed, so the oracle it depends on can no longer be captured from this database. Recovering
    it means observing against a pre-`v1.12.13` copy, or restating the baseline from the route bodies as they
    stand in git history. The exposure it leaves is recorded in `evidence-report.md` § Deferred; the largest
    piece is the attendance arithmetic of 3.12, which moved from TypeScript into SQL
  - **Property 2: Preservation** - Behavior outside the bug condition is untouched
  - **IMPORTANT**: Follow observation-first methodology. The captured baseline is the oracle, so the tests
    cannot drift into asserting whatever the fix happens to do
  - Observe on UNFIXED code and record the values into
    `.kiro/specs/attendance-queue-status-separation/evidence/preservation-baseline.json`
  - Observe: `total_hours`, `break_minutes` and the paid short/personal versus unpaid lunch split across
    generated shift shapes, reusing the arbitraries in
    `src/features/time-attendance/domain/__tests__/arbitraries.ts`. Highest-risk area of the change, because
    this arithmetic moves from TypeScript into SQL (3.12)
  - Observe: `PATCH /api/time-clock` with `action: 'edit'` leaves current availability untouched and writes
    `attendance_audit_log` (3.11)
  - Observe: the **My status** control changes availability immediately, surfaces the returned error, and
    refreshes live data (3.10)
  - Observe: a second clock-in and a second break start are rejected by `uniq_time_clock_open_entry` and
    `uniq_time_clock_open_break`, and the loser receives the open row it lost to (3.13)
  - Observe: **all three** live effects of `ensure_daily_availability_reset()`, not only the availability
    write. Per `evidence-report.md` § 1.3 the live body does three things:
    - every `is_active` agent marked Unavailable exactly once under `pg_advisory_xact_lock(707200072)`
    - all three `rotation_state.current_profile_id` pointers nulled, with `version = version + 1`,
      `updated_at = now()` and `updated_by = null`
    - every unread `user_notifications` row of `notification_type = 'turn'` marked read
    - seed the run with **at least one agent already Unavailable**, so the baseline proves that 4.4's
      narrowed changed-row identification leaves the end state identical and emits no `daily_reset` event
      for a profile whose value did not move
    - also observe the daily-start behavior for the first agent to become Available afterwards (3.9)
  - Observe: the **full `admin_deactivate_profile` deletion path** on unfixed code, capturing the whole
    observable outcome —
    - the target profile's `is_active`, `availability`, `whatsapp_active`, `ringcentral_active`,
      `workload_active` and `updated_at`
    - `current_profile_id`, `version`, `updated_at` and `updated_by` for **all three** `rotation_state`
      rows, including the two the target did not hold, which must not move
    - the `work_desk_settings` CS overflow routing columns
    - the single `audit_log` row with its `action`, `entity_type`, `old_value` and `new_value`
    - the **absence** of any `turn_events` row for this path
    - run it twice: once with the target holding all three rotations, once holding none. This is the oracle
      4.6 is measured against, and the `user_deactivated` event must end up as the only addition (3.17, 2.20)
  - Observe: rotation pointers, `rotation_state.version` and `turn_events` for WhatsApp claim, RingCentral
    claim, CS intake claim, walk-in claim on turn and out of turn, Workload claim, Pass, timed-quote take
    and Recover. The walk-in out-of-turn case must leave `current_profile_id`, `version` and `turn_events`
    untouched (3.8)
  - Observe: a failed clock action leaves displayed figures unchanged and `useClockAction`'s `inFlightRef`
    refuses a second submission while one is in flight (3.14)
  - Write the property-based tests in
    `src/features/time-attendance/server/__tests__/queue-status-preservation-baseline.integration.test.ts`
    plus `.../queue-status-preservation.test.ts` for the pure attendance arithmetic, asserting the recorded
    baseline across the generated input space with `fast-check`. Property-based testing fits here because
    the input space is a product of six independent dimensions — action, mode, queue status, pre-break
    status, whether a break is open, and whether the request is concurrent
  - Restrict generation to `NOT isBugCondition(X)` for the equality assertions; the new
    `availability_events` row is an additive record and is excluded from the comparison
  - Run the tests on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms the baseline behavior to preserve)
  - Mark this task complete when the tests are written, run, and passing on unfixed code
  - _Design: Preservation Requirements, Preservation Checking test cases 5, 8 and 9, Correctness Property 2_
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.17_

- [ ] 4. Fix — forward-only migration for the mode column, pre-break status and audit table

  - [x] 4.1 Create `supabase/migrations/v1.12.13-attendance-queue-status-separation.sql`
    - Forward-only. Latest existing migration is `v1.12.12-reporting-filter-performance.sql`. Do not edit
      any historical migration file
    - Add `public.queue_status_mode` enum: `manual`, `attendance_assisted`
    - Add `profiles.queue_status_mode` `not null default 'manual'`, so every existing profile lands on
      `manual` and no existing user gets attendance-driven queue changes
    - Add `time_clock_breaks.pre_break_queue_status public.availability_status null`. Null means "not
      recorded" and is what every historical row and every `manual`-mode break carries; it is the input to
      the 2.6 fallback
    - _Design: Fix Implementation items 1, 2, 3_
    - _Bug_Condition: C3, C5 — break start loses the prior queue status; attendance writes apply with no opt-in_
    - _Expected_Behavior: 2.11 default `manual`; 2.3–2.6 pre-break memory_
    - _Preservation: 3.15 no historical migration edited; 3.16 profile insert still defaults `availability` to `unavailable`_
    - _Requirements: 2.11, 2.13, 3.15, 3.16_
    - **OUTCOME.** Complete, in `v1.12.13-attendance-queue-status-separation.sql` § 1–3, applied to live
      with `node scripts/run-sql.mjs`. Verification select: `mode_enum 1`, `profiles_column 1`,
      `non_manual_profiles_must_be_zero 0`, `break_column 1`. No historical migration edited

  - [x] 4.2 Add `public.availability_events` with the append-only posture
    - Columns per the design table: `id`, `profile_id`, `previous_status`, `new_status`, `source`,
      `actor_profile_id`, `clock_entry_id`, `break_id`, `reason`, `metadata`, `created_at`
    - Check constraint on `source` limited to **eight** members: `manual_agent`, `manual_manager`,
      `attendance_clock_out`, `attendance_break_start`, `attendance_break_end`, `daily_reset`,
      `system_repair` and `user_deactivated`. The eighth member is the account-deletion path recreated in
      4.6; it is deliberately distinct from `manual_manager`, because the actor is deleting an account
      rather than setting a queue status, and collapsing the two would make a deletion indistinguishable
      from a deliberate manager queue-status change
    - Indexes on `(profile_id, created_at desc)`, `(created_at desc)`, `(source, created_at desc)`
    - Append-only the same way `attendance_audit_log` is: a `before update or delete` trigger that raises,
      plus RLS with select and insert policies only and no update or delete policy. Select granted to the
      employee for their own rows and to `manager` and `super_admin` for all rows
    - _Design: Fix Implementation item 4, Glossary "Source" — eight members_
    - _Bug_Condition: C8 — no existing table can carry an availability transition_
    - _Expected_Behavior: 2.12 one attributable event per change, eight sources including `user_deactivated`; 2.13 new forward-only migration_
    - _Preservation: 3.15 `attendance_audit_log` stays append-only, `turn_events` keeps its existing vocabulary_
    - _Requirements: 2.12, 2.13, 3.15_
    - **OUTCOME.** Complete, § 4. All eight sources are in the check constraint, `daily_reset` and
      `user_deactivated` included, so tasks 4.4 and 4.6 need no constraint change when they land. Three
      indexes, the `before update or delete` trigger, `revoke update, delete`, and RLS with select
      (own rows, or manager / super_admin for all) and insert only — `events_write_policies_must_be_zero 0`.
      One decision worth knowing: the `clock_entry_id`, `break_id` and `profile_id` foreign keys carry **no**
      referential action, because `on delete cascade` and `on delete set null` both fire the append-only
      trigger and would be refused. An availability event therefore pins its clock entry and its profile in
      place, which is correct for production — corrections update clock entries and account deletion is a
      soft deactivate — and is why the task 2 probe had to gain a `purgeAvailabilityEvents()` step

  - [x] 4.3 Add `record_availability_event` and `apply_queue_status`
    - `public.record_availability_event(...)` `security definer` — the single insert point, so the
      eight-source vocabulary and the one-row-per-change rule live in one place. All six writers go through
      it, including the two recreated functions in 4.4 and 4.6
    - `public.apply_queue_status(p_profile_id, p_new_status, p_source, p_actor, p_clock_entry_id, p_break_id, p_reason, p_metadata)`
      returning `availability_status`: `select availability into v_prev from profiles where id = p_profile_id for update`;
      if `v_prev = p_new_status` return with no write, no event and no handoff (the idempotency point);
      otherwise `perform public.set_my_availability(p_new_status)`, re-read `availability`, record the
      event, return the value
    - `set_my_availability` owns the profile write, the deterministic `rotation_state` lock order, the
      `ensure_rotation_valid` recovery, the `advance_rotation` handoff and the `turn_events` rows. No
      rotation is edited directly by any path **this fix introduces**. The two pre-existing direct editors
      recreated in 4.4 and 4.6 keep their existing direct edits unchanged, per the Property 3 allow-list —
      the claim is `advancementPathsIn(F') ⊆ advancementPathsIn(F)`, not that all advancement goes through
      `advance_rotation`
    - Because `set_my_availability` derives its subject from `auth.uid()`, `apply_queue_status` is usable
      only for the calling employee's own profile — the manager path in 5.4 does not reuse it
    - _Design: Fix Implementation items 5, 6_
    - _Bug_Condition: C7, C8 — duplicate transitions and unattributed changes_
    - _Expected_Behavior: 2.10 at most one transition/event/handoff; 2.12 event contents_
    - _Preservation: 3.7 no new advancement path; 3.1, 3.2, 3.5, 3.6 rotation behavior unchanged_
    - _Requirements: 2.10, 2.12, 3.1, 3.2, 3.5, 3.6, 3.7_
    - **OUTCOME.** Complete, § 5–6, including the `v_prev = p_new_status` early return. No rotation is
      edited by either function; the handoff stays `set_my_availability`'s. One narrowing recorded in
      `evidence-report.md`: the early return means an agent already `available` who clicks
      `Sales Queues: Available` no longer re-runs the `ensure_rotation_valid` repair branch. Flagged for
      Byron rather than fixed, because removing the early return would break the 2.10 idempotency that the
      two-concurrent-clock-outs assertion now depends on

  - [ ] 4.4 Recreate `ensure_daily_availability_reset()` from the LIVE body, with one audit insert
    - **DEFERRED out of the core pass** by Byron, to ship sooner. Not built. The `daily_reset` source is
      already in the 4.2 check constraint, so this needs no constraint change when it lands. Until then the
      business-date rollover still records nothing, and the exploration test's "attributes the daily reset"
      assertion still fails. See `evidence-report.md` § Deferred
    - **CORRECTION.** The earlier version of this task said to recreate it from `supabase/schema.sql`
      (~1710). That is wrong and would ship a queue-integrity regression introduced by the fix itself. The
      live body is the `supabase/migrations/v0.9.8-stabilize-integrations.sql:1048` lineage with
      `search_path = public, pg_temp`, confirmed byte-identical to live in `evidence-report.md` § 1.3.
      `supabase/schema.sql:1712` is a stale, materially different lineage and MUST NOT be used
    - Carry the live body verbatim: `returns boolean`, `pg_advisory_xact_lock(707200072)`, the
      `availability_day_state` singleton insert-then-`for update` read, the Eastern business-date advance,
      the `true` / `false` return, and `search_path = public, pg_temp`
    - Reproduce **all three** live effects. Recreating from `supabase/schema.sql` would silently drop the
      second and third, which is the regression:
      1. mark every `is_active` agent Unavailable — the live predicate is
         `where role::text = 'agent' and is_active`, carrying **no** `availability <> 'unavailable'` clause
      2. null all three `rotation_state.current_profile_id` pointers —
         `current_profile_id = null, version = version + 1, updated_at = now(), updated_by = null` for
         `whatsapp`, `ringcentral` and `workload`
      3. mark every unread `user_notifications` row of `notification_type = 'turn'` read —
         `read_at = now() where notification_type = 'turn' and read_at is null`
    - Add one `record_availability_event(..., 'daily_reset', ...)` row per profile whose `availability`
      **actually changed**. Actor is the profile itself, because the reset has no human actor
    - Because the live statement carries no `availability <> 'unavailable'` predicate it rewrites every
      active agent, including those already Unavailable, so its row count cannot identify what changed.
      Emit one event per genuinely-changed profile using an explicit
      `update ... where role::text = 'agent' and is_active and availability <> 'unavailable'
      returning id, availability` — or an equivalent CTE that captures the pre-state and then performs the
      unpredicated update — and write one event per returned row
    - The migration comment MUST state that this changes the number of rows the statement touches while
      leaving the end state identical, because the rows excluded are exactly those already holding the value
      being written. A future reader must not mistake it for a behavior change
    - _Design: Fix Implementation item 11, including "Emitting one event per genuinely-changed profile"_
    - _Bug_Condition: C8 — the `daily_reset` writer leaves no audit trail_
    - _Expected_Behavior: 2.12 `daily_reset` source, exactly one event per genuinely-changed profile_
    - _Preservation: 3.9 all three live effects, the advisory lock, the once-per-business-date semantics, the unchanged end state and the daily-start behavior_
    - _Requirements: 2.12, 2.13, 3.9, 3.15_

  - [ ] 4.5 Reconciliation and grants
    - **PARTIALLY DONE.** The grants for everything the core pass built are in place
      (`v1.12.13-…sql` § 11): `service_role` only on `record_availability_event` and `apply_queue_status`,
      `authenticated, service_role` on the four attendance functions, `set_my_queue_status` and
      `manager_set_queue_status_mode`. The **reconciliation statement is DEFERRED**: it depends on the task 8
      diagnostic, which is also deferred, so there is nothing measured to repair yet. The two recreated
      functions this clause also covers belong to the deferred 4.4 and 4.6
    - `service_role` only on `record_availability_event` and `apply_queue_status` — both internal
    - The two recreated functions in 4.4 and 4.6 keep the grants they have live. Reproduce them from the
      live dump rather than guessing: `create or replace function` preserves existing grants, but a
      `drop`/`create` would silently drop them
    - If the task 8 diagnostic finds rows needing repair, add the one-off reconciliation statement using
      source `system_repair`. Do not invent a new repair function
    - _Design: Fix Implementation items 13, 14_
    - _Requirements: 2.12_

  - [ ] 4.6 Recreate `admin_deactivate_profile(uuid, uuid, text)` from the LIVE body, with two additions
    - **DEFERRED out of the core pass** by Byron, to ship sooner. Not built, and its prerequisite 1.1 is
      complete, so it is ready to author from `evidence/live-functions/admin_deactivate_profile.sql`
      whenever it is picked up. `user_deactivated` is already in the 4.2 check constraint. Until then: 2.20
      is open (a deletion leaves no availability event), 2.21 is open (the caller guard still excludes
      `super_admin`), 2.22 is open (no function-level `super_admin` target refusal, so the direct-RPC bypass
      around the route's 403 stands), and the exploration test's "attributes a user deletion" assertion still
      fails. See `evidence-report.md` § Deferred
    - **PREREQUISITE: task 1.1.** There is no `create function` for this function anywhere in `supabase/`,
      so this migration is its first repo definition and it MUST be transcribed from
      `evidence/live-functions/admin_deactivate_profile.sql`. Do not reconstruct it from memory or from the
      partial capture in `evidence/live-availability-scan.json`
    - Reproduce the live `security definer` posture, `search_path`, volatility, argument names and types,
      and `grant` list from the dump captured in 1.1
    - Byte-identical to live except for exactly **two** additions:
      1. **One `record_availability_event(..., 'user_deactivated', ...)` call.** The previous status is read
         **before** the profile write — from the `v_target` row the function already loads, or an explicit
         `select availability into v_prev` — the new status is `unavailable`, the source is
         `user_deactivated`, and the actor is `p_manager_id`, the acting manager. Exactly one event, whether
         or not the target held a rotation
      2. **A widened caller guard.** The live guard `role = 'manager' and is_active` becomes
         `role in ('manager', 'super_admin') and is_active`, per the workspace super-admin parity rule. The
         role type is `public.app_role`; there is no type named `role`
    - The existing refusal to delete a `super_admin` **target** is preserved unchanged, so widening the
      caller guard does not widen the set of deletable accounts
    - **Its direct `rotation_state` handoff stays exactly as-is.** For each of `whatsapp`, `ringcentral` and
      `workload` the target currently holds, keep
      `update rotation_state set current_profile_id = next_eligible_profile(<kind>, v_target.<kind>_position),
      version = version + 1, updated_at = now(), updated_by = p_manager_id`. Do **NOT** reroute it through
      `advance_rotation` and do **NOT** route it through `apply_queue_status`: `set_my_availability` derives
      its subject from `auth.uid()`, so it would refuse for a non-agent caller and act on the wrong profile
      for an agent one, and rerouting would add an advancement path and write `turn_events` rows this path
      does not write today — breaking Property 3 and 3.17. This is a deliberate exception, matching the
      Property 3 allow-list
    - Everything else reproduced exactly: the profile update setting `is_active = false`,
      `availability = 'unavailable'`, `whatsapp_active`, `ringcentral_active` and `workload_active` false and
      `updated_at = now()`; the `work_desk_settings` CS overflow clearing when it pointed at the deleted
      user; and the one `audit_log` row with `action = 'user_deleted'`, `entity_type = 'profile'`,
      `old_value = to_jsonb(v_target)` and
      `new_value = jsonb_build_object('is_active', false, 'availability', 'unavailable')`
    - Measure the result against the task 3 deletion-path baseline: the `user_deactivated` event must be the
      **only** addition, and the two rotations the target did not hold must still not move
    - _Design: Fix Implementation item 12_
    - _Bug_Condition: C8 — the third writer of `profiles.availability` leaves no availability event_
    - _Expected_Behavior: 2.20 one `user_deactivated` event with the pre-write previous status, `unavailable` as the new status and `p_manager_id` as actor; 2.21 caller guard admits `super_admin`_
    - _Preservation: 3.17 byte-identical otherwise, including the direct `rotation_state` handoff, the `work_desk_settings` clearing and the single `audit_log` row; 3.7 no new advancement path_
    - _Requirements: 2.12, 2.20, 2.21, 3.7, 3.17_

- [ ] 5. Fix — the four attendance transition functions and the explicit status setters

  - [x] 5.1 Add the four `security definer` attendance functions
    - `public.attendance_clock_in(p_status text default 'available')`, `public.attendance_clock_out()`,
      `public.attendance_break_start(p_break_type text default 'lunch')`, `public.attendance_break_end()`,
      each returning `jsonb` shaped
      `{ attendance_status, queue_status, queue_status_mode, entry, break, already_applied, changed_queue }`
    - Fixed lock order in all four so no pair can deadlock: `time_clock_entries` → `time_clock_breaks` →
      `profiles` → `rotation_state`
    - Resolve `auth.uid()` to an active profile and raise if absent; read `queue_status_mode` and `role`
    - Lock the relevant attendance row `for update` and **re-assert its state after the lock**. Clock-out
      and break-end require the row to still be open; if it is not, return the committed state with
      `already_applied: true` instead of the current HTTP 400. Clock-in and break-start keep relying on
      `uniq_time_clock_open_entry` and `uniq_time_clock_open_break` and keep answering the loser with the
      open row
    - Apply the attendance change with the arithmetic exactly as the routes compute it today: `total_hours`
      from clock-out minus clock-in minus `break_minutes`, `break_minutes` incremented for `lunch` only,
      `clock_status` transitions unchanged
    - Each function is one transaction, so a failure in any required step rolls back the attendance change
      too. There is no half-applied outcome to warn about
    - Re-read both statuses from the database and return them. Nothing in the payload is assumed
    - _Design: Fix Implementation item 7_
    - _Bug_Condition: C1, C2, C3, C4, C6, C7 — and 1.6, the independent round trips_
    - _Expected_Behavior: 2.8 one authoritative server-side transition; 2.18 statuses read back from the database_
    - _Preservation: 3.12 attendance figures identical; 3.13 unique-index protection and the open row returned to the loser_
    - _Requirements: 2.7, 2.8, 2.10, 2.18, 3.12, 3.13_
    - **OUTCOME.** Complete, § 8a–8d, plus `attendance_status_payload` for step 6 so all four re-read both
      statuses through one function. The post-lock re-assert is the `where clock_out is null … for update` /
      `where break_end is null … for update` qualification, which READ COMMITTED re-evaluates after the lock
      is granted: the loser of two concurrent clock-outs finds no row and is answered `already_applied: true`
      with HTTP 200. Both concurrent clock-outs now answer 200 in the exploration test, and both retry
      assertions pass. The arithmetic was transcribed statement by statement from the two route bodies
      (`total_hours`, `break_minutes` lunch-only, `duration_minutes`, `clock_status`) — **not measured
      against a baseline**, because task 3 is deferred, which makes it the highest-risk untested part of the
      pass (3.12)

  - [x] 5.2 Implement the per-action queue decision inside those functions
    - `role <> 'agent'::public.app_role` → no queue portion at all. Queue status is meaningless for a
      non-agent and `set_my_availability` would refuse. This is the deterministic C6 case, fixed by not
      making the call. The role enum is `public.app_role`; a cast written against a type named `role` fails
    - `queue_status_mode = 'manual'` → no queue portion
    - `attendance_assisted`, `clock_in` → no queue change; set `offers_join_sales_queues` when queue status
      is not `available`
    - `attendance_assisted`, `clock_out` → `apply_queue_status(..., 'unavailable', 'attendance_clock_out', ...)`
      whether or not a break was open. The `if (onBreak)` condition is gone
    - `attendance_assisted`, `break_start` → write `pre_break_queue_status := v_queue` on the break row,
      then `apply_queue_status(..., 'break', 'attendance_break_start', ...)` **only when**
      `v_queue = 'available'`. Any other value is left alone, so an agent who is not queue-eligible never
      becomes eligible through a break
    - `attendance_assisted`, `break_end` → read `pre_break_queue_status` from the break row being closed.
      Non-null restores exactly that value, so Available restores Available and Unavailable restores
      Unavailable. Null sets `unavailable` and the response offers `Join Sales Queues`
    - _Design: Fix Implementation item 7, step 5_
    - _Bug_Condition: C1, C2, C3, C4, C5, C6_
    - _Expected_Behavior: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.9_
    - _Preservation: 3.2 `profiles.availability` stays the authoritative queue-status field_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.9, 3.2_
    - **OUTCOME.** Complete, § 8 step 5 in each function, with `role <> 'agent'::public.app_role` getting no
      queue portion at all. The queue portion of each function is wrapped and re-raised under SQLSTATE
      `QS001` prefixed `queue_status:`, which is what the route's `failed_portion` reads; the wrapper
      re-raises, so nothing is swallowed and the whole transaction still rolls back. The table is mirrored as
      a pure function in `src/features/time-attendance/domain/queue-status.ts` for the 9.4 unit tests, with
      the SQL named as authoritative in both files

  - [x] 5.3 Add `public.set_my_queue_status(p_status public.availability_status, p_reason text default null)`
    - `perform apply_queue_status(auth.uid(), p_status, 'manual_agent', auth.uid(), null, null, p_reason, ...)`
      and return the resulting status. Closes the `manual_agent` half of C8
    - _Design: Fix Implementation item 8_
    - _Bug_Condition: C8_
    - _Expected_Behavior: 2.9 explicit agent action; 2.12 `manual_agent` source_
    - _Preservation: 3.10 immediate change, surfaced errors, live refresh_
    - _Requirements: 2.9, 2.12, 3.10_
    - **OUTCOME.** Complete, § 9. Proven by the exploration test: the **My status** probe now produces one
      attributable event with source `manual_agent`, where before the run found zero

  - [ ] 5.4 Add the two manager functions
    - **PARTIALLY DONE.** `manager_set_queue_status_mode` **is** built (§ 10), guarded by
      `public.is_manager()`, reason required, recorded in `audit_log` as `queue_status_mode_changed` with the
      old and new mode, writing no availability and no `availability_events` row. It was built because task
      6.3's `admin/users` `PATCH` forwards to it and the whole feature is inert without a way to opt an agent
      in — every profile defaults to `manual`.
    - **`manager_set_queue_status` is DEFERRED**: not in the core pass, so 2.9's manager path and the
      `manual_manager` source have no writer yet. A manager can opt an agent into `attendance_assisted` but
      cannot set another employee's queue status
    - `public.manager_set_queue_status(p_profile_id, p_status, p_reason)` guarded by
      `public.can_manage_sales()` — `manager`, `sales_supervisor`, `super_admin` — the same predicate
      `manager_set_rotation_eligibility` uses, so the two manager queue controls agree on who may use them.
      Reason required. Because `set_my_availability` acts on `auth.uid()`, this writes the target's
      `availability` itself and then calls `ensure_rotation_valid(kind, actor)` for each of the three
      rotations under the same `order by kind for update` lock order, plus `advance_rotation` when the target
      holds a rotation and is no longer eligible — the same two primitives, not a new advancement path. One
      `manual_manager` event
    - `public.manager_set_queue_status_mode(p_profile_id, p_mode, p_reason)` guarded by
      `public.is_manager()`, which is `manager` and `super_admin` exactly, because 2.11 restricts the mode
      change to those two roles and `can_manage_sales()` would additionally admit `sales_supervisor`.
      Reason required, recorded in `audit_log` with the old and new mode. Changes no availability and writes
      no `availability_events` row
    - Grants: `authenticated, service_role` on the four attendance functions and `set_my_queue_status`;
      `authenticated, service_role` on the two manager functions, which enforce their own role check
    - _Design: Fix Implementation items 9, 10, 14_
    - _Bug_Condition: C5, C8 — no explicit manager queue-status setter exists today_
    - _Expected_Behavior: 2.9, 2.11, 2.12, 2.17_
    - _Preservation: 3.7 no second advancement path_
    - _Requirements: 2.9, 2.11, 2.12, 2.17, 3.7_

- [x] 6. Fix — rewrite the routes with strict RPC error handling

  - [x] 6.1 `src/app/api/time-clock/route.ts`
    - `POST` becomes one `rpc('attendance_clock_in', { p_status })`. The unique-violation branch moves into
      SQL; the route keeps returning `already_open` from the payload so the client contract holds
    - `PATCH` with `action: 'clock_out'` becomes one `rpc('attendance_clock_out')`. The manual break-closing
      update, the `total_hours` arithmetic and the `if (onBreak)` availability call all move into SQL and
      the condition is dropped
    - `PATCH` with `action: 'edit'` is untouched. It does not write availability today and must not start
    - Inspect every `rpc` result's `error`. On error: re-read both statuses via the same read
      `/api/time-clock/active` uses and answer with
      `{ error, failed_portion, attendance_status, queue_status }`, where `failed_portion` is `'attendance'`
      or `'queue_status'`, resolved from the SQLSTATE and message the function raised
    - _Design: Fix Implementation § 2, `src/app/api/time-clock/route.ts`_
    - _Bug_Condition: C2, C6 — swallowed `{ error }` results and the `if (onBreak)` condition_
    - _Expected_Behavior: 2.2, 2.7, 2.8_
    - _Preservation: 3.11 manager punch edit leaves availability untouched and still writes `attendance_audit_log`_
    - _Requirements: 2.2, 2.7, 2.8, 3.11_
    - **OUTCOME.** Complete. `PATCH action: 'edit'` is byte-identical to before. `failed_portion` is resolved
      by `resolveFailedPortion` in `src/features/time-attendance/server/attendance-rpc.ts`: SQLSTATE `QS001`,
      the `queue_status:` message prefix, the availability-path messages and the three lock SQLSTATEs map to
      `'queue_status'`; everything else, including the unmapped case, maps to `'attendance'`, because the
      attendance change is applied first and is the only portion all four functions perform

  - [x] 6.2 `src/app/api/time-clock/breaks/route.ts`
    - `POST` becomes one `rpc('attendance_break_start', { p_break_type })`; `PATCH` becomes one
      `rpc('attendance_break_end')`. The `clock_status` updates, the `break_minutes` arithmetic and both
      `set_my_availability` calls move into SQL. Same error handling as 6.1
    - _Design: Fix Implementation § 2, `src/app/api/time-clock/breaks/route.ts`_
    - _Bug_Condition: C3, C4, C6_
    - _Expected_Behavior: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
    - _Preservation: 3.12, 3.13_
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_
    - **OUTCOME.** Complete. Both handlers are one RPC with the same error handling as 6.1. `PATCH` takes no
      request argument now that the body is unused

  - [x] 6.3 `src/app/api/time-clock/active/route.ts` and `src/app/api/admin/users/route.ts`
    - `active` additionally returns `queue_status`, `queue_status_mode` and `is_agent`, so every panel can
      render two labelled values from a database read rather than an assumption
    - `admin/users` `PATCH` accepts `queue_status_mode` and forwards it to
      `manager_set_queue_status_mode`. The route is already guarded by `canAdministerUsers`, which admits
      manager and super_admin
    - **The `DELETE` handler in `src/app/api/admin/users/route.ts` is otherwise untouched.** Its
      own-account refusal, its 403 on a `super_admin` target, its auth ban, its `admin_deactivate_profile`
      call at ~419 and its ban-rollback on RPC failure all stay exactly as they are. The availability event
      is added **inside** the function in 4.6, not in the route, so the deletion remains one transaction —
      putting the event in the route would let a deletion commit without its event, or an event exist for a
      deletion that rolled back
    - _Design: Fix Implementation § 2, `active/route.ts` and `admin/users/route.ts`_
    - _Expected_Behavior: 2.11, 2.14, 2.18; 2.20 the event lives in the function, not the route_
    - _Preservation: 3.17 the deletion path's observable behavior is unchanged outside the added event_
    - _Requirements: 2.11, 2.14, 2.18, 2.20, 3.17_
    - **OUTCOME.** Complete. `active` keeps `clocked_in`, `entry` and `active_break` and adds
      `attendance_status`, `queue_status`, `queue_status_mode` and `is_agent`, all through the same
      `readStatusSnapshot` a failed clock action re-reads with. `admin/users` `PATCH` gained a
      `queue_status_mode` branch that forwards to `manager_set_queue_status_mode` **on the caller's own
      session** rather than the service-role client, because the function is guarded by `is_manager()`, which
      reads `auth.uid()`; the route's `canAdministerUsers` guard has already run. `GET` now also selects
      `queue_status_mode` so the admin screen can show it. `DELETE` is untouched

- [x] 7. Fix — separate the two statuses in the UI

  - [x] 7.1 `src/features/time-attendance/shared/useClockAction.ts`
    - `onRecorded` receives the response payload so callers render the returned statuses instead of
      refetching blind. The `inFlightRef` guard, the mounted guard and the failure handling stay exactly as
      they are
    - _Design: Fix Implementation § 3, `useClockAction.ts`_
    - _Preservation: 3.14 failed action leaves figures unchanged and refuses a second in-flight submission_
    - _Requirements: 2.18, 3.14_
    - **OUTCOME.** Complete. `onRecorded` now takes a `ClockActionResponse`; `inFlightRef`, the mounted guard
      and the failure handling are unchanged. The one existing caller that ignores the argument
      (`TeamTodayHeader`'s `refreshAll`) still type-checks

  - [x] 7.2 `MyDayPanel.tsx` and `TodayScreen.tsx`
    - Two separately labelled values: `Attendance: Clocked Out | Working | On Break` and, for agents only,
      `Sales Queues: Available | Break | Unavailable`. The bare word `Available` never stands alone
    - Clocked in and queue status not `available` → `You are clocked in, but you are not currently
      receiving sales work.` with `Join Sales Queues` as the primary action, calling
      `set_my_queue_status('available')`
    - Clock-out in `attendance_assisted` → `You have been clocked out and removed from the sales queues.`
    - Clock-out in `manual` with queue status still `available` → `You are clocked out but still marked
      Available in Sales Queues.` with a `Set Unavailable` action
    - Every rendered value comes from the response or the next `/api/time-clock/active` read
    - _Design: Fix Implementation § 3, `MyDayPanel.tsx` / `TodayScreen.tsx`_
    - _Bug_Condition: C1 — the fix here is disclosure, not a state change_
    - _Expected_Behavior: 2.14, 2.15, 2.16, 2.17, 2.18_
    - _Requirements: 2.14, 2.15, 2.16, 2.17, 2.18_
    - **OUTCOME.** Complete. The rules live in `src/features/time-attendance/domain/queue-status.ts`
      (`statusLines`, `queueStatusNotice`) and are rendered by a new presentational
      `today/SalesQueueStatus.tsx`, which both `MyDayPanel` and `TodayScreen`'s Team Today render from their
      own `/api/time-clock/active` read. Each line is a single string — `Attendance: Working`,
      `Sales Queues: Unavailable` — so no label and value can drift apart into a bare `Available`, and the
      queue line is omitted entirely for a non-agent. The three sentences of 2.15, 2.16 and 2.17 are fixed in
      `QUEUE_STATUS_MESSAGES` and asserted verbatim in the 9.4 tests

  - [x] 7.3 `src/components/work-desk-app.tsx`
    - `handleAvailability` calls `set_my_queue_status` instead of `set_my_availability`, so the agent's own
      changes are audited. Behavior, toast and refresh are otherwise unchanged
    - Relabel the control and its toast to name sales queues: `Sales Queues: Available`,
      `Sales Queues: Break / Lunch`, `Sales Queues: Unavailable`
    - _Design: Fix Implementation § 3, `work-desk-app.tsx`_
    - _Bug_Condition: C8 — the `manual_agent` writer leaves no audit trail_
    - _Expected_Behavior: 2.12, 2.14_
    - _Preservation: 3.10 immediate change, surfaced error, live refresh_
    - _Requirements: 2.12, 2.14, 3.10_
    - **OUTCOME.** Complete. `handleAvailability` sends `set_my_queue_status`; `runRpc`'s error surfacing,
      toast and refresh are otherwise unchanged. The control heading is now `Sales queues`, the three buttons
      and the toast read `Sales Queues: Available`, `Sales Queues: Break / Lunch` and
      `Sales Queues: Unavailable` from one `QUEUE_STATUS_LABELS` table, and the daily-start hint says which
      of the two statuses this control governs

- [ ] 8. Fix — the read-only production diagnostic
  - **DEFERRED out of the core pass** by Byron, to ship sooner. Not built, so the six production mismatch
    counts stay unknown and task 4.5 has nothing measured to repair. Note for whoever picks it up: with 4.6
    still deferred, the "a queue status with no `availability_events` row" class will flag every profile,
    because no backfill exists yet
  - Create `.kiro/specs/attendance-queue-status-separation/diagnostics/attendance-queue-diagnostic.sql`,
    following the shape of
    `.kiro/specs/queue-rotation-integrity/diagnostics/production-queue-diagnostic.sql`. Read-only — no
    write statement anywhere in the file
  - One row per active agent with attendance state, open clock entry, active break, queue availability,
    queue sync mode, the current WhatsApp / RingCentral / Workload holder, the latest
    `availability_events` row, the latest `attendance_audit_log` row, and a `mismatches` array
  - Flag all six classes: clocked out but queue Available; clocked in but queue Unavailable; active break
    but queue Available; no active break but queue status Break; a queue status with no
    `availability_events` row; and a current queue holder who is not `is_rotation_eligible`
  - Restrict access to manager and super_admin
  - Run it and record the production counts of each mismatch class in `evidence-report.md` — they are
    unknown until this runs, and they decide whether task 4.5 needs a `system_repair` statement
  - _Design: Fix Implementation § 4_
  - _Requirements: 2.19_

- [ ] 9. Validate — property-based and integration tests

  - [ ] 9.1 Verify the bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Attendance never silently decides queue participation
    - **IMPORTANT**: Re-run the SAME test from task 2 - do NOT write a new test. It encodes the expected
      behavior; when it passes, the expected behavior is satisfied
    - **EXPECTED OUTCOME**: Test PASSES (confirms the bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.12, 2.20, 2.21_
    - **RUN AFTER THE CORE PASS — not yet green, and left unchecked.**
      `npm run test:integration -- queue-status-bug-condition` → **4 failed | 19 passed (23)**, from
      18 failed | 5 passed. **14 of the 18 counterexamples are resolved.** The four remaining:
      - "attributes the daily reset" — task 4.4 deferred
      - "attributes a user deletion" — task 4.6 deferred
      - "attributes a break start" and "attributes a break end" — **a test-versus-spec mismatch, not a code
        defect.** Both probes are zero-delta: c3 starts a break from `unavailable`, which per 2.4 records the
        pre-break status and does not write `break`; c4 restores `unavailable` over `unavailable`. Neither
        moves the value, so `apply_queue_status` takes the designed early return and 2.12 — "WHEN queue
        availability changes" — asks for no event. The design's own Fix Checking block guards the same
        assertion with `IF changesQueueAvailability(F', X)`; the test asserts it unconditionally. **Byron's
        call:** guard the two assertions the way Fix Checking does, or record zero-delta queue decisions as
        events, which would mean dropping the early return that makes a duplicate request idempotent
      - Three harness-only changes were made to the task 2 file and are recorded in `evidence-report.md`:
        the seeds now state `queue_status_mode: 'attendance_assisted'` (the mode dimension task 2 fixed, in a
        column that did not exist then), the **My status** probe drives `set_my_queue_status` (the RPC the
        control now sends), and cleanup purges `availability_events` so the probe can still delete its own
        clock rows and profiles. No assertion was weakened

  - [ ] 9.2 Verify the preservation tests still pass
    - **NOT RUNNABLE: task 3 was deferred, so there is no baseline and no test to re-run.** The exploration
      test is the gate this pass. The unmeasured comparison that matters most is the attendance arithmetic,
      which moved from TypeScript into SQL (3.12)
    - **Property 2: Preservation** - Behavior outside the bug condition is untouched
    - **IMPORTANT**: Re-run the SAME tests from task 3 against the recorded baseline in
      `evidence/preservation-baseline.json` - do NOT write new tests and do NOT re-record the baseline
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions). The attendance arithmetic moving from
      TypeScript into SQL is the highest-risk comparison here; the daily reset's three effects and the
      deletion path's rotation rows are the two the recreated functions in 4.4 and 4.6 are measured against
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15, 3.17_

  - [ ] 9.3 Write the rotation invariant property test
    - **DEFERRED out of the core pass** by Byron, to ship sooner. Property 3 is therefore unproven. What can
      be said without it: the four attendance functions and `apply_queue_status` contain no `rotation_state`
      write of any kind — every queue change goes through `set_my_availability` — so no advancement path was
      added. That is an argument from reading the migration, not a measurement
    - **Property 3: Preservation** - Rotation invariants hold for every input, buggy or not
    - In `src/features/time-attendance/server/__tests__/queue-status-rotation-invariants.integration.test.ts`,
      over all generated `StatusTransitionRequest` values, assert four clauses:
      1. each of the three rotations is either bit-identical — `current_profile_id` **and** `version` — or
         is one the request legitimately affects
      2. a non-null current agent is rotation-eligible
      3. no rotation is null while an eligible agent exists for it — **except for the daily reset, which is
         explicitly exempt**. 3.9 requires the reset to null all three pointers, so for
         `X.action = daily_reset` clause 3 is not evaluated; assert the replacement post-condition instead:
         all three pointers are null **AND** no eligible agent exists for any rotation, because the same
         transaction has just marked every `is_active` agent Unavailable. Clause 3 applies unchanged to
         every other input. This is the decision recorded in `design.md` § "Resolving the daily-reset
         tension with clause three" — the exemption names a specific, decidable input, where scoping the
         invariant to "post-reset steady state" would not be evaluable
      4. **CORRECTION.** The earlier wording — "every advancement went through `advance_rotation` rather
         than a direct rotation edit" — is **already false against live**. It would fail on unfixed and
         fixed code alike, so it proves nothing about the fix. Three pre-existing functions edit
         `rotation_state` directly today: `ensure_daily_availability_reset` nulls all three pointers,
         `admin_deactivate_profile` updates each held rotation through `next_eligible_profile`, and
         `take_quote_turn` updates `rotation_state` directly. Assert the subset relation instead —
         `advancementPathsIn(F') ⊆ advancementPathsIn(F)` — every member of which is either
         `advance_rotation` or one of the three allow-listed direct editors
         `ensure_daily_availability_reset`, `admin_deactivate_profile`, `take_quote_turn`. Whatever direct
         editing exists, this change does not add to it
    - The generator MUST include `daily_reset` and `user_deleted` in the action domain, so the daily-reset
      exemption and its replacement post-condition are both exercised and the deletion path's two untouched
      rotations are checked
    - Add the idempotency property: applying any request twice produces the same final state, one
      availability event and at most one turn handoff
    - Add the mode-gate totality property: for any request with `mode = manual` and any action other than an
      explicit status action, queue status is unchanged
    - _Design: Correctness Property 3, "Why the fourth clause is stated as a subset, not as `advance_rotation`", "Resolving the daily-reset tension with clause three", Property-Based Tests_
    - _Preservation: 3.7 no new advancement path, allow-list preserved; 3.9 the reset's rotation nulling_
    - _Requirements: 2.9, 2.10, 3.1, 3.2, 3.5, 3.7, 3.9, 3.17_

  - [x] 9.4 Write the unit tests
    - The per-action queue decision as a pure decision table: action × mode × queue status × pre-break
      status → expected new queue status and expected source. Every cell of 2.1–2.6 and 2.9, including the
      `role <> 'agent'::public.app_role` cell
    - The `failed_portion` mapping from a raised SQLSTATE and message to `'attendance'` or `'queue_status'`,
      including the unmapped fallback
    - The message selection of 2.15, 2.16 and 2.17 from attendance status, queue status and mode
    - The two-label rendering of 2.14, including the assertion that no rendered string is the bare word
      `Available`, and that the queue line is absent for non-agents
    - `already_applied` handling: a retried clock-out and a retried break-end answer with committed state
      rather than an error
    - _Design: Unit Tests_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.9, 2.10, 2.14, 2.15, 2.16, 2.17_
    - **OUTCOME.** Complete: three files, **48 tests, all passing**, no mocks anywhere.
      - `src/features/time-attendance/domain/__tests__/queue-status.test.ts` — the decision table enumerated
        over action × mode × queue status × pre-break status, including the five non-agent roles, the
        `manual` totality, every cell of 2.1–2.6, and the rule that an event belongs to a change rather than
        to an attempt
      - `src/features/time-attendance/server/__tests__/attendance-rpc.test.ts` — the `failed_portion` mapping
        including the unmapped fallback, and `already_applied`: a retried clock-out and a retried break-end
        answer 200 with the committed state and no `error`
      - `src/features/time-attendance/today/__tests__/SalesQueueStatus.test.tsx` — the two-label rendering
        asserted on the DOM, that no rendered string is the bare word `Available`, that the queue line is
        absent for a non-agent, and the 2.15 / 2.16 / 2.17 message and action selection
      - `npx vitest --run queue-status.test attendance-rpc.test SalesQueueStatus` →
        `Test Files 3 passed (3)` / `Tests 48 passed (48)`

  - [ ] 9.5 Write the integration tests against real Supabase
    - **DEFERRED out of the core pass** by Byron, to ship sooner. The exploration test covers a single-agent
      flow, the two concurrency cases and the retry cases; the multi-agent rotation matrix, the rollback
      case, the append-only proof, the migration-default proof and the deletion end-to-end are unverified
    - The full clock-in → join queues → break start → break end → clock-out flow in both modes, asserting
      `profiles.availability`, `rotation_state`, `turn_events` and `availability_events` after each step
    - Per the queue-rotation validation requirements, driven through attendance actions in
      `attendance_assisted` mode: one, two and three eligible agents; wraparound; all agents unavailable;
      recovery when an agent becomes available; a null current agent; an ineligible current agent
    - Simultaneous clock-out and claim, simultaneous break-end and pass, and a browser double-click on each
      of clock-out and break-end, asserting one transition, one event and at most one handoff
    - Rollback: force the queue portion to fail inside `attendance_clock_out` and assert the clock entry is
      still open, no `availability_events` row exists, and the response names `queue_status` as the failed
      portion
    - `availability_events` append-only: update and delete refused on the security-definer path and under
      RLS, following the existing
      `src/features/time-attendance/server/__tests__/audit-immutability.integration.test.ts` pattern
    - Migration default: after the migration every pre-existing profile reads
      `queue_status_mode = 'manual'` and no attendance action changes any queue status until a manager opts
      an agent in
    - The task 8 diagnostic runs read-only against production-shaped data and produces the six mismatch
      classes, and a user deleted after the fix is **not** flagged as a queue status with no availability
      event
    - Account deletion end to end through the `DELETE` route at `src/app/api/admin/users/route.ts`: exactly
      one `user_deactivated` availability event; the three `rotation_state` rows exactly as the task 3
      baseline left them, including the two the target did not hold; one `audit_log` row with
      `action = 'user_deleted'`; no `turn_events` row for this path; and, when the RPC raises, the auth ban
      rolled back with **no** availability event written
    - Widened caller guard, unchanged deletable set: a `super_admin` caller can now invoke
      `admin_deactivate_profile` successfully where it previously raised, a `manager` caller still can, a
      caller with any other role still cannot, and a `super_admin` **target** is still refused — by the
      function **and** by the route's 403 — for a `manager` and a `super_admin` caller alike
    - The `source` check constraint accepts all **eight** members and rejects a ninth, so `user_deactivated`
      is writable and the vocabulary stays closed
    - _Design: Integration Tests_
    - _Requirements: 2.7, 2.8, 2.10, 2.11, 2.12, 2.13, 2.19, 2.20, 2.21, 3.5, 3.15, 3.17_

- [ ] 10. Checkpoint — ensure all tests pass, then type check and build
  - **PARTIALLY DONE in the core pass.** `npx tsc --noEmit` is clean and `npm run build` succeeds. The two
    integration clauses cannot be satisfied while tasks 3, 9.3 and 9.5 are deferred, and `npm run test:integration`
    still reports 4 of the 23 exploration assertions failing (see 9.1). `npm test` reports
    `28 failed | 2557 passed | 61 skipped`; **all 28 are pre-existing and unrelated** — they are in
    `src/features/cancellations` and `src/features/renewals`, they all turn on whether `sales_supervisor`
    counts as a manager, and they come from other uncommitted work already in the working tree
    (`src/lib/permissions.ts` and those two features are modified there). Nothing in this pass imports them.
    Exact output in `evidence-report.md` § Checkpoint commands
  - **The migration has already been applied to live** with `node scripts/run-sql.mjs`, on Byron's standing
    authorization, rather than being left for the Supabase SQL Editor
  - `npm test` — full single-run suite, unfiltered. No new failures
  - `npm run test:integration` — the exploration, preservation, invariant and transition suites green
  - `npx tsc --noEmit` — no new errors relative to the pre-change baseline
  - `npm run build` — production build succeeds
  - A successful build alone is not proof that queue behavior is correct. Task 9.3 and 9.5 are the proof
  - Record the exact command output in `evidence-report.md`, and note that
    `supabase/migrations/v1.12.13-attendance-queue-status-separation.sql` is applied manually by Byron in
    the Supabase SQL Editor — not by the agent, and not as part of this task list
  - Ensure all tests pass; ask the user if questions arise
