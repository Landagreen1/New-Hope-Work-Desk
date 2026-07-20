# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Bidirectional Outcome Change Blocked
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the bug exists (no generalized bidirectional outcome change)
  - **Scoped PBT Approach**: Scope the property to finalized quote outcomes where current_decision != desired_decision, owned by an active agent
  - Test that calling `change_quote_outcome` RPC does not exist on unfixed code (function missing)
  - Test that a sold outcome has no mechanism to revert to not_sold (sold → not_sold completely blocked)
  - Test that `convert_my_not_sold_quote_to_sold` only handles one direction (not_sold → sold) and is not a generalized bidirectional mechanism
  - Test that the UI does not render a "Change Outcome" button for sold quotes (no action available)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Operational Transitions, Ownership Guards, and Backward Compat Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: `finalize_my_active_quote` and `finalize_pending_pricing_quote` RPCs continue to work for forward-progression transitions on unfixed code
  - Observe: Attempting to change another agent's outcome is rejected on unfixed code
  - Observe: Inactive or non-agent profiles are rejected when attempting outcome operations on unfixed code
  - Observe: `convert_my_not_sold_quote_to_sold` works correctly for its original not_sold → sold use case on unfixed code
  - Observe: `add_quote_note` continues to work unchanged on unfixed code
  - Observe: `QUOTE_TRANSITIONS` map enforces forward-only operational flow (sold/not_sold have empty outbound arrays)
  - Write property-based test: for all non-outcome-change operations (operational transitions, note additions, log views), behavior is identical
  - Write property-based test: for all outcome modification attempts by non-owning agents, the system rejects identically
  - Write property-based test: for all attempts by inactive/non-agent profiles, the system rejects identically
  - Write property-based test: `convert_my_not_sold_quote_to_sold` with valid not_sold outcome + note succeeds
  - Verify tests pass on UNFIXED code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Database migration — new `change_quote_outcome` RPC + backward compat wrapper

  - [x] 3.1 Create migration file `supabase/migrations/v1.1.0-quote-outcome-rework.sql`
    - Create `change_quote_outcome(p_outcome_id uuid, p_new_decision quote_decision, p_not_sold_reason text DEFAULT NULL, p_not_sold_reason_other text DEFAULT NULL, p_note text)` RPC
    - Validate: active agent profile (`role = 'agent'`, `is_active = true`)
    - Validate: note is non-empty (trimmed)
    - Validate: outcome belongs to calling agent (`assigned_profile_id = auth.uid()`)
    - Validate: new decision differs from current decision (no-op guard)
    - For `sold → not_sold`: require valid `not_sold_reason`, set reason fields, set `decision = 'not_sold'`, update `finalized_at = now()`
    - For `not_sold → sold`: clear `not_sold_reason` and `not_sold_reason_other`, set `decision = 'sold'`, update `finalized_at = now()`
    - Insert `work_item_events` row: `event_type = 'outcome_change'`, details JSON with previous_decision, new_decision, reason, note
    - Insert `audit_log` row: action `'change_quote_outcome'`, old_value (previous decision + reason), new_value (new decision + finalized_at), reason = note
    - Insert `quote_notes` row documenting the change with agent username reference
    - Return updated `quote_outcomes` row
    - `REVOKE EXECUTE ON FUNCTION change_quote_outcome FROM public, anon`
    - `GRANT EXECUTE ON FUNCTION change_quote_outcome TO authenticated`
    - _Bug_Condition: isBugCondition(input) where current_decision != desired_decision for owned outcomes_
    - _Expected_Behavior: Bidirectional outcome change with audit trail from design_
    - _Preservation: Only decision, finalized_at, not_sold_reason, not_sold_reason_other change; all other fields preserved_
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 3.2 Rewrite `convert_my_not_sold_quote_to_sold` as thin wrapper
    - Replace function body to call `change_quote_outcome(p_outcome_id, 'sold', NULL, NULL, p_note)` internally
    - Maintain same signature `(p_outcome_id uuid, p_note text) returns quote_outcomes`
    - Keep existing `REVOKE/GRANT` permissions unchanged
    - _Preservation: Existing callers of convert_my_not_sold_quote_to_sold continue to work identically_
    - _Requirements: 3.2_

- [x] 4. TypeScript types updates

  - [x] 4.1 Add `QuoteDecision` type to `src/features/quotes/types.ts`
    - Add `export type QuoteDecision = 'sold' | 'not_sold';` (if not already present)
    - Add comment on `finalized_at` in relevant interfaces: `/** Canonical reporting date — use this for period attribution, not quote_created_at */`
    - _Requirements: 2.5_

  - [x] 4.2 Add `NotSoldReason` type if not already exported
    - Ensure the not_sold_reason enum values are typed for the modal form
    - _Requirements: 2.1_

