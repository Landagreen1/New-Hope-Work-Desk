# v1.21.0 — Carrier Email Submission

- Added **Carrier Submissions** to the Specialty Quote workspace. A sender opens a carrier, reviews a pre-filled message with the right application already attached, adjusts anything they want, and sends it from their own mailbox.
- Submissions are sent through the sender's real Microsoft 365 mailbox, authorised once by OAuth. The message lands in their Sent Items and carrier replies thread back to them, rather than arriving at a shared relay address nobody watches.
- **Phase 1 has one sender.** Eligibility is a flag on the profile, not a name in the code, so enabling a second sender is a database update rather than a deployment.
- The Work Desk asks only for permission to send mail and to read the signed-in user's name. **It cannot read anyone's inbox**, and a test fails the build if a mail-read scope is ever added.
- OAuth tokens are encrypted with AES-256-GCM before they reach the database, using a key held only in the server environment. A stolen database backup yields ciphertext and nothing else. The ciphertext column is additionally hidden from browser sessions by column grant, not merely by row-level policy.
- **Submission state is history, not a tick.** A carrier can receive an initial submission, additional documents, and a revised application as three separate records, each preserving the recipients, subject, body, and attachment list exactly as sent.
- The attachment record is a snapshot, not a join. Renaming or deleting a quote document later cannot rewrite what a submission says was sent.
- A send is reserved in the database *before* the provider is contacted, so a double-click, a client retry, or a duplicated request produces one email and returns the original record rather than sending twice.
- **A failed send is never recorded as a success.** Three database constraints refuse to store a submission as sent without a provider message identifier and a timestamp, so the guarantee does not depend on application code being correct.
- Carrier submission addresses, CC lists, and the subject and body templates are maintained from User Administration → Market Directory → Submission. Changing where a submission goes no longer requires a deployment.
- Email submission is off for every carrier until a manager deliberately turns it on.
- Requested coverages are derived from the linked intake, so the message lists Auto Liability, UM/UIM, Physical Damage, Motor Truck Cargo, Trailer Interchange and General Liability only when they were actually asked for.
- Carrier status reuses the existing vocabulary — no new values. A first successful submission advances a carrier from Not Submitted or Ready to Submitted through the existing RPC, and never drags a carrier that has already quoted back to Submitted.
- Generated carrier applications now fail loudly if they cannot be recorded as a quote document. Previously that write discarded its error, so a PDF could exist in storage and never appear on the Documents tab.
- Added Supabase migration v1.21.0 with its own post-conditions, a tested rollback, and a verification probe.

# v1.20.0 — Specialty Quote Workspace

