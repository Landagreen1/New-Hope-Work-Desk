# New Hope Work Desk v0.7.2 — Setup Checklist

## Local preparation

- [ ] Extract v0.7.2 into a new folder.
- [ ] Open PowerShell in the folder containing `package.json`.
- [ ] Run `npm ci`.

## Supabase

- [ ] Create a new Supabase project.
- [ ] Open the Supabase SQL Editor.
- [ ] Run the complete `supabase/schema.sql` file.
- [ ] Copy `.env.example` to `.env.local`.
- [ ] Add the Supabase project URL.
- [ ] Add the Supabase publishable key.
- [ ] Add the server-side Supabase secret key for the bootstrap script and manager User Administration.
- [ ] Keep `NEXT_PUBLIC_AUTH_EMAIL_DOMAIN=workdesk.newhope.local` unless intentionally changing it before creating users.


## Existing database upgrade

- [ ] Back up Supabase.
- [ ] Confirm the v0.7.0 migration is already installed.
- [ ] Run `supabase/migrations/v0.7.2.sql` once.
- [ ] Verify `ensure_daily_availability_reset` exists.
- [ ] Verify `availability_day_state` contains one row.
- [ ] Deploy the v0.7.2 application only after the migration succeeds.
- [ ] Test manager-selected temporary passwords and the daily Unavailable reset.

For databases older than v0.7.0, apply the retained migrations in version order.

## Create the 12 accounts

- [ ] Confirm `private/bootstrap-users.json` exists.
- [ ] Run `npm run bootstrap-users` once.
- [ ] Confirm the terminal reports 10 agents and 2 managers.
- [ ] Keep `private/PRIVATE-USER-CREDENTIALS.txt` private.

## Authentication test

- [ ] Run `npm run dev`.
- [ ] Sign in as Oscar.
- [ ] Confirm first login forces a password change.
- [ ] Confirm Oscar sees the Manager interface only.
- [ ] Sign out.
- [ ] Sign in as one agent.
- [ ] Confirm the agent sees the Agent interface only.
- [ ] Confirm there is no “View as” selector.
- [ ] Confirm there is no Agent/Manager switch.

## Rotation tests

- [ ] WhatsApp turn advances only after the current WhatsApp agent takes or passes it.
- [ ] RingCentral turn advances independently.
- [ ] Additional Workload turn advances independently.
- [ ] WhatsApp update logs without moving a turn.
- [ ] Manual quote logs without moving a turn.
- [ ] Agent can paste a dealer name from WhatsApp and select the matching dealer.
- [ ] All active agents reset to Unavailable when a new Eastern business date begins.
- [ ] First eligible agent to click Available after the reset becomes the daily starter.

## Manager tests

- [ ] Open Tasks displays all active work.
- [ ] Manager can redistribute an open task.
- [ ] Pending Pricing displays all price-sent quotes.
- [ ] Manager can reassign Pending Pricing follow-up.
- [ ] Manager alerts update after workload changes.
- [ ] Rotation controls work for all three lists.
- [ ] Queue Order allows each queue to be reordered independently.
- [ ] Copy WhatsApp order to other queues works as a draft shortcut.
- [ ] Dealer administration can create, edit, deactivate, and reactivate dealers.
- [ ] The old Exception Desk is not present.

## Quote lifecycle tests

- [ ] Agent takes a quote.
- [ ] Agent marks Price Sent.
- [ ] Quote disappears from active workload.
- [ ] Quote appears under Pending Pricing.
- [ ] Agent or manager marks Sold or Not Sold.
- [ ] Final outcome appears in reports.

## Go-live preparation

- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.
- [ ] Create a private GitHub repository.
- [ ] Confirm `.env.local` is not committed.
- [ ] Confirm `private/` is not committed.
- [ ] Deploy the private repository to Vercel.
- [ ] Add the three public Supabase environment variables in Vercel.
- [ ] Add `SUPABASE_SECRET_KEY` to Vercel as a protected server-only environment variable.
- [ ] Confirm the secret does not use a `NEXT_PUBLIC_` prefix and is not exposed to browser code.
- [ ] Test the Manager → Users tab by resetting a test account with a temporary password chosen by management.
- [ ] Test the production URL on at least two office computers at the same time.
- [ ] Distribute each temporary password privately.
- [ ] Confirm every employee changes the temporary password.
