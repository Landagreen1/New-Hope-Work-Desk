# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - RC Claim Leaves cs_intake_submissions Out of Sync (Duplicate Quote)
  - **IMPORTANT**: Write this property-based test BEFORE implementing the fix
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists
  - **Scoped PBT Approach**: Scope the property to the concrete failing case: after `claim_ringcentral_intake` succeeds for a RingCentral-sourced intake, verify `cs_intake_submissions` is synchronized
  - **Bug Condition**: `isBugCondition(X)` where `X.source_type = 'ringcentral' AND X.action = 'claim_ringcentral_intake' AND cs_intake_submissions[X.intake_id].converted_at IS NULL AND operational_quotes WHERE customer_intake_id = X.intake_id EXISTS`
  - Test that after `claim_ringcentral_intake(intake_id)` succeeds:
    - `cs_intake_submissions` row has `converted_at IS NOT NULL`
    - `cs_intake_submissions` row has `status = 'converted'`
    - `cs_intake_submissions` row has `work_item_id` set to the new quote ID
    - Calling `cs_intake_convert` on the same submission does NOT create a second quote record
    - `count(operational_quotes WHERE customer_intake_id = intake_id) = 1`
  - Also test that `isRingcentralSource(row)` correctly identifies RC-sourced intakes when `work_item_id` is NULL but `source_type = 'ringcentral'`
  - Also test that "Create Quote" button is hidden when `converted_at` is already set
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists: `cs_intake_submissions.converted_at` remains NULL, `cs_intake_convert` creates a duplicate, `isRingcentralSource()` returns false for RC intakes)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-RC Claim Flows and Existing Behavior Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - **Observe on UNFIXED code**:
    - `cs_intake_claim` for non-RC intakes sets status='claimed' without auto-converting
    - `cs_intake_convert` for intakes with no existing `operational_quotes` record creates `work_items` as before
    - `assign_customer_intake` / `managerAssignIntake` continues to create exactly one quote and update both tables
    - Validation failures (wrong agent, unavailable, already claimed) raise the same exceptions
    - "Create Quote" button appears for legitimately claimed-but-not-converted non-RC intakes
  - Write property-based tests capturing observed behavior:
    - For all non-RC intakes (source_type != 'ringcentral'), `cs_intake_claim` sets status='claimed' without creating any quote record
    - For all intakes going through standard claim→convert flow (no prior `operational_quotes`), `cs_intake_convert` creates exactly one `work_items` entry
    - For all manager assignments, behavior is identical (one quote, both tables synced)
    - For all validation failures, same exceptions are raised with no partial state
    - `isRingcentralSource(row)` returns false for all non-RC intakes regardless of `work_item_id` state
  - Verify tests PASS on UNFIXED code
  - **EXPECTED OUTCOME**: Tests PASS (this confirms baseline behavior to preserve)
  - Mark task complete when tests are written, run, and passing on unfixed code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for RC Claim Duplicate Quote

  - [x] 3.1 Add `cs_intake_submissions` sync step to `_create_quote_from_intake`
    - File: `supabase/migrations/v1.0.0-fn-create-quote-from-intake.sql`
    - After step 6 (UPDATE customer_intakes with conversion link), add a new step that updates the corresponding `cs_intake_submissions` row:
      - Set `status = 'converted'`
      - Set `converted_at = now()`
      - Set `work_item_id = v_quote_id`
      - Set `updated_at = now()`
    - Use conditional update: `UPDATE cs_intake_submissions SET ... WHERE intake_id = p_intake_id` (or match via customer_intake_id / linked field)
    - Handle gracefully when no matching `cs_intake_submissions` row exists (intakes created directly in `customer_intakes`)
    - _Bug_Condition: isBugCondition(input) where input.source_type = 'ringcentral' AND cs_intake_submissions[input.intake_id].converted_at IS NULL_
    - _Expected_Behavior: cs_intake_submissions.converted_at IS NOT NULL, status='converted', work_item_id=quote_id_
    - _Preservation: Non-RC intakes and intakes without cs_intake_submissions rows are unaffected_
    - _Requirements: 2.1, 2.2_

  - [x] 3.2 Add idempotency guard to `cs_intake_convert`
    - File: `supabase/migrations/v0.9.8-stabilize-integrations.sql` (or new migration file)
    - After the existing validation checks (status='claimed', claimed_by not null), add:
      - Query `operational_quotes` for existing record with `customer_intake_id` matching the intake linked to this submission
      - If found: update `cs_intake_submissions` to status='converted', set `work_item_id` to existing operational quote ID, set `converted_at = now()`, then RETURN the existing quote ID without creating a duplicate `work_items` record
    - This handles the race condition where `cs_intake_submissions` wasn't synced but an operational quote already exists
    - _Bug_Condition: cs_intake_convert called when operational_quotes record already exists for intake_
    - _Expected_Behavior: Return existing quote ID, no duplicate work_items created, count(quotes) = 1_
    - _Preservation: When no prior operational_quotes record exists, cs_intake_convert continues to create work_items as before_
    - _Requirements: 2.3_

  - [x] 3.3 Fix `isRingcentralSource()` heuristic in IntakeQueue.tsx
    - File: `src/features/cs-intake/IntakeQueue.tsx`
    - Replace `return Boolean(row.work_item_id)` with a check that uses source metadata
    - Options (per design): check `row.source_type === 'ringcentral'` if available on `CsIntakeSubmission`, or check `row.quote_origin`, or add a `source_type` field to `cs_intake_submissions` populated during intake creation
    - Ensure the function correctly identifies RC-sourced intakes regardless of whether `work_item_id` has been set
    - _Bug_Condition: isRingcentralSource(row) returns false for RC intakes when work_item_id is NULL_
    - _Expected_Behavior: isRingcentralSource correctly returns true for all RC-sourced intakes_
    - _Preservation: Returns false for all non-RC intakes (dealer intakes, direct intakes, commercial intakes)_
    - _Requirements: 2.4_

  - [x] 3.4 Gate "Create Quote" button on conversion state
    - File: `src/features/cs-intake/IntakeQueue.tsx`
    - Table row button: Change `{canConvert && row.status === 'claimed' && !isDeleted ? (` to `{canConvert && row.status === 'claimed' && !isDeleted && !hasLinkedQuote ? (`
    - Modal button: Change `{(selected.submission.claimed_by === profile.id || isManager) && selected.submission.status === 'claimed' ? (` to add `&& !Boolean(selected.submission.converted_at)` condition
    - This is defense-in-depth: if the sync works correctly, `row.status` would already be 'converted', but this guards against timing issues
    - _Bug_Condition: UI shows "Create Quote" when converted_at is already set or operational_quotes record exists_
    - _Expected_Behavior: "Create Quote" hidden when hasLinkedQuote is true (converted_at set)_
    - _Preservation: "Create Quote" continues to appear for legitimately claimed-but-not-converted non-RC intakes_
    - _Requirements: 2.2_

  - [x] 3.5 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - RC Claim Leaves cs_intake_submissions In Sync (No Duplicate)
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms:
      - `cs_intake_submissions` is synced after `claim_ringcentral_intake`
      - `cs_intake_convert` is idempotent when operational quote already exists
      - `isRingcentralSource()` correctly identifies RC intakes
      - "Create Quote" button is hidden for already-converted intakes
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.6 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-RC Flows and Existing Behavior Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix:
      - Non-RC intakes still follow two-step claim→convert flow
      - Manager assignments still work identically
      - Concurrent claim attempts still fail atomically
      - Validation failures still roll back cleanly
      - "Create Quote" still appears for legitimately claimed-but-not-converted non-RC intakes

- [x] 4. Checkpoint - Ensure all tests pass
  - Run all exploration, preservation, and unit tests
  - Verify no regressions in existing test suite
  - Confirm the full RC claim flow works end-to-end:
    1. Create intake → submit → claim via RC → verify both tables synced → verify UI hides "Create Quote"
    2. Attempt `cs_intake_convert` after RC claim → verify idempotency (no duplicate)
  - Confirm non-RC flow is unaffected:
    1. Create non-RC intake → submit → general claim → convert → verify one quote exists
  - Ask the user if questions arise
