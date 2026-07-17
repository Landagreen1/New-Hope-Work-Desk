# Requirements Document

## Introduction

This specification establishes a permanent, canonical customer identity for the New Hope Work Desk and prevents unrelated duplicate active quotes. The identity applies across Customer Service Quote Intake, WhatsApp, RingCentral, the Quotes Database, the Workload Database, Renewals Management, Power BI renewal imports, and requotes.

The feature extends the existing Next.js and Supabase platform without replacing current operational tables or workflows. Existing WhatsApp timer, claim, warning, and rescue behavior; RingCentral turn behavior; Customer Service intake attribution; workload operations; renewal operations; and performance attribution remain operational while customer and quote-cycle references become consistent.

## Glossary

- **Work_Desk**: The authenticated New Hope internal Next.js and Supabase platform, including Customer Service, Sales, manager, quote, workload, renewal, and reporting modules.
- **Canonical_Customer**: The permanent customer record that represents one person or business across all Work_Desk modules.
- **Customer_ID**: The immutable unique identifier assigned to a Canonical_Customer.
- **Customer_Display_Name**: The customer name exactly as entered or imported for display and historical context.
- **Normalized_Name**: A comparison value derived deterministically by trimming outer whitespace, applying Unicode case folding, removing punctuation and configured honorifics or suffixes, and collapsing internal whitespace, without changing the Customer_Display_Name.
- **Identity_Service**: The Work_Desk capability that creates, matches, updates, and retrieves Canonical_Customer records and protected identifiers.
- **Protected_Identifier**: A customer identifier subject to restricted storage or display, including a driver license, state identification number, DOT number, HawkSoft client ID, policy number, or another verified external identifier.
- **Trusted_Identifier**: A Protected_Identifier whose normalized value and issuer or namespace can confirm a customer match. Trusted identifiers include driver-license state plus secure hash, DOT number, HawkSoft client ID, policy number within the applicable carrier namespace, and manager-approved external identifiers.
- **Driver_License_Reference**: The driver-license issuing state, last four characters, and Secure_Hash retained for matching.
- **Secure_Hash**: A normalized, keyed, one-way comparison value that does not reveal the source identifier and is not generated without the Work_Desk secret.
- **Encrypted_Full_Identifier**: A reversibly encrypted full Protected_Identifier retained only when a documented Operational_Necessity exists.
- **Operational_Necessity**: A recorded business purpose that requires an authorized role to retrieve a full Protected_Identifier for an insurance operation.
- **Authorized_Sensitive_Data_User**: An authenticated role explicitly granted access to the minimum sensitive identifier data required for an Operational_Necessity.
- **Corroborating_Identity_Field**: A normalized phone number, normalized email address, or date of birth used with a Normalized_Name to support identity matching.
- **Line_of_Business**: The normalized insurance product category for a quote, including Personal Auto and Commercial Auto as distinct values.
- **Dealer_ID**: The unique Work_Desk identifier for a dealership or the explicit Direct / No Source classification.
- **Salesperson_ID**: The unique Work_Desk identifier for a dealership salesperson or the explicit No Salesperson classification.
- **Quote_Cycle**: A customer quotation effort for one Canonical_Customer, Dealer_ID, and Line_of_Business from opening through a terminal outcome.
- **Quote_Cycle_ID**: The immutable unique identifier assigned to a Quote_Cycle.
- **Active_Quote_Cycle**: A Quote_Cycle without a terminal outcome of Sold, Not Sold, Cancelled, or manager-approved closure; Pending Pricing remains active.
- **Previous_Quote_Cycle_ID**: The reference from a requote or later quote cycle to the preceding Quote_Cycle.
- **Origin**: The channel or module that initiated a Quote_Cycle, including Customer Service Intake, WhatsApp, RingCentral, manual quote, manager assignment, Renewal, and Power BI-derived requote.
- **Operational_Quote**: The current Work_Desk quote record used for assignment, pending pricing, outcome, notes, activity, timer, and performance workflows.
- **Quote_Guard**: The transactional Supabase `create_quote_guarded(...)` entry point that resolves identity, detects duplicate quote cycles, and creates or returns records.
- **Duplicate_Key**: The combination of Customer_ID, Dealer_ID, and Line_of_Business used to prevent more than one unrelated Active_Quote_Cycle.
- **Confirmed_Match**: A customer identity result supported by an exact Trusted_Identifier match.
- **Probable_Match**: A customer identity result supported by an exact Normalized_Name match and at least one exact Corroborating_Identity_Field match.
- **Similar_Name_Match**: A customer identity candidate selected by the versioned deterministic name-similarity policy without a Confirmed_Match or Probable_Match.
- **Different_Dealer_Reuse**: Reuse of one Canonical_Customer for a quote associated with a Dealer_ID different from the customer’s other quote cycles.
- **Identity_Challenge**: A user-recorded verification step that classifies a Similar_Name_Match as the same customer or a different customer by comparing a Trusted_Identifier or Corroborating_Identity_Field.
- **Resolution_UI**: The Work_Desk interface that presents match evidence and permitted duplicate-resolution actions.
- **Manager_Override**: A manager-only recorded decision that resolves an identity or quote-cycle exception without bypassing the Duplicate_Key invariant.
- **Customer_Service_Credit**: Attribution to the Customer Service profile that created an intake, independent of the Sales profile that claims, converts, or services the quote.
- **Team_Record**: A quote or workload record belonging to any active Work_Desk team member.
- **Access_Control**: Supabase authorization and Work_Desk role enforcement for viewing and changing customer, quote, workload, and sensitive data.
- **Audit_Service**: The append-only history of security-sensitive, identity, duplicate-resolution, merge, delete, reassignment, and override actions.
- **Merge_Service**: The future manager capability that consolidates a duplicate Canonical_Customer into a surviving Canonical_Customer without deleting either identity history.
- **Merged_Profile**: A non-surviving Canonical_Customer marked as merged and unavailable for new activity.
- **Renewal_Module**: The Work_Desk Renewals Management capability, including assignment, contact history, Power BI import, and requote creation.
- **Power_BI_Import**: A manager-initiated renewal data import containing policy, HawkSoft, customer, assignment, and renewal values.
- **Migration_Package**: A new additive, numbered Supabase migration applied after the current migration baseline.
- **Sensitive_Output**: Any report, Team_Record view, warning, notification, performance result, export, audit detail, log, or error message available outside an authorized sensitive-data operation.

