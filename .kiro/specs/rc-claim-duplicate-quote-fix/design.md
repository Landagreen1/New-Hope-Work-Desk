# RC Claim Duplicate Quote Fix — Bugfix Design

## Overview

When an agent claims a RingCentral-sourced intake via `claim_ringcentral_intake`, the system creates an `operational_quotes` record and updates `customer_intakes`, but fails to synchronize the legacy `cs_intake_submissions` table. The IntakeQueue UI reads from `cs_intake_submissions`, so it continues displaying a "Create Quote" button for the already-converted intake. Clicking that button calls `cs_intake_convert`, which creates a second quote record (`work_items`), resulting in duplicate quotes for a single intake.

The fix synchronizes `cs_intake_submissions` during the RC claim flow, adds an idempotency guard to `cs_intake_convert`, fixes the `isRingcentralSource()` heuristic, and conditionally hides the "Create Quote" button when a quote already exists.

## Glossary

- **Bug_Condition (C)**: The state where `claim_ringcentral_intake` has been called, creating an `operational_quotes` record, but `cs_intake_submissions.converted_at` remains NULL — leaving the UI out of sync
- **Property (P)**: After an RC claim, `cs_intake_submissions` reflects the conversion (status='converted', converted_at set, work_item_id set) and no duplicate quote can be created
- **Preservation**: Non-RC claim flows, manager assignments, validation failures, and existing UI behavior for legitimately claimed-but-not-converted intakes remain unchanged
- **`claim_ringcentral_intake`**: RPC function in `v1.0.0-fn-claim-ringcentral-intake.sql` that atomically claims an RC intake and creates the linked operational quote
- **`_create_quote_from_intake`**: Internal function in `v1.0.0-fn-create-quote-from-intake.sql` that creates the operational_quote record with idempotency on `customer_intakes.converted_quote_id`
- **`cs_intake_convert`**: RPC function in `v0.9.8-stabilize-integrations.sql` that converts a claimed intake to a `work_items` quote record and updates `cs_intake_submissions`
- **`isRingcentralSource()`**: Client-side heuristic in `IntakeQueue.tsx` that currently uses `Boolean(row.work_item_id)` to detect RC-sourced intakes
- **`cs_intake_submissions`**: Legacy table that the IntakeQueue UI reads from via `listQueue()`/`listAllIntakes()`
- **`customer_intakes`**: Newer table that `claim_ringcentral_intake` updates directly

## Bug Details

### Bug Condition

The bug manifests when a RingCentral-sourced intake is claimed via `claim_ringcentral_intake`. The function updates `customer_intakes` (status='claimed', assigned_to, converted_quote_id via `_create_quote_from_intake`) but does NOT propagate the conversion state to `cs_intake_submissions`. The UI reads `cs_intake_submissions` and shows a "Create Quote" button because `converted_at` is NULL and `status` is still 'claimed'. Additionally, `isRingcentralSource()` returns `false` because it relies on `row.work_item_id` being truthy — a field only set by `cs_intake_convert`, not by the RC claim flow.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type IntakeClaimAction
  OUTPUT: boolean
  
  RETURN input.source_type = 'ringcentral'
         AND input.action = 'claim_ringcentral_intake'
         AND cs_intake_submissions[input.intake_id].converted_at IS NULL
         AND EXISTS(operational_quotes WHERE customer_intake_id = input.intake_id)