- [x] 5. UI modal and button changes in `src/components/work-desk-app.tsx`

  - [x] 5.1 Add `"change_outcome"` to `ModalKind` type union
    - Add modal state: `changeOutcomeRecord: QuoteRecord | null`
    - _Requirements: 2.6_

  - [x] 5.2 Create `requestChangeOutcome` handler function
    - Accepts a `QuoteRecord` (the finalized outcome row)
    - Sets `changeOutcomeRecord` and opens `"change_outcome"` modal
    - _Requirements: 2.6_

  - [x] 5.3 Create `submitChangeOutcome` handler function
    - Extract form values: note (required), not_sold_reason (if changing to not_sold), not_sold_reason_other (if reason = 'other')
    - Determine target decision: if current is 'sold' → target 'not_sold'; if current is 'not_sold' → target 'sold'
    - Validate: note is non-empty; if target is 'not_sold', reason is required; if reason is 'other', other text is required
    - Call `runRpc('change_quote_outcome', { p_outcome_id, p_new_decision, p_not_sold_reason, p_not_sold_reason_other, p_note }, successMessage)`
    - On success: close modal, clear state, refresh quotes
    - _Bug_Condition: isBugCondition(input) where agent invokes bidirectional change_
    - _Expected_Behavior: RPC called with correct params, outcome updated in UI_
    - _Preservation: Does not affect other modal flows or RPC calls_
    - _Requirements: 2.1, 2.2, 2.6_

  - [x] 5.4 Render "Change Outcome" button on finalized quotes
    - Show on ALL finalized quote outcomes where `quote.assignedProfileId === currentUserId`
    - Renders for both Sold and Not Sold outcomes owned by the current agent
    - Button label: "Change Outcome"
    - Button style: neutral outline/border (not directional green/red)
    - On click: call `requestChangeOutcome(record)`
    - _Requirements: 2.6_

  - [x] 5.5 Render `"change_outcome"` modal content
    - Show current decision prominently (badge or label)
    - Show target decision: "Change to Not Sold" or "Change to Sold"
    - If target is `not_sold`: render NotSoldReason radio group + conditional "Other" text field (reuse existing pattern from `submitNotSoldReason`)
    - Always: required note textarea with placeholder explaining mandatory explanation
    - Submit button calls `submitChangeOutcome`
    - Cancel button closes modal
    - _Requirements: 2.1, 2.2, 2.6_

- [x] 6. Remove old `reopen_not_sold` code in favor of new `change_outcome` pattern

  - [x] 6.1 Remove `requestReopenNotSold` function and `reopenNotSoldRecord` state
    - Remove the `"reopen_not_sold"` modal kind from the union
    - Remove `submitReopenNotSold` function
    - Remove "Mark Sold" button that previously called `requestReopenNotSold`
    - The new "Change Outcome" button on Not Sold quotes replaces this functionality
    - _Preservation: Backward compat maintained at RPC level (wrapper); UI uses new generalized flow_
    - _Requirements: 2.2, 2.6_

  - [x] 6.2 Remove `"reopen_not_sold"` modal rendering
    - Remove the modal JSX that was rendered for `modal === "reopen_not_sold"`
    - Replaced entirely by the `"change_outcome"` modal
    - _Requirements: 2.6_

- [x] 7. Add `finalized_at` canonical date comments

  - [x] 7.1 Add comment in `src/features/quotes/types.ts`
    - On any interface or type that includes `finalized_at`, add JSDoc: `/** Canonical reporting date — use finalized_at for period attribution, not quote_created_at */`
    - _Requirements: 2.5_

  - [x] 7.2 Add comment in migration file
    - Add SQL comment on the `change_quote_outcome` function noting: `-- finalized_at is the canonical reporting date; updated on every outcome change`
    - _Requirements: 2.5_

- [x] 8. Verify fixes

  - [x] 8.1 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Bidirectional Outcome Change Works
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_

  - [x] 8.2 Verify preservation tests still pass
    - **Property 2: Preservation** - Operational Transitions, Ownership Guards, and Backward Compat Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 9. Checkpoint - Ensure all tests pass
  - Run full test suite to verify no regressions
  - Verify `change_quote_outcome` RPC handles sold → not_sold and not_sold → sold correctly
  - Verify `convert_my_not_sold_quote_to_sold` wrapper still functions for backward compat
  - Verify UI renders "Change Outcome" button on agent's own finalized quotes
  - Verify modal correctly shows reason selector only when changing to not_sold
  - Verify old `reopen_not_sold` code is fully removed
  - Verify `finalized_at` comments are in place for reporting context
  - Ensure all tests pass, ask the user if questions arise