## Requirements

### Requirement 1: Canonical Customer Identity

**User Story:** As a Work Desk user, I want one permanent customer identity across every module, so that activity for the same customer remains connected.

#### Acceptance Criteria

1. THE Identity_Service SHALL assign one immutable Customer_ID to each Canonical_Customer.
2. WHEN Customer Service Intake, WhatsApp, RingCentral, the Quotes Database, the Workload Database, Renewals Management, a Power_BI_Import, or a requote records customer activity, THE Identity_Service SHALL link the activity to one Customer_ID.
3. WHEN a user or import supplies a customer name, THE Identity_Service SHALL preserve the supplied value as a Customer_Display_Name.
4. WHEN a user or import supplies a customer name, THE Identity_Service SHALL derive the same Normalized_Name for every input that differs only by case, punctuation, configured honorifics or suffixes, or repeated whitespace.
5. WHEN customer attributes change, THE Identity_Service SHALL retain the Customer_ID and append the source and timestamp of the changed identity attributes.
6. IF an activity references a Merged_Profile, THEN THE Identity_Service SHALL resolve the activity to the surviving Canonical_Customer.

### Requirement 2: Protected Identifier Handling

**User Story:** As a manager, I want customer identifiers protected while still supporting reliable matching, so that duplicate prevention does not expose sensitive data.

#### Acceptance Criteria

