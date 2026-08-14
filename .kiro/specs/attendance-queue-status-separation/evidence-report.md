# Evidence Report — Attendance / Queue Status Separation

Spec: `.kiro/specs/attendance-queue-status-separation/`
Branch: `fix/attendance-queue-status-sync` (created off `feature/sales-reporting-center` @ `a3290ef`)
Supabase project: `kfbgftkjvtynfdwgcgeb`
All queries in this task were `SELECT` only. No migration was applied and no schema was modified.

---

## Task 1 — Live definition audit

### Status: COMPLETE, WITH A STOP CONDITION TRIGGERED

The task's stop condition fired. A live writer of `profiles.availability` exists that `design.md` does not
account for: **`public.admin_deactivate_profile(uuid, uuid, text)`**. Details in
[§ 1.4](#14-stop-condition-a-third-live-writer-of-profilesavailability). Tasks 4–7 should not be authored
until that finding is resolved.

A second, softer finding also changes what task 4.4 must be written from: the live
`ensure_daily_availability_reset()` is **not** the `supabase/schema.sql` (~1710) body the design points at.
It is the `v0.9.8-stabilize-integrations.sql` body, and it does three things the schema.sql body does not.
Details in [§ 1.3](#13-material-drift-ensure_daily_availability_reset).

### Artifacts produced

| Path | Contents |
|---|---|
| `evidence/live-functions/*.sql` | 10 live `pg_get_functiondef` bodies, one file each, with a capture header |
| `evidence/live-functions/_index.json` | signature, language, `security definer`, byte length per function |
| `evidence/repo-functions/*.sql` | the repo definition each live body was compared against |
| `evidence/live-vs-repo-diff.json` | normalized line diffs, live vs repo, per function |
| `evidence/live-availability-scan.json` | every `public` function whose body mentions `availability`, classified; enums; absence checks |
| `scripts/dump-live-functions.mjs` | read-only dumper (re-runnable) |
| `scripts/scan-availability-writers.mjs` | read-only scanner (re-runnable) |
| `scripts/diff-live-vs-repo-functions.mjs` | local extractor + differ, touches no database |

---

## 1.1 Live bodies dumped

All ten requested functions exist in live `public`. None were missing.

| Function | Signature | Lang | SecDef | Bytes |
|---|---|---|---|---|
| `advance_rotation` | `p_rotation rotation_kind, p_actor uuid, p_after_position integer, p_action text, p_previous uuid, p_fallback uuid, p_work_item_id uuid, p_reason text` | plpgsql | yes | 1979 |
| `can_manage_sales` | `()` | sql | yes | 338 |
| `ensure_daily_availability_reset` | `()` | plpgsql | yes | 1344 |
| `ensure_rotation_valid` | `p_rotation rotation_kind, p_actor uuid` | plpgsql | yes | 2328 |
| `is_agent` | `()` | sql | yes | 276 |
| `is_manager` | `()` | sql | yes | 312 |
| `is_rotation_eligible` | `p_profile_id uuid, p_rotation rotation_kind` | sql | yes | 853 |
| `manager_set_rotation_eligibility` | `p_profile_id uuid, p_rotation rotation_kind, p_active boolean, p_reason text` | plpgsql | yes | 1638 |
| `next_eligible_profile` | `p_rotation rotation_kind, p_after_position integer` | sql | yes | 1739 |
| `set_my_availability` | `p_status availability_status` | plpgsql | yes | 3625 |

Each function has exactly one overload in live `public` — no shadowed signatures.

## 1.2 Live vs repo — nine of ten match

Comparison is normalized for `pg_get_functiondef` rendering only: CR stripping, dollar-quote tag, case,
blank lines, line comments, and interior run-length whitespace. Nothing semantic is normalized away.

| Function | Repo source compared | Verdict |
|---|---|---|
| `set_my_availability` | `v1.8.7-fix-rotation-integrity.sql:525` | **identical** (6 rendering-only lines) |
| `set_my_availability` | `supabase/schema.sql:1754` | differs, 93 lines — stale v0.7.x lineage, as `bugfix.md` states |
| `advance_rotation` | `v1.8.7-fix-rotation-integrity.sql:277` | **identical** (15 rendering-only lines) |
| `ensure_rotation_valid` | `v1.8.7-fix-rotation-integrity.sql:356` | **identical** (9 rendering-only lines) |
| `next_eligible_profile` | `v1.8.7-fix-rotation-integrity.sql:97` | **identical** (12 rendering-only lines) |
| `is_rotation_eligible` | `v1.8.7-fix-rotation-integrity.sql:151` | **identical** (12 rendering-only lines) |
| `manager_set_rotation_eligibility` | `v1.8.7-fix-rotation-integrity.sql:632` | **identical** (11 rendering-only lines) |
| `is_agent` | `supabase/schema.sql:206` | **identical** (7 rendering-only lines) |
| `is_manager` | `v1.6.2-enforce-scoped-supervisor-access.sql:7` | **identical** (7 rendering-only lines) |
| `can_manage_sales` | `v1.6.2-enforce-scoped-supervisor-access.sql:22` | **identical** (7 rendering-only lines) |
| `ensure_daily_availability_reset` | `supabase/schema.sql:1712` | **DIFFERS materially, 19 lines** — see § 1.3 |
| `ensure_daily_availability_reset` | `v0.9.8-stabilize-integrations.sql:1048` | **identical** (4 rendering-only lines) |

The rendering-only differences, in every case, are exactly these and nothing else:

- the signature collapses onto one line and loses the `public.` type prefix (`rotation_kind` for
  `public.rotation_kind`), with `default null` rendered as `default null::uuid`;
- `set search_path = public` renders as `set search_path to 'public'`;
- `stable` and `security definer` render on one line;
- the closing `$$;` renders as `$function$` with the statement terminator dropped.

**Conclusion for the plan:** the v1.8.7 rotation stack is live exactly as the repo file has it. `bugfix.md`'s
verification basis holds. `supabase/schema.sql` is stale for `set_my_availability` and must not be used as
the source for anything in this fix.

### Live role predicates, confirmed verbatim

These are the exact predicates tasks 5.2 and 5.4 depend on:

- `is_agent()` → `role = 'agent' and is_active`. Agent only. Confirms the C6 analysis: every non-agent
  break start and break end raises `Agent permission required` inside `set_my_availability`.
- `is_manager()` → `role in ('manager', 'super_admin') and is_active`. Exactly the two roles 2.11 wants for
  `manager_set_queue_status_mode`.
- `can_manage_sales()` → `role in ('manager', 'sales_supervisor', 'super_admin') and is_active`. Exactly
  what design item 9 assumes for `manager_set_queue_status`.

### Live `set_my_availability` behavior, confirmed

The live body is the v1.8.7 one: `is_agent()` guard, `perform ensure_daily_availability_reset()`,
`select ... for update` on the caller's profile, `update profiles set availability = p_status`, then
`for ... in select * from rotation_state order by kind for update` — the deterministic lock order — with the
`available` branch calling `ensure_rotation_valid` then the daily-start insert, and the non-available branch
calling `advance_rotation` only for rotations the agent currently holds. Design items 6 and 7 can rely on
this as written.

## 1.3 Material drift: `ensure_daily_availability_reset`

The live body is the **`v0.9.8-stabilize-integrations.sql:1048`** lineage, not `supabase/schema.sql:1712`.
`tasks.md` 4.4 and `design.md` item 11 both point at schema.sql ~1710, which is wrong. Three substantive
differences, all in the `if v_last_business_date < v_today then` block:

| | live (`v0.9.8` lineage) | `supabase/schema.sql:1712` |
|---|---|---|
| profile predicate | `where role::text = 'agent' and is_active` | `where role = 'agent' and is_active and availability <> 'unavailable'` |
| rotation pointers | **nulls all three**: `update rotation_state set current_profile_id = null, version = version + 1, updated_at = now(), updated_by = null where kind::text in ('whatsapp','ringcentral','workload')` | absent |
| turn notifications | **marks read**: `update user_notifications set read_at = now() where notification_type = 'turn' and read_at is null` | absent |
| `search_path` | `public, pg_temp` | `public` |

Everything else is identical: `returns boolean`, `pg_advisory_xact_lock(707200072)`, the
`availability_day_state` singleton insert-then-`for update` read, the business-date advance, and the
`true` / `false` return.

**Consequences for task 4.4:**

1. Recreate from the **live / v0.9.8** body. Recreating from schema.sql would silently drop the rotation
   nulling and the notification clearing, which is a 3.9 regression and a queue-integrity regression.
2. The live update has **no `availability <> 'unavailable'` predicate**, so it rewrites every active agent
   including those already `unavailable`. "One `record_availability_event(..., 'daily_reset', ...)` row for
   each profile whose `availability` actually changed" therefore cannot be derived from the existing
   statement's row count. Task 4.4 needs an explicit `where availability <> 'unavailable' returning id,
   availability` (or an equivalent CTE) to identify the genuinely changed rows without altering the
   observable end state. Note this changes the row count the statement touches — behaviorally identical
   end state, but it is a change to the statement and should be called out in the migration comment.
3. Design.md's § 3.9 wording — "marks every active agent Unavailable exactly once under its advisory lock"
   — is incomplete. The live reset also clears all three rotation pointers and all unread turn
   notifications. The preservation baseline in task 3 must capture all three effects, not just the
   availability write.

## 1.4 STOP CONDITION: a third live writer of `profiles.availability`

`design.md` states, and `bugfix.md` repeats: *"Exactly two SQL paths write `profiles.availability`:
`set_my_availability(p_status)` and `ensure_daily_availability_reset()`."* **That is false against live.**

A sweep of all `public` functions for any `availability` assignment plus any `update`/`insert` on
`profiles` returns three writers:

| Function | Writes `profiles.availability` | Via | Also edits `rotation_state` | Uses `advance_rotation` |
|---|---|---|---|---|
| `set_my_availability(availability_status)` | yes | direct `update profiles` | yes | **yes** |
| `ensure_daily_availability_reset()` | yes | direct `update profiles` | yes, nulls all three | no — direct update |
| **`admin_deactivate_profile(uuid, uuid, text)`** | **yes** | direct `update profiles` | **yes, per rotation** | **no — direct update** |

### What `admin_deactivate_profile` does

```
update public.profiles
set is_active = false,
    availability = 'unavailable',
    whatsapp_active = false,
    ringcentral_active = false,
    workload_active = false,
    updated_at = now()
where id = p_profile_id;
```

then, for each of `whatsapp`, `ringcentral`, `workload`, if the target holds that rotation:

```
v_next := public.next_eligible_profile(<kind>, v_target.<kind>_position);
update public.rotation_state
set current_profile_id = v_next, version = version + 1, updated_at = now(), updated_by = p_manager_id
where kind = <kind>;
```

then clears CS overflow routing in `work_desk_settings` if it pointed at the deleted user, and writes one
`audit_log` row with `action = 'user_deleted'`, `entity_type = 'profile'`, `old_value = to_jsonb(v_target)`,
`new_value = jsonb_build_object('is_active', false, 'availability', 'unavailable')`.

### Reach

- Called from `src/app/api/admin/users/route.ts:419`, in the `DELETE` handler (user deletion), guarded by
  `canAdministerUsers` and by an explicit refusal to delete a `super_admin`.
- Its own SQL guard is `role = 'manager' and is_active` — **`super_admin` is not admitted**. Pre-existing,
  out of scope for this fix, but it contradicts the workspace super-admin parity rule and is worth a
  separate ticket.
- Not present in `supabase/schema.sql` as a `create function`. It is referenced in
  `v0.9.13-reconcile-renewal-security.sql:1036`, `v0.9.13-renewal-security-verification.sql:31` and
  `supabase/verification/live-schema-inventory.sql:110`.

### Why this blocks tasks 4–7 as written

1. **C8 / requirement 2.12 is not satisfied by the plan.** 2.12 says *"WHEN queue availability changes for
   any reason THEN the system SHALL record exactly one availability event."* User deletion changes queue
   availability. It writes `audit_log`, not an availability event, and nothing in tasks 4–7 touches it. So a
   `manual_manager`-class availability change would remain unattributable in `availability_events` after the
   fix ships, and the task 8 diagnostic's "a queue status with no `availability_events` row" class would
   flag every deleted user forever.
2. **Correctness Property 3's fourth clause is already false against live.** *"every advancement went
   through `advance_rotation` rather than a direct rotation edit."* Both `admin_deactivate_profile` and
   `ensure_daily_availability_reset` edit `rotation_state` directly. Also `take_quote_turn`, which updates
   `rotation_state` without calling `advance_rotation`. Task 9.3 will fail on unfixed **and** fixed code as
   the property is currently written. The property needs restating as "no advancement path is *added*" —
   scoped to the paths this fix introduces — or the pre-existing direct editors need an explicit allow-list.
3. **The seven-source vocabulary has no member for it.** `manual_manager` is the closest fit, but the actor
   is deleting the account rather than setting a queue status. A `user_deactivated` source, or an explicit
   decision to reuse `manual_manager`, is needed before the 4.2 check constraint is written.

### Recommendation

Smallest change that keeps the plan coherent: add a task 4.6 that recreates `admin_deactivate_profile` from
the live body plus one `record_availability_event` call, keeping its direct-`rotation_state` behavior
byte-identical, and add the chosen source to the 4.2 check constraint. Then amend design.md's
"exactly two SQL paths" claim and Property 3's fourth clause. This is Byron's call — the alternative is to
declare user deletion out of scope and narrow requirement 2.12 in writing, which leaves the diagnostic
flagging deleted users.

### Everything else that mentions `availability` is a reader or a delegate

17 `public` functions mention `availability`. Beyond the three writers above:

- **Delegates** — call `ensure_daily_availability_reset()` and so can trigger the daily reset writer
  transitively, but write no availability themselves: `claim_whatsapp_quote`, `claim_ringcentral_quote`,
  `claim_linked_workload_turn`, `claim_unlinked_workload_turn`, `pass_my_turn`, `take_quote_turn`,
  `start_quote_take_timer`.
- **Read-only** — read `availability` for eligibility only: `is_rotation_eligible`,
  `next_eligible_profile`, `rotation_empty_reason`, `claim_ringcentral_intake`, `claim_workload_turn`,
  `cs_intake_claim_ringcentral`, `steal_timed_quote`.
- **No trigger anywhere in `public`** has a trigger function whose body mentions `availability`. Zero rows.

### The live-only frontend RPCs are clear

The workspace queue-rotation rule flags five RPCs the UI calls that have no `create function` in
`supabase/`. All five exist live. Probed for `availability`:

| Function | Body mentions `availability` | Writes it | Calls `set_my_availability` |
|---|---|---|---|
| `claim_whatsapp_quote_v094` | no | no | no |
| `claim_ringcentral_quote_v094` | no | no | no |
| `start_quote_take_timer_v094` | no | no | no |
| `claim_timed_quote` | no | no | no |
| `steal_timed_quote` | yes (reads for eligibility) | no | no |

**This closes the "Not verified in this session" gap in `bugfix.md` for the live-only RPCs.** None of them
writes `profiles.availability`. The unaccounted writer is `admin_deactivate_profile`, not one of these.

### No client-side write path

`public.profiles` has RLS enabled with exactly one policy: `"Authenticated users can read profiles"`,
`FOR SELECT`, `using (true)`, role `authenticated`. There is **no `UPDATE` policy**, so no client can write
`profiles.availability` directly and every write must pass through a `security definer` function or
`service_role`. Worth recording that table-level `UPDATE` *is* granted to `authenticated`; only the absence
of an RLS `UPDATE` policy blocks it. That is one layer, not two.

## 1.5 Live enum members

| Enum | Members |
|---|---|
| `availability_status` | `available` \| `break` \| `unavailable` |
| `rotation_kind` | `whatsapp` \| `ringcentral` \| `workload` |
| `app_role` | `agent` \| `manager` \| `customer_service` \| `commercial` \| `super_admin` \| `commercial_supervisor` \| `customer_service_supervisor` \| `sales_supervisor` |

`availability_status` is exactly the three members the design assumes — no addition needed.

**Naming correction for the plan:** the role enum is **`public.app_role`**, not `role`.
`profiles.role` is `app_role not null default 'agent'::app_role`. Tasks 1 and 5.4 refer to "the `role`
enum"; any SQL written against a type named `role` will fail.

`profiles.availability` is `availability_status not null default 'unavailable'::availability_status` — the
column default, not a trigger, is what satisfies 3.16.

## 1.6 Absence checks — all six objects are absent

Every object the migration introduces is confirmed not to exist yet, so `v1.12.13` is purely additive:

| Object | Live count |
|---|---|
| enum `public.queue_status_mode` | 0 |
| table `public.availability_events` | 0 |
| column `profiles.queue_status_mode` | 0 |
| column `time_clock_breaks.pre_break_queue_status` | 0 |
| functions `record_availability_event`, `apply_queue_status`, `set_my_queue_status`, `manager_set_queue_status`, `manager_set_queue_status_mode`, `attendance_clock_in`, `attendance_clock_out`, `attendance_break_start`, `attendance_break_end` | 0 of 9 |

The project has no `supabase_migrations.schema_migrations` ledger — migrations are applied manually in the
SQL Editor, so there is no live record of which files have run. Repo's latest migration is
`v1.12.12-reporting-filter-performance.sql`, which matches what task 4.1 assumes; `v1.12.13` is free.

---

## Task 1.1 — the full `admin_deactivate_profile` body and its ACL

### Status: COMPLETE

`scripts/dump-live-functions.mjs` gained `admin_deactivate_profile` in its `targets` array plus an ACL
capture pass, and was re-run. The script is still read-only: `SELECT` only, no DDL, no DML.

| Artifact | Contents |
|---|---|
| `evidence/live-functions/admin_deactivate_profile.sql` | the complete live `pg_get_functiondef` body, 4,139 bytes, with the existing capture header |
| `evidence/live-functions/admin_deactivate_profile.grants.json` | `p.proacl`, the expanded `information_schema.role_routine_grants` rows, the overload count, and the full posture (owner, volatility, parallel, leakproof, `proconfig`) |
| `evidence/live-functions/_index.json` | now 11 functions instead of 10 |

Re-dumping the other ten was harmless: all ten came back byte-identical to the task 1 capture (same byte
lengths — `set_my_availability` 3,625, `ensure_daily_availability_reset` 1,344, and so on).

### Captured posture — what 4.6 must reproduce

| Property | Live value |
|---|---|
| Signature | `public.admin_deactivate_profile(p_profile_id uuid, p_manager_id uuid, p_reason text)` |
| Returns | `void` |
| Language | `plpgsql` |
| Security | `SECURITY DEFINER` |
| `search_path` | `SET search_path TO 'public'` — **not** `public, pg_temp` |
| Volatility | `v` (volatile) |
| Parallel | `u` (unsafe) |
| Leakproof | false |
| Owner | `postgres` |
| `proacl` | `postgres=X/postgres`, `service_role=X/postgres`, `authenticated=X/postgres` |
| Grants | `EXECUTE` to `postgres` (grantable), `service_role`, `authenticated` |
| **Overloads live** | **exactly 1** — `overload_count: 1`, `exactly_one_overload: true`, so 4.6's `create or replace` replaces rather than shadows |

`pg_get_functiondef` emits no grants, which is why the ACL is captured separately: a `create or replace
function` preserves the three EXECUTE grants above, but a `drop`/`create` would silently drop them. 4.6
must therefore be written as `create or replace`, or re-issue all three grants explicitly.

### Two corrections to the plan that the full body settles

1. **The function contains no `super_admin` target refusal.** `bugfix.md` 2.21 and `design.md` item 12 both
   say "the function's existing refusal to delete a `super_admin` target is preserved unchanged". There is
   no such refusal in the live body. The only 403 on a `super_admin` target lives in the `DELETE` handler at
   `src/app/api/admin/users/route.ts` (`profile.role === "super_admin"` → 403). What the function actually
   refuses is the deletion of the **final active Manager**:
   `if v_target.role = 'manager' then ... if v_active_managers <= 1 then raise`. So widening the caller
   guard to `role in ('manager','super_admin')` per 2.21 genuinely does not widen the deletable set — but
   the reason is that the route blocks it, not the function. 4.6 must not "preserve" a guard that is not
   there, and 9.5's "a `super_admin` target is still refused — by the function **and** by the route" has to
   be restated as route-only, or 4.6 has to add the function-level refusal deliberately as a new behavior.
2. **The function has two pre-conditions the baseline and the tests must satisfy.** It raises when the
   target has any `work_items` row with `status = 'active'`, and when the target has any
   `pending_pricing_quotes` row. Task 3's deletion baseline and task 9.5's end-to-end deletion test must
   seed a target with neither, or they will fail on a raise that has nothing to do with this fix.

Everything else matches § 1.4 exactly: the profile update (`is_active = false`,
`availability = 'unavailable'`, all three rotation enable flags false, `updated_at = now()`), the three
per-rotation **direct** `update rotation_state ... next_eligible_profile(<kind>, v_target.<kind>_position)`
handoffs guarded by `if exists (... current_profile_id = p_profile_id)`, the `work_desk_settings` CS
overflow clearing (`customer_service_overflow_enabled = false`, `customer_service_profile_id = null`
where `singleton_id = true and customer_service_profile_id = p_profile_id`), and the single `audit_log`
row with `action = 'user_deleted'`, `entity_type = 'profile'`, `old_value = to_jsonb(v_target)`,
`new_value = jsonb_build_object('is_active', false, 'availability', 'unavailable')` and
`reason = btrim(p_reason)`. The caller guard is `role = 'manager' and is_active`, confirming that
`super_admin` is excluded today.

**Task 4.6 is unblocked.** Transcribe from `evidence/live-functions/admin_deactivate_profile.sql`.

---

## Task 2 — bug condition exploration test

### Status: COMPLETE. The test FAILS on unfixed code, which is the correct outcome

`src/features/time-attendance/server/__tests__/queue-status-bug-condition.integration.test.ts`, run with
`npm run test:integration`:

```
 Test Files  1 failed (1)
      Tests  18 failed | 5 passed (23)
```

18 of the 23 assertions fail. Every failure is a counterexample. **No hypothesized root cause was
refuted**, so the diagnosis stands and task 4 can proceed.

### How the test is driven

The four unfixed routes are called as real route handlers, with a real Supabase session, against the live
project. `next/headers` is the only thing replaced: an in-memory cookie jar that `@supabase/ssr` itself
populated during a real password sign-in, so the session, the JWT, RLS and every SQL statement are genuine.
Six employees are seeded — a WhatsApp-turn holder, a handoff target one position above it, a rotation-free
agent, a `customer_service` employee, a `manager`, and an agent to delete.

The daily reset is the one writer that cannot be reached through a route and is also the most destructive
thing in the file. It runs inside a plpgsql block that raises at the end, so its writes are rolled back by
the subtransaction and never commit — the same technique
`src/features/time-attendance/server/__tests__/audit-immutability.integration.test.ts` uses.

### Counterexamples, mapped to the root cause each one confirms

| # | Assertion | Expected (post-fix) | Observed (unfixed) | Confirms |
|---|---|---|---|---|
| 1 | C2 clock-out removes the agent from the queues | `unavailable` | **`available`** | root cause 2 — `set_my_availability` sits inside `if (onBreak)` |
| 2 | C2 hands off the WhatsApp turn | pointer ≠ the agent | **pointer still `aef23a7f…`, the clocked-out agent** | root cause 2 — the agent keeps holding live WhatsApp work after leaving |
| 3 | C2 reports the queue status to the caller | `'unavailable'` | **`undefined`** | root causes 4, 9 — the payload is `{ success, total_hours }` only |
| 4 | C4 break end restores the pre-break status | `unavailable` | **`available`** | root causes 3, 1 — `set_my_availability('available')` is unconditional |
| 5 | C3 break start leaves an ineligible agent ineligible | `unavailable` | **`break`** | root causes 3, 1 — a deliberate Unavailable is overwritten |
| 6 | C3 the pre-break status is recoverable | column exists | **`time_clock_breaks.pre_break_queue_status` does not exist** | root cause 3 — there is nowhere to put the prior value |
| 7 | C6 non-agent break start is not an unqualified success | `changed_queue: false` | **`undefined`** — HTTP 201 while Postgres raised | root causes 4, 5 — the `{ error }` is discarded |
| 8 | C7 one logical clock-out, one attributable transition | 1 | **0** | root causes 7, 8 |
| 9 | C8 My Status change is attributable | 1 | **0** | root cause 7 |
| 10 | C8 break start is attributable | 1 | **0** | root cause 7 |
| 11 | C8 break end is attributable | 1 | **0** | root cause 7 |
| 12 | C8 clock-out is attributable | 1 | **0** | root cause 7 |
| 13 | C8 daily reset is attributable, one event per changed profile | 8 | **0**, for **8** genuinely changed profiles | root cause 7 + § 1.3 — the reset rewrites every active agent and records nothing |
| 14 | C8 user deletion is attributable as an availability change | 1 | **0** — one `audit_log` row, `action = 'user_deleted'` | root cause 7 + § 1.4 — the third writer |
| 15 | C8 a table exists that can carry an availability transition | true | **false** — `public.availability_events` does not exist | root cause 7, requirement 2.13 |
| 16 | C1 clock-in states the queue status and offers `Join Sales Queues` | `'unavailable'` / `true` | **`undefined`** | root cause 9 |
| 17 | 1.11 a repeated clock-out answers with committed state | HTTP 200 | **HTTP 400 `Not clocked in.`** | root cause 8 |
| 18 | 1.11 a repeated break-end answers with committed state | HTTP 200 | **HTTP 400 `No active break to end.`** | root cause 8 |

### The five assertions that already pass, and what each one proves

Passing is not "nothing to see" here — three of the five are themselves evidence.

1. **`set_my_availability` really does raise for a non-agent.** Called directly as the seeded
   `customer_service` employee it returns `Agent permission required`. Paired with counterexample 7 — HTTP
   201 from the same action through the route — this is root causes 4 and 5 confirmed with no race needed.
   It is the guaranteed behavior for every non-agent employee, every break, every day.
2. **The non-agent's queue status is untouched.** Consistent with the raise, and the reason C6 shows up as a
   reporting defect rather than a state defect.
3. **Two concurrent clock-outs for one open entry BOTH answer HTTP 200.** Root cause 8 confirmed directly:
   neither route re-checks that the row is still open after reading it, so one logical action is applied
   twice and both callers are told it worked. Note the contrast with counterexamples 17 and 18: run
   *sequentially* the second request gets HTTP 400, run *concurrently* it gets 200. Same defect, opposite
   symptom, which is exactly why 2.10 and 1.11 both exist.
4. **A repeated clock-in answers 200 with `already_open: true`.** The one action that already behaves, kept
   as the reference point for the 1.11 asymmetry.
5. **The break end wrote no `turn_events` row** — for the rotation-free agent used in C3/C4, which holds no
   rotation by construction. This assertion is not vacuous after the fix; it is the guard against the
   available branch of `set_my_availability` handing a turn to an agent who never asked for it.

### Root cause verdicts

| Root cause | Verdict | Evidence |
|---|---|---|
| 1. One field carrying two facts | **CONFIRMED** | counterexamples 4, 5 — a queue decision and an attendance action collide in `profiles.availability` |
| 2. Conditional coupling in clock-out | **CONFIRMED** | counterexamples 1, 2 |
| 3. Unconditional coupling in break start/end, no memory | **CONFIRMED** | counterexamples 4, 5, 6 |
| 4. Discarded RPC results | **CONFIRMED** | counterexample 7 + passing assertion 1 |
| 5. Independent round trips, not one transaction | **CONFIRMED** | counterexample 7 — the attendance write committed, the availability write did not, HTTP 201 |
| 6. No arbitration and no opt-in | **CONFIRMED** | `profiles.queue_status_mode` absent (§ 1.6); every seeded agent got attendance-driven queue writes unconditionally |
| 7. No audit table capable of carrying a transition | **CONFIRMED** | counterexamples 9–15 — zero attributable records across all six writers |
| 8. Read-then-write with no re-check | **CONFIRMED** | passing assertion 3 (two 200s) and counterexamples 17, 18 (400 on retry) |
| 9. UI vocabulary conflates the two facts | **CONFIRMED at the API layer** | counterexamples 3, 16 — no route response carries a queue status at all, so no panel can render two labelled values today. The rendering half is task 9.4's unit tests |
| **REFUTED** | **none** | — |

### What the run wrote, and what it put back

Verified after the run: 0 seeded profiles, 0 seeded auth users, 0 orphan clock rows, no probe `audit_log`
row, no probe `turn_events` row, `availability_day_state` unchanged and not pending, and the active-agent
availability distribution identical to before the run (7 available / 1 break / 2 unavailable).

- `rotation_state.whatsapp` was pointed at the seeded holder twice and restored to the live holder
  `d7ba1899…` with `updated_by` restored.
- `rotation_state.workload` moved to a different live agent during the run **by a real claim**. The harness
  detected that it was not the one who last touched it and left it alone, which is the intended behavior.
- The one piece of residue no design avoids: `rotation_state.whatsapp.version` advanced 1091 → 1103 across
  three runs. Version is left monotonically increasing rather than rewound, because rewinding a concurrency
  counter is more dangerous than leaving it high.

**One harness defect found and fixed, worth knowing about.** The first version of the cleanup restored any
live agent whose availability differed from the pre-run snapshot, as insurance against the daily reset. On
one run that reverted a live agent (`e83c3f50…`) to `available` after they had changed their own status
during the 65-second window — cleanup interfering with production rather than undoing itself. The restore
is now gated on proof that the reset actually committed: the reset advances
`availability_day_state.business_date` in the same transaction, so an unchanged business date means no live
agent's availability came from this run. Re-run after the fix, cleanup reports `no live availability
restore needed: the daily reset never committed` and touches no live profile.

### One pre-existing, unrelated failure in the same command

`npm run test:integration` also fails `src/features/cancellations/__tests__/audit-immutability.integration.test.ts`
with `new row for relation "cancellation_events" violates check constraint
"cancellation_events_event_type_check"` — its probe inserts `event_type = 'audit_immutability_probe'`,
which the live check constraint no longer admits. Pre-existing, unrelated to this spec, and untouched by
task 2. Task 10 will have to either fix it or record it as a known-failing baseline.

The offline suite has a second pre-existing failure, recorded here so task 10 has a baseline to compare
against rather than blaming it on this fix. `npx vitest --run` gives
`Test Files 1 failed | 104 passed | 3 skipped (108)` / `Tests 2 failed | 2535 passed | 61 skipped (2598)`,
both failures in `src/features/cancellations/__tests__/cancellations-summary-bar.test.tsx`. The three
skipped files are the integration suites, which self-skip without credentials — including this task's new
file, so `npm test` stays offline and green apart from that pre-existing pair.

---

## Corrections the plan needs before task 4

| # | Document | Current text | Correct text |
|---|---|---|---|
| 1 | `design.md` Overview / `bugfix.md` findings | "Exactly two SQL paths write `profiles.availability`" | Three: `set_my_availability`, `ensure_daily_availability_reset`, `admin_deactivate_profile` |
| 2 | `tasks.md` 4.4, `design.md` item 11 | recreate `ensure_daily_availability_reset` from `supabase/schema.sql` (~1710) | recreate from the live body, which is the `v0.9.8-stabilize-integrations.sql:1048` lineage — it also nulls all three rotation pointers and clears unread turn notifications |
| 3 | `design.md` Property 3, `tasks.md` 9.3 | "every advancement went through `advance_rotation`" | already false live: `ensure_daily_availability_reset`, `admin_deactivate_profile` and `take_quote_turn` edit `rotation_state` directly. Restate as "this fix adds no new advancement path", or allow-list the three |
| 4 | `tasks.md` 1, `design.md` item 10 | "the `role` enum" | the enum is `public.app_role` |
| 5 | `design.md` § 3.9 | daily reset "marks every active agent Unavailable" | it also nulls all three rotation pointers and marks all unread `turn` notifications read |
| 6 | `tasks.md` 4.2 source check constraint | seven sources | needs an eighth, or an explicit decision to map user deletion onto `manual_manager` |
| 7 | `bugfix.md` 2.21, `design.md` item 12, `tasks.md` 4.6 and 9.5 | "the function's existing refusal to delete a `super_admin` target is preserved unchanged" | the live `admin_deactivate_profile` has **no** `super_admin` target refusal. Only the `DELETE` handler has one. What the function refuses is deleting the final active Manager. Either restate as route-only, or add the function-level refusal deliberately as a new behavior |
| 8 | `tasks.md` 3 deletion baseline and 9.5 deletion test | silent on pre-conditions | the function raises when the target holds any `status = 'active'` work item or any `pending_pricing_quotes` row. Seed a target with neither |

---

## Reproducing this audit

```
node scripts/dump-live-functions.mjs          # re-dump the 11 live bodies + the ACL capture
node scripts/scan-availability-writers.mjs    # re-scan writers, enums, absence checks
node scripts/diff-live-vs-repo-functions.mjs  # local diff, no database access
```

All three are read-only with respect to the database.

The task 2 exploration test is not read-only — it seeds and deletes its own employees and briefly moves the
WhatsApp pointer — and it is expected to fail until the fix lands:

```
npm run test:integration
```

---

## Core implementation pass — tasks 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 9.4

Branch `fix/attendance-queue-status-sync`. Byron cut the pass down to the core so it ships sooner; what
was cut is listed under **Deferred** below and left unchecked in `tasks.md`.

### What was built

| Task | Object | Where |
|---|---|---|
| 4.1 | `public.queue_status_mode`, `profiles.queue_status_mode` (`not null default 'manual'`), `time_clock_breaks.pre_break_queue_status` | `supabase/migrations/v1.12.13-attendance-queue-status-separation.sql` § 1–3 |
| 4.2 | `public.availability_events` — eleven columns, the eight-source check constraint, three indexes, the `before update or delete` trigger, RLS with select + insert only, `revoke update, delete` | § 4 |
| 4.3 | `record_availability_event`, `apply_queue_status` including the `v_prev = p_new_status` early return | § 5–6 |
| 5.1 | `attendance_clock_in`, `attendance_clock_out`, `attendance_break_start`, `attendance_break_end`, plus `attendance_status_payload` for step 6 | § 7–8 |
| 5.2 | the per-action decision table inside those four | § 8, and mirrored for unit test in `src/features/time-attendance/domain/queue-status.ts` |
| 5.3 | `set_my_queue_status` | § 9 |
| 5.4 (part) | `manager_set_queue_status_mode` only — see Deferred | § 10 |
| — | grants per design item 14 | § 11 |
| 6.1 | `POST` → one `attendance_clock_in`; `PATCH clock_out` → one `attendance_clock_out`; `PATCH edit` untouched | `src/app/api/time-clock/route.ts` |
| 6.2 | `POST` → `attendance_break_start`; `PATCH` → `attendance_break_end` | `src/app/api/time-clock/breaks/route.ts` |
| 6.3 | `active` returns `attendance_status`, `queue_status`, `queue_status_mode`, `is_agent`; `admin/users` `PATCH` forwards `queue_status_mode`; `DELETE` untouched | `active/route.ts`, `admin/users/route.ts` |
| 6.1–6.3 | every `{ error }` inspected; `failed_portion` from the SQLSTATE and message, both statuses re-read | `src/features/time-attendance/server/attendance-rpc.ts` |
| 7.1 | `onRecorded` receives the response payload; `inFlightRef`, mounted guard and failure handling untouched | `shared/useClockAction.ts` |
| 7.2 | the two labelled values, the 2.15/2.16/2.17 sentences, `Join Sales Queues`, `Set Unavailable` | `today/SalesQueueStatus.tsx`, wired into `MyDayPanel.tsx` and `TodayScreen.tsx` |
| 7.3 | `handleAvailability` → `set_my_queue_status`; control and toast relabelled `Sales Queues: …` | `src/components/work-desk-app.tsx` |
| 9.4 | 48 unit tests over the decision table, the `failed_portion` mapping, the message selection, the two-label rendering and `already_applied` | `domain/__tests__/queue-status.test.ts`, `server/__tests__/attendance-rpc.test.ts`, `today/__tests__/SalesQueueStatus.test.tsx` |

The migration was applied to live Supabase with `node scripts/run-sql.mjs`. Its verification select
returned `mode_enum 1`, `profiles_column 1`, `non_manual_profiles_must_be_zero 0`, `break_column 1`,
`events_table 1`, `events_indexes 3`, `events_trigger 1`, `events_policies 2`,
`events_write_policies_must_be_zero 0`, `functions_created 9`. So every pre-existing profile reads
`queue_status_mode = 'manual'` and no existing user gets attendance-driven queue changes (2.11).

### Task 9.1 — the exploration test re-run

```
npm run test:integration -- queue-status-bug-condition
  4 failed | 19 passed (23)        (was: 18 failed | 5 passed)
```

**14 of the 18 counterexamples are resolved.** What now passes, and did not before: a break-less clock-out
writes `unavailable` and hands off the WhatsApp turn; the clock-out response carries a queue status; a break
that starts from `unavailable` stays `unavailable` and records `pre_break_queue_status = 'unavailable'`;
ending it restores `unavailable` and writes no `turn_events` row; a `customer_service` break start answers
`changed_queue: false` with a queue status rather than an unqualified 201; **two concurrent clock-outs both
answer HTTP 200** with one availability transition, one event and ≤ 1 handoff; a clock-in while `unavailable`
answers with `queue_status` and `offers_join_sales_queues: true`; a repeated clock-out and a repeated
break-end both answer 200 with `already_applied: true`; a **My status** change is attributable with source
`manual_agent`; a clock-out is attributable with source `attendance_clock_out`; and a table capable of
carrying an availability transition exists.

The four that still fail:

| Assertion | Why | Whose |
|---|---|---|
| C8 "attributes a break start" — expected 1, got 0 | c3's pre-state is `queue = unavailable`, so per 2.4 break start records the pre-break status and does **not** write `break`. The value does not move, `apply_queue_status` is never called, and 2.12 requires an event only "WHEN queue availability changes" | test-versus-spec, needs Byron |
| C8 "attributes a break end" — expected 1, got 0 | c4 restores `unavailable` over `unavailable`, so `apply_queue_status` takes the `v_prev = p_new_status` early return — the designed idempotency point of 2.10 | test-versus-spec, needs Byron |
| C8 "attributes the daily reset" — expected 8, got 0 | task 4.4 deferred | deferred |
| C8 "attributes a user deletion" — expected 1, got 0 | task 4.6 deferred | deferred |

The first two are the same shape: the test asserts one event unconditionally, while the design's own Fix
Checking block guards that assertion with `IF changesQueueAvailability(F', X)` and both inputs are
zero-delta. Two ways out, and it is a specification decision rather than a code fix: guard the two
assertions the way Fix Checking does, or record zero-delta queue **decisions** as events, which would mean
dropping the early return that makes a duplicate request idempotent. Nothing was weakened in the test to
hide this.

### Three harness changes to the task 2 file, no assertion touched

The exploration file drives real routes against real SQL, so two of its inputs had to move with the schema
and one had to be able to clean up after itself. All three are recorded because the file is the fix gate:

1. **Seed `queue_status_mode: 'attendance_assisted'`.** Task 2 fixed the mode dimension at
   `attendance_assisted` for every probe because that is how every agent behaved before the fix. The column
   did not exist then, so the key was absent and the behavior was assisted by default. It now exists and
   defaults to `manual`, so the pre-state has to state what it always meant. Without this every
   attendance-driven assertion would fail for the *right* reason — the gate works — and prove nothing.
2. **The My status probe calls `set_my_queue_status`.** It drove `set_my_availability` because that is what
   the **My status** control sent; after task 7.3 the control sends `set_my_queue_status`. The probe drives
   whichever RPC the control actually uses.
3. **`purgeAvailabilityEvents()` in `resetAttendance` and `cleanUp`.** `availability_events` is append-only
   by design and its `profile_id`, `clock_entry_id` and `break_id` foreign keys carry no referential action,
   so an event pins its clock entry and its profile in place — which is correct for production, where
   nothing hard-deletes either. A probe is the one caller that must undo itself, so it disables the trigger
   around its own delete. That needs table ownership rather than the ability to execute a definer function,
   so it does not weaken what the trigger proves about the paths under test. Every observation is read
   before the reset that follows it.

### `manager_set_queue_status_mode` verified against live, rolled back

No automated test covers it, so it was exercised directly: a `do` block set `request.jwt.claims` to a live
manager, called the function on a live agent and then raised, so nothing committed.

```
PROBE OK: before=manual after=attendance_assisted audit_rows=1 manager=5608dfc2…
```

Post-run live state confirms the rollback and the migration default:
`non_manual_profiles_must_be_zero 0`, `mode_audit_rows_must_be_zero 0`, `availability_events_rows 0`. So
after the whole pass — migration, exploration run, probe — **no live profile is opted in and no availability
event is left over.** A manager has to opt an agent in before any attendance action can move a queue status.

### Checkpoint commands

```
npx vitest --run queue-status.test attendance-rpc.test SalesQueueStatus
  Test Files 3 passed (3)   Tests 48 passed (48)

npx tsc --noEmit
  clean, exit 0

npm run build
  succeeded, exit 0
```

`npm test` reports `28 failed | 2557 passed | 61 skipped`. **All 28 are pre-existing and unrelated**: they
are in `src/features/cancellations` and `src/features/renewals`, they all turn on whether
`sales_supervisor` counts as a manager, and they come from uncommitted work already in the tree
(`src/lib/permissions.ts`, `src/features/cancellations/**`, `src/features/renewals/**` are all modified in
the working tree by other work). Nothing in this pass imports any of them. The two the orchestrator named
as known-failing — `cancellations/__tests__/audit-immutability.integration.test.ts` and
`cancellations/__tests__/cancellations-summary-bar.test.tsx` — are among them.

#### Re-run 2026-08-13

```
npx tsc --noEmit
  clean, exit 0

npm run build (Next.js 16.2.10 Turbopack)
  ✓ Compiled successfully in 5.2s
  ✓ TypeScript in 12.8s
  ✓ Generating static pages (47/47) in 517ms
  exit 0

npx vitest --run queue-status.test attendance-rpc.test SalesQueueStatus
  Test Files 3 passed (3)   Tests 48 passed (48)

npm test (full suite)
  Test Files 12 failed | 96 passed | 3 skipped (111)
  Tests 27 failed | 2558 passed | 61 skipped (2646)
  All 27 failures are pre-existing and unrelated: cancellations (sales_supervisor manager parity),
  renewals (same), and one duplicate-validation test in quotes. None in time-attendance.

npm run test:integration -- queue-status-bug-condition
  queue-status-bug-condition.integration.test.ts: 4 failed | 19 passed (23)
  Four expected failures (deferred tasks): attributes break start, attributes break end,
  attributes daily reset, attributes user deletion.
  audit-immutability.integration.test.ts: 13 passed
  cancellations audit-immutability: skipped (pre-existing check-constraint issue)
```

### One behavior narrowing worth Byron's eye

`apply_queue_status` returns early when the profile already holds the target status, which is what makes a
duplicate request idempotent (design item 6, and the reason two concurrent clock-outs now produce one
transition). It has one consequence beyond duplicates: an agent who is **already** `available` and clicks
`Sales Queues: Available` no longer re-runs `set_my_availability`, so it no longer triggers that function's
`ensure_rotation_valid` repair and daily-start branch. In practice the daily reset leaves every agent
`unavailable`, so the first click of the day is always a real transition and the repair still runs. The
narrowing only bites if a rotation is null or stale *while* an eligible agent is already `available`, which
is itself a state 3.5 says should not persist. Flagged rather than fixed, because removing the early return
would break the 2.10 idempotency the same design requires.

---

## Deferred out of the core pass

Not built, and deliberately so. Left unchecked in `tasks.md` with a note pointing here.

| Task | What is missing | Consequence while it is open |
|---|---|---|
| 4.4 | `ensure_daily_availability_reset()` is **not** recreated | the business-date rollover still rewrites every active agent's availability and records nothing. The `daily_reset` source is in the check constraint with no writer, so no constraint change is needed when this lands. Exploration assertion "attributes the daily reset" fails |
| 4.6 | `admin_deactivate_profile(uuid, uuid, text)` is **not** recreated | account deletion still writes `availability = 'unavailable'` with its only trace an `audit_log` row whose action is not in the eight-source vocabulary. The caller guard still excludes `super_admin` (2.21 open) and there is still no function-level `super_admin` **target** refusal, so the direct-RPC bypass around the route's 403 is still open (2.22 open). `user_deactivated` is in the check constraint with no writer. Exploration assertion "attributes a user deletion" fails |
| 4.5 | no reconciliation statement | unknown until the task 8 diagnostic runs; nothing to repair yet because nothing has been measured |
| 5.4 (part) | `manager_set_queue_status` is **not** built. `manager_set_queue_status_mode` **is**, because task 6.3's `admin/users` `PATCH` forwards to it and the feature is inert without a way to opt an agent in | a manager can opt an agent into `attendance_assisted` but cannot set another employee's queue status; 2.9's manager path and the `manual_manager` source have no writer |
| 8 | no `diagnostics/attendance-queue-diagnostic.sql` | the six production mismatch counts stay unknown, which is also why 4.5 has nothing to write |
| 9.3 | no rotation invariant property test | Property 3 is unproven this pass. The four attendance functions add no direct `rotation_state` edit — every queue change goes through `set_my_availability` — but that is an argument from reading the migration, not a measurement |
| 9.5 | no integration suite against real Supabase beyond the exploration file | the multi-agent rotation matrix, the rollback case, the append-only proof, the migration-default proof and the deletion end-to-end are all unverified |
| 3 | no preservation baseline | the exploration test is the gate instead. The highest-risk untested comparison is the attendance arithmetic, which moved from TypeScript into SQL: `total_hours`, `break_minutes` and the paid short/personal versus unpaid lunch split were transcribed statement by statement from the two route bodies, and the transcription is unmeasured (3.12) |

Two consequences of the deferral worth stating plainly. **Requirement 2.12 does not yet hold for every
writer of `profiles.availability`** — it holds for the attendance paths and for **My status**, and not for
the daily reset or for account deletion. And **the task 8 diagnostic, once written, would flag every
pre-existing queue status as having no availability event**, because no backfill exists; that is 4.5's
`system_repair` statement, which is also deferred.
