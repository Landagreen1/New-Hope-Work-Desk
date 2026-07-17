# Requirements Document

## Introduction

This specification defines the operational workflow for customer intake editing, RingCentral claim enforcement, automatic quote creation, Agent Work Desk quote management, organized intake note logs, duplicate quote flagging and review, intake/quote history events, reporting impact, notifications, and associated UI changes for the New Hope Work Desk.

This feature builds on top of the architectural foundations defined in the `unified-customer-identity-duplicate-quote-prevention` spec (canonical customer identity, protected identifiers, quote-cycle model, and transactional guarded quote creation). This document focuses on the practical CS, Agent, and Management operational workflows that consume those building blocks.

The platform is Next.js 16 with React 19, Supabase (database and auth), TypeScript, and Tailwind CSS 4.

## Glossary

- **Work_Desk**: The authenticated New Hope internal Next.js and Supabase platform.
- **Customer_Intake**: A customer information submission created by Customer Service containing customer details, source, coverage needs, and driver/vehicle information.
- **Intake_Queue**: The list of submitted intakes awaiting claim or assignment, visible to Agents and Management.
- **CS_User**: A Customer Service employee who creates, edits, and submits customer intakes.
- **Agent**: A Sales agent who claims or is assigned intakes and works quotes to completion.
- **Manager**: A Management user with elevated permissions for editing, assigning, deleting, restoring, reviewing duplicates, and overriding workflow rules.
- **RingCentral_Agent**: The Agent currently designated as the active rotation recipient for RingCentral-sourced intakes.
- **Operational_Quote**: The active quote record in an Agent's Work Desk representing one customer quotation effort.
- **Quote_Card**: The UI representation of an Operational_Quote in the Agent's My Desk view.
- **Intake_Status**: One of Draft, Submitted, Waiting for Claim, Waiting for Assignment, Claimed, Assigned, Converted, Deleted.
- **Quote_Status**: One of Assigned, Quoting, Pricing Sent, Not Sold, Activation Pending, Activated, Sold.
- **Assignment_Method**: One of RingCentral Claim, Manager Assignment, Automatic Rotation Assignment, Renewal Requote Assignment.
- **Quote_Identity**: The combination of Customer Name, Source, Salesperson, and Line of Business that forms the recommended identity for a quote.
- **Source_Type**: One of Dealership, Walk-in Office, WhatsApp, RingCentral, Customer Service, Renewal Requote, Existing Customer, Referral, Other.
- **Duplicate_Review_Status**: A quote status indicating the record has been flagged as a possible duplicate and awaits Manager decision.
- **Intake_Note_Log**: An auto-generated organized summary of intake information attached to a converted quote's history.
- **Personal_Auto_Format**: The structured note format for personal auto intakes containing Customer, Source, Coverage Requested, Drivers, Vehicles, and Additional Notes sections.
- **Commercial_Auto_Format**: The structured note format for commercial auto intakes containing Business, Source, Drivers, Vehicles, Coverage Requested, and Additional Notes sections.
- **Soft_Delete**: A logical deletion that removes a record from active queues and totals while preserving it in audit views.
- **History_Event**: A timestamped, attributed record of a significant action on an intake or quote.
- **Rotation_Validation**: The server-side check confirming the requesting agent is the current RingCentral rotation recipient at the exact moment of claim.

## Requirements

### Requirement 1: Quote Identity Components

**User Story:** As a Manager, I want each intake and quote to store a complete set of identity components, so that duplicate detection is accurate and name alone cannot determine identity.

#### Acceptance Criteria

