# Bugfix: queue-rotation-integrity

Branch: `fix/queue-rotation-integrity`
Baseline commit: `09b9901` (`fix(queue): comprehensive queue system fixes v1.8.6`)
Audit performed: 2026-07-31, against the live Supabase project via the Management API (read-only).

> **Status: FIXED AND DEPLOYED.** `v1.8.7-fix-rotation-integrity.sql` applied to production
> 2026-07-31 ~03:50 UTC. Verified by a 10/10 post-deploy replay of the original incident and a
> zero-violation live invariant audit. See `evidence-report.md`.
>
> **Two findings below were later corrected** — read `evidence-report.md` §3 before relying on §3 here:
> 1. The `_v094` drift is **not** a functional root cause. Those RPCs are thin wrappers that delegate
>    to the unsuffixed functions, so `v1.8.5` did reach the UI path.
> 2. Duplicate rotation positions are **already impossible** — three partial unique indexes prevent
>    them for active agents. The non-determinism risk was theoretical, not live.

---

## 1. Headline finding

The live `public.next_eligible_profile()` function **is not the function in this repository**. Production
carries an undocumented variant that **lost queue wraparound** by moving the position comparison from the
`ORDER BY` clause into the `WHERE` clause.

```sql
-- REPOSITORY (v0.4.0, v0.6.0, supabase/schema.sql) — wraparound works
WHERE  <eligibility predicates only>
ORDER BY
  case when <pos> > p_after_position then 0 else 1 end,   -- prefer "after me", else wrap
  <pos>
LIMIT 1

-- LIVE PRODUCTION — wraparound destroyed
WHERE  <eligibility predicates>
  AND  <pos> > p_after_position          -- ← hard filter, not a sort key
ORDER BY <pos>
LIMIT 1
```

The repository version can only return `NULL` when the eligible set is empty. The live version returns
`NULL` whenever **no eligible agent holds a position strictly greater than the current agent's position** —
even when eligible agents exist at lower positions.

This single divergence is the root cause of the intermittent "No agent available".

Evidence file: `evidence/live-functions/next_eligible_profile_p_rotation_rotation_kind__p_after_position_integer_.sql`

---

## 2. Current behavior (observed, not inferred)

### 2.1 Live probe of the rotation engine

`next_eligible_profile` is declared `STABLE`, so it was called directly with no writes
(`scripts/probe-next-eligible.mjs`). Result across all three rotations and every position 1–15:

```
whatsapp:    1->NULL 2->NULL 3->NULL 4->NULL 5->NULL ... 15->NULL
ringcentral: 1->NULL 2->NULL 3->NULL 4->NULL 5->NULL ... 15->NULL
workload:    1->NULL 2->NULL 3->NULL 4->NULL 5->NULL ... 15->NULL
after_position = NULL -> NULL on all three
```

### 2.2 Production was in a violating state during the audit

`scripts/live-audit.mjs` → `evidence/live-audit.json`:

| rotation | current_profile_id | eligible agents | verdict |
|---|---|---|---|
| whatsapp | `null` | 1 | **VIOLATION: null current agent but eligible agents exist** |
| ringcentral | `null` | 1 | **VIOLATION: null current agent but eligible agents exist** |
| workload | Estefania Bayas | 1 | OK |

The single eligible agent at that moment was Estefania Bayas — `is_active=true`,
`availability='available'`, `whatsapp_active=true`, `ringcentral_active=true`, `workload_active=true`,
positions `5/5/5`. She was eligible for all three rotations, yet held only workload.

WhatsApp `version=873`, RingCentral `version=401`, both stamped `2026-07-31 00:30:30.399646+00`.

### 2.3 The exact production event sequence that produced it

From `public.turn_events` (`evidence/live-audit.json` → `turn_events`):

