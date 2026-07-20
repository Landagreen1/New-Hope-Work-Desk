# Quote Outcome Rework — Bugfix Design

## Overview

The quote outcome system currently treats `sold` and `not_sold` as absolute terminal states. The only recovery path is a narrow `convert_my_not_sold_quote_to_sold` RPC — agents cannot reverse a sold outcome or use a generalized mechanism. Additionally, reporting queries use `quote_created_at` instead of `finalized_at` for date attribution. This design introduces a generalized `change_quote_outcome` RPC that handles bidirectional outcome changes, a unified "Change Outcome" modal in the agent's quotes tab, and establishes `finalized_at` as the canonical reporting date column.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug — an agent owns a finalized quote but cannot change its outcome (sold → not_sold is impossible; not_sold → sold only via narrow RPC)
- **Property (P)**: The desired behavior — bidirectional outcome changes with proper audit trail, and `finalized_at` used for report date attribution
- **Preservation**: Existing operational quote transitions (assigned → quoting → pricing_sent etc.), other agents' ownership protections, and the old RPC's backward compatibility
- **`change_quote_outcome`**: The new generalized Supabase RPC function in a migration SQL file that replaces the narrow conversion pattern
- **`quote_outcomes`**: The table storing finalized quote decisions with columns: id, source_work_item_id, customer_name, dealer_id, salesperson_id, work_type, original_owner_profile_id, assigned_profile_id, assignment_method, received_through, quote_created_at, assigned_at, accepted_at, price_sent_at, finalized_at, decision, not_sold_reason, not_sold_reason_other
- **`finalized_at`**: Timestamp of when the outcome was last determined — the canonical date for reporting period attribution

## Bug Details

### Bug Condition

The bug manifests when an agent owns a finalized quote outcome and needs to change the decision. The system either completely blocks the change (sold → not_sold) or forces the agent through a narrow, single-direction RPC (not_sold → sold via `convert_my_not_sold_quote_to_sold`). There is no generalized bidirectional outcome change.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type QuoteOutcomeChangeRequest
  OUTPUT: boolean

  RETURN (input.current_decision = 'sold' AND input.desired_decision = 'not_sold')
      OR (input.current_decision = 'not_sold' AND input.desired_decision = 'sold'
          AND input.uses_generalized_path = true)