1. THE Work_Desk SHALL store the following identity components for each Customer_Intake and Operational_Quote: customer name (max 150 chars), source or dealership, dealer salesperson, quote origin, line of business, phone (max 20 chars), email (max 254 chars), driver's license reference (max 30 chars, optional), date of birth, intake creator, assigned or claiming Agent, and creation timestamp.
2. THE Work_Desk SHALL require customer name, source, line of business, phone or email, and intake creator before allowing save; driver's license and dealer salesperson are optional.
3. THE Work_Desk SHALL use case-insensitive exact matching on Customer Name, Source, and Line of Business as minimum identity criteria.
4. WHEN a matching combination is detected on new intake submission, THE Work_Desk SHALL present the existing record and require explicit confirmation before creating a separate record.
5. WHEN the Source_Type is Dealership, THE Work_Desk SHALL require both the dealership identifier and the dealer salesperson as separate fields.
6. THE Work_Desk SHALL classify Source_Type as one of: Dealership, Walk-in Office, WhatsApp, RingCentral, Customer Service, Renewal Requote, Existing Customer, Referral, or Other; WHEN Other is selected, THE Work_Desk SHALL require a free-text description (max 100 chars).

### Requirement 2: Customer Intake Editing by CS

**User Story:** As a CS_User, I want to edit intakes I created before they are claimed, so that I can correct or update customer information while it is still within my control.

#### Acceptance Criteria

1. WHILE the Intake_Status is Draft, Submitted, Waiting for Claim, or Waiting for Assignment, THE Work_Desk SHALL permit the creating CS_User to edit all intake fields directly.
2. WHILE the Intake_Status is Claimed, Assigned, or Converted, THE Work_Desk SHALL permit the creating CS_User to edit all fields, appending changes as update entries to intake history and linked quote history.
3. WHEN a CS_User edits an intake, THE Work_Desk SHALL record the previous value, new value, editor identity, and timestamp in a History_Event.
4. THE Work_Desk SHALL NOT permit a CS_User to permanently delete any Customer_Intake.
5. IF a CS_User attempts to edit an intake they did not create, THEN THE Work_Desk SHALL reject the edit with an error.
6. IF an edit fails validation or server error, THEN THE Work_Desk SHALL reject the edit, preserve original values, and display the error reason.

### Requirement 3: Customer Intake Editing by Manager

**User Story:** As a Manager, I want to edit any intake at any stage with full audit history, so that corrections are traceable and accountable regardless of intake status.

#### Acceptance Criteria

1. THE Work_Desk SHALL permit a Manager to edit all customer-provided and CS-entered fields on any Customer_Intake regardless of Intake_Status, excluding system-managed fields.
2. WHEN a Manager edits any intake field, THE Work_Desk SHALL create a History_Event containing the previous value, new value, Manager identity, timestamp, and mandatory reason (min 5 chars).
3. WHEN a Manager performs a Soft_Delete on a Customer_Intake, THE Work_Desk SHALL require a mandatory reason (min 5 chars) before completing the deletion.
4. WHEN a Customer_Intake is soft-deleted, THE Work_Desk SHALL remove the intake from active queues, prevent quote creation from the intake, exclude the intake from operational totals, and retain the intake in the audit view.
5. WHEN a Manager restores a soft-deleted Customer_Intake, THE Work_Desk SHALL return the intake to its pre-deletion status, record the restore action as a History_Event with the Manager identity, timestamp, and reason, and make the intake visible in active queues.
6. IF a Manager attempts to edit a Deleted intake, THEN THE Work_Desk SHALL reject the edit with an error indicating the intake must be restored first.

### Requirement 4: Intake Edit History

**User Story:** As a Manager, I want a readable timeline of all intake changes, so that I can audit the full lifecycle without reading raw data.

#### Acceptance Criteria

1. THE Work_Desk SHALL maintain a chronological timeline of History_Events for each Customer_Intake, displayed in reverse chronological order (newest first).
2. THE Work_Desk SHALL record the following event types in the intake timeline: Created, Updated, Source Changed, Submitted, Claimed, Assigned, Converted to Quote, Deleted, and Restored.
3. WHEN multiple fields are edited simultaneously, THE Work_Desk SHALL display them as one grouped History_Event listing all affected fields.
4. WHEN displaying intake history, THE Work_Desk SHALL present each History_Event as a human-readable entry containing the employee name, formatted datetime, action type, and event-specific details.
5. THE Work_Desk SHALL NOT display raw JSON or unformatted data structures in the intake history view.