```
00:31:13  workload     auto_skip  actor=Mauricio Plaza  prev=Mauricio Plaza  next=Estefania Bayas  null=False  "Agent became unavailable"
00:30:30  ringcentral  auto_skip  actor=Miguel Leiva    prev=Miguel Leiva    next=<NULL>           null=True   "Agent became unavailable and no eligible agent is currently available"
00:30:30  whatsapp     auto_skip  actor=Miguel Leiva    prev=Miguel Leiva    next=<NULL>           null=True   "Agent became unavailable and no eligible agent is currently available"
00:30:07  ringcentral  auto_skip  actor=Pablo Teran     prev=Pablo Teran     next=Miguel Leiva     null=False  "Agent became unavailable"
```

Two calls to the same function, 43 seconds apart, produced opposite outcomes:

- **00:30:30** — Miguel Leiva went unavailable. His WhatsApp/RingCentral position is **8**.
  `next_eligible_profile('whatsapp', 8)` requires `position > 8`. Positions 9, 10, 11 (Maria Zumarraga,
  Maria Trujillo, Juliana Abrego) were all unavailable. Estefania at position **5** was skipped because
  `5 > 8` is false. Result `NULL`. The rotation was nulled and the message claimed no eligible agent
  existed. **That claim was false.**
- **00:31:13** — Mauricio Plaza went unavailable. His workload position is **3**.
  `next_eligible_profile('workload', 3)` requires `position > 3`. Estefania at position **5** satisfied it.
  Result: correct handoff.

Workload survived purely because the departing agent sat at a *lower* position than the remaining
eligible agent. The rotation engine is position-order dependent in a way it must not be.

The same signature appears earlier in the log:

```
21:29:50  whatsapp  auto_skip  actor=Juliana Abrego  next=<NULL>  "…no eligible agent is currently available"
```

Juliana Abrego holds WhatsApp position **11** — the highest position in the roster. Any departure from the
last position nulls the rotation unconditionally.

### 2.4 The second symptom: the turn sticks on one agent

`v1.8.5-fix-rotation-null-on-claim.sql` wrapped the claim functions in
`coalesce(v_next, v_me.id)`. With the broken `next_eligible_profile`, the highest-positioned agent's claim
resolves `v_next = NULL`, so `coalesce` re-assigns the turn **back to the claimer**. The rotation never
advances. Live proof:

```
22:55:29  workload  claim  actor=Miguel Leiva  prev=Miguel Leiva  next=Miguel Leiva
```

`previous_profile_id == next_profile_id`. The turn was consumed and handed straight back. So the two
reported symptoms — "stuck showing No agent available" and "the queue stops moving" — are the same
defect expressed through two different call sites.

### 2.5 Managers have been manually repairing this

`turn_events.action = 'manual_change'`, reason `"Manager changed rotation from Overview"`, appears
repeatedly on 2026-07-30 — 20:15, 20:27, 21:31 (×2), 22:02, 22:54, 22:56. Managers are compensating for
the defect by hand, which is exactly the behavior invariant 7 forbids.

### 2.6 "No agent available" is database state, not stale UI

`rotation_state.current_profile_id` is genuinely `NULL` in production. This is **not** a display-only or
stale-realtime problem. The frontend is faithfully rendering broken database state.

---

## 3. Root causes

### RC-1 — `next_eligible_profile` lost wraparound (primary)

**Where:** live `public.next_eligible_profile(rotation_kind, integer)`. Not present in any repository file.

The position comparison is a `WHERE` predicate instead of an `ORDER BY` bucket. Breaks invariants 3, 9 and 10:

- **Invariant 9 (wraparound)** — the highest position never wraps to the lowest.
- **Invariant 10 (single agent)** — one eligible agent at position *p* can never be returned, because
  `p > p` is false. A solo agent's rotation nulls or sticks on every action.
- **Invariant 3 (never null while eligible agents exist)** — violated whenever remaining eligible agents
  all sit at lower positions.

