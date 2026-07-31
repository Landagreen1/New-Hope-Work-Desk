# Evidence Report — queue-rotation-integrity

Branch: `fix/queue-rotation-integrity`
Baseline: `09b9901`
Migration applied to production: **`v1.8.7-fix-rotation-integrity.sql` — 2026-07-31 ~03:50 UTC**

---

## 1. Outcome

The primary defect is fixed and deployed. Production verification, run against the live
functions immediately after deploy, replays the exact 2026-07-31 00:30:30 incident and passes:

```
low  : Estefania Bayas (whatsapp_position 5)
high : Miguel Leiva    (whatsapp_position 8)

[PASS] INCIDENT_selector_from_pos8    expected=Estefania Bayas (wraps)    actual=Estefania Bayas
[PASS] INCIDENT_advance_from_pos8     expected=Estefania Bayas, not NULL  actual=Estefania Bayas
[PASS] self_loop_keeps_agent          expected=Estefania Bayas            actual=Estefania Bayas
[PASS] recovers_from_null             expected=Estefania Bayas            actual=Estefania Bayas
[PASS] repairs_ineligible_pointer     expected=Estefania Bayas            actual=Estefania Bayas
[PASS] rotations_independent          expected=rc+wl unchanged            actual=rc=null wl=null
[PASS] one_turn_event_written         expected=1                          actual=1
[PASS] ensure_valid_idempotent        expected=version unchanged          actual=v877 -> v877
[PASS] null_when_truly_empty          expected=NULL                       actual=NULL
[PASS] setup_two_eligible             expected=2                          actual=2

10/10 checks passed
Rollback verification: production state UNCHANGED
```

That test ran inside a transaction that rolled back, so it changed no production data.

Live invariant audit after deploy — zero violations:

| rotation | current agent | eligible | verdict | diagnostic |
|---|---|---|---|---|
| whatsapp | none | 0 | OK: legitimately empty | All 10 WhatsApp agents are unavailable or on break. |
| ringcentral | none | 0 | OK: legitimately empty | All 10 Customer Service Intake Queue agents are unavailable or on break. |
| workload | none | 0 | OK: legitimately empty | All 10 Additional Workload agents are unavailable or on break. |

All agents were offline at 03:50 UTC, so `NULL` is correct here (invariant 6). Before the fix the
same audit reported `VIOLATION: null current agent but eligible agents exist` on WhatsApp and
RingCentral while Estefania Bayas was available and eligible on all three.

---

## 2. Root cause

**RC-1 (primary).** The deployed `next_eligible_profile()` had moved the position comparison out of
`ORDER BY` and into `WHERE`:

```sql
-- WAS (production only; never in any repo migration)
WHERE <eligibility> AND <pos> > p_after_position      -- hard filter
ORDER BY <pos> LIMIT 1

-- NOW
WHERE <eligibility> AND <pos> IS NOT NULL
ORDER BY
  case when <pos> > p_after_position then 0 else 1 end,   -- wraparound bucket
  <pos>, p.id
LIMIT 1
```

Consequences of the old form, all confirmed against live data:

- **No wraparound.** The highest position never returned to the lowest.
- **Single eligible agent unreachable.** `p > p` is false, so a solo agent could never be selected.
- **NULL while eligible agents existed** whenever the remaining agents sat at lower positions.

Proof of the mechanism, from `public.turn_events` — the same function 43 seconds apart:

```
00:30:30  whatsapp/ringcentral  Miguel Leiva  (pos 8) -> NULL   "no eligible agent is currently available"  ← false
00:31:13  workload              Mauricio Plaza (pos 3) -> Estefania Bayas (pos 5)                           ← correct
```

Workload survived only because the departing agent sat *below* the remaining eligible agent.

Second symptom from the same cause: `v1.8.5`'s `coalesce(v_next, v_me.id)` turned the NULL into a
self-assignment, so the turn stuck. Live evidence:

```
22:55:29  workload  claim  actor=Miguel Leiva  prev=Miguel Leiva  next=Miguel Leiva
```

Managers had been compensating by hand — `action='manual_change'`, reason "Manager changed rotation
from Overview", seven times on 2026-07-30 alone.

**RC-2.** Five functions wrote `next_eligible_profile()` straight into `rotation_state` with no guard:
`set_my_availability` (leave branch), `claim_timed_quote`, `steal_timed_quote`, `claim_workload_turn`.
`pass_my_turn` instead raised `No eligible next agent`, so Pass failed outright for the
highest-positioned agent.