### Requirement 5: RingCentral Claim Eligibility Enforcement

**User Story:** As a Manager, I want the RingCentral claim button restricted to the current rotation Agent, so that only the designated Agent can claim RingCentral intakes.

#### Acceptance Criteria

1. WHEN a RingCentral-sourced intake is in Waiting for Claim status, THE Work_Desk SHALL enable the claim button only for the current RingCentral_Agent or a Manager performing an override.
2. WHEN an Agent clicks the claim button, THE Work_Desk SHALL validate at the exact moment of click: rotation position, turn start time not expired, Agent logged in and not away/offline, and Agent not suspended/removed.
3. IF the current RingCentral_Agent fails the availability check, THEN THE Work_Desk SHALL reject the claim for all Agents and display an error about Agent unavailability.
4. IF a non-current Agent attempts to claim, THEN THE Work_Desk SHALL reject the claim, disable the button, and display the current valid Agent by name.
5. WHEN a Manager override is used, THE Work_Desk SHALL require a mandatory reason and record the selected Agent, reason, timestamp, and Manager identity without altering the rotation order.
6. THE Work_Desk SHALL display the current RingCentral turn holder by name to all Agents and update within 5 seconds of a rotation change.

### Requirement 6: RingCentral Claim Transaction

**User Story:** As a platform owner, I want the RingCentral claim validated and executed atomically in Supabase, so that race conditions cannot produce invalid claims.

#### Acceptance Criteria

1. THE Work_Desk SHALL provide a Supabase function `claim_ringcentral_intake(intake_id)` that executes within a single transaction.
2. WHEN `claim_ringcentral_intake` is called, THE function SHALL acquire a row-level lock within 5 seconds, confirm the intake is unclaimed (no assigned Agent, no claim timestamp), read the current rotation state, confirm the calling Agent matches the current RingCentral_Agent, record the claim timestamp, assign the intake to the Agent, create the linked Operational_Quote, and return the resulting quote identifier.
3. WHEN two Agents attempt to claim the same RingCentral intake concurrently, THE Work_Desk SHALL permit only the first valid transaction to succeed and return an error to subsequent attempts indicating the intake is already claimed.
4. IF any step within `claim_ringcentral_intake` fails, THEN THE Work_Desk SHALL roll back all changes from the transaction and return an error indicating which validation failed.
5. IF the intake_id does not exist or is not RingCentral-sourced, THEN THE Work_Desk SHALL return an error and perform no state changes.

### Requirement 7: RingCentral Quote Non-Stealability

**User Story:** As an Agent, I want my RingCentral quotes protected from steal or rescue actions, so that my assigned work remains mine until I complete it or Management reassigns it.

#### Acceptance Criteria

1. THE Work_Desk SHALL NOT provide any rescue timer, steal button, or automatic reassignment mechanism for RingCentral-sourced quotes.
2. WHILE a RingCentral-sourced Operational_Quote is active, THE Work_Desk SHALL keep the quote assigned to the claiming Agent until the Agent records a terminal outcome (Sold or Not Sold) or a Manager performs a reassignment with reason.
3. WHEN a Manager reassigns a RingCentral-sourced quote, THE Work_Desk SHALL record the previous Agent, new Agent, Manager identity, timestamp, and mandatory reason (min 10 chars) as a History_Event.
4. IF the reassignment reason is shorter than 10 characters, THEN THE Work_Desk SHALL reject the reassignment.

### Requirement 8: Automatic Quote Creation on Claim or Assignment

**User Story:** As an Agent, I want a quote automatically created in my Work Desk when I claim or am assigned an intake, so that I never have a claimed intake without an operational quote to work.

#### Acceptance Criteria

