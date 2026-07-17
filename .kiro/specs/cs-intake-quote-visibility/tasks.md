# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Quote Visibility Missing for Converted Intakes
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Surface counterexamples that demonstrate the visibility gap exists
  - **Scoped PBT Approach**: Scope the property to converted intake rows (status='converted', work_item_id set) and assert expected UI elements are present
  - Test that rendering IntakeQueue with a converted intake row does NOT produce a quote status badge (confirms bug)
  - Test that rendering IntakeQueue with a converted intake row does NOT produce a "Quote Activity" button (confirms bug)
  - Test that rendering a `created_from_cs_intake` event does NOT show structured intake data sections (confirms bug)
  - Test that rendering IntakeQueue as manager with a converted intake does NOT produce a "Delete Quote" button (confirms bug)
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (this is correct - it proves the bug exists)
  - Document counterexamples found to understand root cause
  - Mark task complete when test is written, run, and failure is documented
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Non-Converted Intakes and Non-CS-Intake Quotes Unchanged
  - **IMPORTANT**: Follow observation-first methodology
  - Observe: Non-converted intake rows (draft, submitted, claimed, returned, rejected) render without any quote status column or Quote Activity button on unfixed code
  - Observe: Quotes not created from a CS intake render their existing activity log format without intake-specific sections on unfixed code
  - Observe: Non-manager users do not see delete options for any quote actions
  - Write property-based test: for all intake rows where status != 'converted' OR work_item_id IS NULL, no new quote-visibility UI elements are rendered
  - Write property-based test: for all work_item_events where event_type != 'created_from_cs_intake', the event renders with standard formatting (no intake-specific sections)
  - Write property-based test: for all non-manager users viewing converted intakes, no "Delete Quote" button is rendered
  - Verify tests pass on UNFIXED code
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Implement API layer for quote visibility

  - [x] 3.1 Add `getLinkedQuoteStatuses` batch function to `src/features/cs-intake/api.ts`
    - Accepts array of work_item_ids from converted intakes
    - Queries `work_items` table for `id` and `status` in a single SELECT ... WHERE id IN (...)
    - Returns `Map<string, string>` mapping work_item_id to status
    - Handles empty arrays gracefully (returns empty map)
    - _Bug_Condition: isBugCondition(input) where intake.status='converted' AND work_item_id IS NOT NULL_
    - _Expected_Behavior: CS agents see current quote status inline on converted rows_
    - _Preservation: Non-converted intakes are not queried_
    - _Requirements: 2.2_

  - [x] 3.2 Add `getLinkedQuoteEvents` function to `src/features/cs-intake/api.ts`
    - Accepts a single work_item_id
    - Queries `work_item_events` WHERE `source_work_item_id = workItemId` ordered by `created_at ASC`
    - Joins with `profiles` table to resolve actor display names
    - Returns array of events with `{ id, event_type, details, created_at, actor_name }`
    - _Bug_Condition: isBugCondition(input) where action='view_quote_event_log'_
    - _Expected_Behavior: CS agents can open read-only event log for linked quote_
    - _Preservation: Does not affect existing intake event queries_
    - _Requirements: 2.3_

  - [x] 3.3 Add `deleteLinkedWorkItem` function to `src/features/cs-intake/api.ts`
    - Accepts work_item_id and reason string
    - Updates `work_items` SET `status = 'cancelled'` WHERE `id = workItemId`
    - Inserts audit event into `work_item_events` with event_type='cancelled_from_cs_queue', details containing reason and actor
    - Returns success/failure
    - Manager-only: caller must verify role before invoking
    - _Bug_Condition: isBugCondition(input) where action='delete_linked_work_item' AND user_role='manager'_
    - _Expected_Behavior: Manager can soft-delete linked work item with audit trail_
    - _Preservation: Does not affect existing intake delete logic_
    - _Requirements: 2.4_

- [x] 4. Create `IntakeDataDisplay` component

  - [x] 4.1 Create `src/features/cs-intake/IntakeDataDisplay.tsx`
    - Accepts `details` prop typed as the JSONB object from `created_from_cs_intake` event
    - Renders structured sections: Insured Personal Info, Drivers list, Vehicles list, Coverage Preferences, Current Policy Info, CSR Notes
    - Handles missing/null fields gracefully (show "N/A" or omit section)
    - Uses `ui` utility from `../nhwd-shared/ui` for consistent styling (badges, cards, text)
    - Responsive layout suitable for modal display
    - _Bug_Condition: isBugCondition(input) where action='view_intake_details_in_quote'_
    - _Expected_Behavior: Full intake form data rendered in structured, readable format_
    - _Preservation: Component is new; no existing UI affected_
    - _Requirements: 2.1_