**Why safeguards failed:** `v1.8.5`'s `coalesce(v_next, v_me.id)` treated `NULL` as "nobody is available"
and papered over it by re-assigning the claimer. It addressed the symptom at 5 call sites while the
defective selector stayed in place, and it left the 5 other call sites that write `NULL` untouched.

### RC-2 — `NULL` is written into `rotation_state` without a guard

These live functions assign `next_eligible_profile()` straight into `rotation_state.current_profile_id`
with no re-validation and no fallback (`coalesce` count = 0):

| function | behavior on `v_next = NULL` |
|---|---|
| `set_my_availability` (non-available branch) | writes `NULL`, logs a misleading reason |
| `claim_timed_quote` | writes `NULL` |
| `steal_timed_quote` | writes `NULL` |
| `claim_workload_turn` | writes `NULL` |
| `pass_my_turn` | raises `No eligible next agent` — Pass fails outright for the last-positioned agent |

`pass_my_turn` therefore violates invariant 10 from the opposite direction: with one eligible agent it
throws instead of returning the turn to that agent.

### RC-3 — No automatic recovery from a `NULL` or invalid current agent

`set_my_availability('available')` is the **only** path in the entire system that can un-null a rotation,
and it only fires when an agent actively transitions to available. An agent who is *already* available
never triggers it. Consequences:

- **`manager_set_rotation_eligibility(p_active => true)` (restore) has no recovery logic at all.** The
  repair block is inside `if not p_active then`. Restoring the only eligible agent to a `NULL` rotation
  leaves it `NULL` indefinitely.
- **`manager_set_rotation_eligibility(p_active => false)` (remove) repairs only conditionally:**
  ```sql
  if v_next is not null and v_next <> p_profile_id then  -- else: no repair at all
  ```
  When `v_next` is `NULL` the rotation is left pointing at the agent who was just made ineligible. That is
  a hard deadlock: every other agent gets *"This turn belongs to another agent"*, and the current agent
  gets *"You are paused from the queue"*. Nobody can act.
- Deactivating an agent and editing rotation positions have no recovery path either.

Breaks invariants 5 and 7.

### RC-4 — `claim_ringcentral_intake` validates the RingCentral turn but never consumes it

`src/app/api/intakes/[id]/claim/route.ts` calls `claim_ringcentral_intake`. Measured against the live
body (`evidence/live-functions/`):

```
claim_ringcentral_intake      advance=0  nextElig=0  turnEvents=0  lockRS=0
cs_intake_claim_ringcentral   advance=1  nextElig=1  turnEvents=1  lockRS=1
```

`claim_ringcentral_intake` reads `rotation_state` **without `FOR UPDATE`**, enforces
`NOT_YOUR_TURN`, creates the quote via `_create_quote_from_intake`, and then **never advances the rotation
and never writes a `turn_events` row**. The claiming agent stays current and receives every subsequent
RingCentral intake. Breaks invariants 8 and 11 and the "one `turn_events` row per action" requirement.

`cs_intake_claim_ringcentral` (from `v1.0.1-fix-ringcentral-intake-claim.sql`) implements the correct
atomic claim → convert → assign → advance → audit sequence, but the API route does not call it.

**Two parallel intake systems are live simultaneously:**

| system | table | claim function | advances RC turn |
|---|---|---|---|
| newer | `public.cs_intake_submissions` | `cs_intake_claim_ringcentral` | yes |
| older | `public.customer_intakes` | `claim_ringcentral_intake` | **no** |

### RC-5 — Eligibility is defined inconsistently and unsafely

`next_eligible_profile` (live and repo) has:

- **No `position IS NOT NULL` guard.** A `NULL` position sorts last but remains selectable, so an agent
  with no valid position can become the current agent. Breaks invariant 4.