1. WHEN a Customer_Intake is claimed or assigned, THE Work_Desk SHALL atomically create one linked Operational_Quote with initial status Assigned in the same transaction as the claim or assignment.
2. IF the Operational_Quote creation fails, THEN THE Work_Desk SHALL roll back the claim or assignment and return a structured error.
3. WHEN the linked Operational_Quote is created, THE Work_Desk SHALL store the following on the intake: converted_quote_id, converted_at, converted_by, assigned_to, claimed_at, and Assignment_Method.
4. WHEN the linked Operational_Quote is created, THE Work_Desk SHALL store the following on the quote: customer_intake_id, intake creator, assigned Agent, source, dealership, salesperson, origin, quote type, and Intake_Note_Log per Requirement 10 or 11.
5. WHEN a claim or assignment is attempted for an intake that already has a linked Operational_Quote, THE Work_Desk SHALL return the existing quote identifier as success rather than creating a duplicate.
6. THE Work_Desk SHALL enforce a database uniqueness constraint preventing more than one Operational_Quote per Customer_Intake.
7. WHEN the claim or assignment completes, THE Work_Desk SHALL transition Intake_Status to Claimed or Assigned respectively and record a History_Event with the Agent, method, and timestamp.

### Requirement 9: Agent Work Desk Quote Card

**User Story:** As an Agent, I want a quote card in My Desk showing all key information at a glance, so that I can manage my workload efficiently.

#### Acceptance Criteria

1. WHEN an Operational_Quote is assigned to an Agent, THE Work_Desk SHALL display a Quote_Card in the Agent's My Desk view within 5 seconds of assignment.
2. THE Quote_Card SHALL display: customer name, source, dealership, salesperson, quote type, intake creator, assigned date, current Quote_Status, urgency indicator, and last activity (most recent status change, note, or attachment).
3. THE Work_Desk SHALL calculate urgency as: normal (less than 24 hours), elevated (24-48 hours), high (greater than 48 hours with no progression beyond Assigned).
4. THE Work_Desk SHALL show only actions valid for the current Quote_Status on each Quote_Card.
5. WHEN an Agent changes the Quote_Status, THE Work_Desk SHALL enforce the transitions: Assigned to Quoting, Quoting to Pricing Sent or Not Sold, Pricing Sent to Activation Pending or Not Sold, Activation Pending to Activated or Not Sold, Activated to Sold or Not Sold.
6. IF an invalid status transition is attempted, THEN THE Work_Desk SHALL prevent the transition and display an error.
7. THE Quote_Card Open action SHALL navigate to the full quote detail view.

### Requirement 10: Organized Intake Note Log - Personal Auto

**User Story:** As an Agent, I want converted personal auto intakes to include a formatted summary in quote history, so that I can read all intake information without switching screens.

#### Acceptance Criteria

1. WHEN a Personal Auto Customer_Intake is converted to an Operational_Quote, THE Work_Desk SHALL auto-generate an Intake_Note_Log in the Personal_Auto_Format within 3 seconds of conversion.
2. THE Personal_Auto_Format SHALL contain the following sections in order: Customer, Source, Coverage Requested, Drivers, Vehicles, and Additional Notes.
3. THE Work_Desk SHALL omit entire sections with no data but retain all fields within a displayed section.
4. THE Intake_Note_Log SHALL preserve original values exactly as entered and include a metadata header with CS_User name, agent or claim reference, and generation timestamp in system timezone.
5. IF conversion fails after initiation, THEN THE Work_Desk SHALL NOT generate the log and SHALL retain the intake in unconverted state.

### Requirement 11: Organized Intake Note Log - Commercial Auto

**User Story:** As an Agent, I want converted commercial auto intakes to include a formatted summary in quote history, so that I can read business and fleet information in a structured layout.

#### Acceptance Criteria

1. WHEN a Commercial Auto Customer_Intake is converted to an Operational_Quote, THE Work_Desk SHALL auto-generate an Intake_Note_Log in the Commercial_Auto_Format.
2. THE Commercial_Auto_Format SHALL contain the following sections in order: Business (name, type of work, DOT, years in business, operating radius), Source (dealership or type, salesperson, origin), Drivers (name, DOB, relationship, license details), Vehicles (year, make, model, VIN, ownership, usage, mileage, garaging ZIP), Coverage Requested (limits, deductibles, current carrier, expiration), and Additional Notes.
3. THE Intake_Note_Log SHALL include all user-entered values, omit empty sections, preserve original values, and include creator, assignment, and claiming Agent display names with UTC timestamp.
4. WHEN multiple drivers or vehicles exist, THE Work_Desk SHALL display them in ascending position order.
5. THE Intake_Note_Log SHALL be stored as the first entry in the linked Operational_Quote's history.