1. WHEN the Work_Desk receives a driver-license or state-identification value, THE Identity_Service SHALL retain a Driver_License_Reference containing the issuing state, last four characters, and Secure_Hash.
2. WHERE a documented Operational_Necessity exists, THE Identity_Service SHALL retain the full driver-license or state-identification value only as an Encrypted_Full_Identifier.
3. IF a documented Operational_Necessity does not exist, THEN THE Identity_Service SHALL discard the full driver-license or state-identification value after deriving the Driver_License_Reference.
4. WHEN the Work_Desk stores DOT numbers, HawkSoft client IDs, policy numbers, or other Trusted_Identifiers, THE Identity_Service SHALL associate each normalized value with the applicable identifier type and issuer or namespace.
5. WHEN an Authorized_Sensitive_Data_User retrieves an Encrypted_Full_Identifier, THE Audit_Service SHALL record the actor, Customer_ID, business purpose, identifier type, and timestamp without recording the full identifier.
6. THE Access_Control SHALL permit Encrypted_Full_Identifier retrieval only when the requester is both an Authorized_Sensitive_Data_User and associated with a documented Operational_Necessity.
7. THE Work_Desk SHALL exclude full driver-license and state-identification values from every Sensitive_Output.
8. THE Work_Desk SHALL display no more than the issuing state and last four characters of a driver-license or state-identification value outside an authorized sensitive-data operation.

### Requirement 3: Quote-Cycle Model

**User Story:** As a Sales or Customer Service user, I want each quotation effort represented as a quote cycle, so that quote history and duplicate rules reflect the customer, dealership, and product involved.

#### Acceptance Criteria

1. THE Work_Desk SHALL assign an immutable Quote_Cycle_ID to each Quote_Cycle.
2. THE Work_Desk SHALL associate each Quote_Cycle with a Customer_ID, Dealer_ID, Salesperson_ID, Line_of_Business, Origin, creator profile, assignee profile, opening date, status dates, and outcome.
3. WHEN a Quote_Cycle is a requote or continuation of an earlier cycle, THE Work_Desk SHALL store the earlier Quote_Cycle_ID as the Previous_Quote_Cycle_ID.
4. WHEN an earlier Quote_Cycle has a terminal outcome, THE Work_Desk SHALL permit a later Quote_Cycle for the same Duplicate_Key.
5. WHEN one Canonical_Customer requests Personal Auto and Commercial Auto, THE Work_Desk SHALL permit one Active_Quote_Cycle for each Line_of_Business at the same Dealer_ID.
6. WHEN one Canonical_Customer requests quotes through different Dealer_ID values, THE Work_Desk SHALL permit a distinct Active_Quote_Cycle for each Dealer_ID and Line_of_Business combination.
7. WHILE a Quote_Cycle is in Pending Pricing, THE Work_Desk SHALL classify the Quote_Cycle as an Active_Quote_Cycle.

### Requirement 4: Transactional Guarded Quote Creation

**User Story:** As an operations manager, I want every quote creation path protected by one transaction, so that simultaneous or module-specific submissions cannot create unrelated duplicate active quotes.

#### Acceptance Criteria

1. THE Quote_Guard SHALL provide the transactional Supabase `create_quote_guarded(...)` entry point for customer resolution and quote creation.
2. WHEN Customer Service conversion, WhatsApp claim, RingCentral claim, manual quote entry, manager assignment, renewal requote, or Power BI-derived quote creation requests an Operational_Quote, THE Work_Desk SHALL use the Quote_Guard before creating the Operational_Quote.
3. WHEN the Quote_Guard receives a request, THE Quote_Guard SHALL evaluate Trusted_Identifiers, name evidence, Dealer_ID, Salesperson_ID, Line_of_Business, Origin, creator, assignee, and Previous_Quote_Cycle_ID within one transaction.
4. WHEN no identity or Duplicate_Key conflict exists, THE Quote_Guard SHALL atomically create or reuse the Canonical_Customer, create the Quote_Cycle, create the Operational_Quote, and return all resulting identifiers.
5. WHEN an Active_Quote_Cycle exists for the resolved Duplicate_Key, THE Quote_Guard SHALL return the existing Customer_ID, Quote_Cycle_ID, Operational_Quote identifier, match level, and permitted resolution actions without creating another Active_Quote_Cycle.
6. IF any required customer, Quote_Cycle, Operational_Quote, relationship, or audit write fails, THEN THE Quote_Guard SHALL roll back every write from the request.
7. WHEN concurrent requests resolve to the same Duplicate_Key, THE Quote_Guard SHALL serialize the decisions so that no more than one unrelated Active_Quote_Cycle exists after all requests complete.
8. WHEN concurrent requests resolve to Duplicate_Key values that differ by Line_of_Business or Dealer_ID, THE Quote_Guard SHALL permit distinct Quote_Cycle records only for the requests whose differing values form different Duplicate_Key values.