**RC-3.** Recovery from a NULL or ineligible pointer only ever happened inside
`set_my_availability('available')`, which fires only when an agent actively transitions to available.
`manager_set_rotation_eligibility` had its repair block inside `if not p_active then`, so **restoring**
an agent to a NULL rotation left it NULL forever; and even the remove branch was gated on
`v_next is not null and v_next <> p_profile_id`, so removing the only eligible agent left the rotation
pointing at the agent it had just made ineligible — a hard deadlock.

**RC-4.** `claim_ringcentral_intake` validated the queue turn but never consumed it
(`advance=0, turnEvents=0, lockRS=0`). See §5 — its entire call chain turned out to be dead code.

**RC-5.** `next_eligible_profile` had no `position IS NOT NULL` guard and no deterministic tiebreaker.

**RC-6.** Fifteen functions run in production with no `create function` definition anywhere in
`supabase/`, including the current `next_eligible_profile` variant itself. That is how a hand-edit to
the rotation engine went unnoticed.

---

## 3. Corrections to earlier findings

Recorded because the earlier analysis in `bugfix.md` overstated two items.

**The `_v094` drift is not a functional root cause.** The project steering note says patching the
unsuffixed functions "does not necessarily change what the UI actually executes". That is **false
here.** The live `_v094` RPCs are thin wrappers that delegate to the unsuffixed functions:

```sql
CREATE FUNCTION public.claim_whatsapp_quote_v094(...) ...
  perform public.validate_dealer_salesperson(p_dealer_id, p_salesperson_id, true);
  select * into v_item from public.claim_whatsapp_quote(p_customer_name, p_dealer_id, p_note);  -- delegates
  update public.work_items set salesperson_id = p_salesperson_id where id = v_item.id ...
```

`claim_ringcentral_quote_v094`, `claim_unlinked_workload_turn_v094` and `start_quote_take_timer_v094`
follow the same pattern. So `v1.8.5` did reach the UI path, and patching the unsuffixed functions is
the correct approach. The drift is a repo-completeness gap, not a behavioural one.

**Duplicate rotation positions are already impossible.** `bugfix.md` listed non-deterministic ordering
under duplicate positions as a live risk. It is not reachable: three partial unique indexes prevent it.

```
profiles_whatsapp_position_unique    ON profiles (whatsapp_position)    WHERE role='agent' AND is_active
profiles_ringcentral_position_unique ON profiles (ringcentral_position) WHERE role='agent' AND is_active
profiles_workload_position_unique    ON profiles (workload_position)    WHERE role='agent' AND is_active
```

The `p.id` tiebreaker was still added — it is free and makes the ordering total — but it fixes a
theoretical concern, not an observed one.

---

## 4. Files changed

### Database
| File | Change |
|---|---|
| `supabase/migrations/v1.8.7-fix-rotation-integrity.sql` | **new** — forward-only fix, applied to production |
| `supabase/migrations/v1.8.7-rollback.sql` | **new** — generated from the live bodies captured immediately pre-deploy |

No historical migration was edited.

### Application
| File | Change |
|---|---|
| `src/features/rotation/rotation-engine.ts` | **new** — executable specification of the corrected semantics |
| `src/features/rotation/rotation-actions.ts` | **new** — executable model of each queue action |
| `src/features/rotation/__tests__/rotation-bug-condition.test.ts` | **new** — 11 tests proving the defect |
| `src/features/rotation/__tests__/rotation-invariants.test.ts` | **new** — 47 invariant/transition tests |
| `src/features/rotation/__tests__/migration-sql-parity.test.ts` | **new** — 51 tests locking the SQL shape |

`rotation-engine.ts` and `rotation-actions.ts` are specifications, not runtime code. Nothing imports
them outside tests, and the header of each says so. The database remains the only authority for queue
state.

### Spec and tooling
`.kiro/specs/queue-rotation-integrity/` — `bugfix.md`, `design.md`, `tasks.md`, this report,
`diagnostics/production-queue-diagnostic.sql`, 11 scripts, and `evidence/` (live function dumps, audit
JSON, dry-run and post-deploy results).

---

## 5. Functions changed in production