### Requirement 12: Intake Note Log Updates

**User Story:** As an Agent, I want intake edits after conversion to appear as additional update entries in my quote history, so that I see changes without the original summary being overwritten.

#### Acceptance Criteria

1. WHEN a CS_User or Manager edits a Customer_Intake that has already been converted to an Operational_Quote, THE Work_Desk SHALL create a single update entry in the linked quote's history and SHALL NOT modify the original Intake_Note_Log.
2. WHEN an update entry is created, THE Work_Desk SHALL record the changed fields with previous and new values, editor display name, and datetime to the minute.
3. THE Work_Desk SHALL present the Intake_Note_Log then updates in chronological order (oldest first) within the quote history.
4. THE Work_Desk SHALL prevent direct modification of the original Intake_Note_Log after conversion; changes are update entries only.

### Requirement 13: Duplicate Quote Flagging by Agent

**User Story:** As an Agent, I want to flag a quote as a possible duplicate from multiple locations, so that I can report suspected duplicates wherever I discover them.

#### Acceptance Criteria

1. THE Work_Desk SHALL provide a "Mark as Possible Duplicate" action accessible from: the Agent Work Desk Quote_Card, the Quotes Database, a Customer_Intake converted quote, and the quote detail or history screen.
2. WHEN an Agent marks a quote as a possible duplicate, THE Work_Desk SHALL require the Agent to select exactly one existing quote as the suspected original and enter a reason (10-500 chars).
3. IF no original is selected or the reason is shorter than 10 characters, THEN THE Work_Desk SHALL prevent submission with inline validation.
4. WHEN a quote is flagged as a possible duplicate, THE Work_Desk SHALL change the quote status to Duplicate_Review_Status, retain all data, history, and attachments, and record the flagging Agent and timestamp.
5. WHEN a quote enters Duplicate_Review_Status, THE Work_Desk SHALL remove the quote from active queues within 5 seconds and notify Management.
6. THE Work_Desk SHALL NOT permit an Agent to flag a quote as a duplicate of itself.

### Requirement 14: Manager Duplicate Review Screen

**User Story:** As a Manager, I want a dedicated duplicate review screen with side-by-side comparison, so that I can make informed merge or keep decisions.

#### Acceptance Criteria

1. THE Work_Desk SHALL provide a Manager duplicate-review screen accessible at Databases, then Quotes, then Duplicate Review.
2. WHEN a Manager opens the duplicate review screen, THE Work_Desk SHALL display a side-by-side comparison of all fields between the flagged quote and the selected original record with differing values visually distinguished.
3. THE Work_Desk SHALL provide the following Manager decisions: Not a Duplicate (remove flag, both active), Merge Records (select primary, choose fields, archive non-surviving), and Keep Both but Link Them (bidirectional reference, both active).
4. WHEN a Manager completes any decision, THE Work_Desk SHALL remove the pair from the review queue and display the next pending pair or an empty-state message.
5. IF Merge Records is selected but conflicting fields are not all resolved, THEN THE Work_Desk SHALL prevent submission.

### Requirement 15: Duplicate Merge Behavior

**User Story:** As a Manager, I want merge to consolidate records without losing history, so that the surviving quote contains all relevant information.

#### Acceptance Criteria

1. WHEN a Manager initiates a merge, THE Work_Desk SHALL require the Manager to designate the surviving record and the merged duplicate before proceeding.
2. WHEN a merge completes, THE Work_Desk SHALL append all notes, attachments, and history from the merged record to the surviving record in chronological order with original timestamps and authorship preserved.
3. WHEN a merge completes, THE Work_Desk SHALL mark the non-surviving record with status "Merged Duplicate" and exclude it from active queues.
4. WHEN a merge completes, THE Work_Desk SHALL record a History_Event with: Manager identity, datetime, surviving quote ID, merged quote ID, fields selected, and reason (1-500 chars).
5. THE Work_Desk SHALL exclude records with "Merged Duplicate" status from Sold, Not Sold, Pending, Completed, and Conversion reporting denominators.
6. THE Work_Desk SHALL NOT permit merging a record with itself or with an already-merged record.
7. WHEN conflicting field values exist between the two records, THE Work_Desk SHALL require the Manager to select which value to retain for each conflicting field.

