# Design: queue-rotation-integrity

Companion to `bugfix.md`. Describes the current architecture as measured against the live database, the
corrected state machine, and the transaction/locking strategy for the repair.

---

## 1. Current architecture

### 1.1 Data model

| Object | Role |
|---|---|
| `public.rotation_state` | One row per rotation keyed by `kind` (`whatsapp`, `ringcentral`, `workload`). Holds `current_profile_id`, `version`, `updated_at`, `updated_by`. The authoritative queue pointer. |
| `public.profiles` | Eligibility source: `is_active`, `availability`, `role`, and per-rotation `<r>_active` / `<r>_position`. |
| `public.turn_events` | Audit log. `action` constrained to `claim`, `pass`, `manual_change`, `auto_skip`, `daily_start`. |
| `public.quote_take_events` | Audit for the `take_quote_turn` (3-minute window) flow. |
| `public.quote_take_timers` | Rescue-timer rows: `rotation`, `current_profile_id`, `started_by_profile_id`, `claimed_by_profile_id`, `deadline_at`, `status`, `source_work_item_id`. |
| `public.daily_rotation_starts` | Records which agent started each rotation per business date. |
| `public.availability_day_state` | Singleton guarding the daily reset. |
| `public.cs_intake_submissions` | **Newer** CS intake system. |
| `public.customer_intakes` | **Older** CS intake system, still live. |

### 1.2 The rotation engine

Every advancement funnels through one selector:

```
next_eligible_profile(p_rotation rotation_kind, p_after_position integer) -> uuid
```

It is `LANGUAGE sql`, `STABLE`, `SECURITY DEFINER`, owner `postgres`. `profiles` has RLS enabled but not
forced, and the function owner owns the table, so the selector sees all rows.

**Live implementation is defective (RC-1):** the position comparison is a `WHERE` predicate rather than an
`ORDER BY` bucket, so it returns `NULL` whenever no eligible agent holds a position strictly greater than
`p_after_position`. See `bugfix.md` §1.

### 1.3 Call graph — what the UI actually executes

The UI calls `_v094` RPCs. Those are **thin wrappers** that delegate to the unsuffixed functions and then
attach `salesperson_id`. Patching the unsuffixed function therefore does change UI behavior.

```
work-desk-app.tsx
├── submitWhatsappQuote      → claim_whatsapp_quote_v094 ──────→ claim_whatsapp_quote ──────────┐
├── submitRingCentralQuote   → claim_ringcentral_quote_v094 ───→ claim_ringcentral_quote ───────┤
├── submitWorkloadTurn
│   ├── linked               → claim_linked_workload_turn ──────────────────────────────────────┤
│   └── unlinked             → claim_unlinked_workload_turn_v094 → claim_unlinked_workload_turn ┤
├── submitTakeQuote          → start_quote_take_timer_v094 ────→ start_quote_take_timer         │  (no advance)
├── claimTimedQuote          → claim_timed_quote ──────────────────────────────────────────────┤
├── recoverTimedQuote        → steal_timed_quote ──────────────────────────────────────────────┤
├── handlePass               → pass_my_turn ─────────────────────────────────────────────────── ┤
├── handleAvailability       → set_my_availability ───────────────────────────────────────────  ┤
│                                                                                              │
│                                                            all of the above ─────────────────┴──→ next_eligible_profile()
├── submitManualWorkload     → log_manual_workload            (must NOT advance)
├── submitManualQuote        → log_manual_quote_v094           (must NOT advance)
├── submitPayment            → log_payment_v094                (must NOT advance)
└── submitManagerAssigned*   → manager_create_and_assign_quote_v094 / log_manual_workload  (must NOT advance)

src/app/api/intakes/[id]/claim/route.ts
└── claim_ringcentral_intake        ← validates the RC turn but NEVER advances it (RC-4)

(correct but unused by that route)
    cs_intake_claim_ringcentral     ← atomic claim → convert → assign → advance → audit
```