### Requirement 5: Four-Level Duplicate Hierarchy

**User Story:** As a quote creator, I want duplicate candidates classified consistently, so that strong matches are reused and uncertain matches receive verification.

#### Acceptance Criteria

1. WHEN an incoming Trusted_Identifier exactly matches a Canonical_Customer in the same identifier namespace, THE Identity_Service SHALL classify the candidate as a Confirmed_Match regardless of additional name or contact matching evidence.
2. WHEN an incoming Normalized_Name exactly matches a Canonical_Customer and at least one Corroborating_Identity_Field exactly matches, THE Identity_Service SHALL classify the candidate as a Probable_Match unless a Trusted_Identifier produces a Confirmed_Match or an identity-data conflict requires manager resolution.
3. WHEN the versioned deterministic name-similarity policy identifies a Similar_Name_Match without a Confirmed_Match or Probable_Match, THE Identity_Service SHALL require an Identity_Challenge before quote creation continues.
4. WHEN a Confirmed_Match or verified Probable_Match belongs to a different Dealer_ID, THE Identity_Service SHALL classify the result as Different_Dealer_Reuse and reuse the Customer_ID.
5. WHEN a Confirmed_Match has an Active_Quote_Cycle for the incoming Dealer_ID and Line_of_Business, THE Quote_Guard SHALL return the existing Active_Quote_Cycle.
6. WHEN a Confirmed_Match has no Active_Quote_Cycle for the incoming Dealer_ID and Line_of_Business, THE Quote_Guard SHALL create a new Quote_Cycle under the matched Customer_ID.
7. IF Trusted_Identifiers conflict with each other or identity evidence contains another unresolved conflict, THEN THE Identity_Service SHALL block automatic quote creation and require manager resolution.

### Requirement 6: Duplicate Resolution Experience

**User Story:** As a quote creator, I want clear duplicate-resolution choices with protected evidence, so that I can continue the correct customer or identify a different customer.

#### Acceptance Criteria

1. WHEN the Quote_Guard returns one or more matches, THE Resolution_UI SHALL display the match level, Customer_ID, Customer_Display_Name, masked matching evidence, Dealer_ID, Line_of_Business, quote status, assignee, and Quote_Cycle_ID for each candidate.
2. WHEN the Quote_Guard returns an existing Active_Quote_Cycle, THE Resolution_UI SHALL offer an action to open and continue the existing Operational_Quote.
3. WHEN the Identity_Service returns Different_Dealer_Reuse, THE Resolution_UI SHALL offer an action to reuse the Customer_ID and create the permitted dealership-specific Quote_Cycle.
4. WHEN the Identity_Service returns a Similar_Name_Match, THE Resolution_UI SHALL require the user to record an Identity_Challenge result before enabling a same-customer or different-customer action.
5. WHEN an Identity_Challenge confirms a Trusted_Identifier or Corroborating_Identity_Field, THE Resolution_UI SHALL permit reuse of the matched Customer_ID regardless of other non-conflicting matching conditions and subject to the Duplicate_Key rule.
6. WHEN an Identity_Challenge verifies that the candidate represents a different customer, THE Resolution_UI SHALL permit creation of a distinct Canonical_Customer and record the compared field types without recording full Protected_Identifier values.
7. IF a required Identity_Challenge is incomplete, THEN THE Resolution_UI SHALL block quote creation until a manager records a Manager_Override.
8. WHEN no Identity_Challenge is required, THE Resolution_UI SHALL permit quote creation to proceed subject to the Quote_Guard result.
9. THE Resolution_UI SHALL exclude full driver-license and state-identification values from match evidence and duplicate warnings.

### Requirement 7: Manager Controls and Auditable Overrides

**User Story:** As a manager, I want controlled correction tools with complete history, so that exceptional identity and assignment decisions remain accountable.

#### Acceptance Criteria