- Opening a Specialty Quote is now a **navigation to its own full-screen page** at `/specialty-quotes/[quoteId]`, not a side panel. Browser Back returns to the list, refreshing keeps the quote open, and a manager can send a teammate a link straight to a quote — or to one carrier's request.
- Added `/specialty-quotes`, the routed list. Its search, view, filters and page live in the query string, so coming back from a quote lands on the list you left rather than on a default one.
- Removed the quote-detail side drawer. It was the only place the whole case could be read, and a five-carrier trucking quote does not fit in a 640-pixel panel.
- The workspace has five tabs — Overview, Carriers, Application, Documents, Activity — each addressable as `?tab=`.
- Added a **workflow progress rail**: Intake → Submissions → Quoting → Customer → Complete, derived from the existing nine stages and the live carrier markets. No new status column, no second status system.
- Added a **Next Action** reading, computed in one place from the quote's own state and ordered so that a carrier's request for information outranks a document the team is still chasing. What a teammate recorded by hand is shown beside it, never replaced by it.
- Added a **quote health** panel that names what is missing — outstanding information, carrier requests, an unanswered section — instead of inventing a completion percentage.
- Rebuilt the Carriers tab as a case with one workstream per carrier: a marketing summary, a comparison of the viable quotes, and a full-width workspace per carrier holding its status, dates, pricing, documents, notes and status history.
- Renamed the carrier statuses for readability without touching the nine stored values: Not Started → **Not Submitted**, Waiting → **Under Review**, More Information Needed → **Needs Information**, Quote Received → **Quoted**. Declined, Not Competitive and Withdrawn stay separately named, because the carrier performance report measures the difference.
- Rebuilt the Application tab as the master intake in collapsible sections — Customer, Business, Operations, Drivers, Vehicles, Cargo, Coverage, Prior Insurance, Loss History — each showing its state, its summary and the answers an underwriter would send it back for.
- Gave **Cargo** the room it needs. The structured category, the commodity mix with per-load values, the prohibited-cargo answers and the maximum value per load are all shown by name, a one-word answer such as "Dry Freight" is called out as too general to rate, and a requested cargo limit below the biggest recorded load is flagged before the quote is marketed.
- Made **requested coverage** prominent and editable where it lives: Auto Liability, Cargo, Physical Damage and Trailer Interchange for trucking, dwelling and liability for homeowners.
- Replaced the single global edit form with contextual editing: Coverage, Cargo, a driver, a unit, a carrier's pricing and a carrier's requested information are each edited from where they are read.
- Grouped Documents into Customer Documents, Carrier Applications, Carrier Quotes, Underwriting and Other. A reading of the existing categories — no new column, no second storage system, and adopted Commercial Board documents still open from their original bucket.
- Kept the notes list and the workflow checklist, both on the Overview. The checklist is still seeded from the line of business's workflow template and still counted on the list rows; ticked items can be hidden so a long checklist does not sit between the reader and what is left.
- A document's Remove button now appears only where the database would allow the deletion — the uploader, or a manager. It was previously offered to any editor and refused on click.
- Added Supabase migration v1.20.0, which widens `specialty_update_intake` to accept the coverage, cargo, operations and underwriting fields the workspace shows, and fixes a latent data-loss bug: its driver and vehicle replace-all predated the trucking columns, so editing a driver would have erased every CDL, stated value and truck type on the intake.
- In the same migration, an unanswered driver question stays unanswered. `cdl`, `owner_operator`, `accidents_36mo` and `violations_36mo` were being defaulted to false, which turns a question nobody asked into an answer the insured never gave.
- No data migration, no new tables and no changed statuses. Every existing Specialty Quote, carrier submission, document and price opens in the new workspace unchanged.

# v1.16.0 — Specialty Quotes Engine

- Added **Specialty Quotes**, one collaborative quoting module for Trucking and Homeowners, replacing the practice of routing those intakes onto the Commercial Board.
- Added **Quoting Teams** under User Administration. A manager creates a team, sets its members and their capabilities, chooses its assignment method, and routes a line of business to it — no migration and no developer.
- Access to Specialty Quotes comes from team membership, not from an application role. No `trucking_agent` or `homeowners_agent` role exists; Oscar and Jason are Super Admins and Brenda is Customer Service, and all three are ordinary team members.
- Seeded the Trucking Team (Oscar, Jason) and the Homeowners Team (Oscar, Jason, Brenda), both on Shared Claim with collaborative editing enabled.
- **Assignment is accountability, not ownership.** Every eligible team member can open, edit, add notes to, upload documents to and work the carrier markets of any of the team's quotes, whoever is assigned. No row-level policy anywhere in the engine tests the assignee.
- Added the Specialty Quote Opportunity, with the nine-stage workflow New → Information Needed → Ready to Market → Marketing → Options Ready → Price Sent → Follow-Up → Sold / Not Sold.
- Added **Carrier Markets**: one quote holds many carriers, each with its own status, submission date, follow-up date, premium, down payment, terms, documents, notes and decline reason. A five-carrier quote is one record, not five.
- Added a price comparison across viable quotes, and an explicit **Price Sent** action that freezes a snapshot of exactly what the customer was shown. Receiving a carrier quote no longer implies the customer has a price.
- Required a structured reason for Not Sold, and a bound carrier plus a premium for Sold. Reopening a closed quote is a manager action.
- Added a structured **Information Needed** list that Customer Service can see and answer from Quote Center, so a customer callback no longer needs a new intake.
- Added workflow templates that seed the standard Trucking and Homeowners checklists when a quote arrives.
- Added one chronological activity timeline per quote, merged with the originating intake's own history. Every entry records the employee who actually acted, never the assignee.
- Added contributor tracking derived from recorded actions, reported separately from primary assignment.
- Added Specialty reporting: pipeline, needs-attention, employee workload, contribution, pipeline timing, carrier performance and lost business.
- Made claiming atomic: two members clicking Claim at the same moment produce one winner and a message naming them, and the quote stays fully workable by both.
- Made collaborative editing safe: a save against a stale version is refused with a conflict message instead of overwriting a teammate.
- Added a linked-intake edit flow so a specialty member can correct customer, business, property, vehicle and driver information on the original intake rather than in a second copy.
- Routed new Trucking and Homeowners intakes to the specialty team that owns the line. Customer Service no longer picks an assignee for those lines.
- Stopped Trucking and Homeowners from reaching the Commercial Board, with two independent guards, so one live quote can never appear in two places.
- Migrated existing live Trucking and Homeowners commercial cards into Specialty Quotes with their comments, attachments, checklists, history, assignee and original timestamps intact. The commercial rows are kept and simply stop appearing on the board.
- Extended Quote Center so a customer handed to a specialty team keeps a truthful status — Submitted to Specialty Team, Information Needed, Being Quoted, Options Ready, Price Sent, Sold, Not Sold — instead of reading "On Commercial Board".
- Commercial GL is deliberately unchanged: same board, same routing, same reports, same attachments and checklists.
- Added Supabase migrations v1.16.0 through v1.16.7, each with its own post-conditions.