`IntakeQueue.tsx` at the repository root is a stale duplicate of `src/components/work-desk-app.tsx`
(identical handlers at different line offsets). It is not imported by the app; the live component is
`src/components/work-desk-app.tsx`. Confirm and remove during implementation.

### 1.4 Measured rotation behavior per live function

`advance` = writes `rotation_state`; `lockRS` = takes `FOR UPDATE` on it; `coalesce` = has the v1.8.5 guard.

| Function | advance | nextElig | turnEvents | lockRS | coalesce | Assessment |
|---|---|---|---|---|---|---|
| `claim_whatsapp_quote` | 1 | 1 | 1 | 1 | 2 | sticks on self when selector returns NULL |
| `claim_ringcentral_quote` | 1 | 1 | 1 | 1 | 2 | sticks on self |
| `claim_linked_workload_turn` | 1 | 1 | 1 | 1 | 2 | sticks on self |
| `claim_unlinked_workload_turn` | 1 | 1 | 1 | 1 | 2 | sticks on self |
| `take_quote_turn` | 1 | 1 | 1 | 1 | 2 | sticks on self |
| `claim_workload_turn` | 1 | 1 | 1 | 1 | 0 | legacy; writes NULL |
| `pass_my_turn` | 1 | 1 | 1 | 1 | 0 | raises `No eligible next agent` |
| `claim_timed_quote` | 1 | 1 | 1 | 1 | 0 | writes NULL |
| `steal_timed_quote` | 1 | 1 | 1 | 1 | 0 | writes NULL |
| `set_my_availability` | 3 | 1 | 3 | 2 | 0 | writes NULL; sole recovery path |
| `cs_intake_claim_ringcentral` | 1 | 1 | 1 | 1 | 0 | correct shape, writes NULL on selector failure |
| `claim_ringcentral_intake` | **0** | **0** | **0** | **0** | 0 | **RC-4: validates turn, never consumes it** |
| `ensure_daily_availability_reset` | 1 | 0 | 0 | 0 | 0 | intentional daily null |
| `manager_set_rotation_eligibility` | 1 | 1 | 1 | 1 | 0 | RC-3: no recovery on restore |
| `manager_set_rotation_current` | 1 | 0 | 1 | — | 0 | manual override, intended |
| `cs_intake_claim`, `cs_intake_convert`, `cs_intake_manager_assign` | 0 | 0 | 0 | 0 | 0 | correct — must stay 0 |
| `log_manual_quote(_v094)`, `log_manual_workload`, `log_payment_v094`, `manager_create_and_assign_quote_v094` | 0 | 0 | 0 | 0 | 0 | correct — must stay 0 |

### 1.5 Frontend state flow

`src/components/work-desk-app.tsx`:

- Realtime: `postgres_changes` on `rotation_state` (and related tables) → `scheduleRefresh`.
- Fallback: periodic `refreshLiveData()` poll.
- Every mutation goes through `runRpc(name, args, msg)`, which awaits `refreshLiveData()` on both success
  and error before showing a toast. So the client never advances the rotation locally — invariant 14 is
  already satisfied. **The frontend is not a root cause.**
- Around line 6981 the UI derives `currentAgent` by matching `rotation_state.current_profile_id` against
  `agentList`, and renders `"No agent yet"` when it is null. It computes an `eligible` list but does not
  use it to explain *why* the queue is empty — the source of the undifferentiated message (AC-9).

---

## 2. Corrected state machine

### 2.1 Eligibility predicate (single definition, used everywhere)

An agent is **eligible** for rotation *r* when all hold:

```
is_active = true
availability = 'available'
role ∈ ROTATION_ROLES          -- see §2.2
<r>_active = true
<r>_position IS NOT NULL
```

This predicate must be defined once and reused by the selector, by the "is the current agent still
usable" check, and by the diagnostic. Today those three disagree (RC-5).

### 2.2 Role scope — decision required

The selector currently restricts to `role = 'agent'`, while `v1.8.6` made `sales_supervisor` a legitimate
intake claimer. Two options:

- **Option A (default, minimal):** keep `ROTATION_ROLES = {'agent'}`. Rotations stay agent-only;
  `sales_supervisor` participates only in manual/manager intake paths. Requires no data change.
- **Option B:** `ROTATION_ROLES = {'agent', 'sales_supervisor'}`. Broader, but changes who receives turns.

**Recommendation: Option A.** It preserves current production behavior and is not needed to fix any
observed defect. Live data supports it — the only `sales_supervisor` (Micaela Delgado) already has all
three rotation flags `false`. Option B is a product decision, not a bugfix, and is out of scope.

### 2.3 Selector contract

```sql
next_eligible_profile(p_rotation, p_after_position) -> uuid
```

- Returns the eligible agent with the smallest position **strictly greater than** `p_after_position`.
- If none exists, wraps and returns the eligible agent with the smallest position overall.
- If `p_after_position` is `NULL`, returns the eligible agent with the smallest position.
- Returns `NULL` **only** when the eligible set is empty.
- With exactly one eligible agent, always returns that agent (including when they are the current agent).
- Deterministic under duplicate positions via an `id` tiebreaker.

Implementation shape:

```sql
WHERE  <eligibility predicate §2.1>
ORDER BY
  case when <pos> > p_after_position then 0 else 1 end,   -- wraparound bucket
  <pos>,
  p.id                                                    -- deterministic tiebreak
LIMIT 1
```

Because the caller is normally itself eligible, the wraparound bucket makes invariants 9 and 10 structural.

### 2.4 Resolve-and-advance helper

To stop each call site from re-deriving advancement, introduce one internal function that owns the whole
transition. Every turn-consuming function calls it instead of `next_eligible_profile` + ad-hoc `UPDATE`.

```
advance_rotation(p_rotation, p_actor, p_after_position, p_action, p_work_item_id, p_reason)
  -> uuid   -- the new current_profile_id
```

Responsibilities, in order, inside the caller's transaction:

1. `SELECT ... FROM rotation_state WHERE kind = p_rotation FOR UPDATE` (serializes concurrent callers).
2. Resolve `v_next := next_eligible_profile(p_rotation, p_after_position)`.
3. If `v_next IS NULL` **and** the actor is still eligible → `v_next := p_actor` (invariant 10).
4. If `v_next IS NULL` and no eligible agent exists → write `NULL` (invariant 6) with an accurate reason.
5. `UPDATE rotation_state SET current_profile_id = v_next, version = version + 1, ...`.
6. Insert exactly one `turn_events` row (invariant/AC-12).
7. Return `v_next`.

Step 3 replaces the scattered `coalesce(v_next, v_me.id)`, and steps 1+6 guarantee one lock and one audit
row per transition.

### 2.5 Self-healing entry guard

To satisfy invariants 5 and 7 without a second queue engine, add one idempotent repair used at the start
of every rotation-reading action:

```
ensure_rotation_valid(p_rotation) -> uuid
```