- **No deterministic tiebreaker.** Duplicate positions produce an unspecified `ORDER BY`.
  **CORRECTED:** this is not reachable in practice. Three partial unique indexes
  (`profiles_<rotation>_position_unique ... WHERE role='agent' AND is_active`) already prevent duplicate
  positions for active agents. The `p.id` tiebreaker was still added because it is free and makes the
  ordering total, but it addresses a theoretical concern rather than an observed one.
- **`role = 'agent'` only.** `v1.8.6-fix-queue-system-comprehensive.sql` made `sales_supervisor` a
  legitimate intake claimer, but the rotation selector cannot return one. A `sales_supervisor` holding a
  turn is treated as unusable by `set_my_availability`'s `v_current_usable` check, which repeats the same
  `role = 'agent'` filter and also omits the position check.

Live roster confirms the risk: `Micaela Delgado` is `sales_supervisor` with positions `14/14/14` and all
three rotation flags `false`.

### RC-6 — Repo/live drift (documentation defect, not a runtime defect)

These functions run in production but have **no `create function` definition anywhere in `supabase/`**:

`claim_whatsapp_quote_v094`, `claim_ringcentral_quote_v094`, `claim_unlinked_workload_turn_v094`,
`start_quote_take_timer_v094`, `log_manual_quote_v094`, `log_payment_v094`,
`manager_create_and_assign_quote_v094`, `start_quote_take_timer`, `claim_timed_quote`,
`steal_timed_quote`, `claim_ringcentral_intake`, `manager_set_rotation_eligibility`,
`manager_set_rotation_current`, `validate_dealer_salesperson`, `next_eligible_profile` (current variant).

**Correction to a prior assumption.** The project steering note states that patching the unsuffixed
functions "does not necessarily change what the UI actually executes". That is **not true here.** The live
`_v094` functions are thin wrappers that delegate to the unsuffixed functions and then attach
`salesperson_id`:

```sql
CREATE OR REPLACE FUNCTION public.claim_whatsapp_quote_v094(...)
...
  perform public.validate_dealer_salesperson(p_dealer_id, p_salesperson_id, true);
  select * into v_item
  from public.claim_whatsapp_quote(p_customer_name, p_dealer_id, p_note);   -- ← delegates
  update public.work_items set salesperson_id = p_salesperson_id where id = v_item.id
  returning * into v_item;
  return v_item;
```

`claim_ringcentral_quote_v094`, `claim_unlinked_workload_turn_v094` and `start_quote_take_timer_v094`
follow the identical pattern. So `v1.8.5` **did** reach the UI code path. Patching the unsuffixed
functions is the correct approach and remains so for the real fix. The drift is a repo-completeness
problem, not a functional one, and must not be cited as a root cause.

---

## 4. Expected behavior

Mandatory invariants (from `.kiro/steering/queue-rotation.md`, restated as acceptance criteria in §6).

1. Each rotation is independent; an action in one must not alter the other two.
2. At most one current agent per rotation.
3. If ≥1 eligible agent exists, `current_profile_id` must not be `NULL`.
4. The current agent must be active, available, enabled for that rotation, and hold a non-null position.
5. If the current agent becomes ineligible, the rotation advances automatically.
6. With zero eligible agents, `NULL` ("No agent available") is valid.
7. When the first eligible agent appears after a zero-agent state, the rotation recovers automatically —
   no manual manager repair.
8. A completed queue-consuming action advances to the next eligible agent by that rotation's position.
9. Order wraps from the highest position back to the lowest.
10. With exactly one eligible agent, a completed action leaves that agent current. Never `NULL`.
11. Claim, conversion, advancement and event logging are atomic.
12. Retries and double-clicks are idempotent.
13. Simultaneous claims are serialized; only one caller consumes a turn.
14. Realtime/refresh may display state; the client must never be an alternative source of advancement.

### Corrected selector semantics

```sql
WHERE  is_active
  AND  role IN (<rotation-eligible roles>)
  AND  availability = 'available'
  AND  <rotation>_active
  AND  <rotation>_position IS NOT NULL          -- RC-5
ORDER BY
  case when <pos> > p_after_position then 0 else 1 end,   -- RC-1: wraparound as a sort key
  <pos>,
  id                                            -- RC-5: deterministic tiebreaker
LIMIT 1
```

