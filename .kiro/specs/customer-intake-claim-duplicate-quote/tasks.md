# Implementation Plan: Customer Intake, Claim, and Duplicate Quote

## Overview

This plan implements the end-to-end workflow for CS intake editing, RingCentral claim enforcement, automatic quote creation, Intake Note Log generation, duplicate quote detection/review, history events, notifications, and reporting. Implementation follows a bottom-up approach: database layer first, then shared types, API routes, and finally React UI components with real-time subscriptions.

## Tasks

- [x] 1. Database schema migration and core tables
  - [x] 1.1 Create the `customer_intakes` table migration
    - Create SQL migration file with full table definition including all identity, workflow, personal auto, commercial auto, coverage, and soft-delete columns
    - Add all CHECK constraints (source_type enum, status enum, priority enum, phone_or_email_required, dealership_requires_salesperson, other_requires_description)
    - Add the unique index on `converted_quote_id`
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 3.4_

  - [x] 1.2 Create the `operational_quotes` table migration
    - Create SQL migration with all columns: intake link, identity copies, status state machine, assignment, urgency tracking, duplicate linking
    - Add CHECK constraint for status enum and assignment_method enum
    - Add unique constraint `one_quote_per_intake` on `customer_intake_id`
    - Add indexes: `idx_quotes_assigned_to`, `idx_quotes_status`, `idx_quotes_duplicate_review`
    - _Requirements: 8.6, 9.5_

  - [x] 1.3 Create the `intake_history_events` table migration
    - Create SQL migration with immutable append-only design
    - Add CHECK constraint `no_empty_event` requiring details or changed_fields
    - Add index `idx_intake_history_intake` on (intake_id, created_at DESC)
    - _Requirements: 4.1, 4.2, 17.5_

  - [x] 1.4 Create the `quote_history_events` table migration
    - Create SQL migration with event_type enum CHECK, note_log_content column for Intake Note Log
    - Add index `idx_quote_history_quote` on (quote_id, created_at ASC)
    - _Requirements: 11.5, 17.1, 17.2_

  - [x] 1.5 Create the `notifications` table migration
    - Create SQL migration with notification_type enum, payload columns, read/dismiss state
    - Add index `idx_notifications_recipient_unread`
    - _Requirements: 19.3, 20.3, 21.3_

  - [x] 1.6 Create the `duplicate_reviews` table migration
    - Create SQL migration with flagged/original quote references, resolution fields
    - Add CHECK constraints: `not_self_duplicate`, `no_double_flag` unique constraint
    - Add index `idx_duplicate_reviews_pending`
    - _Requirements: 13.6, 14.1_

  - [x] 1.7 Create the `quote_links` table migration
    - Create SQL migration with bidirectional link structure
    - Add CHECK constraints: `no_self_link`, `unique_link`
    - _Requirements: 14.3, 25.4_

  - [ ] 1.8 Create the `failed_history_events` recovery table migration
    - Create SQL migration for retry/recovery of failed history inserts
    - _Requirements: 17.4_

- [x] 2. Row Level Security policies
  - [x] 2.1 Create RLS policies for `customer_intakes`
    - Enable RLS on table
    - Create policies: `cs_select_own`, `cs_insert`, `cs_update_own`, `agent_select_queue`, `manager_select_all`, `manager_update_all`
    - _Requirements: 27.1, 27.2, 27.3, 27.4_

  - [x] 2.2 Create RLS policies for `operational_quotes`
    - Enable RLS on table
    - Create policies: `agent_select`, `agent_update_own`, `manager_all_quotes`
    - Ensure merged_duplicate status filtered from agent views
    - _Requirements: 27.2, 27.3, 15.3_

  - [x] 2.3 Create RLS policies for `intake_history_events` and `quote_history_events`
    - Enable RLS on both tables
    - Create SELECT-only policies linked to parent record visibility
    - No UPDATE/DELETE policies (immutable by design)
    - _Requirements: 17.5, 27.4_

  - [x] 2.4 Create RLS policies for `notifications`
    - Enable RLS on table
    - Create policies: `own_notifications` (SELECT), `mark_own_read` (UPDATE)
    - _Requirements: 19.3, 27.1, 27.2, 27.3_

  - [x] 2.5 Create RLS policies for `duplicate_reviews`
    - Enable RLS on table
    - Create policies: `agent_own_reviews` (SELECT flagged_by = uid), `manager_all_reviews` (SELECT all)
    - _Requirements: 27.2, 27.3_