END FUNCTION
```

### Examples

- Agent finalizes quote as Sold, but the customer later cancels. Agent cannot change outcome back to Not Sold — no UI button, no RPC exists. They must ask a manager to manually edit the database.
- Agent finalizes quote as Not Sold, but the customer later buys. Agent can currently use "Mark Sold" (calls `convert_my_not_sold_quote_to_sold`), but this is the only direction supported and uses a bespoke RPC rather than a unified mechanism.
- Agent marks quote Sold incorrectly (wrong customer or duplicate entry). The system offers no correction path.
- Reporting shows a sale on the day the quote was created (April 1) when the actual sale happened on May 15. The report attributes to `quote_created_at` instead of `finalized_at`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Operational quote forward-progression (assigned → quoting → pricing_sent → activation_pending → activated) must continue enforcing `QUOTE_TRANSITIONS` with no outbound transitions from terminal states in the operational flow
- Mouse clicks, table rendering, quote log viewing, note adding must all continue unchanged
- Other agents cannot modify outcomes they don't own (`assigned_profile_id` ownership check)
- Inactive profiles and non-agent roles are rejected
- All original fields on the outcome row (quote_created_at, assigned_at, accepted_at, price_sent_at, source_work_item_id, assigned_profile_id, assignment_method, received_through) are preserved — only decision, finalized_at, not_sold_reason, and not_sold_reason_other change
- The existing `convert_my_not_sold_quote_to_sold` RPC remains functional as a thin wrapper around the new generalized RPC (backward compatibility)

**Scope:**
All inputs that do NOT involve changing a finalized outcome's decision should be completely unaffected. This includes:
- Operational quote status transitions via `finalize_my_active_quote`, `finalize_pending_pricing_quote`
- Adding quote notes, viewing quote logs
- Manager views and admin operations
- Turn rotation, assignment, and claim operations

## Hypothesized Root Cause

Based on the bug description, the root causes are:

1. **Missing RPC for sold → not_sold**: No database function exists to change a sold outcome back to not_sold. The `QUOTE_TRANSITIONS` map marks both `sold` and `not_sold` as terminal with empty outbound arrays, and no RPC was ever written for the reverse direction.

2. **Narrow single-purpose RPC**: `convert_my_not_sold_quote_to_sold` was written as a one-off recovery tool rather than a generalized outcome change mechanism. It hardcodes the not_sold → sold direction and cannot be extended without duplication.

3. **UI only exposes "Mark Sold" button**: The quotes tab only renders a "Mark Sold" button for Not Sold quotes. No corresponding button exists for Sold quotes, and no generalized "Change Outcome" action is available.

4. **Report date attribution to wrong column**: Reporting queries (to be reworked next) use `quote_created_at` for period grouping. This was the original design before `finalized_at` was added in v0.7.0 and is simply a legacy query pattern that was never updated.

## Correctness Properties

Property 1: Bug Condition - Bidirectional Outcome Change

_For any_ input where an active agent owns a finalized quote outcome and requests a decision change (sold → not_sold with reason, or not_sold → sold) with a non-empty note, the fixed `change_quote_outcome` RPC SHALL update the decision, set `finalized_at` to the current timestamp, clear or set `not_sold_reason`/`not_sold_reason_other` appropriately, log a `work_item_events` entry with `event_type = 'outcome_change'`, insert an `audit_log` entry with action `'change_quote_outcome'`, and return the updated outcome row.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4**

Property 2: Preservation - Non-Outcome-Change Operations

_For any_ input that is NOT a request to change a finalized outcome's decision (operational transitions, note additions, quote log views, other agents' outcomes, inactive profiles), the fixed code SHALL produce exactly the same behavior as the original code, preserving all existing functionality for non-outcome-change interactions.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

Property 3: Reporting Date Attribution

_For any_ quote outcome row, the canonical date for reporting period attribution SHALL be `finalized_at`, never `quote_created_at`. The `finalized_at` column is updated to `now()` on each outcome change, ensuring reports reflect when the decision was last determined.

**Validates: Requirements 2.5**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `supabase/migrations/v{next}.sql` (new migration)

**Function**: `change_quote_outcome`

**Specific Changes**:

1. **New generalized RPC `change_quote_outcome`**:
   - Parameters: `p_outcome_id uuid`, `p_new_decision quote_decision`, `p_not_sold_reason text DEFAULT NULL`, `p_not_sold_reason_other text DEFAULT NULL`, `p_note text`
   - Validates: active agent profile, note is non-empty, outcome belongs to calling agent
   - For `not_sold → sold`: clears reason fields, sets `decision = 'sold'`, updates `finalized_at = now()`
   - For `sold → not_sold`: requires valid `not_sold_reason`, sets reason fields, sets `decision = 'not_sold'`, updates `finalized_at = now()`
   - Rejects same-decision changes (no-op guard)
   - Inserts `work_item_events` row with `event_type = 'outcome_change'` and details JSON
   - Inserts `audit_log` row with action `'change_quote_outcome'`
   - Inserts a `quote_notes` row documenting the change
   - Returns the updated `quote_outcomes` row

2. **Deprecate/wrap old RPC**:
   - Rewrite `convert_my_not_sold_quote_to_sold` body to call `change_quote_outcome(p_outcome_id, 'sold', NULL, NULL, p_note)` internally — maintains backward compatibility for any existing callers

3. **Grant/revoke permissions**:
   - `REVOKE EXECUTE ON FUNCTION change_quote_outcome FROM public, anon`
   - `GRANT EXECUTE ON FUNCTION change_quote_outcome TO authenticated`

**File**: `src/components/work-desk-app.tsx`

**UI Changes**:

4. **Replace "Mark Sold" button with "Change Outcome" button**:
   - Show on ALL finalized quotes where `quote.assignedProfileId === currentUserId` (both Sold and Not Sold)
   - Button label: "Change Outcome"
   - Button style: neutral (border/outline) rather than directional green/red

5. **New modal `"change_outcome"`**:
   - Shows current decision prominently
   - Target decision is the opposite (sold shows "Change to Not Sold", not_sold shows "Change to Sold")
   - If target is not_sold: render NotSoldReason radio group + conditional "Other" text field (reuse existing pattern from `submitNotSoldReason`)
   - Always: required note textarea
   - Submit calls new `change_quote_outcome` RPC

6. **Update modal type union**:
   - Add `"change_outcome"` to the `ModalKind` type
   - Add state: `changeOutcomeRecord: QuoteRecord | null`

7. **`finalized_at` as canonical date** (documentation/comment only for now):
   - Add a comment in the QuoteOutcome type noting `finalized_at` is the reporting date
   - No query changes in this spec — reports are reworked in the next spec

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Attempt to call the new RPC signature on unfixed code (it won't exist), and verify that the existing system has no mechanism for sold → not_sold changes. Also verify that `convert_my_not_sold_quote_to_sold` is the only path for not_sold → sold.

**Test Cases**:
1. **Sold → Not Sold blocked**: Call `change_quote_outcome` with a sold outcome → function doesn't exist (will fail on unfixed code)
2. **No UI button for Sold quotes**: Render agent quotes tab with a Sold quote → no "Change Outcome" button appears (will fail on unfixed code since no button exists at all)
3. **Old RPC only works one direction**: Call `convert_my_not_sold_quote_to_sold` with a sold outcome → correctly rejects (confirming the narrow scope)
4. **finalized_at not used in reports**: Check report queries reference `quote_created_at` for grouping (demonstrates the attribution bug)

**Expected Counterexamples**:
- No function `change_quote_outcome` exists in the database
- Sold quotes in the UI have no action button for outcome reversal
- The only outcome change path is `convert_my_not_sold_quote_to_sold` which is unidirectional

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := change_quote_outcome(input.outcome_id, input.new_decision, input.reason, input.reason_other, input.note)
  ASSERT result.decision = input.new_decision
  ASSERT result.finalized_at >= input.request_time
  ASSERT work_item_events contains row with source_work_item_id AND event_type = 'outcome_change'
  ASSERT audit_log contains row with entity_id = input.outcome_id AND action = 'change_quote_outcome'
  ASSERT quote_notes contains row with the change documentation
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT original_system(input) = fixed_system(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (random agent IDs, random outcome states, non-agent roles)
- It catches edge cases that manual unit tests might miss (concurrent changes, null fields, boundary conditions)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for operational transitions, ownership guards, and role checks, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Operational transition preservation**: Verify that `finalize_my_active_quote` and `finalize_pending_pricing_quote` continue to work exactly as before
2. **Ownership guard preservation**: Verify that attempting to change another agent's outcome is rejected identically
3. **Role guard preservation**: Verify that non-agent/inactive profiles are rejected identically
4. **Old RPC backward compatibility**: Verify `convert_my_not_sold_quote_to_sold` continues to work for its original use case
5. **Note adding preservation**: Verify `add_quote_note` continues to work unchanged

### Unit Tests

- Test `change_quote_outcome` with sold → not_sold (valid reason, valid note) → success
- Test `change_quote_outcome` with not_sold → sold (valid note) → success
- Test `change_quote_outcome` with empty note → rejection
- Test `change_quote_outcome` with outcome owned by different agent → rejection
- Test `change_quote_outcome` with inactive profile → rejection
- Test `change_quote_outcome` with same decision (sold → sold) → rejection
- Test `change_quote_outcome` sold → not_sold without reason → rejection
- Test that `convert_my_not_sold_quote_to_sold` still works (backward compat wrapper)
- Test UI renders "Change Outcome" button for agent's own Sold quotes
- Test UI renders "Change Outcome" button for agent's own Not Sold quotes
- Test UI does NOT render "Change Outcome" button for other agents' quotes
- Test modal shows reason selector when changing to not_sold
- Test modal hides reason selector when changing to sold

### Property-Based Tests

- Generate random (decision, new_decision, reason, note, ownership) tuples and verify the RPC accepts valid changes and rejects invalid ones according to the formal bug condition
- Generate random non-outcome-change operations and verify preservation of existing behavior
- Generate random outcome rows and verify `finalized_at` is always updated to current time on change

### Integration Tests

- Test full flow: agent views quotes → clicks "Change Outcome" on Sold quote → modal opens → selects Not Sold reason → enters note → submits → outcome updated in list
- Test full flow: agent views quotes → clicks "Change Outcome" on Not Sold quote → modal opens → enters note → submits → outcome updated in list
- Test that quote log shows the outcome change event after submission
- Test that the old "Mark Sold" button is replaced by the new generalized button