| Function | Change |
|---|---|
| `next_eligible_profile(rotation_kind, integer)` | **RC-1 fix** — wraparound restored to `ORDER BY`, null-position guard, `id` tiebreaker |
| `pass_my_turn(rotation_kind, text)` | self-loop instead of `No eligible next agent`; repairs a stale pointer; revalidates after locking |
| `set_my_availability(availability_status)` | recovery on return; guarded advance on leave |
| `manager_set_rotation_eligibility(uuid, rotation_kind, boolean, text)` | **RC-3 fix** — repair on **both** branches |
| `claim_timed_quote(uuid)` | guarded advance |
| `steal_timed_quote(uuid)` | guarded advance; still advances from the **missed** agent's position |
| `advance_rotation(...)` | **new** — the single place a turn is consumed |
| `ensure_rotation_valid(...)` | **new** — idempotent self-healing |
| `is_rotation_eligible(uuid, rotation_kind)` | **new** — the one eligibility predicate |
| `rotation_position_of(uuid, rotation_kind)` | **new** |
| `rotation_empty_reason(rotation_kind)` | **new** — specific empty-queue diagnostics |

Deliberately **not** touched: the five claim functions `v1.8.5` already patched
(`claim_whatsapp_quote`, `claim_ringcentral_quote`, `claim_linked_workload_turn`,
`claim_unlinked_workload_turn`, `take_quote_turn`). Once the selector wraps correctly their existing
`coalesce(v_next, v_me.id)` simply stops being reachable. Also untouched:
`cs_intake_claim_ringcentral` (already the correct atomic flow), every manual/manager function, and
`ensure_daily_availability_reset`.

### RC-4 resolution

`cs_intake_claim_ringcentral` was audited against your six criteria and **already meets all of them**,
so no change was needed:

| Requirement | Status |
|---|---|
| Claims a `cs_intake_submissions` record | yes |
| Creates the normal quote/work item | yes, via `cs_intake_convert` |
| Assigns it to the current agent | yes |
| Advances the internal intake rotation | yes (`advance=1, turnEvents=1, lockRS=1`) |
| Prevents duplicate quotes and duplicate advancement | yes — returns early when already converted |
| Returns the existing result on retry | yes |

The live Intake Queue **already calls it**: `src/features/cs-intake/IntakeQueue.tsx:298` →
`claimRingcentralQueueIntake` → `cs_intake_claim_ringcentral`.

The broken `claim_ringcentral_intake` path is **dead code**:

- `customer_intakes` holds **0 rows, and always has** — `cs_intake_submissions` has all 12.
- `src/app/api/intakes/[id]/claim/route.ts` is referenced nowhere in the codebase.
- `src/features/quotes/api.ts::claimRingcentralIntake` is exported but never called.

Left in place for now rather than deleted: removing an API route and an exported function is a
separate cleanup, and the DB function is still named in `rls-role-enforcement.test.ts`. It is
unreachable from any UI, so it cannot consume or fail to consume a turn. Flagged as follow-up.

---

## 6. Tests run

### `npx vitest --run`
```
Test Files  21 passed (21)
     Tests  350 passed (350)
```
Baseline was 18 files / 241 tests. 109 new tests, none skipped, none filtered.

### `npx tsc --noEmit`
```
tsc errors: 4  (baseline = 4)
  1  src/features/cs-intake/__tests__/rc-claim-bug-condition.test.ts
  3  src/features/cs-intake/__tests__/rc-claim-preservation.test.ts
```
Exactly the pre-existing baseline errors from the earlier `rc-claim-duplicate-quote-fix` work. Zero
introduced. These are `fast-check` arbitraries missing newer `CsIntakeSubmission` fields, unrelated to
queue rotation.

### `npm run lint`
```
187 problems (58 errors, 129 warnings)
```
Identical to baseline. Zero introduced.

### `npm run build`
```
Exit Code: 0   (all routes compiled)
```

### Real-PostgreSQL scenario suite — 32/32
Ran inside a rolled-back transaction with the actual installed selector mirrored onto a temporary
table, so the logic under test was byte-identical to production:

```
[PASS] S1_WRAPAROUND_from_10_gives_A1     [PASS] S1_full_cycle_closes
[PASS] S1_from_1_gives_A2                 [PASS] S1_from_2_gives_A3
[PASS] S1_gap_from_5_gives_A3             [PASS] S1_beyond_highest_wraps
[PASS] S1_null_after_gives_lowest         [PASS] S1_never_null_pos_0_to_20
[PASS] S2_two_agents_from_1               [PASS] S2_two_agents_wrap_from_2
[PASS] S3_one_agent_self_loop             [PASS] S3_one_agent_never_null
[PASS] S4_all_unavailable_is_null         [PASS] S5_recovery_after_empty
[PASS] S6_null_position_never_selected    [PASS] S6_null_position_only_is_null
[PASS] S7_non_agents_never_selected       [PASS] S7_agent_selected_despite_lower_supervisor
[PASS] S8_inactive_never_selected         [PASS] S8_inactive_wrap_still_skips
[PASS] S9_whatsapp_picks_WaOnly           [PASS] S9_ringcentral_picks_RcOnly
[PASS] S9_workload_picks_WlOnly           [PASS] S9_each_rotation_wraps_to_its_own
[PASS] S10_deterministic_repeat           [PASS] S11_wraparound_in_order_by
[PASS] S11_position_NOT_in_where          [PASS] S11_helpers_installed
[PASS] S12_duplicate_positions_prevented  [PASS] S13_empty_reason_specific
[PASS] S13_empty_reason_not_generic       [PASS] S1_fixture_three_eligible

32/32 scenarios passed
Rollback verification: production data UNCHANGED
New functions persisted after rollback: 0
```

### Post-deploy verification — 10/10
See §1.

---

## 7. Queue transition table

Proven by the TypeScript action model (`rotation-invariants.test.ts`) plus the SQL scenario and
post-deploy suites. Rows marked *model* are verified against the executable specification, which the
parity suite ties to the deployed SQL.

| # | Action | Rotation consumed | Others unchanged | turn_events | Result |
|---|---|---|---|---|---|
| 1 | Take WhatsApp quote | whatsapp | verified | 1 | PASS (model) |
| 2 | Take RingCentral quote | ringcentral | verified | 1 | PASS (model) |
| 3 | Claim CS intake via queue | ringcentral | verified | 1 | PASS (model) |
| 4 | Linked Additional Workload | workload | verified | 1 | PASS (model) |
| 5 | Unlinked Additional Workload | workload | verified | 1 | PASS (model) |
| 6 | Pass (WhatsApp) | whatsapp | verified | 1 | PASS (model) |
| 7 | Pass (RingCentral) | ringcentral | verified | 1 | PASS (model) |
| 8 | Pass (Workload) | none — rejected | verified | 0 | PASS (model) |
| 9 | Pass, one eligible agent | self-loop, stays current | verified | 1 | PASS (model + live) |
| 10 | Claim timed quote | whatsapp | verified | 1 | PASS (SQL) |
| 11 | Recover timed quote | whatsapp, from missed agent | verified | 1 | PASS (parity + SQL) |
| 12 | Availability → unavailable | rotations held by actor | verified | 1 each | PASS (model + live) |
| 13 | Availability → available | null/invalid rotations | verified | 1 each | PASS (model + live) |
| 14 | Remove agent from rotation | that rotation only | verified | 1 if current | PASS (model + live) |
| 15 | Restore agent to rotation | that rotation only | verified | 1 if recovered | PASS (model) |
| 16 | Manual workload log | none | verified | 0 | PASS (model) |
| 17 | Manual quote / requote | none | verified | 0 | PASS (model) |
| 18 | Manager intake assign | none | verified | 0 | PASS (model) |
| 19 | Wraparound highest → lowest | that rotation only | verified | 1 | PASS (SQL + live) |

Every successful action writes exactly one `turn_events` row — asserted in
`rotation-invariants.test.ts`, in the parity suite (`advance_rotation` contains exactly one
`insert into public.turn_events`), and live (`one_turn_event_written`).

### Manual quote / requote preserved
Explicitly tested as a first-class parallel workflow, not a fallback. It creates the normal work item,
records the real source, requires no intake, does **not** require holding the turn, works when every
rotation is empty, moves no rotation, and stays distinguishable via
`assignment_method='manual_quote'` versus `'whatsapp_turn'`/`'ringcentral_turn'`/`'workload_turn'`.

---

## 8. Approved decisions as implemented

1. **Customer Service Intake Queue** — `cs_intake_claim_ringcentral` confirmed as the single
   authoritative atomic workflow; already wired to the live UI. No RingCentral API or external
   integration added. `ringcentral` kept as the internal key, with a header note in the migration and
   in `rotation-engine.ts` recording that it is a legacy label. User-facing strings from
   `rotation_empty_reason()` say "Customer Service Intake Queue".
2. **Agent-only rotations** — `ROTATION_ROLES = ['agent']`; the selector keeps `role = 'agent'`.
   Supervisors and managers retain view, monitor, manual-assign and override powers, and cannot hold a
   turn, influence next-agent, claim, or pass. Verified by `S7_non_agents_never_selected`.