- [x] 3. Supabase RPC functions - Core operations
  - [x] 3.1 Create `_generate_intake_note_log` internal function
    - Implement Personal Auto format with sections: Customer, Source, Coverage Requested, Drivers, Vehicles, Additional Notes
    - Implement Commercial Auto format with sections: Business, Source, Drivers, Vehicles, Coverage Requested, Additional Notes
    - Omit empty sections, preserve original values, include metadata header
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 11.1, 11.2, 11.3, 11.4_

  - [x] 3.2 Create `_create_quote_from_intake` internal helper function
    - Copy identity fields from intake to quote
    - Generate Intake Note Log via `_generate_intake_note_log`
    - Insert operational_quote with status='assigned'
    - Insert intake_note_log as first quote_history_events entry
    - Insert quote_created event
    - Handle idempotency (return existing quote if already converted)
    - _Requirements: 8.1, 8.4, 8.5, 8.6, 11.5_

  - [x] 3.3 Create `claim_ringcentral_intake` RPC function
    - Acquire row-level lock with NOWAIT
    - Validate: intake exists, is RingCentral-sourced, is unclaimed, status allows claiming
    - Validate: caller is current RingCentral_Agent or Manager
    - Validate: caller availability is 'available'
    - Call `_create_quote_from_intake`
    - Update intake status, assigned_to, claimed_at, assignment_method, converted fields
    - Insert intake_history_event (claimed)
    - Insert notifications for CS creator and assigned Agent
    - Return quote_id
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 8.1, 8.2, 8.7_

  - [x] 3.4 Create `assign_customer_intake` RPC function
    - Manager-only authorization check
    - Lock intake row, validate status allows assignment
    - Call `_create_quote_from_intake` with method='manager_assignment'
    - Update intake status to 'assigned', set assigned_to and assignment_method
    - Insert history events and notifications
    - Return quote_id
    - _Requirements: 5.5, 8.1, 8.7, 24.4_

  - [x] 3.5 Create `update_customer_intake` RPC function
    - Lock intake row, validate caller permissions (CS owns intake, or Manager with reason)
    - Iterate p_changes JSONB, build changed_fields array with old/new values
    - Apply updates via dynamic SQL
    - Insert grouped intake_history_event
    - If intake is converted, also insert quote_history_event (intake_update type)
    - Return success with affected_ids
    - _Requirements: 2.1, 2.2, 2.3, 2.5, 2.6, 3.1, 3.2, 3.6, 12.1, 12.2_

  - [x] 3.6 Create `delete_customer_intake` RPC function
    - Manager-only authorization
    - Validate reason >= 5 chars
    - Store pre_delete_status, set status='deleted', deleted_at, deleted_by, deleted_reason
    - Insert history event
    - _Requirements: 3.3, 3.4, 27.3_

  - [x] 3.7 Create `restore_customer_intake` RPC function
    - Manager-only authorization
    - Validate intake is in 'deleted' status
    - Restore to pre_delete_status, clear deletion fields
    - Insert history event
    - _Requirements: 3.5_

  - [x] 3.8 Create `flag_quote_duplicate` RPC function
    - Validate: reason 10-500 chars, not self-flag, quote not in terminal/review status
    - Set quote status to 'duplicate_review', store pre_flag_status
    - Insert duplicate_reviews record
    - Insert quote_history_event
    - Notify all active managers
    - _Requirements: 13.2, 13.3, 13.4, 13.5, 13.6, 21.1, 21.2_

  - [x] 3.9 Create `resolve_quote_duplicate` RPC function
    - Manager-only authorization
    - Handle 'not_duplicate': restore pre_flag_status, clear pre_flag_status
    - Handle 'merge': validate field_selections provided, call merge_quote_records
    - Handle 'keep_both_link': create quote_links entry, update linked_quote_id on both
    - Mark review as resolved, insert history events
    - _Requirements: 14.3, 14.4, 16.2, 25.2, 25.4, 25.5_

  - [x] 3.10 Create `merge_quote_records` RPC function
    - Manager-only authorization
    - Validate: not self-merge, merged record not already 'merged_duplicate'
    - Apply field_selections to surviving record
    - Move all quote_history_events from merged to surviving
    - Mark merged record status='merged_duplicate', set merged_into_id
    - Create quote_links entry with type='merged_source'
    - Insert history event on surviving record
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7_