# v0.9.4.1

- Allowed quotes to proceed without a salesperson when the selected source has zero active salespeople.
- Kept salesperson selection mandatory when the selected source has one or more active salespeople.
- Added a safe follow-up SQL hotfix for databases where v0.9.4b was already applied.

# v0.9.4

- Added a one-minute automatic dashboard refresh fallback while preserving Supabase Realtime updates.
- Added refresh-on-focus, refresh-on-tab-return, refresh-on-reconnect, and a visible Last Updated time.
- Added safe manager-controlled user deletion that disables access and queue participation while preserving history.
- Added dealer-specific salesperson administration. Salesperson selection is required when the selected source has active salespeople and optional when it has none.
- Persisted salesperson ownership through Active, Pending Pricing, Sold/Not Sold, rescue timers, service work, logs, reports, and CSV data.
- Renamed All Quotes / Quote Records to **Quotes Database** and removed quote-count navigation badges.
- Added Quotes Database filters for day, status, update type, customer, source, salesperson, and agent.
- Added the Agent **My Team** interaction view for reviewing the latest team quote activity and preventing duplicate entries.
- Added Agent **Manual Workload** for Activations and Changes without moving the Additional Workload rotation.
- Added v0.9.4 Supabase migrations and verification queries.

# v0.9.3

- Added a dedicated Customer Service user role and workspace.
- Added Customer Service accounts to User Administration.
- Updated Queue Health overflow controls to select only Customer Service accounts.
- Fixed password reset so management types the temporary password.
- Removed direct Pass from the Additional Workload rotation.
- Restricted linked Additional Workload to Sold and Pending Pricing quotes.
- Added Agent-controlled Not Sold to Sold recovery with required notes, activation history, Sold credit preservation, and audit logging.

# v0.9.2

- Replaced multi-agent quote-stealing windows with one three-minute timer for the current queue agent.
- Added immediate and 30-second rescue-timer alerts.
- Preserved queue order when another eligible agent steals the quote.
- Added manager-controlled Customer Service overflow in Queue Health.
- Added required notes and pass tracking for Activation/Change Customer Service handoffs.
- Preserved Additional Workload turn credit after Customer Service reassignment.

# Changelog

## v0.9.1

