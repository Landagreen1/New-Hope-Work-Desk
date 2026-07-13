# New Hope Work Desk v0.9.4

Internal sales-operations application for New Hope Insurance Agency.

## Current workflow

The application manages three independent rotations:

1. **WhatsApp New Quotes**
2. **RingCentral Quotes / Requotes**
3. **Additional Workload** for Activations and Changes

It also includes Pending Pricing follow-up, Quotes Database, My Team activity, Customer Service overflow, user administration, source/salesperson administration, shared quote logs, rescue timers, management reports, and CSV exports.

## v0.9.4 highlights

- Supabase Realtime plus a guaranteed 60-second refresh fallback.
- Refresh on focus, tab return, and internet reconnection.
- Safe manager user deletion that preserves historical records.
- Dealer/source-specific salesperson management and quote tracking.
- Quotes Database day, status, update, and search filters.
- Agent My Team activity view to prevent duplicate quote entry.
- Manual Workload for Activations and Changes without moving the workload queue.

## Roles

- **Agent:** rotations, quotes, follow-up, service work, My Team, and performance.
- **Customer Service:** accepted Activation/Change overflow assignments.
- **Manager:** queues, assignments, reports, sources, salespeople, and users.

## Quote lifecycle

```text
Active -> Price Sent -> Pending Pricing -> Sold / Not Sold
```

Activations may convert a related Pending Pricing quote to Sold while preserving the original sales owner. Service-work credit remains with the employee completing the Activation or Change.

## Upgrade from v0.9.3

Run these files in order and as separate Supabase SQL Editor executions:

1. `supabase/migrations/v0.9.4a-add-manual-workload-enum.sql`
2. `supabase/migrations/v0.9.4b-team-database-salespeople.sql`

Then run:

```bash
npm install
npm run lint
npm run build
```

Read `UPGRADE-v0.9.4.1.md` for the full deployment and test sequence.

## Environment variables

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_AUTH_EMAIL_DOMAIN
SUPABASE_SECRET_KEY
```

`SUPABASE_SECRET_KEY` is server-only. Never commit it or expose it through a `NEXT_PUBLIC_` variable.