- [x] 4. Checkpoint - Database layer complete
  - Ensure all migrations run successfully against local Supabase
  - Ensure all RPC functions compile without errors
  - Ensure all RLS policies are applied correctly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. TypeScript types and shared utilities
  - [x] 5.1 Create shared type definitions
    - Create `src/features/quotes/types.ts` with all TypeScript types from design
    - Include: IntakeStatus, QuoteStatus, AssignmentMethod, SourceType, NotificationType, DuplicateDecision, UrgencyLevel
    - Include interfaces: OperationalQuote, DuplicateReview, Notification, IntakeHistoryEvent, QuoteHistoryEvent
    - Include QUOTE_TRANSITIONS map and calculateUrgency function
    - _Requirements: 9.3, 9.5_

  - [x] 5.2 Update `src/features/nhwd-shared/types.ts` with IntakeStatus and QuoteStatus enums
    - Add IntakeStatus and QuoteStatus type exports to shared types
    - Ensure existing code can import from shared location
    - _Requirements: 9.5_

  - [x] 5.3 Create notification types in `src/features/notifications/types.ts`
    - Define Notification interface and NotificationType union
    - _Requirements: 19.1, 20.1, 21.1_

  - [x] 5.4 Write property tests for status transitions and urgency calculation
    - **Property 5 (PBT-5): Quote Status Transition Enforcement**
    - **Validates: Requirements 9.5, 9.6**
    - **Property 6 (PBT-6): Urgency Calculation Correctness**
    - **Validates: Requirements 9.3**

- [x] 6. Feature API modules - Supabase client calls
  - [x] 6.1 Create `src/features/cs-intake/api.ts` expanded intake API
    - Add functions: submitIntake, updateIntake, getIntakeHistory
    - Use consistent error handling pattern with throwIfError
    - Each function calls corresponding Supabase RPC
    - _Requirements: 2.1, 2.2, 2.3, 4.1_

  - [x] 6.2 Create `src/features/quotes/api.ts` quote API module
    - Add functions: claimRingcentralIntake, getMyQuotes, changeQuoteStatus, getQuoteHistory, getQuoteDetail
    - Include flagQuoteDuplicate function
    - Use consistent error handling pattern
    - _Requirements: 6.1, 9.5, 13.1_

  - [x] 6.3 Create `src/features/quotes/api.ts` duplicate resolution API functions
    - Add functions: resolveDuplicate, mergeQuotes, getPendingDuplicateReviews, getDuplicateReviewDetail
    - _Requirements: 14.1, 14.3, 15.1_

  - [x] 6.4 Create `src/features/notifications/api.ts` notification API module
    - Add functions: getUnreadNotifications, markAsRead, dismissNotification
    - Add real-time subscription function: subscribeToNotifications
    - Add rotation change subscription: subscribeToRotationChanges
    - _Requirements: 19.1, 19.3, 20.1, 23.5_

  - [x] 6.5 Create `src/features/cs-intake/api.ts` manager actions
    - Add functions: assignIntake, deleteIntake, restoreIntake
    - _Requirements: 3.3, 3.4, 3.5, 24.4_

  - [x] 6.6 Write property tests for intake validation and edit access control
    - **Property 1 (PBT-1): Intake Validation Rejects Incomplete Identity**
    - **Validates: Requirements 1.2, 1.5, 1.6**
    - **Property 3 (PBT-3): CS_User Edit Access Control**
    - **Validates: Requirements 2.1, 2.2, 2.5**