### Requirement 16: Duplicate Reporting Exclusion

**User Story:** As a Manager, I want duplicate-flagged quotes excluded from volume metrics, so that reporting is not inflated by duplicates under review or merged records.

#### Acceptance Criteria

1. WHILE a quote is in Duplicate_Review_Status, THE Work_Desk SHALL exclude the quote from all volume counts, dashboards, exports, and calculated percentages.
2. WHEN a Manager resolves a duplicate as "Not a Duplicate," THE Work_Desk SHALL return the quote to its previous active status within 5 seconds and include it in reporting.
3. WHEN a duplicate is confirmed, THE Work_Desk SHALL permanently exclude the merged or discarded record from all counts.
4. THE Work_Desk SHALL reflect status changes on the next report refresh, not mid-render.
5. THE Work_Desk SHALL provide duplicate rate metrics by source, intake creator, and dealership showing: identified, confirmed, and not-duplicate counts within a Manager-selected date range (1-365 days).
6. THE Work_Desk SHALL display a visual aging indicator on duplicate review items with no resolution within 72 hours.

### Requirement 17: Intake and Quote History Events

**User Story:** As a Manager, I want a complete event timeline for every intake and quote, so that the full lifecycle is auditable with attribution.

#### Acceptance Criteria

1. THE Work_Desk SHALL record the following History_Event types: Intake Created, Submitted, Edited, Claimed or Assigned, Quote Created, Agent Started Quoting, Pricing Sent, Follow-Up Recorded, Activation Started, Activation Completed, Sold, Not Sold, and Duplicate Review Entered.
2. WHEN a History_Event is recorded, THE Work_Desk SHALL store: employee identity (unique ID and display name), UTC datetime with second-level precision, action type, and human-readable details (1-500 chars).
3. WHEN a History_Event involves both an intake and a quote, THE Work_Desk SHALL store references to both the intake ID and the quote ID; intake-only reference when no linked quote exists.
4. IF persistence of a History_Event fails, THEN THE Work_Desk SHALL retry 3 times, then log for recovery without blocking the originating action.
5. THE Work_Desk SHALL treat all History_Events as immutable with no modification or deletion after creation.
6. THE Work_Desk SHALL display History_Events in chronological order by UTC datetime.

### Requirement 18: Reporting Impact - Intake and Agent Metrics

**User Story:** As a Manager, I want reporting to credit CS for intake work and Agents for quote work separately, so that performance attribution is accurate across roles.

#### Acceptance Criteria

1. THE Work_Desk SHALL track per CS_User: intakes created, submitted, claimed, and converted to sold quote as separate counters.
2. THE Work_Desk SHALL track per Agent: quotes assigned, in progress, pricing sent, sold, and not sold as separate counters.
3. THE Work_Desk SHALL attribute intake credit exclusively to the originating CS_User and quote credit exclusively to the assigned Agent as independent values.
4. THE Work_Desk SHALL provide filtering by individual CS_User or Agent and date range.
5. WHEN a quote is reassigned, THE Work_Desk SHALL attribute credit to the Agent who held the assignment at final status.
6. THE Work_Desk SHALL count intakes with no linked quote in CS_User created and submitted metrics.

### Requirement 19: Notifications - Agent Assignment

**User Story:** As an Agent, I want a notification when an intake creates a quote in my Work Desk, so that I can begin work immediately.

#### Acceptance Criteria

