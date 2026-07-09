# Upgrade to v0.7.2

This release changes manager password resets and adds the automatic daily availability reset.

## Database migration required

Before deploying the v0.7.2 application, run this file once in the Supabase SQL Editor:

```text
supabase/migrations/v0.7.2.sql
```

Do not rerun the full `schema.sql` against an existing production database.

## What the migration adds

- `availability_day_state`, a protected singleton record that tracks the current America/New_York business date.
- `ensure_daily_availability_reset()`, a concurrency-safe database function that resets every active agent to Unavailable once per new business day.
- an updated `set_my_availability()` function that always performs the daily-reset check before accepting an availability change.

The migration does not delete or recreate users, queue orders, sources, work items, Pending Pricing, outcomes, reports, notifications, or passwords.

## Password-reset behavior

No database change is needed for the password-reset UI itself.

After v0.7.2 is deployed, a manager clicks **Management → Users → Reset Password**, enters the temporary password they want to issue, and confirms the reset. The employee must still create a private password at the next sign-in.

Temporary passwords must be 8–72 characters and cannot begin or end with spaces.

## Daily availability behavior

The system uses the existing America/New_York business date.

At the first check after midnight Eastern:

1. every active agent is reset to **Unavailable**;
2. the three queue pointers remain in place temporarily;
3. the first eligible agent to click **Available** becomes the daily starter for each queue they are eligible to receive;
4. each queue then follows its own saved order.

The reset check runs:

- before dashboard data is loaded;
- before an agent changes availability;
- once per minute while an office Work Desk screen remains open.

This means an open office screen resets statuses within about one minute after midnight Eastern. If no screen is open overnight, the first page load or first availability action performs the reset before normal work begins.

## Verify the migration

Run:

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name = 'ensure_daily_availability_reset';
```

You should see one row:

```text
ensure_daily_availability_reset
```

Then run:

```sql
select business_date, reset_at
from public.availability_day_state;
```

You should see one row.

## Upgrade sequence

1. Back up Supabase.
2. Run `supabase/migrations/v0.7.2.sql` once.
3. Confirm the verification queries succeed.
4. Copy your existing `.env.local` into the new v0.7.2 folder.
5. Run `npm ci`.
6. Run `npm run lint`.
7. Run `npm run build`.
8. Deploy v0.7.2.
9. Test one manager password reset using a temporary password you choose.
10. Confirm the employee is forced to change that password after sign-in.