- [x] 7. API route handlers
  - [x] 7.1 Create intake API routes
    - Create `src/app/api/intakes/route.ts` (GET list, POST create)
    - Create `src/app/api/intakes/[id]/route.ts` (GET detail, PATCH update, DELETE soft-delete)
    - Create `src/app/api/intakes/[id]/submit/route.ts` (POST submit)
    - Create `src/app/api/intakes/[id]/claim/route.ts` (POST claim)
    - Create `src/app/api/intakes/[id]/assign/route.ts` (POST manager assign)
    - Create `src/app/api/intakes/[id]/restore/route.ts` (POST restore)
    - Create `src/app/api/intakes/[id]/history/route.ts` (GET history events)
    - _Requirements: 2.1, 3.1, 5.1, 6.1, 24.1_

  - [x] 7.2 Create quote API routes
    - Create `src/app/api/quotes/route.ts` (GET list filtered by role)
    - Create `src/app/api/quotes/[id]/route.ts` (GET detail, PATCH status change)
    - Create `src/app/api/quotes/[id]/duplicate/route.ts` (POST flag, GET review data)
    - Create `src/app/api/quotes/[id]/history/route.ts` (GET history events)
    - _Requirements: 9.1, 13.1, 17.1_

  - [x] 7.3 Create duplicate review API routes
    - Create `src/app/api/duplicates/route.ts` (GET pending reviews)
    - Create `src/app/api/duplicates/[id]/resolve/route.ts` (POST resolve decision)
    - Create `src/app/api/duplicates/[id]/merge/route.ts` (POST merge records)
    - _Requirements: 14.1, 14.3, 15.1_

  - [x] 7.4 Create notification API routes
    - Create `src/app/api/notifications/route.ts` (GET unread, PATCH mark read)
    - Create `src/app/api/notifications/dismiss/route.ts` (POST dismiss)
    - _Requirements: 19.3, 19.5_

- [x] 8. Checkpoint - API layer complete
  - Ensure all API routes compile and respond correctly
  - Verify RPC function calls return expected shapes
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. React components - Intake features
  - [x] 9.1 Refactor `IntakeQueue.tsx` for role-based views
    - Display source, customer name, submission date, claim status, current RingCentral_Agent name
    - Enable claim button only when viewing Agent === current RC Agent
    - Add real-time subscription to rotation changes + queue updates
    - Show turn holder name for non-current agents
    - _Requirements: 22.1, 22.2, 22.3, 23.1, 23.2, 23.3, 23.5_

  - [x] 9.2 Create `IntakeEditForm.tsx` component
    - Implement post-claim edit form for subset of fields
    - Available to creating CS_User and Managers
    - Manager edits require mandatory reason field (min 5 chars)
    - Append changes as history update entries on save
    - Inline field-level validation
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 22.4_

  - [x] 9.3 Create `IntakeHistory.tsx` component
    - Display reverse-chronological timeline of history events
    - Group multi-field edits as single entry
    - Human-readable formatting (employee name, formatted datetime, action type, details)
    - No raw JSON display
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 24.5_

  - [x] 9.4 Refactor `CsIntakeLanding.tsx` for CS queue view
    - Show only intakes created by viewing CS_User
    - Display: customer name, source, submission date, status, assigned Agent, linked quote ID
    - Sort by submission date descending, Drafts first
    - Provide View, Edit (on Draft/Submitted/Waiting), Submit (on Draft only)
    - Empty state message when no intakes
    - _Requirements: 22.1, 22.2, 22.3, 22.5, 22.6_

- [x] 10. React components - Quote features
  - [x] 10.1 Create `QuoteCard.tsx` component
    - Display: customer name, source, dealership, salesperson, quote type, intake creator, assigned date, Quote_Status, urgency indicator, last activity
    - Show only valid actions for current status using QUOTE_TRANSITIONS map
    - Include "Mark as Possible Duplicate" action
    - Open action navigates to full quote detail
    - Urgency color coding: normal/elevated/high
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.7, 13.1_

  - [x] 10.2 Create `IntakeNoteLog.tsx` renderer component
    - Render formatted note log text with section headers and indentation
    - Handle both Personal Auto and Commercial Auto formats
    - Display metadata header (creator, timestamp)
    - _Requirements: 10.1, 10.4, 11.3, 11.5_

  - [x] 10.3 Create `QuoteHistory.tsx` timeline component
    - Display chronological timeline (oldest first) of quote history events
    - Show Intake Note Log as first entry
    - Show subsequent intake_update events with changed fields
    - Human-readable formatting matching IntakeHistory pattern
    - _Requirements: 12.3, 17.1, 17.6_

  - [x] 10.4 Write property tests for Intake Note Log generation
    - **Property 7 (PBT-7): Personal Auto Section Ordering**
    - **Validates: Requirements 10.2, 10.3**
    - **Property 8 (PBT-8): Commercial Auto Section Ordering**
    - **Validates: Requirements 11.2, 11.3**
    - **Property 9 (PBT-9): Intake Note Log Data Preservation**
    - **Validates: Requirements 10.4, 11.3, 11.4**

