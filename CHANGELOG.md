# Changelog

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