Returns `NULL` **only** when the eligible set is empty. That makes invariants 3, 9 and 10 structural
rather than patched at each call site.

---

## 5. Unchanged behavior (explicit non-goals)

- **Workload Pass stays disabled.** `pass_my_turn` rejects `p_rotation = 'workload'`, and
  `work-desk-app.tsx` blocks it client-side with a matching message. This is consistent product policy, not
  a defect. It will not be silently changed.
- **Manual logging must not move any rotation:** `log_manual_quote`, `log_manual_workload`,
  `log_payment_v094`, `manager_create_and_assign_quote_v094`. Verified `advance=0` today; must stay 0.
- **Manager/manual intake assignment must not consume the RingCentral turn:** `cs_intake_manager_assign`,
  `cs_intake_claim`, `cs_intake_convert`, `assign_customer_intake`. Verified `advance=0` today.
- **Reassignment/void must not move rotations:** `workload_reassign`, `workload_void`.
- **The daily reset intentionally nulls all three rotations.** `ensure_daily_availability_reset()` sets
  every agent to `unavailable` and clears all rotations at the business-date rollover. This is by design
  and is preserved; recovery must then come from invariant 7, not from a manager.
- RLS, role authorization, and super_admin/manager parity are preserved.
- No historical migration is edited. All database changes ship as a new forward-only migration.

---

## 6. Acceptance criteria

### Selector

- **AC-1** `next_eligible_profile` returns a non-null id whenever ≥1 eligible agent exists, for every
  `p_after_position` in 1..N and for `NULL`.
- **AC-2** Wraparound: current agent at the highest position advances to the lowest-positioned eligible agent.
- **AC-3** Single eligible agent at position *p*: `next_eligible_profile(kind, p)` returns that agent.
- **AC-4** Agents with `NULL` position are never selected.
- **AC-5** Duplicate positions resolve deterministically and identically across repeated calls.

### Invariants

- **AC-6** After every action in the §7 matrix, no rotation is `NULL` while an eligible agent exists.
- **AC-7** After every action, the current agent is active, available, rotation-enabled, non-null position.
- **AC-8** Every action touches exactly one rotation; the other two keep their `current_profile_id` **and**
  `version`.
- **AC-9** Zero eligible agents → `NULL` is accepted and the UI states *why*, not a generic message.
- **AC-10** A rotation at `NULL` recovers automatically when any eligible agent becomes available,
  is restored to the rotation, is reactivated, or is given a valid position — with no manager action.
- **AC-11** Removing the current agent from a rotation never leaves the rotation pointing at them.

### Atomicity and concurrency

- **AC-12** Each queue-consuming action writes exactly **one** `turn_events` row.
- **AC-13** No quote/work item exists without its intended turn transition, and no turn is consumed
  without its work item. Verified by asserting rollback on injected failure.
- **AC-14** Two simultaneous claims: exactly one succeeds, the rotation advances once, one `turn_events` row.
- **AC-15** Double-click / browser retry is idempotent: no duplicate work item, no second advance.
- **AC-16** Claim vs Pass and Claim vs availability-change submitted together serialize safely.
- **AC-17** A stale client acting on an outdated `version` is rejected with a clear message.

### Customer Service intake

- **AC-18** A RingCentral-channel intake claim atomically claims, converts, assigns, marks the assignment
  as a RingCentral turn, advances RingCentral once, and writes intake + work-item + turn audit rows.
- **AC-19** A retry after a successful intake claim returns the existing work item and does not advance again.
- **AC-20** Manager/manual intake assignment does not consume the RingCentral turn.
- **AC-21** An intake left `claimed` but unconverted by the older workflow is recoverable without a duplicate quote.

### Timed / Recover