- [x] 11. React components - Duplicate review features
  - [x] 11.1 Create `DuplicateFlagForm.tsx` modal component
    - Search/select original quote (cannot select self)
    - Reason field: 10-500 chars with inline character count validation
    - Prevent submission if no original selected or reason invalid
    - _Requirements: 13.2, 13.3, 13.6_

  - [x] 11.2 Create `DuplicateReviewScreen.tsx` component
    - Side-by-side comparison of all fields between flagged and original
    - Highlight differing values visually
    - Three action buttons: Not a Duplicate, Merge Records, Keep Both but Link
    - Merge requires field-by-field selection for conflicts with confirmation
    - Cancel discards selections and leaves records unchanged
    - Display next pending pair or empty state after resolution
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 25.1, 25.2, 25.3, 25.4, 25.5_

  - [x] 11.3 Write property tests for duplicate flag validation
    - **Property 10 (PBT-10): Duplicate Flag Validation**
    - **Validates: Requirements 13.2, 13.3, 13.6**
    - **Property 11 (PBT-11): Not-A-Duplicate Restores Pre-Flag Status**
    - **Validates: Requirements 16.2, 25.5**
    - **Property 12 (PBT-12): Merge Cannot Target Self or Already-Merged**
    - **Validates: Requirements 15.6**

- [x] 12. React components - Notifications
  - [x] 12.1 Create `NotificationPanel.tsx` component
    - Bell icon with unread count badge in header
    - Dropdown with notification list (newest first)
    - Each notification: title, body, timestamp, action button
    - Real-time subscription for new notifications via Supabase Realtime
    - Mark as read on action click, dismiss functionality
    - Persist across page reloads via database state
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 20.1, 20.2, 20.3, 21.1, 21.2_

- [x] 13. Checkpoint - Component layer complete
  - Ensure all components render correctly with mock data
  - Verify real-time subscriptions connect properly
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Page integration and routing
  - [x] 14.1 Create quote detail page at `src/app/tools/quotes/[id]/page.tsx`
    - Fetch quote detail, display QuoteCard (expanded), QuoteHistory with IntakeNoteLog
    - Status change actions, duplicate flag action
    - _Requirements: 9.7, 12.3_

  - [x] 14.2 Create duplicate review page at `src/app/tools/quotes/duplicate-review/[id]/page.tsx`
    - Fetch duplicate review detail with both quotes
    - Render DuplicateReviewScreen component
    - _Requirements: 14.1, 25.1_

  - [x] 14.3 Create quotes list page at `src/app/tools/quotes/page.tsx`
    - Agent view: My Desk with QuoteCards, filtered by assigned_to
    - Manager view: all quotes with filtering
    - Include duplicate review queue link for managers
    - _Requirements: 9.1, 16.5_

  - [x] 14.4 Update `src/app/tools/cs-intake/queue/page.tsx` for Manager view
    - Full intake management: View, Edit, Assign, Delete, Restore, Open Linked Quote, View History
    - Disable actions appropriately for deleted intakes
    - Show existing quote rather than allowing duplicate assignment
    - _Requirements: 24.1, 24.2, 24.3, 24.4, 24.5, 24.6_

  - [x] 14.5 Wire NotificationPanel into app layout
    - Add NotificationPanel to `src/app/layout.tsx` or header component
    - Initialize real-time subscription on auth session
    - _Requirements: 19.1, 20.1, 21.1_

- [x] 15. Real-time subscriptions and live updates
  - [x] 15.1 Implement queue real-time updates
    - Subscribe to `customer_intakes` changes for queue refresh
    - Subscribe to `profiles` rotation changes for turn holder update
    - Update UI within 5 seconds of change without page refresh
    - _Requirements: 5.6, 23.5_

  - [x] 15.2 Implement notification real-time delivery
    - Subscribe to `notifications` INSERT events filtered by recipient_id
    - Update unread badge count in real-time
    - Page-load fallback query for missed notifications
    - _Requirements: 19.1, 20.1, 21.1_

  - [x] 15.3 Implement quote status real-time updates
    - Subscribe to `operational_quotes` changes for Agent My Desk
    - Update QuoteCard status and urgency in real-time
    - Handle duplicate_review status removal from active view
    - _Requirements: 9.1, 13.5_