1. THE Access_Control SHALL restrict Manager_Override, customer merge, operational delete, and reassignment actions to active manager profiles.
2. WHEN a manager records a Manager_Override, THE Resolution_UI SHALL require a non-empty reason and a selected resolution action.
3. WHEN a manager records a Manager_Override, THE Audit_Service SHALL append the actor, timestamp, incoming request reference, candidate Customer_ID values, match levels, selected action, reason, and resulting identifiers.
4. WHEN a manager deletes an eligible Operational_Quote or workload record, THE Audit_Service SHALL preserve the actor, timestamp, reason, entity identifier, Customer_ID, Quote_Cycle_ID, and non-sensitive before-state after operational removal.
5. WHEN a manager reassigns a Quote_Cycle, Operational_Quote, pending-pricing record, renewal, or workload record, THE Audit_Service SHALL preserve the previous assignee, new assignee, actor, timestamp, and required reason.
6. IF a Manager_Override would create a second unrelated Active_Quote_Cycle for the same Duplicate_Key, THEN THE Quote_Guard SHALL require the manager to continue, close, or reclassify the existing Quote_Cycle instead.
7. WHERE a manager declares a documented emergency that requires a temporary second Active_Quote_Cycle for the same Duplicate_Key, THE Quote_Guard SHALL mark the additional cycle as an emergency-related exception and require enhanced audit details containing the emergency basis, approving manager, expiration or resolution condition, and links between both cycles.
8. THE Access_Control SHALL reject merge, delete, reassignment, and Manager_Override requests from every agent and Customer Service profile through the user interface and direct Supabase requests.

### Requirement 8: Team Visibility and Role Boundaries

**User Story:** As an agent, I want visibility into complete team quote and workload records, so that I can detect existing work and collaborate without gaining manager powers.

#### Acceptance Criteria

1. WHEN an active agent opens the Quotes Database or Workload Database, THE Access_Control SHALL permit viewing Team_Records across all assignees.
2. WHEN an active Customer Service profile opens an authorized quote or workload team view, THE Access_Control SHALL permit the Team_Record visibility assigned to the Customer Service role.
3. WHILE an agent or Customer Service profile views Team_Records, THE Work_Desk SHALL omit Encrypted_Full_Identifiers and display Protected_Identifiers only in the masked forms allowed by Requirement 2.
4. WHILE an agent or Customer Service profile views Team_Records, THE Work_Desk SHALL hide merge, delete, reassignment, and Manager_Override controls.
5. THE Access_Control SHALL enforce Team_Record visibility and manager-only mutation boundaries in Supabase authorization in addition to user-interface controls.

### Requirement 9: Customer Service Intake and Credit

**User Story:** As a Customer Service employee, I want intake work linked to the canonical customer while retaining my intake credit, so that Sales conversion does not erase Customer Service contribution.

#### Acceptance Criteria

1. WHEN Customer Service submits a quote intake, THE Identity_Service SHALL resolve or create the Customer_ID before the intake becomes eligible for conversion.
2. WHEN Sales claims or a manager assigns a Customer Service intake, THE Work_Desk SHALL preserve the current claim, assignment, return, and notification behavior.
3. WHEN Sales converts a Customer Service intake, THE Quote_Guard SHALL create or reuse the applicable Quote_Cycle and Operational_Quote.
4. WHEN the Quote_Guard returns an existing Active_Quote_Cycle for a Customer Service intake, THE Work_Desk SHALL link the intake to the existing Quote_Cycle and record the duplicate-resolution outcome.
5. WHEN a Customer Service intake is linked to a new or existing Quote_Cycle, THE Work_Desk SHALL preserve Customer_Service_Credit for the intake creator independently from Sales assignment and quote ownership within the same transaction as the linkage.
6. IF Customer_Service_Credit preservation or another required linkage write fails, THEN THE Work_Desk SHALL roll back the intake-to-Quote_Cycle linkage and all related writes.
7. WHEN a Customer Service intake includes drivers, THE Work_Desk SHALL prevent full driver-license or state-identification values from entering work-item events, quote notes, notifications, reports, or team database payloads.
8. WHEN a Customer Service intake originates from a renewal, THE Work_Desk SHALL preserve the renewal, intake, Customer_ID, Quote_Cycle_ID, and Operational_Quote links.