- Redesigned Reports Center with grouped vertical navigation and a mobile selector.
- Prioritized Command Center, Sales, People, Queues, Service, and Control reports.
- Simplified report KPI header and export layout.
- Simplified login screen and added Enter-to-sign-in behavior.

## v0.8.0

- Linked Activations automatically convert the related quote to **Sold** while still creating a workload task that must be taken and completed.
- Added legacy/unlinked Change and Activation entry for older business not already stored in Work Desk.
- Added a shared Quote Log for every quote with activities, notes, timestamps, display names, and `@username`.
- Added a 3-minute **Take** action for overdue WhatsApp and RingCentral quote turns.
- Take records the taker, skipped eligible agents, source-received time, taken time, and total elapsed time.
- Replaced the WhatsApp Update quick action with **Payments**; payment activity does not require an existing quote or consume a turn.
- Added notes to normal WhatsApp, RingCentral, manual, Take, workload, and manager-assignment workflows.
- Manager reassignments now require a reason and preserve it in shared quote history when applicable.
- Added `quote_take_events` and new v0.8.0 RPCs.
- Requires `supabase/migrations/v0.8.0.sql`.

## v0.7.4

- Daily reset now clears all three rotation pointers so queues display **No agent yet** until the first eligible agent becomes Available.
- If the current agent becomes unavailable and nobody else is eligible, the queue becomes empty instead of waiting on an unavailable agent.
- Removed the client-side fallback that displayed the first agent when the database had no current queue owner.
- Failed turn actions now force an immediate live-data refresh so stale queue screens self-correct.
- Added an agent-facing **All Quotes** tab with search across every agent and every quote stage.
- Additional Workload now links activations and changes to an existing quote instead of re-entering customer/source details and creating duplicate quote records.
- Added persistent quote follow-up notes that survive Active -> Pending Pricing -> Sold/Not Sold transitions.
- Added follow-up note history and note entry to both Agent Pending Pricing and Management Pending Pricing.
- Updated manager quote deletion to remove notes belonging to the deleted quote.

## 0.7.2

- Managers can type the temporary password they want to issue when resetting a user password.
- Added an optional secure-password generator inside the reset dialog.
- Kept mandatory private-password change behavior after every reset.
- Added a concurrency-safe daily availability reset based on the America/New_York business date.
- All active agents reset to Unavailable at the start of each new business day.
- The reset is enforced on dashboard load, before availability changes, and by a one-minute open-screen heartbeat.
- The first eligible agent to click Available after the daily reset starts each eligible queue for the day.
- Requires `supabase/migrations/v0.7.2.sql`.

## 0.7.1

- Added live agent availability status to the Agent Performance team comparison.
- Added current open task counts to Agent Performance.
- Highlighted Lunch/Unavailable agents who still have active work as needing coverage.
- Kept all Quote Timing analysis manager-only under Management → Reports → Quote Timing.
- Added future module architecture guidance so new internal tools can be added without rebuilding the Work Desk.
- Added a central module registry scaffold and feature-module conventions for future platform growth.
- No database migration is required beyond the existing v0.7.0 migration.

## 0.7.0

- Added manager-created and manager-assigned quotes without moving any rotation.
- Added explicit agent acceptance for manager-assigned and manager-reassigned active work.
- Added persistent turn and assignment notifications stored in Supabase.
- Added desktop/browser notifications, sound alerts, unread counts, and an in-app alert inbox.
- Added the four standard Not Sold reasons: Price too high, Customer chose another option, No response, and Customer no longer needs coverage.
- Added an Other Not Sold reason with required typed detail.
- Added Not Sold reason reporting and CSV fields.
- Added assignment, acceptance, price-sent, final-decision, completion, cancellation, and reassignment lifecycle timestamps.
- Added a work-item lifecycle event log for auditability.
- Added Quote Timing reports by agent and detailed quote timeline tables.
- Added quote timing CSV exports for assignment-to-take, take-to-price, take-to-final-decision, price-to-decision, and total cycle time.
- Added manager alerts for assignments waiting on agent acceptance.
- Reassigning active work now starts a new acceptance clock and sends an alert to the new agent.
- Requires `supabase/migrations/v0.7.0.sql` when upgrading from v0.6.x.

