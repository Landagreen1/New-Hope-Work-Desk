# Upgrade to New Hope Work Desk v0.7.0

This release requires a database migration before the v0.7.0 application is deployed.

## What the migration adds

- manager-created and manager-assigned quotes;
- agent acceptance timestamps;
- persistent turn and assignment alerts;
- lifecycle event timestamps;
- Not Sold reasons;
- timing fields preserved through Pending Pricing and final outcomes;
- report support for quote response and cycle times.

## Upgrade order

### 1. Back up Supabase

Create a database backup or snapshot before applying the migration.

### 2. Confirm v0.6.0 was already applied

The following query must return three rows:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'profiles'
  and column_name in (
    'whatsapp_position',
    'ringcentral_position',
    'workload_position'
  )
order by column_name;
```

### 3. Run the v0.7.0 migration

In Supabase:

```text
SQL Editor → New Query
```

Open:

```text
supabase/migrations/v0.7.0.sql
```

Copy the entire file, paste it into the SQL Editor, and run it once.

### 4. Verify the new tables

Run:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('user_notifications', 'work_item_events')
order by table_name;
```

You should see:

```text
user_notifications
work_item_events
```

Verify timing fields:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'quote_outcomes'
  and column_name in (
    'assigned_at',
    'accepted_at',
    'not_sold_reason',
    'not_sold_reason_other'
  )
order by column_name;
```

### 5. Deploy v0.7.0

After the migration succeeds:

```powershell
npm ci
npm run dev
```

Test locally, then push the v0.7.0 code to the same private GitHub repository connected to Vercel.

## Recommended production test

1. Log in as a manager.
2. Create and assign a quote to an agent.
3. Confirm the agent receives an alert.
4. Confirm the agent sees **Awaiting your acceptance**.
5. Click **Accept**.
6. Mark the quote **Price Sent**.
7. Finalize it as Sold or Not Sold.
8. For Not Sold, verify a reason is required.
9. Open Manager → Reports → Quote Timing.
10. Confirm the timeline and durations appear.

## Important

Do not deploy the v0.7.0 application before the migration succeeds. The application queries the new notification and timing fields during dashboard load.