### Requirement 10: WhatsApp and RingCentral Operational Preservation

**User Story:** As a Sales agent, I want duplicate prevention added without changing channel rotation rules, so that quote ownership remains fair and familiar.

#### Acceptance Criteria

1. WHEN a WhatsApp rescue timer starts, THE Work_Desk SHALL preserve the configured current-agent deadline, warning timing, and alert behavior.
2. WHEN the current WhatsApp agent claims a timed quote, THE Work_Desk SHALL preserve the normal WhatsApp queue-advancement rule and route quote creation through the Quote_Guard.
3. WHEN an eligible agent rescues an expired WhatsApp quote, THE Work_Desk SHALL preserve the rule that consumes the missed agent’s turn and preserves the next queue position.
4. WHEN the Quote_Guard returns an existing Active_Quote_Cycle during a WhatsApp claim or rescue, THE Work_Desk SHALL link the channel event to the existing Quote_Cycle while preserving the applicable claim or rescue turn event.
5. WHEN the current RingCentral agent claims a quote, THE Work_Desk SHALL preserve the RingCentral queue-advancement rule and route quote creation through the Quote_Guard.
6. WHILE a RingCentral operation is active, THE Work_Desk SHALL provide no rescue or steal action.
7. IF a non-current agent attempts to claim a RingCentral quote, THEN THE Work_Desk SHALL reject RingCentral ownership and turn advancement for the non-current agent.
8. WHEN a rejected non-current RingCentral claim contains a valid quote request, THE Work_Desk SHALL permit the Quote_Guard to create or reuse the quote records for assignment to the current RingCentral agent without granting ownership to the non-current agent.

### Requirement 11: Operational Work and Database Consistency

**User Story:** As a Work Desk user, I want quotes and workloads linked to the same customer and cycle, so that database views do not disagree about ownership or history.

#### Acceptance Criteria

1. THE Work_Desk SHALL associate each current or newly created `work_items` record with a Customer_ID, Quote_Cycle_ID, Dealer_ID, and Salesperson_ID.
2. WHEN an operational record has no external dealership or salesperson, THE Work_Desk SHALL use the explicit Direct / No Source Dealer_ID and No Salesperson Salesperson_ID classifications.
3. WHEN workload is created from an existing quote, THE Work_Desk SHALL inherit the Customer_ID, Quote_Cycle_ID, Dealer_ID, and Salesperson_ID from the linked quote.
4. WHEN legacy unlinked workload is entered, THE Identity_Service SHALL resolve the Customer_ID and associate the workload with a traceable Quote_Cycle before creation completes.
5. IF Customer_ID or Quote_Cycle resolution fails for legacy unlinked workload, THEN THE Work_Desk SHALL roll back workload creation.
6. WHEN a quote moves among active work, Pending Pricing, Sold, Not Sold, or Cancelled states, THE Work_Desk SHALL retain the same Customer_ID and Quote_Cycle_ID.
7. WHEN the Quotes Database and Workload Database display records from the same Quote_Cycle, THE Work_Desk SHALL display consistent customer, dealer, salesperson, assignee, Line_of_Business, and status values.
8. IF the Work_Desk detects inconsistent current customer, dealer, salesperson, assignee, Line_of_Business, or status values for the same Quote_Cycle, THEN THE Work_Desk SHALL block mutations for the affected records until consistency is restored.
9. WHEN an identity, dealer, salesperson, or assignee correction occurs, THE Work_Desk SHALL propagate the corrected relationship to module views without changing historical audit events.

### Requirement 12: Renewals, Power BI Imports, and Requotes

**User Story:** As a renewal user, I want imported and requoted records tied to the canonical customer, so that renewal work cannot create disconnected identities or duplicate active quotes.

#### Acceptance Criteria

