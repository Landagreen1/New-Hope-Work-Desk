# CS Intake Quote Visibility Bugfix Design

## Overview

After a CS intake is converted into a Work Desk quote, three user roles lose visibility into the quote lifecycle:

1. **Sales agents** see only a raw `created_from_cs_intake` event in their quote's activity log without the structured intake form data (drivers, vehicles, coverage details, notes).
2. **CS agents** cannot see the converted quote's current status or event log from the CS Intake Queue, making it impossible to answer customer follow-up calls.
3. **Managers** cannot soft-delete the linked work item/quote from the CS Intake Queue when a conversion was erroneous.

The fix surfaces existing data that is already stored (the `work_item_events.details` JSONB contains full intake data) and adds a thin visibility layer in the CS Intake Queue for converted rows.

## Glossary

- **Bug_Condition (C)**: The condition that triggers the visibility gap — a CS intake has `status = 'converted'` AND `work_item_id IS NOT NULL`, and the user needs quote status, intake details in the quote view, or event log access
- **Property (P)**: The desired behavior — sales agents see structured intake data in the quote activity view, CS agents see quote status inline and can open a read-only event log, managers can soft-delete linked work items
- **Preservation**: Existing queue behavior for non-converted intakes, existing mouse/keyboard interactions, existing quote views for non-CS-intake quotes, and existing delete/restore for the intake itself
- **work_item_events**: Immutable table storing lifecycle events for work items (quotes). The `created_from_cs_intake` event stores full intake form data in its `details` JSONB column
- **quote_history_events**: Newer table tracking operational quote lifecycle events (used by the v1.0.0 operational quotes system)
- **CsIntakeSubmission**: TypeScript type representing a row in `cs_intake_submissions` — includes `work_item_id` and `converted_at` fields that link to the converted quote
- **work_items.status**: Enum (`active`, `price_sent`, `sold`, `not_sold`, `completed`, `cancelled`) — the current state of a quote in the Work Desk

## Bug Details

### Bug Condition

The bug manifests when a CS intake has been converted into a Work Desk quote (status = 'converted', work_item_id is set) and any user needs visibility into the converted quote's lifecycle. The system stores full intake data in `work_item_events.details` but does not render it. The CS Intake Queue shows no quote status or event log access for converted rows.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type IntakeQueueInteraction
  OUTPUT: boolean
  
  RETURN input.intake.status = 'converted'
         AND input.intake.work_item_id IS NOT NULL
         AND (
           input.action = 'view_quote_status_in_queue'
           OR input.action = 'view_quote_event_log'
           OR input.action = 'view_intake_details_in_quote'
           OR input.action = 'delete_linked_work_item'
         )
