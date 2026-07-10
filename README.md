# New Hope Work Desk v0.7.4

Private internal web application for New Hope Insurance Agency.

The application manages three independent rotations, active work, pending pricing follow-up, live management visibility, user accounts, and date-based reporting.



## What changed in v0.7.4

- Daily queue reset now clears every current queue owner. A new day begins with **No agent yet** instead of leaving yesterday's agent on the turn.
- The first eligible agent to click **Available** starts each eligible queue. If no eligible agent remains available later, the queue returns to **No agent yet**.
- Removed the client-side fallback that could display an agent as current even when Supabase had no matching queue owner.
- Failed turn actions refresh live data immediately so stale screens self-correct.
- Agents now have an **All Quotes** tab with shared read-only visibility across active, pending, sold, and not-sold quote records.
- Additional Workload activations and changes now link to an existing quote instead of creating duplicate quote records.
- Pending Pricing now supports persistent timestamped follow-up notes with author history.
- Quote deletion also removes the quote's attached notes.
- Requires `supabase/migrations/v0.7.4.sql` when upgrading from v0.7.3 or earlier.

## What changed in v0.7.3

- Managers can search and permanently delete incorrect quote records from Active, Pending Pricing, Sold, or Not Sold stages.
- Every deletion requires a reason and writes an audit-log snapshot.
- Deleted quotes stop contributing to workload, performance, efficiency, conversion, timing, and source reporting.

## What changed in v0.7.2

- Managers now type the temporary password they want to issue during a password reset.
- The reset form can also generate a secure suggested password, but management may replace it with its own temporary password.
- Reset passwords still force the employee to create a private password at the next sign-in.
- All active agent availability statuses reset to **Unavailable** when a new America/New_York business date begins.
- The Work Desk checks the daily reset on page load, before any availability change, and once per minute while an office screen remains open.
- The first eligible agent to click **Available** after the reset becomes the daily starter for each eligible queue.
- Requires `supabase/migrations/v0.7.2.sql` when upgrading from v0.7.1 or earlier.

## What changed in v0.7.1

- Agents can now see every teammate's live availability status from the Performance tab.
- The team comparison also shows current open tasks and warns when an unavailable or lunch agent still has work that may need coverage.
- Quote Timing remains visible only to managers under **Management → Reports → Quote Timing**.
- Added `FUTURE-ARCHITECTURE.md`, a module registry scaffold, and feature conventions so future tools can be added to the same platform instead of rebuilding the project.
- No new Supabase migration is required beyond v0.7.0.

## What changed in v0.7.0

- Managers can create a new quote and assign it directly to any agent without moving a rotation.
- Manager-created and manager-reassigned work requires the receiving agent to click **Accept**, creating a measurable assignment-to-take time.
- Added four standard Not Sold reasons plus a typed Other reason.
- Added persistent agent alerts for turn changes and manager assignments.
- Added desktop/browser notifications, alert sound, unread badges, and an in-app alert inbox.
- Added lifecycle timestamps for created, assigned, accepted, price sent, sold, not sold, completed, cancelled, and reassigned actions.
- Added a dedicated **Quote Timing** manager report showing assignment-to-take, take-to-price, take-to-final-decision, price-to-decision, and total cycle time.
- Added detailed timing data to CSV exports.
- Added Not Sold reason analysis to management reporting.
- Requires the `supabase/migrations/v0.7.0.sql` database migration when upgrading from v0.6.x.

## Roles

### Agents

Agents can:

- manage their own availability;
- take only their own current turns;
- pass only their own current turns;
- see all three rotations and their own active work together in **My Desk**;
- create manual no-turn quotes;
- log WhatsApp updates;
- update only work assigned to them;
- move quotes to Pending Pricing;
- finalize their own pending pricing decisions;
- view performance comparisons, including Turns Passed.

### Managers

Managers can:

- create and assign quotes directly to agents without moving a rotation;
- see all open tasks and redistribute them;
- see and reassign Pending Pricing follow-ups;
- mark pending pricing Sold or Not Sold;
- manage each of the three rotation pointers;
- independently reorder all three queues;
- create, edit, deactivate, and reactivate sources;
- pause agents independently from each rotation;
- see real-time operational alerts;
- review quote-cycle timing and agent response-speed reports;
- use date-based reports and CSV exports;
- create new usernames;
- reset passwords and choose the one-time temporary password issued to the employee.

Managers are excluded from the three agent rotations.

## Three independent rotations

1. **WhatsApp New Quotes** — brand-new dealership quotes from WhatsApp.
2. **RingCentral Quotes / Requotes** — new quotes and requotes received through RingCentral.
3. **Additional Workload** — redistributed activations and changes.

WhatsApp quote updates and manually submitted quotes are recorded for reporting but do not advance any rotation.