1. WHEN the Renewal_Module creates or updates a renewal record, THE Identity_Service SHALL link the renewal record to a Customer_ID.
2. WHEN a Power_BI_Import supplies a HawkSoft client ID or policy number, THE Identity_Service SHALL evaluate the supplied value as a Trusted_Identifier in the applicable namespace.
3. WHEN a Power_BI_Import row matches an existing policy number and renewal date, THE Renewal_Module SHALL preserve the current update-open-record and preserve-closed-record behavior while retaining the Customer_ID.
4. WHEN a Power_BI_Import row identifies an existing Canonical_Customer through Trusted_Identifier or Probable_Match evidence, THE Renewal_Module SHALL reuse the Customer_ID.
5. WHEN a renewal is sent to requote, THE Renewal_Module SHALL create or reuse an intake linked to the renewal and Customer_ID.
6. WHEN an authorized user creates an intake without a renewal requote trigger, THE Work_Desk SHALL permit intake creation and apply canonical identity resolution before conversion.
7. WHEN a renewal intake converts to a quote, THE Quote_Guard SHALL enforce the Duplicate_Key rule and store the Previous_Quote_Cycle_ID when a preceding Quote_Cycle exists.
8. WHEN a renewal requote resolves to an existing Active_Quote_Cycle for the same Duplicate_Key, THE Renewal_Module SHALL always link the renewal and intake to the existing Quote_Cycle without creating another Active_Quote_Cycle for that Duplicate_Key.
9. WHEN a renewal record, intake, quote, or workload view displays the same customer activity, THE Work_Desk SHALL use the same Customer_ID and Quote_Cycle_ID relationships.

### Requirement 13: Future Duplicate-Customer Merge

**User Story:** As a manager, I want a safe future merge operation for confirmed duplicate customers, so that relationships consolidate without deleting history.

#### Acceptance Criteria

1. WHEN a manager starts a customer merge, THE Merge_Service SHALL require a surviving Customer_ID, a duplicate Customer_ID, and a non-empty reason.
2. WHEN a customer merge completes, THE Merge_Service SHALL transfer quote cycles, work items, pending-pricing records, quote outcomes, intakes, renewals, identifiers, notes, and other customer relationships to the surviving Customer_ID.
3. WHEN transferred relationships would violate the Duplicate_Key rule, THE Merge_Service SHALL require the manager to resolve the conflicting Active_Quote_Cycle records before completing the merge.
4. WHEN a customer merge completes, THE Merge_Service SHALL append immutable merge history containing both Customer_ID values, actor, timestamp, reason, transferred relationship counts, and identifier-conflict decisions.
5. WHEN a customer merge completes, THE Merge_Service SHALL mark the duplicate customer as a Merged_Profile linked to the surviving Customer_ID.
6. IF a merge status is recorded before the surviving Customer_ID link succeeds, THEN THE Merge_Service SHALL keep the duplicate customer blocked as a Merged_Profile, record an incomplete-merge exception, and require manager repair before completing relationship transfers.
7. WHILE a Canonical_Customer is a Merged_Profile, THE Identity_Service SHALL block new quotes, workloads, renewals, intakes, identifiers, and direct profile updates against the Merged_Profile.
8. THE Merge_Service SHALL retain the Merged_Profile and associated immutable history rather than deleting the duplicate customer record.
9. WHEN the Quote_Guard receives a Merged_Profile Customer_ID with a surviving Customer_ID link, THE Quote_Guard SHALL use the surviving Customer_ID before duplicate evaluation.
10. IF the Quote_Guard receives a Merged_Profile Customer_ID without a surviving Customer_ID link, THEN THE Quote_Guard SHALL block new activity and return the incomplete-merge exception.

### Requirement 14: Audit, Reporting, and Attribution Integrity

**User Story:** As a manager, I want identity decisions and performance attribution to remain complete and safe, so that operational reports are trustworthy.

#### Acceptance Criteria

