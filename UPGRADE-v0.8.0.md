# Upgrade to New Hope Work Desk v0.8.0

v0.8.0 is a workflow expansion. It preserves the existing Work Desk, users, passwords, queue orders, Sources, active work, Pending Pricing, quote outcomes, alerts, notes, and reports.

## What v0.8.0 adds

- Linked Activation automatically converts the underlying quote to **Sold**.
- Legacy / old-business Activation can be entered without an existing quote and creates a Sold quote record.
- Shared Quote Log visible to all agents and managers.
- Quote Log shows activities, notes, timestamp, display name, and `@username`.
- 3-minute **Take** action for overdue WhatsApp and RingCentral quote turns.
- Take records the taker, skipped eligible agents, source-received time, taken time, and elapsed time.
- **Payments** replaces the WhatsApp Update quick action and does not require a quote link.
- Additional Workload supports either an existing quote or older business not in Work Desk.
- Notes are available on normal quote, requote, Take, workload, manual quote, and manager-assignment forms.
- Manager reassignments require a reason and preserve it in quote history when applicable.

## Required deployment order

1. Back up the production Supabase project.
2. Run `supabase/migrations/v0.8.0.sql` in Supabase SQL Editor.
3. Stop at the first red SQL error. Do not deploy the UI until the migration succeeds.
4. Verify the new database objects.
5. Copy the v0.8.0 application files into the GitHub-connected project.
6. Run `npm ci` only if dependencies are not already installed.
7. Run `npm run lint`.
8. Run `npx tsc --noEmit`.
9. Run `npm run build`.
10. Test locally.
11. Commit and push to `main`.
12. Wait for Vercel production deployment to become Ready.
13. Test `https://www.nhpfs.com`.

## Run the migration

In Supabase:

1. Open **SQL Editor**.
2. Create a new query.
3. Open `supabase/migrations/v0.8.0.sql` from this release.
4. Paste the complete file.
5. Run it once.

Do not rerun `supabase/schema.sql` against the existing live database.

## Verify the migration

### Verify the new Take table

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'quote_take_events';
```

Expected result:

```text
quote_take_events
```

### Verify the new RPC functions

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'take_quote_turn',
    'claim_unlinked_workload_turn',
    'log_payment'
  )
order by routine_name;
```

Expected results:

```text
claim_unlinked_workload_turn
log_payment
take_quote_turn
```

### Verify enum values

```sql
select t.typname, e.enumlabel
from pg_type t
join pg_enum e on e.enumtypid = t.oid
where t.typname in ('work_type', 'assignment_method')
  and e.enumlabel in ('payment', 'payment_log')
order by t.typname, e.enumsortorder;
```

Expected results include:

```text
assignment_method  payment_log
work_type          payment
```

## Exact workflow tests

### Test 1 — Normal quote note

1. Log in as the current WhatsApp agent.
2. Take a new quote.
3. Add a note in the quote form.
4. Open **All Quotes → Log**.
5. Confirm the note shows with the author's `@username` and timestamp.

### Test 2 — 3-minute Take

Use two available agents in the same quote queue.

1. Leave Agent A current.
2. Log in as Agent B.
3. Click **Take** on the queue.
4. Enter a received time less than 3 minutes ago. Confirm Take is not yet allowed.
5. Enter a received time more than 3 minutes ago. Confirm Agent B is allowed if they are second in the live eligible order.
6. Submit a test quote.
7. Open **All Quotes → Log**.
8. Confirm the log shows the taker, skipped agent(s), and elapsed time.

The server rechecks queue order, availability, eligibility, and elapsed time. The browser preview is not the authority.

### Test 3 — Linked Activation

1. Create a test quote.
2. Take **Additional Workload**.
3. Choose **Existing Quote**.
4. Select the test quote.
5. Choose **Activation**.
6. Submit.
7. Open **All Quotes**.
8. Confirm the original quote now shows **Sold**.
9. Open its Log and confirm the Activation and Sold activities are present.

### Test 4 — Old business Activation

1. Take **Additional Workload**.
2. Choose **Old / Not in System**.
3. Enter new customer/source information.
4. Choose **Activation**.
5. Submit.
6. Confirm a Sold quote record appears in **All Quotes**.

### Test 5 — Payments

1. Open **Quick Actions → Payments**.
2. Enter a customer/account name.
3. Source is optional.
4. Enter payment notes.
5. Submit.
6. Confirm no queue moved.

### Test 6 — Manager reassignment note

1. Log in as management.
2. Reassign an active quote or Pending Pricing item.
3. Enter the required reason.
4. Open the quote Log.
5. Confirm the manager's note shows with `@username` and timestamp.

## Git commands for the live project

After local tests pass:

```powershell
git status
```

Then:

```powershell
git add src/components/work-desk-app.tsx src/lib/dashboard-data.ts src/lib/types.ts supabase/migrations/v0.8.0.sql UPGRADE-v0.8.0.md package.json package-lock.json
```

Commit:

```powershell
git commit -m "Add quote logs timed Take and activation workflow"
```

Push:

```powershell
git push origin main
```

Vercel should automatically deploy the new production commit.

## Important behavior notes

- **Take** applies only to WhatsApp and RingCentral quote rotations.
- Each available, active, queue-eligible agent consumes one 3-minute window.
- Unavailable, Lunch/Break, paused, and inactive agents do not consume a window.
- A normal current agent still uses the normal queue action, not Take.
- Additional Workload still requires the workload turn to be taken.
- Activation changes the quote outcome to Sold, but the Activation service task itself remains an active workload task until completed.
- Shared quote logs are visible to all authenticated agents and managers.
- Payments are standalone operational activity and do not need an existing quote.