1. WHEN a Customer_Intake is claimed or assigned to an Agent and an Operational_Quote is created, THE Work_Desk SHALL send an in-app notification to the assigned Agent within 5 seconds without requiring page refresh.
2. THE notification SHALL include the customer name, source, line of business, intake creator, and an Open Quote button navigating to the quote detail.
3. THE Work_Desk SHALL persist notifications as unread until opened or dismissed and retain them after page reload.
4. IF the quote creation fails, THEN THE Work_Desk SHALL NOT send a notification.
5. WHEN the Open Quote button is clicked, THE Work_Desk SHALL navigate to the quote detail view and mark the notification as read.

### Requirement 20: Notifications - CS Intake Claimed

**User Story:** As a CS_User, I want to know when my intake is claimed, so that I have visibility into downstream progress.

#### Acceptance Criteria

1. WHEN a Customer_Intake created by a CS_User is claimed by an Agent, THE Work_Desk SHALL persist a notification to the creating CS_User within 5 seconds of the claim event.
2. THE notification SHALL include the customer name, claiming Agent display name, and claim datetime.
3. IF the CS_User is not active at the time of the claim, THE Work_Desk SHALL present the notification on next session load without requiring manual refresh.

### Requirement 21: Notifications - Duplicate Flagged

**User Story:** As a Manager, I want to be notified when a quote is flagged as a possible duplicate, so that I can review and resolve it promptly.

#### Acceptance Criteria

1. WHEN an Agent flags a quote as a possible duplicate, THE Work_Desk SHALL create a persistent notification for each active Manager within 30 seconds of flagging.
2. THE notification SHALL include the flagged quote customer name, the original record customer name, the flagging Agent name, the reason (max 500 chars), and a Review button navigating to the duplicate review screen.
3. IF no active Managers exist at the time of flagging, THE Work_Desk SHALL persist the notification record for when a Manager becomes active.

### Requirement 22: UI - CS Intake Queue View

**User Story:** As a CS_User, I want the Intake Queue to show claim status and linked quote information, so that I can track my intakes through the workflow.

#### Acceptance Criteria

1. THE Work_Desk SHALL display only intakes created by the viewing CS_User with: customer name, source, submission date, Intake_Status, assigned Agent, and linked quote ID.
2. THE Work_Desk SHALL sort by submission date descending, with Drafts appearing above submitted intakes regardless of date.
3. THE Work_Desk SHALL provide View on all intakes, Edit on Draft, Submitted, and Waiting statuses, and Submit on Draft only.
4. WHEN a CS_User edits a Claimed, Assigned, or Converted intake, THE Work_Desk SHALL append changes as update entries per Requirement 2.
5. THE Work_Desk SHALL NOT provide a permanent delete action to CS_Users on any intake.
6. WHEN no intakes exist, THE Work_Desk SHALL display an empty state message with guidance to create a new intake.

### Requirement 23: UI - Agent Intake Queue View

**User Story:** As an Agent, I want the Intake Queue to show whose turn it is and enable claim only when it is my turn, so that I can claim efficiently without confusion.

#### Acceptance Criteria

1. THE Work_Desk SHALL display each intake with source, customer name, submission date, claim status, and current RingCentral_Agent name adjacent to unclaimed RingCentral intakes.
2. WHEN the viewing Agent is the current RingCentral_Agent, THE Work_Desk SHALL enable the claim button on unclaimed RingCentral-sourced intakes.
3. WHEN the viewing Agent is NOT the current RingCentral_Agent, THE Work_Desk SHALL disable the claim button on RingCentral-sourced intakes and display a message showing the current turn holder.
4. WHEN an Agent claims an intake, THE Work_Desk SHALL navigate to My Desk and display the auto-created Operational_Quote.
5. THE Work_Desk SHALL update the turn holder and button state within 5 seconds of a rotation change without requiring page refresh.
6. THE Work_Desk SHALL enable the claim button on non-RingCentral intakes for any eligible Agent.

### Requirement 24: UI - Management Intake Management

**User Story:** As a Manager, I want full intake management capabilities with history and linked quote access, so that I can oversee the entire intake lifecycle.

#### Acceptance Criteria