- [x] 5. Create `QuoteActivityModal` component

  - [x] 5.1 Create `src/features/cs-intake/QuoteActivityModal.tsx`
    - Accepts `workItemId`, `isOpen`, `onClose` props
    - On open, calls `getLinkedQuoteEvents(workItemId)` to fetch events
    - Renders timeline of events with human-readable labels, timestamps, and actor names
    - For `created_from_cs_intake` events, renders `IntakeDataDisplay` component with the event details
    - For other event types (price_sent, sold, not_sold, customer_contacted), renders standard event cards
    - Read-only modal (no edit actions)
    - Loading state and empty state handling
    - Uses existing modal pattern from the codebase
    - _Bug_Condition: isBugCondition(input) where action='view_quote_event_log'_
    - _Expected_Behavior: CS agents see full work_item_events timeline in modal_
    - _Preservation: Does not modify existing IntakeHistory modal_
    - _Requirements: 2.3_

- [x] 6. Update `IntakeQueue.tsx` with quote visibility features

  - [x] 6.1 Add quote status column to converted intake rows
    - Add state: `quoteStatuses: Map<string, string>` initialized on queue load
    - In the `refresh` function, after fetching intakes, extract `work_item_id`s from converted rows and call `getLinkedQuoteStatuses`
    - Render a "Quote Status" badge on converted rows showing the mapped status (Active, Pricing Sent, Sold, Not Sold, etc.)
    - Only render for rows where `converted_at` is truthy and `work_item_id` is set
    - Use color-coded badges consistent with existing status badge styling
    - _Bug_Condition: isBugCondition(input) where action='view_quote_status_in_queue'_
    - _Expected_Behavior: Quote status displayed inline on converted rows_
    - _Preservation: Non-converted rows render identically to current behavior_
    - _Requirements: 2.2, 3.1_

  - [x] 6.2 Add "Quote Activity" button for converted rows
    - Add state for QuoteActivityModal: `selectedQuoteWorkItemId`, `isQuoteActivityOpen`
    - Render "Quote Activity" button in the actions area for converted rows (visible to all roles)
    - On click, set `selectedQuoteWorkItemId` and open QuoteActivityModal
    - Place button alongside existing action buttons without disrupting layout
    - _Bug_Condition: isBugCondition(input) where action='view_quote_event_log'_
    - _Expected_Behavior: Button opens read-only event log modal_
    - _Preservation: Existing action buttons (Claim, Edit, History, Delete) unchanged_
    - _Requirements: 2.3, 3.1_

  - [x] 6.3 Add "Delete Quote" button for managers on converted rows
    - Only render when user role is 'manager' and row is converted
    - On click, show confirmation prompt with reason input
    - On confirm, call `deleteLinkedWorkItem(workItemId, reason)`
    - On success, refresh the queue to reflect updated status
    - Apply consistent destructive-action styling (red/warning)
    - _Bug_Condition: isBugCondition(input) where action='delete_linked_work_item' AND user_role='manager'_
    - _Expected_Behavior: Manager can soft-delete linked work item_
    - _Preservation: Non-manager users do not see this button; non-converted rows unaffected_
    - _Requirements: 2.4, 3.4_

  - [x] 6.4 Integrate quote status refresh with existing real-time subscription
    - When `cs_intake_submissions` subscription fires an update for a converted row, also refresh `quoteStatuses` for that work_item_id
    - Ensure the `refresh` function updates both intake data and quote statuses atomically
    - No degradation to existing real-time unclaimed/claimed count updates
    - _Preservation: Existing real-time subscription behavior unchanged for non-converted rows_
    - _Requirements: 3.3_

- [x] 7. Update `QuoteHistory.tsx` with intake data renderer

  - [x] 7.1 Add `created_from_cs_intake` event renderer to `QuoteHistory.tsx`
    - Import `IntakeDataDisplay` component
    - When rendering event with `event_type === 'created_from_cs_intake'`, use `IntakeDataDisplay` with `event.details`
    - For all other event types, render with existing logic (no changes)
    - _Bug_Condition: isBugCondition(input) where action='view_intake_details_in_quote'_
    - _Expected_Behavior: Sales agents see structured intake data in quote activity view_
    - _Preservation: Non-CS-intake quotes render identically_
    - _Requirements: 2.1, 3.2_

- [x] 8. Verify fixes

  - [x] 8.1 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Quote Visibility Present for Converted Intakes
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - The test from task 1 encodes the expected behavior
    - When this test passes, it confirms the expected behavior is satisfied
    - Run bug condition exploration test from step 1
    - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

  - [x] 8.2 Verify preservation tests still pass
    - **Property 2: Preservation** - Non-Converted Intakes and Non-CS-Intake Quotes Unchanged
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run preservation property tests from step 2
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Confirm all tests still pass after fix (no regressions)

- [x] 9. Checkpoint - Ensure all tests pass
  - Run full test suite to verify no regressions
  - Verify IntakeQueue renders correctly for all intake statuses
  - Verify QuoteHistory renders correctly for CS-intake and non-CS-intake quotes
  - Ensure all tests pass, ask the user if questions arise
