---
inclusion: always
---

# Queue Rotation Rules

The New Hope Work Desk has three independent queue rotations:

- WhatsApp
- RingCentral
- Additional Workload

Treat Supabase as the authoritative source of rotation state. The frontend displays and refreshes the state but must not independently decide or persist queue advancement.

## Core invariants

- Each rotation changes independently.
- An action in one rotation must not alter the other two rotations.
- When at least one eligible agent exists, that rotation must have a valid current agent.
- A current agent must be active, available, enabled for that rotation, and have a valid rotation position.
- If the current agent becomes unavailable or ineligible, automatically select the next eligible agent.
- If no eligible agents exist, a null current agent is allowed.
- When an eligible agent later becomes available, a null rotation must automatically recover.
- Queue order wraps from the highest position back to the lowest.
- With one eligible agent, the queue remains assigned to that agent after an action.
- Every queue-consuming transition must be atomic, concurrency-safe, idempotent, and recorded in `turn_events`.
- Lock the relevant `rotation_state` row before validating and advancing a turn.
- Never create a quote successfully while failing to perform its required queue transition.
- Never advance a turn if the associated claim or work-item creation fails.
- Never advance the same turn twice because of a browser retry or double-click.

## Action rules

### WhatsApp

A successful normal WhatsApp quote claim consumes and advances only the WhatsApp turn.

### RingCentral

A successful normal RingCentral quote claim consumes and advances only the RingCentral turn.

Customer Service quote intakes with the RingCentral channel use the RingCentral queue. A successful intake claim must atomically:

1. Validate the current RingCentral agent.
2. Claim the intake.
3. Convert it into the canonical active quote/work item.
4. Assign it to the claiming agent.
5. Mark it as a RingCentral-turn assignment.
6. Advance the RingCentral rotation once.
7. Record the intake, work-item, and turn audit events.

Manager/manual intake assignments do not consume the RingCentral turn.

### Additional Workload

Normal linked and unlinked workload claims taken through the workload queue advance only the Additional Workload rotation.

Manually logged workload does not advance any rotation.

### Pass

Only the current eligible agent may pass their own turn. Pass changes only the specified rotation and must be audited.

### Timed quote and Recover

Timed/rescue quote actions must follow their documented rotation rules. Recover must not duplicate the quote, advance a turn twice, or incorrectly replace the current normal queue position.

## Database migrations

- Do not assume `supabase/schema.sql` contains the latest production logic.
- Inspect all later migrations.
- Do not modify historical migrations that may already have been deployed.
- Use a new forward-only migration for fixes.
- Compare repository function definitions with the live Supabase definitions before diagnosing production behavior.

## Validation requirements

Queue changes require tests covering:

- One, two, and three eligible agents.
- Wraparound.
- All agents unavailable.
- Recovery when an agent becomes available.
- Invalid or null current agents.
- Availability changes.
- Simultaneous claims.
- Simultaneous Claim and Pass.
- Browser retries and double-clicks.
- Stale frontend state.
- WhatsApp claims.
- RingCentral claims.
- Customer Service intake claims.
- Workload claims.
- Pass.
- Timed quote claim.
- Recover.

A successful build alone is not proof that queue behavior is correct.

## System reference

Verified against the repository. Re-verify against live Supabase before diagnosing production behavior.

### State and audit tables

- `public.rotation_state` — one row per rotation, keyed by `kind` (`whatsapp`, `ringcentral`, `workload`), holding `current_profile_id`, `version`, `updated_at`, `updated_by`. Select `for update` before validating or advancing.
- `public.turn_events` — audit log with `rotation`, `action`, `actor_profile_id`, `previous_profile_id`, `next_profile_id`, `work_item_id`, `reason`. `action` is constrained to `claim`, `pass`, `manual_change`, `auto_skip`, `daily_start`.
- `public.quote_take_events` — audit log for timed/rescue actions.

### Eligibility

An agent is eligible for a rotation when all of the following hold on `public.profiles`:

- `is_active`
- `availability = 'available'`
- the rotation's enable flag: `whatsapp_active` / `ringcentral_active` / `workload_active`
- a valid rotation position: `whatsapp_position` / `ringcentral_position` / `workload_position`

`public.next_eligible_profile(kind, position)` resolves the next eligible agent with wraparound. It returns `null` when no eligible agent exists; callers must not blindly write that `null` into `rotation_state`.

### Turn-consuming functions

- `claim_whatsapp_quote` — WhatsApp only
- `claim_ringcentral_quote` — RingCentral only
- `cs_intake_claim_ringcentral` — CS intake on the RingCentral queue; performs the full atomic claim/convert/assign/advance sequence
- `claim_linked_workload_turn`, `claim_unlinked_workload_turn` — Additional Workload only
- `take_quote_turn` — timed/Take action
- `claim_timed_quote`, `steal_timed_quote` — timed quote claim and Recover (`steal_timed_quote` is surfaced in the UI as "Recover")
- `pass_my_turn(p_rotation, p_reason)` — Pass, one rotation only
- `set_my_availability` — carries the auto-skip and null-recovery logic across all three rotations

### Non-consuming functions

These must never advance a rotation:

- `cs_intake_claim`, `cs_intake_convert`, `cs_intake_manager_assign` — manager/manual intake paths
- `log_whatsapp_update`, `log_manual_quote` — manual logging
- `workload_reassign`, `workload_void`, `manager_reassign_work_item`, `manager_reassign_pending_pricing`

### Known repo/live drift

The frontend (`src/components/work-desk-app.tsx`, root `IntakeQueue.tsx`) calls RPCs that have no `create function` definition anywhere in `supabase/`:

- `claim_whatsapp_quote_v094`
- `claim_ringcentral_quote_v094`
- `start_quote_take_timer_v094`
- `claim_timed_quote`
- `steal_timed_quote`

These exist only in live Supabase. Patching the unsuffixed repo functions (as `v1.8.5-fix-rotation-null-on-claim.sql` does for `claim_whatsapp_quote` and `claim_ringcentral_quote`) does not necessarily change what the UI actually executes. Always dump the live definition before concluding a fix landed.