END FUNCTION
```

### Examples

- **Agent presses "Claim" on RC intake**: `claim_ringcentral_intake` succeeds, `operational_quotes` record is created, but `cs_intake_submissions` still shows status='claimed' with no `converted_at`. UI refreshes and shows "Create Quote" button. Agent clicks it → `cs_intake_convert` creates a duplicate `work_items` record.
- **Agent refreshes page after RC claim**: `listQueue()` returns the row from `cs_intake_submissions` with status='claimed', `converted_at=NULL`. The "Create Quote" button appears because the UI checks `row.status === 'claimed'` and `!hasLinkedQuote` (where `hasLinkedQuote = Boolean(row.converted_at)`).
- **Source column shows wrong label**: `isRingcentralSource(row)` returns `false` (since `work_item_id` is NULL after RC claim), so the Source column shows "Personal" or "Commercial" instead of "RingCentral" for a legitimately RC-sourced intake.
- **Second agent sees stale state**: Because `cs_intake_submissions` isn't updated, other agents' UI also shows the intake as claimable/convertible, though the `customer_intakes` row is already locked.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Non-RingCentral intakes claimed via `cs_intake_claim` continue the two-step flow (claim → convert) without auto-creating a quote
- Manager assignment via `assign_customer_intake` continues to work exactly as before
- Concurrent claim attempts continue to fail atomically for the second requester
- Validation failures (wrong agent, unavailable, already claimed) continue to roll back cleanly
- The "Create Quote" button continues to appear for legitimately claimed-but-not-converted non-RC intakes
- Mouse clicks, non-number keyboard inputs, and general UI interactions remain unchanged
- `cs_intake_convert` continues to work correctly for non-RC intakes that go through the standard claim → convert flow

**Scope:**
All inputs that do NOT involve a RingCentral claim action should be completely unaffected by this fix. This includes:
- Non-RC intake claims (`cs_intake_claim`)
- Manual conversions of non-RC intakes (`cs_intake_convert` for standard flow)
- Manager assignments (`assign_customer_intake`)
- Intake creation, editing, deletion, and restoration
- Notification delivery and rotation state management

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Missing `cs_intake_submissions` Synchronization in RC Claim Flow**: `claim_ringcentral_intake` calls `_create_quote_from_intake` which updates `customer_intakes` but neither function touches `cs_intake_submissions`. The legacy table remains stale with status='claimed' and `converted_at=NULL`.

2. **No Idempotency Guard in `cs_intake_convert`**: The function checks `status='claimed'` and `claimed_by IS NOT NULL` but does not check whether an `operational_quotes` record already exists for this intake. If the submission is in 'claimed' state (because it wasn't updated to 'converted'), `cs_intake_convert` proceeds to create a duplicate quote.

3. **Incorrect `isRingcentralSource()` Heuristic**: The function uses `Boolean(row.work_item_id)` which is only truthy after `cs_intake_convert` sets it. RC intakes claimed via `claim_ringcentral_intake` never have `work_item_id` set in `cs_intake_submissions`, so they are misidentified as non-RC.

4. **UI "Create Quote" Button Not Gated on Conversion State**: The button renders when `row.status === 'claimed'` but does not additionally check if `converted_at` is already set or if an `operational_quotes` record exists for the intake. Even if the sync is fixed, a defense-in-depth check is warranted.

## Correctness Properties

Property 1: Bug Condition — No Duplicate Quote After RC Claim

_For any_ intake where `source_type = 'ringcentral'` and `claim_ringcentral_intake` is called successfully, the fixed system SHALL update `cs_intake_submissions` to set `status='converted'`, `converted_at=now()`, and `work_item_id` to the new quote ID, ensuring exactly one quote record exists for that intake and the UI cannot trigger a second quote creation.

**Validates: Requirements 2.1, 2.2**

Property 2: Preservation — Non-RC Flows and Existing Behavior Unchanged

_For any_ input where the bug condition does NOT hold (non-RC intakes, manager assignments, validation failures, standard claim-then-convert flow), the fixed system SHALL produce exactly the same behavior as the original system, preserving the two-step non-RC flow, concurrent claim rejection, and all existing UI interactions.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `supabase/migrations/v1.0.0-fn-create-quote-from-intake.sql`

**Function**: `_create_quote_from_intake`

**Specific Changes**:
1. **Add `cs_intake_submissions` sync step**: After step 6 (updating `customer_intakes`), add a step that updates the corresponding `cs_intake_submissions` row to set `status='converted'`, `converted_at=now()`, and `work_item_id=v_quote_id`. Use a conditional update (`UPDATE ... WHERE id = (SELECT id FROM cs_intake_submissions WHERE ... LIMIT 1)`) to handle cases where no matching submission exists (e.g., intakes created directly in `customer_intakes`).

---

**File**: `supabase/migrations/v0.9.8-stabilize-integrations.sql`

**Function**: `cs_intake_convert`

**Specific Changes**:
2. **Add idempotency guard**: After the existing validation checks (status='claimed', claimed_by not null), add a check:
   - Query `operational_quotes` for an existing record with `customer_intake_id` matching the intake linked to this submission
   - If found, update `cs_intake_submissions` to 'converted' state with the existing quote's ID, then return without creating a duplicate `work_items` record
   - This handles the race condition where `cs_intake_submissions` wasn't synced but an operational quote already exists

---

**File**: `src/features/cs-intake/IntakeQueue.tsx`

**Function**: `isRingcentralSource`

**Specific Changes**:
3. **Fix source detection heuristic**: Replace `Boolean(row.work_item_id)` with a check against `row.source_type === 'ringcentral'` if the column is available on `cs_intake_submissions`, OR add a `source_type` column to `cs_intake_submissions` populated during intake creation. Alternatively, check `row.quote_origin` or add a `ringcentral_call_id` field as a reliable indicator.

---

**File**: `src/features/cs-intake/IntakeQueue.tsx`

**UI Logic**: "Create Quote" button rendering

**Specific Changes**:
4. **Gate "Create Quote" on conversion state**: Add `!hasLinkedQuote` condition to the "Create Quote" button's render guard. Currently the button shows when `canConvert && row.status === 'claimed' && !isDeleted`. Change to `canConvert && row.status === 'claimed' && !isDeleted && !hasLinkedQuote`. This is defense-in-depth — if the sync works correctly, `row.status` would be 'converted' already, but this guards against timing issues.

5. **Gate modal "Create Quote" button similarly**: Apply the same `!hasLinkedQuote` guard to the modal's "Create Quote" button that renders when `selected.submission.status === 'claimed'`.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that simulate the RC claim flow and then check the state of `cs_intake_submissions`. Run these on UNFIXED code to observe the desynchronization.

**Test Cases**:
1. **RC Claim Leaves Submission Stale**: Call `claim_ringcentral_intake`, then query `cs_intake_submissions` — assert `converted_at` is NULL (will pass on unfixed code, confirming the bug)
2. **Duplicate Quote Creation**: Call `claim_ringcentral_intake`, then call `cs_intake_convert` on the same submission — assert two quote records exist (will succeed on unfixed code, demonstrating the duplicate)
3. **isRingcentralSource Returns False**: After RC claim, check that `work_item_id` is NULL in `cs_intake_submissions` — confirms the heuristic fails
4. **UI Shows Create Quote Button**: After RC claim, assert that a row with status='claimed' and no `converted_at` renders the "Create Quote" button (will succeed on unfixed code)

**Expected Counterexamples**:
- `cs_intake_submissions.converted_at` remains NULL after successful `claim_ringcentral_intake`
- `cs_intake_convert` succeeds and creates `work_items` even when `operational_quotes` record exists
- `isRingcentralSource()` returns `false` for a legitimately RC-sourced intake

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := claim_ringcentral_intake'(input.intake_id)
  cs_row := cs_intake_submissions[input.intake_id]
  ASSERT cs_row.converted_at IS NOT NULL
  ASSERT cs_row.status = 'converted'
  ASSERT cs_row.work_item_id = result
  ASSERT count(operational_quotes WHERE customer_intake_id = input.intake_id) = 1
  // Attempting cs_intake_convert after should be idempotent
  convert_result := cs_intake_convert'(input.submission_id)
  ASSERT count(operational_quotes WHERE customer_intake_id = input.intake_id) = 1
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT claim_ringcentral_intake_original(input) = claim_ringcentral_intake_fixed(input)
  ASSERT cs_intake_convert_original(input) = cs_intake_convert_fixed(input)
  ASSERT isRingcentralSource_original(input) = isRingcentralSource_fixed(input)
    WHERE input.source_type != 'ringcentral'
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (various intake types, statuses, roles)
- It catches edge cases that manual unit tests might miss (e.g., intakes in draft status, deleted intakes)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for non-RC intakes and standard flows, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Non-RC Claim Preservation**: Verify `cs_intake_claim` for non-RC intakes continues to set status='claimed' without auto-converting
2. **Standard Convert Preservation**: Verify `cs_intake_convert` for intakes with no existing `operational_quotes` record continues to create `work_items` as before
3. **Manager Assignment Preservation**: Verify `assign_customer_intake` behavior is identical before and after fix
4. **Validation Failure Preservation**: Verify error cases (wrong agent, unavailable, already claimed) continue to raise the same exceptions

### Unit Tests

- Test `_create_quote_from_intake` updates `cs_intake_submissions` when a matching row exists
- Test `_create_quote_from_intake` succeeds gracefully when no `cs_intake_submissions` row exists (direct `customer_intakes` only)
- Test `cs_intake_convert` idempotency guard returns existing quote when `operational_quotes` record exists
- Test `cs_intake_convert` still creates `work_items` when no prior operational quote exists
- Test `isRingcentralSource()` correctly identifies RC-sourced rows regardless of `work_item_id`
- Test "Create Quote" button is hidden when `converted_at` is set

### Property-Based Tests

- Generate random intake configurations (RC/non-RC, various statuses) and verify `claim_ringcentral_intake` always leaves `cs_intake_submissions` in sync
- Generate random sequences of claim + convert actions and verify at most one quote exists per intake
- Generate random `CsIntakeSubmission` rows with varying fields and verify `isRingcentralSource()` produces correct results for all combinations

### Integration Tests

- Test full RC claim flow: create intake → submit → claim via RC → verify both tables synced → verify UI hides "Create Quote"
- Test full non-RC flow: create intake → submit → general claim → convert → verify one quote exists
- Test race condition: RC claim succeeds then `cs_intake_convert` called → verify idempotency guard prevents duplicate
- Test UI refresh cycle: after RC claim, verify `listQueue()` returns the row with status='converted' and `converted_at` set