1. Lock the `rotation_state` row.
2. If `current_profile_id` is not `NULL` and still eligible → return it unchanged.
3. If `current_profile_id` is `NULL` or ineligible:
   - resolve the next eligible agent (from the ineligible agent's position if known, else the lowest);
   - if one exists → assign it, bump `version`, log `auto_skip` with a precise reason;
   - if none exists → leave `NULL` (invariant 6).

Called from: `set_my_availability` (both branches), the claim functions, `pass_my_turn`,
`manager_set_rotation_eligibility` (**both** the remove and the restore branch — fixes RC-3), the
deactivate/reactivate path, and any position edit. This converts recovery from "whoever happens to click
Available" into a property of every queue interaction.

### 2.6 Transition matrix

`current` = the rotation's current agent. `E` = size of the eligible set **after** the change.

| Trigger | Precondition | Rotation(s) touched | Result | turn_events |
|---|---|---|---|---|
| WhatsApp claim | caller is current + eligible | whatsapp | advance once (wrap; self if E=1) | 1 `claim` |
| RingCentral claim | caller is current + eligible | ringcentral | advance once | 1 `claim` |
| CS intake claim (RC channel) | caller is current RC + eligible | ringcentral | claim+convert+assign+advance atomically | 1 `claim` |
| Linked workload claim | caller is current + eligible | workload | advance once | 1 `claim` |
| Unlinked workload claim | caller is current + eligible | workload | advance once | 1 `claim` |
| Pass (wa/rc) | caller is current + eligible | that rotation | advance once; self if E=1 | 1 `pass` |
| Pass (workload) | — | none | rejected by policy (unchanged) | 0 |
| Start rescue timer | caller eligible, not current | none | timer row only | 0 |
| Claim timed quote | caller is the timer's current agent | timer's rotation | advance from current's position | 1 `claim` |
| Recover timed quote | past deadline, caller ≠ current, eligible | timer's rotation | advance from **missed agent's** position | 1 `claim` |
| Availability → unavailable | caller holds turn(s) | each rotation the caller holds | advance; `NULL` only if E=0 | 1 per rotation |
| Availability → available | any rotation `NULL` or invalid and caller eligible | those rotations | recover to caller | 1 per recovered |
| Remove from rotation | target is current | that rotation only | advance; never leave on the removed agent | 1 `auto_skip` |
| Restore to rotation | that rotation is `NULL`/invalid | that rotation only | recover | 1 `auto_skip` |
| Deactivate agent | target is current | each rotation held | advance | 1 per rotation |
| Manager set current | manager override | that rotation only | set explicitly | 1 `manual_change` |
| Daily reset | business date rolled over | all three | `NULL` all (by design) | 0 (existing behavior) |
| Manual quote / workload / payment log | — | none | no rotation change | 0 |
| Manager create+assign, manager intake assign | — | none | no rotation change | 0 |

### 2.7 Null-state semantics and diagnostics (AC-9)

`NULL` must be reported with a reason instead of one generic string. Distinguish:

| Condition | Message |
|---|---|
| no agents enabled for this rotation | "No agents are assigned to this queue." |
| agents enabled but all unavailable | "All N queue agents are unavailable or on break." |
| agents available but all lack a position | "N agents are available but have no queue position set." |
| business-date reset, nobody back yet | "The queue resets daily. The first available agent starts it." |
| eligible agents exist but pointer is null | **internal error** — auto-repair fires and this must never render |

Derive this from data the dashboard already loads (`agentList` + `rotation_state`); no new RPC required.

---

## 3. Transaction and locking strategy

### 3.1 Ordering

All turn-consuming functions acquire locks in a fixed order to avoid deadlock:

```
1. profiles (the caller)            SELECT ... FOR UPDATE
2. the subject row                  intake / timer / related work item, FOR UPDATE
3. rotation_state (single kind)     SELECT ... FOR UPDATE
```

Never lock more than one `rotation_state` row in a turn-consuming function — that is what keeps rotations
independent (invariant 1). `set_my_availability` is the sole exception: it iterates all three and already
orders them deterministically with `ORDER BY kind FOR UPDATE`, which is safe because it is consistent.

### 3.2 Revalidate after locking

Current claim functions read the caller's profile, then lock `rotation_state`, then compare. Between those
two reads another transaction may have changed eligibility. After acquiring the `rotation_state` lock, each
function must re-assert:

- the caller is still active, available and rotation-enabled;
- `rotation_state.current_profile_id = caller`;
- the subject row is still in a claimable state.

### 3.3 Atomicity

Each RPC is a single transaction (PostgreSQL functions are atomic by default), so work-item creation,
intake conversion, rotation advancement and `turn_events` either all commit or all roll back — invariant 11.
The rule to enforce is **no new code path may create a work item and then advance the rotation in a
separate transaction.**

Note `claim_ringcentral_intake` uses `FOR UPDATE NOWAIT` on the intake and maps `lock_not_available` to
`ALREADY_LOCKED`. That is acceptable for idempotency but must be paired with the missing advancement.

### 3.4 Idempotency

- **Intake claims:** keyed on intake status. `cs_intake_claim_ringcentral` already returns the existing
  `work_item_id` when `status='converted'` and `claimed_by = caller`. Preserve exactly (AC-19).
- **Timed quotes:** keyed on `quote_take_timers.status`; a non-`active` timer rejects the second call.
- **Quote claims (WhatsApp/RingCentral/workload):** naturally guarded because the first commit moves the
  turn away, so the retry fails the `current_profile_id = caller` check. The one gap is a genuine
  double-submit where both requests read the pre-advance state; the `FOR UPDATE` in §3.1 serializes them so
  the second sees the advanced pointer and fails cleanly (AC-14, AC-15).

### 3.5 Stale-client rejection

`rotation_state.version` is already incremented on every transition but is never checked by callers. Turn
consumption is already protected by `current_profile_id = caller`, which is sufficient. Passing an expected
version from the client is **not** adopted — it would add a failure mode without closing a real gap, and
the client must not be a source of truth (invariant 14). Stale clients are handled by `refreshLiveData()`
after every action plus the realtime subscription and the periodic poll.

---

## 4. Sequence diagrams

### 4.1 Claim (WhatsApp; RingCentral and workload are identical modulo table/flags)

```
Agent          UI                        DB (single transaction)
 │             │                          │
 ├─ submit ───►│                          │
 │             ├─ rpc claim_whatsapp_quote_v094
 │             │                          ├─ validate_dealer_salesperson()
 │             │                          ├─ claim_whatsapp_quote()
 │             │                          │   ├─ is_agent()
 │             │                          │   ├─ ensure_daily_availability_reset()
 │             │                          │   ├─ LOCK profiles(caller)      FOR UPDATE
 │             │                          │   ├─ LOCK rotation_state(wa)    FOR UPDATE
 │             │                          │   ├─ ensure_rotation_valid('whatsapp')      ← NEW (§2.5)
 │             │                          │   ├─ revalidate caller eligible + is current ← NEW (§3.2)
 │             │                          │   ├─ INSERT work_items
 │             │                          │   ├─ add_quote_note_if_present()
 │             │                          │   └─ advance_rotation('whatsapp', ...)      ← NEW (§2.4)
 │             │                          │        ├─ next_eligible_profile()  (wraparound fixed)
 │             │                          │        ├─ if NULL and caller eligible → caller
 │             │                          │        ├─ UPDATE rotation_state (version+1)
 │             │                          │        └─ INSERT turn_events  ×1
 │             │                          └─ UPDATE work_items.salesperson_id
 │             │◄──── work_item ───────────┤ COMMIT
 │             ├─ refreshLiveData()        │
 │◄─ toast ────┤                          │
               │◄── realtime rotation_state change ─┤
```

Failure anywhere rolls back the whole transaction: no orphan quote, no consumed turn.

### 4.2 Pass

```
Agent → UI → pass_my_turn(rotation, reason)
                ├─ reject rotation = 'workload'            (unchanged policy)
                ├─ require non-empty reason
                ├─ LOCK profiles(caller) FOR UPDATE
                ├─ LOCK rotation_state(rotation) FOR UPDATE
                ├─ ensure_rotation_valid(rotation)
                ├─ require current_profile_id = caller     else "belongs to another agent"
                └─ advance_rotation(rotation, action='pass', reason=...)
                     ├─ next_eligible_profile()  → wraps
                     ├─ if NULL and caller eligible → caller   (AC-3; replaces the raise)
                     └─ INSERT turn_events ×1 with previous, next, actor, rotation, reason, timestamp
```

Change: the current `if v_next is null then raise 'No eligible next agent'` is removed. With one eligible
agent, Pass returns the turn to that agent rather than failing.

### 4.3 Recover (`steal_timed_quote`)

```
Agent → UI ("Recover") → steal_timed_quote(timer_id)
        ├─ LOCK quote_take_timers(id) FOR UPDATE
        ├─ require status = 'active'                    else "no longer active"
        ├─ require deadline_at <= now()                 else "current agent still has time"
        ├─ require caller <> timer.current_profile_id   else "use Take Timed Quote"
        ├─ require caller active + available + rotation-enabled
        ├─ LOCK rotation_state(timer.rotation) FOR UPDATE
        ├─ require rotation_state.current = timer.current_profile_id
        │                                               else "the queue moved"
        ├─ INSERT work_items (assigned to caller)
        ├─ UPDATE timers SET status/claimed_by/completed_at/source_work_item_id
        └─ advance_rotation(timer.rotation,
                            p_after_position = MISSED agent's position)  ← preserves the rule
             └─ INSERT turn_events ×1  (previous = missed agent, next = resolved)
```

The documented rule is that Recover consumes **only the missed agent's turn** and leaves the next queue
position intact. That is expressed by advancing from the *missed* agent's position, not the recoverer's —
which is what the live function already does. Preserve it and cover it with tests (AC-25). `claim_timed_quote`
is the same flow for the current agent, minus the deadline check.

### 4.4 Availability change

```
Agent → UI → set_my_availability(status)
              ├─ ensure_daily_availability_reset()
              ├─ LOCK profiles(caller) FOR UPDATE
              ├─ UPDATE profiles.availability = status
              │
              ├─ status = 'available':
              │    FOR each rotation ORDER BY kind FOR UPDATE:
              │      if caller enabled for it:
              │        ensure_rotation_valid(kind)      ← recovers NULL *or* invalid pointer
              │        if still NULL → assign caller, log daily_start | auto_skip
              │
              └─ status <> 'available':
                   FOR each rotation ORDER BY kind FOR UPDATE:
                     if current_profile_id = caller:
                       advance_rotation(kind, action='auto_skip',
                                        after_position = caller's position)
                       -- NULL only when the eligible set is truly empty,
                       -- and the logged reason then states the real count
```

### 4.5 Customer Service intake claim via RingCentral

Target flow (`cs_intake_claim_ringcentral`, already correct in shape):

```
Agent → UI → cs_intake_claim_ringcentral(submission_id)
              ├─ is_agent()
              ├─ LOCK profiles(caller) FOR UPDATE
              ├─ LOCK cs_intake_submissions(id) FOR UPDATE
              │    ├─ status='converted' && work_item_id && claimed_by=caller → RETURN existing  (AC-19)
              │    ├─ status='converted' && other agent  → raise "already converted"
              │    ├─ intake_channel <> 'ringcentral'    → raise "manual/manager assigned"  (AC-20)
              │    ├─ status='claimed' && claimed_by=caller && work_item_id IS NULL
              │    │      → recovery path for the old claim-only workflow            (AC-21)
              │    └─ status <> 'submitted'              → raise "no longer available"
              ├─ require caller available + ringcentral_active
              ├─ LOCK rotation_state('ringcentral') FOR UPDATE
              ├─ ensure_rotation_valid('ringcentral')
              ├─ require current_profile_id = caller
              ├─ UPDATE cs_intake_submissions → claimed   + cs_intake_events
              ├─ v_work_item_id := cs_intake_convert(id)   -- creates canonical work_items row
              ├─ UPDATE work_items SET assignment_method='ringcentral_turn',
              │                        received_through='RingCentral / Customer Service intake'
              ├─ INSERT work_item_events 'ringcentral_intake_claim_completed'
              └─ advance_rotation('ringcentral', ...)  → INSERT turn_events ×1
```

`claim_ringcentral_intake` (older `customer_intakes` system) must either advance the RingCentral turn the
same way or stop being reachable from a queue-consuming button. **Decision required — see §6.**

---

## 5. Realtime vs database responsibilities

| Concern | Owner |
|---|---|
| Deciding the next agent | **Database only**, inside `advance_rotation` in the caller's transaction |
| Persisting the queue pointer | `rotation_state` (`FOR UPDATE` before validate + advance) |
| Serializing concurrent claims | Row lock on the single `rotation_state` row |
| Audit | `turn_events` — exactly one row per transition |
| Detecting change | Realtime `postgres_changes` on `rotation_state` → `scheduleRefresh` |
| Guaranteed convergence | Periodic `refreshLiveData()` poll, plus an explicit refresh after every RPC |
| Explaining an empty queue | Client-side derivation from `agentList` + `rotation_state` (display only) |

The client must never write `rotation_state`, never precompute the next agent, and never cache a turn
decision across a refresh. `runRpc` already awaits `refreshLiveData()` on both paths, so a missed realtime
frame degrades to "slightly stale display", never to a wrong write.

If realtime is disconnected while the database advances correctly, the periodic refresh must still converge
(AC-17 / scenario coverage). That path needs a test, not a code change.

---

## 6. Open decisions to confirm before implementation

1. **RC-4 resolution.** Either (a) add the missing lock + advance + `turn_events` to
   `claim_ringcentral_intake`, or (b) repoint `src/app/api/intakes/[id]/claim/route.ts` at
   `cs_intake_claim_ringcentral` and retire the older path. (b) is cleaner but only valid if the
   `customer_intakes` system is genuinely superseded — that must be verified against live row counts and
   the Intake Queue UI before choosing. Do not assume.
2. **Role scope (§2.2).** Confirm Option A (agent-only rotations).
3. **Pass with one eligible agent.** Confirm returning the turn to the same agent is desired, versus
   keeping today's hard failure. §4.2 assumes return-to-self per invariant 10.
4. **Root `IntakeQueue.tsx` / `CsIntakeLanding.tsx`.** Confirm these root-level files are dead duplicates
   before deleting.

---

## 7. Migration plan (forward-only)

One new migration, `supabase/migrations/v1.8.7-fix-rotation-integrity.sql`. No historical migration is
edited. Contents, in order:

1. `next_eligible_profile` — restore the `ORDER BY` wraparound bucket, add `position IS NOT NULL`, add the
   `id` tiebreaker. **This single change fixes the primary defect.**
2. `advance_rotation(...)` — new internal helper (§2.4).
3. `ensure_rotation_valid(...)` — new idempotent repair (§2.5).
4. Rewrite the turn-consuming functions to call the helpers: `claim_whatsapp_quote`,
   `claim_ringcentral_quote`, `claim_linked_workload_turn`, `claim_unlinked_workload_turn`,
   `take_quote_turn`, `claim_workload_turn`, `pass_my_turn`, `claim_timed_quote`, `steal_timed_quote`,
   `set_my_availability`, `cs_intake_claim_ringcentral`.
5. `manager_set_rotation_eligibility` — call `ensure_rotation_valid` on **both** branches (RC-3).
6. RC-4 per the §6 decision.
7. Capture the live-only functions in the repo verbatim so `supabase/` stops drifting (RC-6): the four
   `_v094` wrappers, `start_quote_take_timer`, `claim_timed_quote`, `steal_timed_quote`,
   `log_manual_quote_v094`, `log_payment_v094`, `manager_create_and_assign_quote_v094`,
   `manager_set_rotation_eligibility`, `manager_set_rotation_current`, `validate_dealer_salesperson`,
   `claim_ringcentral_intake`. Re-declare them unchanged except where this spec changes them.
8. Re-`GRANT EXECUTE ... TO authenticated` after every `CREATE OR REPLACE`, preserving existing
   `REVOKE ... FROM public, anon`.

**No data-repair `UPDATE` is included.** Once `ensure_rotation_valid` is deployed, the first interaction
with each rotation self-heals. Section 9 of the deployment checklist verifies this rather than mutating
production state.

Rollback: a companion `v1.8.7-rollback.sql` that restores the prior function bodies from
`evidence/live-functions/`. It touches functions only — never `rotation_state`, `work_items`,
`cs_intake_submissions`, `customer_intakes`, `turn_events` or any audit table.