## 0.6.1

- Added Completion Efficiency: final Sold/Not Sold decisions divided by all quotes received.
- Pending Pricing and active quotes no longer count as completed for efficiency.
- Kept Sales Conversion separate: Sold divided by finalized decisions only.
- Added Completion Efficiency to agent performance, team comparison, manager reports, source reports, input-method reports, and CSV exports.
- Renamed the user-facing Dealers concept to Sources across management, agent forms, follow-up screens, reports, and exports.
- Sources can represent dealerships, walk-ins, office calls, email leads, referrals, websites, or other lead origins.
- Kept Input Method as a separate reporting dimension; WhatsApp and RingCentral are automatic, while manual quotes select an input method.
- Made Source required for manual quotes so every quote has a reportable origin.
- Fixed the searchable Source field so the search icon no longer overlaps typed or pasted text.
- Changed the login username placeholder from an employee example to `Username`.
- No database migration is required beyond the existing v0.6.0 migration.

## 0.6.0

- Added manager dealer administration with create, edit, deactivate, and reactivate controls.
- Added searchable dealer selection with paste-to-match behavior in all agent quote and service forms.
- Preserved inactive dealer names in historical reports while removing them from new selections.
- Added independent WhatsApp, RingCentral, and Additional Workload queue positions.
- Added manager queue ordering controls with per-queue save and copy-WhatsApp-to-all shortcut.
- Added the daily first-eligible-Available starter rule using America/New_York business dates.
- Added concurrency-safe daily rotation start records.
- Added automatic queue recovery when a queue points to an unavailable or paused agent.
- Updated new-agent creation so new agents are appended to all three queue orders.

## 0.5.0

- Added a manager-only Users tab.
- Added secure in-app creation of new agent and manager usernames.
- Added manager password resets with generated one-time temporary passwords.
- Forced newly created and reset accounts to create a private password at the next sign-in.
- Added new agents at the end of the permanent rotation order and started them as Unavailable.
- Combined the Agent Overview and My Tasks screens into a single My Desk tab.
- Added Turns Passed to agent performance cards and live team comparison.
- Added Turns Passed to manager Team Controls, date-based reports, and CSV exports.
- Clarified queue status display as Active, Skipped · Lunch, Skipped · Unavailable, or Paused.
- Preserved queue eligibility while automatically skipping agents who are on Lunch or Unavailable.
- Added New Hope Insurance horizontal and vertical logos throughout the application.
- Reworked the color system around New Hope brand navy `#223F7A`.
- Added a secure server-only `/api/admin/users` route with manager authorization checks and audit logging.

## 0.4.0

- Removed the Manager Exception Desk.
- Simplified the manager landing page to live alerts and rotation controls.
- Added real Supabase username/password authentication.
- Removed the Agent/Manager switch and employee impersonation selector.
- Added 10 agent accounts and 2 manager accounts through a private bootstrap process.
- Added Oscar Landaverde and Jason Toro as manager roles.
- Added mandatory first-login password changes.
- Added role-locked database functions so agents can perform only agent actions tied to their authenticated profile.
- Excluded managers from all three agent rotations.
- Added server-side route protection and session refresh.
- Added shared Realtime subscriptions for profiles, rotations, active work, Pending Pricing, and outcomes.
- Added an idempotent account bootstrap script that preserves existing passwords, availability, and current turns unless an explicit reset flag is used.
- Added the live deployment guide for Supabase, private GitHub, and Vercel.

## 0.3.0

- Added the separate Pending Pricing lifecycle.
- Removed Price Sent quotes from active workload.
- Added date-filtered management reports and CSV exports.
- Split Agent and Manager interfaces into cleaner tabs.

## 0.2.0

- Added three independent rotations.
- Added manager-wide open task visibility and redistribution.
- Added manual no-turn quotes and quote status handling.

## 0.1.1

- Corrected package registry URLs for public npm installation.

## 0.1.0

- Initial interactive Work Desk prototype.
