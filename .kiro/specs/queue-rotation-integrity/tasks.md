# Tasks: queue-rotation-integrity

Branch `fix/queue-rotation-integrity`. Ordered. Do not skip ahead — tests that must fail first are marked.

Legend: `[ ]` pending · `[x]` done · **BLOCKED** needs a decision from Byron.

---

## Phase 1 — Audit (complete)

- [x] 1.1 Inspect `git status`, create branch `fix/queue-rotation-integrity` off `09b9901`.
- [x] 1.2 Inventory every rotation-touching file, function, table, trigger and subscription.
- [x] 1.3 Build the function-version table across all 77 migrations (`bugfix.md` §10).
- [x] 1.4 Dump all 29 live function definitions via `pg_get_functiondef` → `evidence/live-functions/`.
- [x] 1.5 Capture live `rotation_state`, roster, `turn_events`, invariant verdicts → `evidence/live-audit*.json`.
- [x] 1.6 Probe `next_eligible_profile` (STABLE, read-only) across all rotations × positions.
- [x] 1.7 Decompose the selector predicate-by-predicate; confirm RLS/owner posture.
- [x] 1.8 Author + validate the read-only production diagnostic (25/25 statements execute).
- [x] 1.9 Confirm `supabase_migrations.schema_migrations` is absent; reconstruct ordering from filenames.

## Phase 2 — State machine (complete)