END FUNCTION
```

### Examples

- **CS agent checks quote status**: Intake row shows "Converted" badge but no indication of whether the quote is Active, Pricing Sent, or Sold. The agent cannot answer a customer callback without interrupting the sales agent.
- **Sales agent opens quote activity**: The `created_from_cs_intake` event is logged but only shows as a plain event entry without the structured insured info, drivers, vehicles, coverage preferences, or CSR notes that are stored in `details`.
- **CS agent wants to view quote progress**: No button or modal exists to show the work_item_events timeline for the linked quote from the CS Intake Queue.
- **Manager needs to delete erroneous conversion**: The existing Delete button deletes the intake itself, but the linked work item in `work_items` remains orphaned with no cascade or separate delete option.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Non-converted intake rows (draft, submitted, claimed, returned, rejected, deleted) display identically to current behavior with no new UI elements
- Existing Claim, Create Quote, Edit, History, Delete, Assign, Return actions continue to work without modification
- Quotes not created from a CS intake display their existing activity log format without intake-specific sections
- Real-time queue updates (unclaimed count, claimed count, filtering, search) continue without degradation
- The existing `IntakeHistory` component for CS intake events (not work item events) remains unchanged
- Mouse clicks, keyboard interactions, and all existing non-quote-visibility actions are unaffected

**Scope:**
All inputs that do NOT involve viewing converted-quote data should be completely unaffected by this fix. This includes:
- Viewing, claiming, editing, or deleting non-converted intakes
- Normal Work Desk quote interactions for non-CS-intake quotes
- Real-time subscription behavior and queue refresh logic
- Existing history timeline for intake lifecycle events

## Hypothesized Root Cause

Based on the bug description and code analysis, the root causes are:

1. **Missing Quote Status Column in CS Queue**: The `IntakeQueue.tsx` component has no column or inline element that fetches and displays `work_items.status` for converted rows. The `listAllIntakes()` and `listQueue()` API calls only query `cs_intake_submissions` without joining to `work_items`.

2. **Missing Event Log Access for CS Agents**: There is no "Quote Activity" button or modal in the queue for converted rows. The existing `IntakeHistory` component shows `cs_intake_events` (intake lifecycle), not `work_item_events` (quote lifecycle).

3. **Intake Data Not Rendered in Quote View**: The `created_from_cs_intake` event stores full intake data in `work_item_events.details` JSONB, but the `QuoteHistory.tsx` component does not have a renderer for this event type. It falls through to a generic details display.

4. **No Cascade Delete for Linked Work Items**: The existing `deleteCustomerIntake` RPC soft-deletes the intake record but does not touch the linked `work_items` row. There is no mechanism to soft-delete a work item from the CS Intake Queue context.

## Correctness Properties

Property 1: Bug Condition - Quote Status Visible to CS Agents

_For any_ converted intake row where `work_item_id IS NOT NULL` and the user has role 'agent' or 'manager' viewing the CS Intake Queue, the queue SHALL display the current quote status (active, price_sent, sold, not_sold, completed, cancelled) inline on that row.

**Validates: Requirements 2.2**

Property 2: Bug Condition - Quote Event Log Accessible

_For any_ converted intake row where `work_item_id IS NOT NULL` and the user has role 'agent' or 'manager', the queue SHALL provide a "Quote Activity" button that opens a read-only modal displaying all `work_item_events` for the linked work item, with human-readable labels and timestamps.

**Validates: Requirements 2.3**

Property 3: Bug Condition - Intake Details Rendered in Quote Activity

_For any_ work item event with `event_type = 'created_from_cs_intake'`, the quote activity view SHALL render the `details` JSONB as structured, readable sections: insured personal info, drivers list, vehicles list, coverage preferences, current policy info, and CSR notes.

**Validates: Requirements 2.1**

Property 4: Bug Condition - Manager Can Soft-Delete Linked Work Item

_For any_ converted intake where the user has role 'manager', the system SHALL provide a soft-delete option for the linked work item that marks it as cancelled with an audit trail, accessible only to managers.

**Validates: Requirements 2.4**

Property 5: Preservation - Non-Converted Intakes Unchanged

_For any_ intake row where `status != 'converted'` OR `work_item_id IS NULL`, the queue SHALL render identically to the current implementation with no new columns, buttons, or UI elements affecting those rows.

**Validates: Requirements 3.1, 3.3, 3.4, 3.5**

Property 6: Preservation - Non-CS-Intake Quotes Unchanged

_For any_ quote in the Work Desk that was NOT created from a CS intake (no `created_from_cs_intake` event), the quote activity view SHALL display the existing event log format without intake-specific sections.

**Validates: Requirements 3.2**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `src/features/cs-intake/api.ts`

**New Functions**:
1. **`getLinkedQuoteStatus(workItemId: string)`**: Fetches the current `status` from `work_items` table for a given work_item_id
2. **`getLinkedQuoteEvents(workItemId: string)`**: Fetches all `work_item_events` for a given `source_work_item_id`, ordered by `created_at`
3. **`deleteLinkedWorkItem(workItemId: string, reason: string)`**: Soft-deletes (cancels) a work item with audit logging — managers only

**Specific Changes**:
1. **Add batch quote status fetching**: Modify `listAllIntakes()` and/or add a new function that fetches `work_items.status` for all converted intakes in a single query, returning a `Map<workItemId, status>` to avoid N+1 queries.

2. **Add work_item_events fetching**: New `getLinkedQuoteEvents()` function that selects from `work_item_events` joined with `profiles` for actor names, ordered chronologically.

3. **Add work item soft-delete**: New `deleteLinkedWorkItem()` function that updates `work_items.status = 'cancelled'` and inserts an audit entry in `work_item_events` with reason.

---

**File**: `src/features/cs-intake/IntakeQueue.tsx`

**Specific Changes**:
1. **Add "Quote Status" column**: After the Status column for converted rows, show a badge with the work item status (Active, Pricing Sent, Sold, Not Sold, etc.). Only render for rows where `converted_at` is truthy. Fetch statuses in batch on queue load.

2. **Add "Quote Activity" button**: In the Actions column for converted rows, add a button that opens a modal displaying the linked work item's event timeline. Use a new `QuoteActivityModal` component.

3. **Add "Delete Quote" button for managers**: In the Actions column for converted rows (manager only), add a button that prompts for a reason and calls `deleteLinkedWorkItem`.

4. **State management**: Add `quoteStatuses` state (`Map<string, string>`) fetched alongside intakes in the `refresh` function. Add `quoteEvents` state for the modal.

---

**File**: `src/features/cs-intake/QuoteActivityModal.tsx` (NEW)

**Purpose**: Read-only modal component that displays work_item_events for a linked quote. Renders the `created_from_cs_intake` event with structured intake data (insured info, drivers table, vehicles table, notes), and other events with human-readable labels.

---

**File**: `src/features/cs-intake/IntakeDataDisplay.tsx` (NEW)

**Purpose**: Component that renders the `details` JSONB from a `created_from_cs_intake` event as structured, readable sections. Reusable in both the CS queue modal and the sales agent's quote view.

---

**File**: `src/features/quotes/QuoteHistory.tsx`

**Specific Changes**:
1. **Add `created_from_cs_intake` event renderer**: When `event_type === 'created_from_cs_intake'`, render the IntakeDataDisplay component with the event's details JSONB instead of showing raw text.

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code, then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis. If we refute, we will need to re-hypothesize.

**Test Plan**: Write tests that render the IntakeQueue with converted intake rows and assert that quote status and event log elements are present. Write tests that render QuoteHistory with a `created_from_cs_intake` event and assert structured intake data is displayed. Run these tests on the UNFIXED code to observe failures.

**Test Cases**:
1. **Quote Status Missing Test**: Render IntakeQueue with a converted intake row — assert no quote status badge is visible (will fail = confirms bug on unfixed code)
2. **Quote Activity Button Missing Test**: Render IntakeQueue with a converted intake row — assert no "Quote Activity" button exists (will fail = confirms bug)
3. **Intake Data Not Rendered Test**: Render QuoteHistory with a `created_from_cs_intake` event containing full details — assert structured driver/vehicle sections are NOT shown (will fail = confirms bug)
4. **Manager Delete Quote Missing Test**: Render IntakeQueue as manager with a converted intake — assert no "Delete Quote" button exists (will fail = confirms bug)

**Expected Counterexamples**:
- No quote status badge rendered for converted rows in the queue
- No "Quote Activity" button or modal available for converted rows
- `created_from_cs_intake` event renders as generic text, not structured data
- Possible causes: missing API calls, missing UI components, missing event type handlers

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  IF input.action = 'view_quote_status_in_queue' THEN
    row := renderIntakeQueueRow(input.intake)
    ASSERT row.displays(quoteStatusBadge(input.intake.work_item_id))
  END IF
  
  IF input.action = 'view_quote_event_log' THEN
    modal := openQuoteActivityModal(input.intake.work_item_id)
    ASSERT modal.containsAll(workItemEvents(input.intake.work_item_id))
  END IF
  
  IF input.action = 'view_intake_details_in_quote' THEN
    view := renderCreatedFromCsIntakeEvent(event.details)
    ASSERT view.containsStructured(insuredInfo, drivers, vehicles, notes)
  END IF
  
  IF input.action = 'delete_linked_work_item' AND input.user_role = 'manager' THEN
    result := deleteLinkedWorkItem(input.intake.work_item_id, reason)
    ASSERT workItem(input.intake.work_item_id).status = 'cancelled'
    ASSERT auditEventRecorded(input.intake.work_item_id, reason)
  END IF
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT renderIntakeQueue_fixed(input) = renderIntakeQueue_original(input)
  ASSERT renderQuoteHistory_fixed(input) = renderQuoteHistory_original(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (various intake statuses, roles, quote kinds)
- It catches edge cases that manual unit tests might miss (e.g., converted intake with null work_item_id due to race condition)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: Observe behavior on UNFIXED code first for non-converted intakes, then write property-based tests capturing that behavior.

**Test Cases**:
1. **Non-Converted Row Preservation**: Verify that rows with status in (draft, submitted, claimed, returned, rejected, deleted) render identically before and after the fix — no new columns or buttons
2. **Non-CS-Intake Quote Preservation**: Verify that QuoteHistory for quotes without a `created_from_cs_intake` event renders identically
3. **Queue Functionality Preservation**: Verify that filtering, search, claim, create quote, edit, history actions continue working for non-converted rows
4. **Role-Based Access Preservation**: Verify that non-manager users cannot see delete options for linked quotes

### Unit Tests

- Test `getLinkedQuoteStatus` returns correct status for valid work_item_id and null for invalid
- Test `getLinkedQuoteEvents` returns chronologically ordered events with actor names
- Test `deleteLinkedWorkItem` updates status to 'cancelled' and creates audit event
- Test `IntakeDataDisplay` renders all sections (insured, drivers, vehicles, notes) from valid JSONB
- Test `IntakeDataDisplay` handles missing/null fields gracefully
- Test quote status badge renders correct label and color for each work_status value

### Property-Based Tests

- Generate random intake rows with various statuses and verify only converted rows show new UI elements
- Generate random `created_from_cs_intake` details JSONB (varying numbers of drivers, vehicles, optional fields) and verify IntakeDataDisplay renders without errors
- Generate random user roles and verify manager-only actions (Delete Quote) are hidden from non-managers
- Generate random work_item_events arrays and verify QuoteActivityModal renders all events in chronological order

### Integration Tests

- Test full flow: create intake, convert, verify quote status appears in CS queue
- Test full flow: convert intake, add work_item_events (price_sent, sold), verify CS agent can see progression in Quote Activity modal
- Test full flow: manager deletes linked work item, verify status updates in both queue and work_items table
- Test that existing IntakeHistory modal continues to show cs_intake_events independently from new Quote Activity modal