## Availability versus queue eligibility

These are separate concepts:

- **Active** — the agent is eligible for the queue and currently available.
- **Skipped · Lunch** — eligibility is preserved, but the agent is temporarily skipped.
- **Skipped · Unavailable** — eligibility is preserved, but the agent is temporarily skipped.
- **Paused** — a manager has intentionally removed the agent from that specific queue.

The database skips Lunch and Unavailable agents when calculating the next turn. At midnight Eastern, all active agents reset to Unavailable. The first eligible agent to click Available on the new business day starts each eligible queue. Realtime profile and rotation subscriptions keep shared screens synchronized.

## Quote lifecycle

```text
Active Quote
    ↓
Price Sent
    ↓
Pending Pricing
    ↓
Sold / Not Sold
```

Once pricing is sent, the quote leaves active workload and moves to the separate Pending Pricing dataset. It no longer counts as an active task.

## Manager-assigned quote lifecycle

```text
Manager creates + assigns quote
        ↓
Agent receives persistent alert
        ↓
Agent clicks Accept
        ↓
Quote work begins
        ↓
Price Sent / Sold / Not Sold
```

Reassigning an active task starts a new assignment-to-take clock for the new agent.

## Alerts

The application stores alerts in Supabase, so turn and assignment alerts are not lost if an employee refreshes the page or signs in later. Agents can also enable desktop notifications and sound from the Alerts panel.

Alerts are created when:

- an agent becomes current on any of the three rotations;
- a manager creates and assigns a quote;
- a manager reassigns an active task;
- a manager reassigns a Pending Pricing follow-up.

## Quote timing and timestamps

The system preserves these timestamps for reporting:

- quote created;
- assigned;
- accepted;
- price sent;
- final Sold/Not Sold decision.

The Reports Center includes a **Quote Timing** tab and CSV export.

## First local setup

Read `LIVE-DEPLOYMENT-GUIDE.md` for the complete deployment sequence.

The condensed flow is:

```powershell
Copy-Item .env.example .env.local
npm ci
npm run bootstrap-users
npm run dev
```

Before `npm run bootstrap-users`, you must:

1. create the Supabase project;
2. run `supabase/schema.sql` in the Supabase SQL Editor;
3. fill `.env.local` with the project URL, publishable key, and server-side secret key.

## User administration

The manager Users tab calls the server-only route:

```text
/api/admin/users
```

That route:

- verifies the signed-in user is an active manager;
- uses a server-only Supabase secret to create Auth users and reset passwords;
- never sends the Supabase secret to the browser;
- accepts the manager-selected temporary password during resets and returns it only once for confirmation;
- forces the user to change that temporary password at the next sign-in.

New agents:

- are added at the end of all three queue orders;
- start Unavailable;
- start eligible for all three queues.

New managers:

- never enter the three rotations.

## Initial account bootstrap

The one-time initial account creation command is:

```powershell
npm run bootstrap-users
```

Private bootstrap definitions and temporary credentials are stored under:

```text
private/
```

The entire `private/` folder is ignored by Git and must never be committed.

The bootstrap command is safe to rerun. Existing passwords, availability states, and current rotation positions are preserved unless an explicit reset flag is used.

## Database files

For a new Supabase project:

```text
supabase/schema.sql
```

For an existing v0.7.1 database, run:

```text
supabase/migrations/v0.7.2.sql
```

before deploying v0.7.2. This migration adds the automatic daily availability reset guard.

For an older database, apply the retained migrations in version order. A v0.6.x database must receive `v0.7.0.sql` before `v0.7.2.sql`.

Previous migrations are retained under:

```text
supabase/migrations/
```

## Production environment variables

The deployed application needs:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_AUTH_EMAIL_DOMAIN
SUPABASE_SECRET_KEY
```

The first three may be used by the browser application. `SUPABASE_SECRET_KEY` is **server-only** and is required by the manager Users tab.

Never:

- prefix the secret with `NEXT_PUBLIC_`;
- expose it in browser code;
- commit it to Git;
- send it to employees.

The legacy alternative is:

```text
SUPABASE_SERVICE_ROLE_KEY
```

## Validation commands

```powershell
npm run lint
npm run build
npm run dev
```

## Main project structure

```text
src/app/                    Protected Next.js routes and server API
src/app/api/admin/users/    Manager-only user creation/password reset
src/components/             Login, password change, and Work Desk UI
src/lib/dashboard-data.ts   Shared live data loader
src/lib/supabase/           Browser/server/proxy Supabase clients
src/proxy.ts                Session refresh and route protection
public/                     New Hope brand assets and PWA icons
supabase/schema.sql         Fresh production database
supabase/migrations/        Historical upgrade scripts
scripts/bootstrap-users.mjs Initial account bootstrap
private/                    Private credentials; never committed
```