- **AC-22** Recover is permitted only for the authorized agent, only after the deadline.
- **AC-23** Recover creates no duplicate work item and consumes no turn twice.
- **AC-24** Expired, already-claimed and unauthorized Recover attempts fail with distinct, safe errors.
- **AC-25** The queue position after Recover matches the documented rule and does not reset the normal queue.

---

## 7. Queue transition matrix to be proven (Phase 5)

Result column stays empty until Phase 5 executes. No row may be marked passing without command output.

| # | Action | Rotation consumed | Others unchanged | turn_events rows | Result |
|---|---|---|---|---|---|
| 1 | Take WhatsApp quote | whatsapp | rc, workload | 1 | |
| 2 | Take RingCentral quote | ringcentral | wa, workload | 1 | |
| 3 | Claim CS intake via RingCentral | ringcentral | wa, workload | 1 | |
| 4 | Take linked Additional Workload | workload | wa, rc | 1 | |
| 5 | Take unlinked Additional Workload | workload | wa, rc | 1 | |
| 6 | Pass (WhatsApp) | whatsapp | rc, workload | 1 | |
| 7 | Pass (RingCentral) | ringcentral | wa, workload | 1 | |
| 8 | Pass (Workload) | none — rejected by policy | all | 0 | |
| 9 | Start timed/rescue quote | none | all | 0 | |
| 10 | Claim timed quote | whatsapp | rc, workload | 1 | |
| 11 | Recover timed quote | whatsapp | rc, workload | 1 | |
| 12 | Change availability → unavailable | all held by actor | — | 1 per rotation held | |
| 13 | Change availability → available (recovery) | all null+eligible | — | 1 per rotation recovered | |
| 14 | Pause agent (rotation removal) | affected rotation only | others | 1 if current | |
| 15 | Restore agent to rotation | affected rotation only if null | others | 1 if recovered | |
| 16 | Manual workload log | none | all | 0 | |
| 17 | Manual quote log | none | all | 0 | |
| 18 | Manager intake assign | none | all | 0 | |
| 19 | Manager create+assign quote | none | all | 0 | |

## 8. Scenario coverage required (Phase 3 harness)

One / two / three eligible agents · position gaps · duplicate positions · null position · current agent
unavailable · current agent inactive · current agent disabled for that rotation only · all agents
unavailable · one agent returning after all were unavailable · last position wrapping to first ·
`current_profile_id` null with eligible agents · `current_profile_id` pointing at an ineligible agent ·
two simultaneous claims · claim + pass · claim + availability change · two tabs double-clicking ·
stale frontend after another client advanced · CS intake via RingCentral · CS intake browser retry ·
intake claimed under the former workflow but unconverted · manager-assigned intake · timed quote claim ·
Recover by authorized agent · Recover by unauthorized agent · Recover after another agent claimed ·
realtime disconnected while the database advances · 60-second fallback refresh after a missed event.

---

## 9. Evidence index

| Path | Contents |
|---|---|
| `scripts/live-audit.mjs` | Read-only catalog + state audit (15 queries, write-keyword guard) |
| `scripts/live-audit2.mjs` | Manager functions, business date, day state, eligibility snapshot |
| `scripts/live-audit3.mjs` | `audit_log` eligibility-change history, timer columns |
| `scripts/probe-next-eligible.mjs` | Direct `STABLE` probe of the selector, all rotations × positions |
| `scripts/decompose-eligibility.mjs` | Predicate-by-predicate decomposition, RLS/owner posture |
| `evidence/live-audit*.json` | Raw captured results |
| `evidence/live-functions/*.sql` | 29 live `pg_get_functiondef` dumps |
| `scripts/validate-diagnostic.mjs` | Executes every diagnostic statement live; 25/25 pass |
| `diagnostics/production-queue-diagnostic.sql` | Read-only script for the Supabase SQL Editor |
| `evidence/validation-baseline.md` | Pre-implementation tsc / lint / vitest baseline and tooling notes |