1. THE Work_Desk SHALL display all intakes with customer name, source, status, submission date, Agent, linked quote, and creator; providing View, Edit, Assign, Delete, Restore, Open Linked Quote, and View History actions.
2. WHILE an intake has Deleted status, THE Work_Desk SHALL disable Edit, Assign, Delete, and Open Linked Quote, enabling only Restore and View History.
3. IF no linked quote exists, THE Work_Desk SHALL disable or hide the Open Linked Quote action.
4. WHEN a Manager assigns an intake, THE Work_Desk SHALL present an active Agent list, trigger the automatic quote creation workflow, and record the Assignment_Method as Manager Assignment.
5. WHEN a Manager selects View History, THE Work_Desk SHALL display the full timeline per Requirement 4.
6. IF an intake already has a linked quote, THE Work_Desk SHALL show the existing quote rather than allowing duplicate assignment.

### Requirement 25: UI - Management Duplicate Review

**User Story:** As a Manager, I want the duplicate review interface to support compare, merge, keep-both, and mark-not-duplicate actions with field selection, so that I can resolve duplicates accurately.

#### Acceptance Criteria

1. THE duplicate review screen SHALL display both records side-by-side with all stored fields, highlighting differences.
2. WHEN a Manager selects Merge Records, THE Work_Desk SHALL allow the Manager to select which fields to keep from each record, require confirmation, and archive the non-surviving record.
3. IF the Manager cancels or navigates away during merge field selection, THE Work_Desk SHALL discard selections and leave both records unchanged.
4. WHEN a Manager selects Keep Both but Link Them, THE Work_Desk SHALL create a bidirectional reference displayed on each detail view and return both to active status.
5. WHEN a Manager selects Not a Duplicate, THE Work_Desk SHALL return the flagged quote to its pre-flagging status and remove it from the duplicate review queue.

### Requirement 26: Database Functions and Transactions

**User Story:** As a platform owner, I want all critical operations executed as Supabase functions with transactional safety, so that data integrity is guaranteed under concurrent use.

#### Acceptance Criteria

1. THE Work_Desk SHALL provide the following Supabase database functions: `update_customer_intake`, `delete_customer_intake`, `restore_customer_intake`, `claim_ringcentral_intake`, `assign_customer_intake`, `convert_intake_to_quote`, `flag_quote_duplicate`, `resolve_quote_duplicate`, and `merge_quote_records`.
2. WHEN any of the listed database functions is called, THE Work_Desk SHALL execute all writes within a single database transaction and return a result object with success boolean and affected record IDs.
3. IF any write within a database function fails, THEN THE Work_Desk SHALL roll back the entire transaction and return an error object with success=false, error code string, and human-readable message.
4. WHEN concurrent calls target the same record, THE Work_Desk SHALL serialize via row-level locking.
5. IF a database function exceeds 30 seconds, THEN THE Work_Desk SHALL abort, roll back, and return a timeout error.

### Requirement 27: Database Permissions

**User Story:** As a platform owner, I want role-based permissions enforced at the database level, so that no role can perform unauthorized actions even through direct API access.

#### Acceptance Criteria

1. THE Work_Desk SHALL enforce the following CS_User permissions: create intake, edit own intake (subject to status rules), submit intake, and view intake queue.
2. THE Work_Desk SHALL enforce the following Agent permissions: claim eligible intakes, view intake queue, view team quotes, manage own quotes (add notes, attachments, status changes), and flag duplicates.
3. THE Work_Desk SHALL enforce the following Manager permissions: all CS_User permissions, all Agent permissions, edit any intake, assign intakes, soft-delete intakes, restore intakes, override RingCentral claims, review and resolve duplicates, merge records, reassign quotes, and view all history.
4. THE Work_Desk SHALL enforce these permissions at the Supabase Row Level Security and RPC authorization level in addition to UI-level controls.
5. IF an unauthorized action is attempted, THEN THE Work_Desk SHALL reject at the database level with an error and no data modified.
6. IF a CS_User attempts to edit a non-owned or non-draft intake, THEN THE Work_Desk SHALL reject at the database level.