1. WHEN identity matching, Identity_Challenge, Different_Dealer_Reuse, duplicate reuse, Manager_Override, merge, delete, or reassignment occurs, THE Audit_Service SHALL append a timestamped event with the actor and resulting Customer_ID and Quote_Cycle_ID values.
2. THE Audit_Service SHALL exclude full driver-license and state-identification values from audit events.
3. WHEN a Quote_Cycle is reused instead of duplicated, THE Work_Desk SHALL count the Quote_Cycle once in quote totals while retaining each intake, channel, claim, rescue, and resolution event.
4. WHEN Customer Service creates an intake that Sales converts or links, THE Work_Desk SHALL retain Customer_Service_Credit and Sales ownership as separate attribution values.
5. WHEN quote or workload relationships are reassigned, THE Work_Desk SHALL retain original creator, original owner, prior assignee, and current assignee attribution.
6. WHEN reports, exports, warnings, notifications, team databases, or performance views are generated, THE Work_Desk SHALL use canonical Customer_ID and Quote_Cycle_ID relationships.
7. THE Work_Desk SHALL exclude full driver-license and state-identification values from reports, exports, warnings, notifications, team databases, performance views, logs, and errors.

### Requirement 15: Additive Migration and Backfill

**User Story:** As a platform owner, I want an additive database rollout, so that unified identity can be introduced without destructive replacement or interruption of current operations.

#### Acceptance Criteria

1. THE Migration_Package SHALL use a new numbered migration after the current Supabase migration baseline.
2. THE Migration_Package SHALL add or extend schema objects without rerunning `schema.sql` or destructively replacing production tables.
3. WHEN the Migration_Package encounters existing quote, workload, intake, renewal, pending-pricing, outcome, note, timer, event, or performance records, THE Migration_Package SHALL preserve the records and existing operational identifiers.
4. WHEN existing records contain enough Trusted_Identifier or Probable_Match evidence, THE Migration_Package SHALL backfill Customer_ID and Quote_Cycle_ID relationships deterministically.
5. WHEN existing records do not contain enough evidence for deterministic identity resolution, THE Migration_Package SHALL flag the records for manager resolution without automatically merging customers.
6. WHEN existing evidence cannot be classified as sufficient or insufficient by the migration rules, THE Migration_Package SHALL preserve the records as unflagged legacy records and proceed without automatic identity resolution.
7. WHEN existing event, JSON, report-support, or team-view data contains a full driver-license or state-identification value, THE Migration_Package SHALL remove the full value from broad-access storage and retain only the protected representation required by Requirement 2.
8. WHEN the migration backfill forms Quote_Cycle records, THE Migration_Package SHALL preserve existing assignment, Customer_Service_Credit, intake, renewal, channel, timing, outcome, and performance attribution.
9. IF migration verification detects a missing required relationship or a Duplicate_Key violation, THEN THE Migration_Package SHALL stop activation of guarded quote creation, allow existing quote creation behavior to remain available, and report the affected record identifiers without exposing full Protected_Identifier values.
10. WHILE the feature is being activated, THE Work_Desk SHALL preserve current WhatsApp, RingCentral, workload, Customer Service, renewal, notification, and reporting behavior except where this document explicitly adds identity and duplicate controls.

### Requirement 16: Cross-Module Invariants and Failure Responses

**User Story:** As a Work Desk user, I want every module to enforce the same identity rules and return actionable failures, so that alternate workflows cannot bypass duplicate protection.

#### Acceptance Criteria

1. THE Work_Desk SHALL maintain no more than one unrelated Active_Quote_Cycle for each Duplicate_Key.
2. WHEN the same Canonical_Customer has different Dealer_ID or Line_of_Business values, THE Work_Desk SHALL preserve the permitted distinct Quote_Cycle records.
3. WHEN a full driver-license match is submitted as a Driver_License_Reference, THE Identity_Service SHALL reuse the matched Customer_ID and enforce no more than one unrelated Active_Quote_Cycle for the resulting Duplicate_Key.
4. WHEN similar names lack Confirmed_Match or Probable_Match evidence, THE Work_Desk SHALL require the Identity_Challenge defined by Requirement 6.
5. WHEN any module attempts direct quote creation outside the Quote_Guard, THE Access_Control SHALL reject the creation.
6. IF identity resolution, duplicate evaluation, authorization, or transactional creation fails, THEN THE Quote_Guard SHALL return a structured failure category and user-safe message without exposing a full Protected_Identifier.
7. WHEN the same record is displayed in Customer Service Intake, WhatsApp or RingCentral activity, Quotes Database, Workload Database, Renewals, Power BI import results, or requotes, THE Work_Desk SHALL resolve the record to consistent Customer_ID and Quote_Cycle_ID values.