Reproduce with:

```
node .kiro/specs/queue-rotation-integrity/scripts/live-audit.mjs
node .kiro/specs/queue-rotation-integrity/scripts/probe-next-eligible.mjs
```

`supabase_migrations.schema_migrations` does not exist in this project, so applied-migration history
cannot be read from the database. Migration ordering was reconstructed from `supabase/migrations/`
filenames and verified by comparing live function bodies against each candidate definition.

---

## 10. Function-version table

`repo latest` = last repository file defining the function. `matches live?` compares behavior.

| Function | Introduced | Later redefinitions | Repo latest | Live? | Matches live? |
|---|---|---|---|---|---|
| `next_eligible_profile` | v0.4.0 | v0.6.0, schema.sql | v0.6.0 | yes | **NO — live lost wraparound (RC-1)** |
| `set_my_availability` | v0.4.0 | v0.6.0, v0.7.2, v0.7.4, schema.sql | v0.7.4 | yes | yes (byte-identical) |
| `pass_my_turn` | v0.4.0 | v0.6.0, v0.9.3, schema.sql | v0.9.3 | yes | yes |
| `ensure_daily_availability_reset` | v0.7.2 | v0.7.4, v0.9.8, schema.sql | v0.9.8 | yes | to confirm |
| `claim_whatsapp_quote` | v0.4.0 | v0.6.0, v0.7.4, v0.8.0, v1.8.5, schema.sql | v1.8.5 | yes | yes |
| `claim_ringcentral_quote` | v0.4.0 | v0.6.0, v0.7.4, v0.8.0, v1.8.5 | v1.8.5 | yes | yes |
| `claim_linked_workload_turn` | v0.7.4 | v0.8.0, v0.9.3, v1.8.5 | v1.8.5 | yes | yes |
| `claim_unlinked_workload_turn` | v0.8.0 | v1.8.5 | v1.8.5 | yes | yes |
| `claim_workload_turn` | v0.4.0 | v0.6.0 | v0.6.0 | yes | legacy, still callable |
| `take_quote_turn` | v0.8.0 | v1.8.5 | v1.8.5 | yes | yes |
| `cs_intake_claim_ringcentral` | v1.0.1 | — | v1.0.1 | yes | yes |
| `cs_intake_claim` | v1.8.6 | — | v1.8.6 | yes | yes |
| `cs_intake_convert` | earlier | v1.8.6 | v1.8.6 | yes | yes |
| `cs_intake_manager_assign` | v1.0.1 | v1.8.6 | v1.8.6 | yes | yes |
| `claim_ringcentral_intake` | v1.0.0-fn | v1.3.5 | v1.3.5 | yes | yes — **but never advances RC (RC-4)** |
| `claim_whatsapp_quote_v094` | — | — | **absent** | yes | wrapper, repo gap (RC-6) |
| `claim_ringcentral_quote_v094` | — | — | **absent** | yes | wrapper, repo gap |
| `claim_unlinked_workload_turn_v094` | — | — | **absent** | yes | wrapper, repo gap |
| `start_quote_take_timer` / `_v094` | — | — | **absent** | yes | repo gap |
| `claim_timed_quote` | — | — | **absent** | yes | repo gap, writes NULL (RC-2) |
| `steal_timed_quote` | — | — | **absent** | yes | repo gap, writes NULL (RC-2) |
| `manager_set_rotation_eligibility` | — | — | **absent** | yes | repo gap, no restore recovery (RC-3) |
| `manager_set_rotation_current` | — | — | **absent** | yes | repo gap |
| `log_manual_quote_v094` / `log_payment_v094` / `manager_create_and_assign_quote_v094` | — | — | **absent** | yes | repo gap, correctly non-advancing |

`supabase/schema.sql` is **older** than later migrations for `claim_*` and `pass_my_turn` and was not
treated as authoritative.