- [x] 2.1 Document the corrected selector contract and single eligibility predicate.
- [x] 2.2 Write the full transition matrix (`design.md` §2.6).
- [x] 2.3 Define the locking order and revalidate-after-lock rule (`design.md` §3`).
- [x] 2.4 Sequence diagrams for Claim, Pass, Recover, availability change, CS intake claim.
- [x] 2.5 Split realtime vs database responsibilities.
- [x] 2.6 Enumerate unchanged behavior / non-goals (`bugfix.md` §5).

## Phase 3 — Decisions (blocking)

- [ ] **3.1 BLOCKED** Confirm RC-4 resolution: patch `claim_ringcentral_intake` to advance, **or** repoint
      `src/app/api/intakes/[id]/claim/route.ts` at `cs_intake_claim_ringcentral` and retire the older path.
      Requires verifying whether `customer_intakes` is superseded by `cs_intake_submissions` in the live UI.
- [ ] **3.2 BLOCKED** Confirm rotation role scope = `{'agent'}` only (recommended Option A).
- [ ] **3.3 BLOCKED** Confirm Pass with one eligible agent returns the turn to that agent instead of
      raising `No eligible next agent`.
- [x] 3.4 Root-level `IntakeQueue.tsx` / `CsIntakeLanding.tsx` confirmed dead. Every real import resolves
      to `@/features/cs-intake/IntakeQueue` or `@/features/cs-intake/CsIntakeLanding`
      (`src/app/tools/cs-intake/queue/page.tsx`, `src/components/role-workspace.tsx`,
      `src/components/work-desk-app.tsx`, `src/app/tools/cs-intake/page.tsx`). Nothing imports the root
      copies. Deleting them is safe — still needs Byron's go-ahead since it is outside the defect.
- [ ] 3.5 Decide whether to enumerate live-only functions into the repo in this migration or a follow-up.

## Phase 4 — Reproduction harness (must fail before any fix)

- [ ] 4.1 Choose the harness. Confirm whether the repo has a runner for SQL logic tests; today
      `src/features/cs-intake/__tests__/rc-claim-preservation.test.ts` is TS-level only. Prefer a
      pgTAP-style SQL harness runnable against a scratch schema, or an ephemeral Supabase branch.
      **Never against production.**
- [ ] 4.2 Build fixtures: N agents with configurable `availability`, `<r>_active`, `<r>_position`,
      and seeded `rotation_state`.
- [ ] 4.3 Selector unit tests (expected RED against current production logic):
      one / two / three eligible agents · position gaps · duplicate positions · null position ·
      last position wrapping to first · `p_after_position = NULL` · zero eligible agents.
- [ ] 4.4 Assert the specific live defects reproduce, matching `bugfix.md` §2:
      `next_eligible_profile('whatsapp', 8)` returns NULL while an eligible agent sits at position 5.
- [ ] 4.5 Invariant tests: current agent unavailable · inactive · disabled for that rotation only ·
      all agents unavailable · one agent returning · `current_profile_id` null with eligible agents ·
      `current_profile_id` pointing at an ineligible agent.
- [ ] 4.6 Independence tests: every action asserts the other two rotations keep both
      `current_profile_id` **and** `version`.
- [ ] 4.7 Concurrency tests: two simultaneous claims · claim + pass · claim + availability change ·
      two tabs double-clicking the same claim · stale client acting after another advanced the queue.
- [ ] 4.8 Atomicity tests: inject a failure after work-item insert and assert full rollback —
      no work item, no `turn_events`, rotation unchanged.
- [ ] 4.9 `turn_events` cardinality test: every successful action writes exactly one row (AC-12).
- [ ] 4.10 CS intake tests: claim via RingCentral · browser retry returns the same work item ·
      intake claimed under the old workflow but unconverted · manager-assigned intake does not
      consume the turn.
- [ ] 4.11 Timed-quote tests: claim · Recover by authorized agent · Recover by unauthorized agent ·
      Recover after another agent claimed · Recover before deadline · queue position after Recover.
- [ ] 4.12 Frontend tests: realtime disconnected while the DB advances · 60-second fallback refresh
      after a missed event · `runRpc` refreshes on both success and error.
- [ ] 4.13 Record initial state / action / expected / actual / faulty call site for every reproduced
      failure into `bugfix.md` §2.
- [ ] 4.14 Preservation tests (must be GREEN before and after): `log_manual_quote`,
      `log_manual_workload`, `log_payment_v094`, `manager_create_and_assign_quote_v094`,
      `cs_intake_claim`, `cs_intake_convert`, `cs_intake_manager_assign`, `assign_customer_intake`,
      `workload_reassign`, `workload_void` move **no** rotation.
- [ ] 4.15 Preservation test: workload Pass stays rejected.
- [ ] 4.16 Preservation test: `ensure_daily_availability_reset` still nulls all three at rollover.

## Phase 5 — Implementation (only after Phase 4 is RED)

- [ ] 5.1 Create `supabase/migrations/v1.8.7-fix-rotation-integrity.sql`. Forward-only. Do not edit
      any existing migration.
- [ ] 5.2 Fix `next_eligible_profile`: wraparound back into `ORDER BY`, add `position IS NOT NULL`,
      add `id` tiebreaker. Re-run 4.3 — expect GREEN.
- [ ] 5.3 Add `advance_rotation(...)` (`design.md` §2.4): lock → resolve → self-if-eligible →
      update+version → exactly one `turn_events` row.
- [ ] 5.4 Add `ensure_rotation_valid(...)` (`design.md` §2.5): idempotent null/invalid repair.
- [ ] 5.5 Rewrite `claim_whatsapp_quote` and `claim_ringcentral_quote` to use both helpers; remove the
      ad-hoc `coalesce(v_next, v_me.id)`; revalidate the caller after the lock.
- [ ] 5.6 Same for `claim_linked_workload_turn`, `claim_unlinked_workload_turn`, `claim_workload_turn`.
- [ ] 5.7 Same for `take_quote_turn`.
- [ ] 5.8 `pass_my_turn`: keep the workload rejection and the reason requirement; replace the
      `No eligible next agent` raise per decision 3.3; ensure the audit row records previous, next,
      actor, rotation, timestamp and reason.
- [ ] 5.9 `claim_timed_quote` and `steal_timed_quote`: use `advance_rotation`; keep Recover advancing
      from the **missed** agent's position; keep the deadline / ownership / "queue moved" guards.
- [ ] 5.10 `set_my_availability`: call `ensure_rotation_valid` in the available branch; use
      `advance_rotation` in the non-available branch; make the logged reason state the real eligible count.
- [ ] 5.11 `manager_set_rotation_eligibility`: call `ensure_rotation_valid` on **both** branches; remove the
      `v_next is not null and v_next <> p_profile_id` gap that strands the rotation on a removed agent.
- [ ] 5.12 Apply decision 3.1 for `claim_ringcentral_intake` / the intake claim route.
- [ ] 5.13 `cs_intake_claim_ringcentral`: switch to the helpers, preserve the idempotent
      already-converted return and the old-workflow recovery path verbatim.
- [ ] 5.14 Capture live-only functions into the repo verbatim per decision 3.5.
- [ ] 5.15 Re-`GRANT EXECUTE ... TO authenticated` for every replaced function; preserve existing
      `REVOKE ... FROM public, anon`.
- [ ] 5.16 Frontend: replace the single `"No agent yet"` string with the diagnostic reasons in
      `design.md` §2.7, derived from already-loaded data. No new RPC. No client-side advancement.
- [ ] 5.17 Confirm `runRpc` refreshes after every mutation (already true) and add a regression test.
- [ ] 5.18 Delete the dead root-level duplicates per decision 3.4.
- [ ] 5.19 Write `supabase/migrations/v1.8.7-rollback.sql` restoring prior bodies from
      `evidence/live-functions/`. Functions only. No data statements.

## Phase 6 — Validation (no skipping; record real output)

Compare every result against `evidence/validation-baseline.md`. The baseline is **not clean**: 4 pre-existing
`tsc` errors and 187 pre-existing lint problems (58 errors). The gate is "no worse than baseline, plus the
new suites green" — not "zero problems".

- [ ] 6.1 `npx tsc --noEmit` — must report **exactly the 4 baseline errors**, no fifth.
- [ ] 6.2 `npm run lint` — must not exceed 187 problems / 58 errors.
- [ ] 6.3 `npx vitest --run` — full suite, unfiltered. All 241 baseline tests plus the new suites.
      Note: `package.json` has no `test` script, and `vitest.config.ts` only collects
      `src/**/*.{test,spec}.{ts,tsx}` — put new tests under `src/` or extend the config first.
- [ ] 6.4 Selector + invariant + concurrency + atomicity suites GREEN.
- [ ] 6.5 Preservation suites 4.14–4.16 still GREEN.
- [ ] 6.6 `npm run build`
- [ ] 6.7 Apply the migration to a **scratch/branch** database and re-run the full DB suite there.
- [ ] 6.8 Run `diagnostics/production-queue-diagnostic.sql` against the scratch DB; §5 must report
      `OK — wraparound implemented as an ORDER BY bucket`, §6 must show zero `DEFECT` rows, §7 zero
      `VIOLATION` rows.
- [ ] 6.9 Fill in the queue transition table (`bugfix.md` §7) with actual results — every one of the 19
      rows, each asserting exactly one `turn_events` record.
- [ ] 6.10 Confirm no test was skipped or filtered; paste exact command output into the evidence report.

## Phase 7 — Deployment (exact execution order)

- [ ] 7.1 Confirm Phase 6 fully GREEN. A passing build alone is not sufficient.
- [ ] 7.2 Capture a pre-deploy baseline: run the production diagnostic and archive the output.
- [ ] 7.3 Re-dump live definitions of every function the migration replaces; archive as the rollback source.
- [ ] 7.4 Verify the archived rollback script is complete and syntactically valid on the scratch DB.
- [ ] 7.5 Announce a short queue-quiet window (advancement behavior changes mid-session).
- [ ] 7.6 Open a PR from `fix/queue-rotation-integrity`. Do not merge to `main` without review.
- [ ] 7.7 **Byron applies** `v1.8.7-fix-rotation-integrity.sql` in the Supabase SQL Editor. Not automated;
      not applied by the agent.
- [ ] 7.8 Immediately re-run the production diagnostic. Confirm §5 `OK`, §6 no `DEFECT`, §7 no `VIOLATION`.
- [ ] 7.9 Verify self-healing without touching data: confirm each rotation acquires a valid current agent on
      first interaction, or is legitimately empty with zero eligible agents.
- [ ] 7.10 Deploy the frontend change (§5.16).
- [ ] 7.11 Smoke test in production with one agent: WhatsApp claim, RingCentral claim, workload claim,
      Pass, availability toggle. Confirm one `turn_events` row each and no cross-rotation movement.
- [ ] 7.12 Watch `turn_events` for 24h: zero rows where `next_profile_id IS NULL` while eligible agents
      exist, and zero rows where `previous_profile_id = next_profile_id`.
- [ ] 7.13 Confirm `action = 'manual_change'` manager repairs drop to zero.

## Phase 8 — Rollback plan (data-preserving)

Trigger: any invariant violation after deploy, duplicate work items, or turns advancing more than once.

- [ ] 8.1 Apply `v1.8.7-rollback.sql`. It only runs `CREATE OR REPLACE FUNCTION` + `GRANT`.
- [ ] 8.2 Re-grant execute permissions.
- [ ] 8.3 Revert the frontend deployment.
- [ ] 8.4 Re-run the production diagnostic and archive the output.
- [ ] 8.5 Confirm zero rows were deleted or modified in `work_items`, `quote_outcomes`,
      `pending_pricing_quotes`, `cs_intake_submissions`, `customer_intakes`, `turn_events`,
      `quote_take_events`, `work_item_events`, `cs_intake_events`, `audit_log`.

Explicit rollback constraints:

- No `DELETE`, `TRUNCATE` or `DROP TABLE` at any point.
- Never reset the database or restore a snapshot — that would destroy quote and audit history.
- `rotation_state` is **not** rewritten by the rollback. A rotation left pointing at a valid agent is
  harmless under the old functions.
- Do not touch secrets or environment values.

## Phase 9 — Deliverables

- [x] 9.1 `bugfix.md`
- [x] 9.2 `design.md`
- [x] 9.3 `tasks.md`
- [x] 9.4 `diagnostics/production-queue-diagnostic.sql` (validated, 25/25 statements)
- [ ] 9.5 `supabase/migrations/v1.8.7-fix-rotation-integrity.sql`
- [ ] 9.6 `supabase/migrations/v1.8.7-rollback.sql`
- [ ] 9.7 Automated tests
- [ ] 9.8 Deployment checklist in execution order → Phase 7
- [ ] 9.9 Rollback plan → Phase 8
- [ ] 9.10 `evidence-report.md`: files changed · functions changed · root cause per problem · tests run ·
      exact command output · remaining risks · production SQL Byron must run manually.