3. **Pass self-loop** — the hard failure is removed. With one eligible agent, Pass records
   `previous = next = the agent`, keeps them current, bumps version once, writes one `pass` event, and
   returns *"Pass recorded, but you remain current because no other eligible agent is available."*
   Tests cover one agent, multiple agents, no eligible agents, another agent becoming eligible after a
   self-loop, and double-click.
4. **Dead root files** — pending, see §11. Reference search complete; deletion is a separate commit.

---

## 9. Production SQL you must run manually

**None.** `v1.8.7-fix-rotation-integrity.sql` is already applied and verified.

No data-repair SQL is needed. `ensure_rotation_valid()` heals each rotation on its next interaction,
which is why no `UPDATE` against `rotation_state` shipped in the migration.

Optional, read-only, any time:
```
.kiro/specs/queue-rotation-integrity/diagnostics/production-queue-diagnostic.sql
```
Section 5 should report `OK — wraparound implemented as an ORDER BY bucket`, section 6 zero `DEFECT`
rows, section 7 zero `VIOLATION` rows.

---

## 10. Data integrity

Row counts immediately before and after the production deploy:

```
before: profiles=39 work_items=309 turn_events=1515 take_events=11 intakes=12 outcomes=998 audit=1728
after : profiles=39 work_items=309 turn_events=1515 take_events=11 intakes=12 outcomes=998 audit=1728
Data integrity: all row counts unchanged.
```

The migration replaces functions and grants only. It contains no `INSERT`, `UPDATE`, `DELETE`,
`TRUNCATE`, `DROP TABLE` or `ALTER TABLE` — enforced by a pre-send guard in `apply-sql.mjs` and by the
parity test suite.

---

## 11. Remaining risks and follow-ups

1. **Not yet observed under real load.** Every rotation was empty at deploy time because all agents
   were offline. The first live claims will happen on the next shift. Watch `turn_events` for 24h:
   there should be zero rows where `next_profile_id IS NULL` while eligible agents exist, and zero
   where `previous_profile_id = next_profile_id` with more than one eligible agent.
2. **Frontend still shows the generic "No agent yet".** `rotation_empty_reason()` is deployed and
   returns specific text, but `work-desk-app.tsx` does not surface it yet. Database behaviour is
   correct; only the message is still vague. Not deployed as part of this fix.
3. **RC-6 repo drift is unresolved.** Fifteen functions still exist only in production. Until they are
   captured in `supabase/`, another silent hand-edit to the rotation engine is possible. The parity
   test now guards `next_eligible_profile` specifically, which is the highest-value target.
4. **`next_eligible_profile` retains its pre-existing `anon` EXECUTE grant.** Preserved deliberately so
   the migration changed no authorization surface, but an anonymous caller can enumerate eligible agent
   UUIDs. Worth revoking separately.
5. **Dead `claim_ringcentral_intake` chain still present** — see §5. Unreachable, but confusing.
6. **Dead root duplicates not yet deleted.** `IntakeQueue.tsx` and `CsIntakeLanding.tsx` at the repo
   root are confirmed unreferenced; every real import resolves to `@/features/cs-intake/*`. Deletion
   is queued as its own commit with a full validation pass.
7. **Model-verified rows in §7.** Rows 1–8 and 15–18 are proven against the executable model plus the
   SQL parity suite rather than by executing each RPC in production, because those RPCs depend on
   `auth.uid()` and would create real quotes. The parity suite is what ties the model to the deployed
   SQL; it is weaker than end-to-end execution and the 24h watch in item 1 is the compensating control.
8. **A passing build is not proof of queue correctness.** The evidence here is the 32/32 SQL scenario
   suite, the 10/10 post-deploy incident replay, and the live invariant audit — not the build.

---

## 12. Rollback

`supabase/migrations/v1.8.7-rollback.sql` is generated from the live bodies captured immediately
before deploy, and was dry-run validated (`DRY RUN PASSED`, all row counts unchanged).

It restores the six replaced functions, drops the five new helpers, and re-grants. It performs no data
statement, does not rewrite `rotation_state`, and destroys no quote, intake, work item or audit data.

```
node .kiro/specs/queue-rotation-integrity/scripts/apply-sql.mjs supabase/migrations/v1.8.7-rollback.sql --dry-run
node .kiro/specs/queue-rotation-integrity/scripts/apply-sql.mjs supabase/migrations/v1.8.7-rollback.sql --apply
```

Running it reintroduces RC-1. Only use it if v1.8.7 causes a worse problem.