- [x] 16. Reporting and metrics
  - [x] 16.1 Implement reporting exclusion logic
    - Exclude `merged_duplicate` and `duplicate_review` statuses from volume counts and conversion metrics
    - Ensure status changes reflect on next report refresh
    - _Requirements: 15.5, 16.1, 16.3, 16.4_

  - [x] 16.2 Implement CS and Agent metrics queries
    - Per CS_User: intakes created, submitted, claimed, converted to sold
    - Per Agent: quotes assigned, in progress, pricing sent, sold, not sold
    - Filter by individual user and date range
    - Reassignment credits Agent at final status
    - _Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6_

  - [x] 16.3 Implement duplicate rate metrics
    - By source, intake creator, and dealership
    - Show: identified, confirmed, not-duplicate counts
    - Manager-selected date range (1-365 days)
    - Visual aging indicator on items unresolved > 72 hours
    - _Requirements: 16.5, 16.6_

- [x] 17. Checkpoint - Integration complete
  - Verify end-to-end flows: CS creates → Agent claims → Quote appears
  - Verify duplicate flow: Agent flags → Manager resolves → Status restored
  - Verify notifications delivered in real-time
  - Verify reporting excludes merged/review records
  - Ensure all tests pass, ask the user if questions arise.

- [x] 18. Property-based tests and unit tests
  - [x] 18.1 Write property test for grouped history events
    - **Property 4 (PBT-4): Edit Produces Grouped History Event**
    - **Validates: Requirements 2.3, 4.3**

  - [x] 18.2 Write property test for role-based access control
    - **Property 13 (PBT-13): RLS Role Enforcement**
    - **Validates: Requirements 27.1, 27.2, 27.3, 27.4, 27.5**

  - [x] 18.3 Write property test for case-insensitive identity matching
    - **Property 2 (PBT-2): Case-Insensitive Identity Matching**
    - **Validates: Requirements 1.3**

  - [x] 18.4 Write unit tests for RingCentral claim flow
    - Test happy path claim, wrong agent rejection, concurrent claim handling
    - Test failure rollback (no partial state)
    - _Requirements: 5.1, 5.2, 6.1, 6.2, 6.3, 6.4_

  - [x] 18.5 Write unit tests for quote creation and Note Log
    - Test idempotent re-claim returns existing quote
    - Test Personal Auto and Commercial Auto format generation
    - Test empty section omission
    - _Requirements: 8.5, 10.1, 10.3, 11.1, 11.2_

  - [x] 18.6 Write unit tests for duplicate flagging and resolution
    - Test flag happy path, self-flag rejection, reason validation
    - Test not_duplicate restores status, merge consolidates history, keep_both creates links
    - _Requirements: 13.2, 13.6, 14.3, 15.2, 15.6, 16.2_

  - [x] 18.7 Write unit tests for notification delivery
    - Test claim notification created for CS and Agent
    - Test flag notification created for all managers
    - Test read/dismiss state management
    - _Requirements: 19.1, 20.1, 21.1_

- [x] 19. Final checkpoint - Full feature validation
  - Ensure all tests pass, ask the user if questions arise.
  - Verify all 27 requirements have implementing tasks
  - Confirm no orphaned or hanging code exists

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All RPC functions use SECURITY DEFINER with explicit auth.uid() checks
- Real-time subscriptions use Supabase Realtime postgres_changes channels
- The feature module pattern places all new code under `src/features/quotes/` and expands `src/features/cs-intake/`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8"] },
    { "id": 1, "tasks": ["2.1", "2.2", "2.3", "2.4", "2.5"] },
    { "id": 2, "tasks": ["3.1", "5.1", "5.2", "5.3"] },
    { "id": 3, "tasks": ["3.2", "5.4"] },
    { "id": 4, "tasks": ["3.3", "3.4", "3.5", "3.6", "3.7", "3.8"] },
    { "id": 5, "tasks": ["3.9", "3.10"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3", "6.4", "6.5", "6.6"] },
    { "id": 7, "tasks": ["7.1", "7.2", "7.3", "7.4"] },
    { "id": 8, "tasks": ["9.1", "9.2", "9.3", "9.4", "10.1", "10.2", "10.3", "10.4"] },
    { "id": 9, "tasks": ["11.1", "11.2", "11.3", "12.1"] },
    { "id": 10, "tasks": ["14.1", "14.2", "14.3", "14.4", "14.5"] },
    { "id": 11, "tasks": ["15.1", "15.2", "15.3"] },
    { "id": 12, "tasks": ["16.1", "16.2", "16.3"] },
    { "id": 13, "tasks": ["18.1", "18.2", "18.3", "18.4", "18.5", "18.6", "18.7"] }
  ]
}
```
