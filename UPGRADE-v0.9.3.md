# New Hope Work Desk v0.9.3 Upgrade

This release adds a dedicated Customer Service login role, manager-entered temporary passwords, Additional Workload restrictions, and recovery of an agent's own older Not Sold quotes.

## Deployment order

1. Back up the production Supabase database.
2. Run `supabase/migrations/v0.9.3.sql` in Supabase SQL Editor.
3. Confirm the migration returns the v0.9.3 success message.
4. Replace the application files from the patch.
5. Run `npm run lint`, `npx tsc --noEmit`, and `npm run build`.
6. Commit and push to the GitHub branch connected to Vercel.
7. Create at least one Customer Service login in Management → Users.
8. In Management → Reports → Queue Health, select that Customer Service user and enable overflow.

## Important behavior changes

### Customer Service role

Customer Service is now a separate role from Agent and Manager. Customer Service users:

- do not enter WhatsApp, RingCentral, or Additional Workload rotations;
- receive Activations and Changes passed through Customer Service overflow;
- accept assigned work;
- review handoff instructions and linked quote logs;
- add quote notes; and
- complete assigned service work.

The migration disables any old overflow selection that points to an Agent account. Management must create/select a dedicated Customer Service account after deployment.

### Password resets

Management now types the exact temporary password during a reset. The password must contain 8–72 characters and cannot start or end with spaces. The employee must create a private password after the next sign-in.

### Additional Workload

- The Workload queue can no longer be passed directly.
- An agent must take the Activation or Change first.
- After acceptance, the agent may pass the task to Customer Service when overflow is enabled.
- The Customer Service handoff still counts as one workload pass for reporting and does not move the queue again.
- Linked workload selection shows only Sold and Pending Pricing quotes.
- Active and Not Sold quotes cannot be selected for linked workload.

### Not Sold recovery

An agent can open All Quotes and use **Mark Sold** on their own Not Sold quote. A required note explains the later sale. The system:

- changes the existing outcome to Sold;
- keeps Sold credit with the original assigned agent;
- records an Activation event;
- adds a shared quote note with the username and previous Not Sold reason; and
- writes an audit-log entry.

## Verification queries

```sql
select enumlabel
from pg_enum e
join pg_type t on t.oid = e.enumtypid
where t.typname = 'app_role'
order by e.enumsortorder;
```

Expected roles include:

- `agent`
- `manager`
- `customer_service`

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'convert_my_not_sold_quote_to_sold',
    'pass_workload_to_customer_service',
    'claim_linked_workload_turn',
    'accept_my_assigned_item',
    'complete_my_service_item'
  )
order by routine_name;
```

## Production test

1. Create a Customer Service login and complete its first password change.
2. Enable Customer Service overflow and select the new account.
3. Take an Activation or Change as an Agent, accept it, and pass it to Customer Service with a reason and note.
4. Log in as Customer Service, accept the assignment, add a linked quote note, and complete it.
5. Confirm the Workload queue did not move a second time and the original Agent received one workload pass.
6. Open Additional Workload and confirm the existing-quote selector shows only Sold and Price Sent records.
7. Open an Agent's own Not Sold quote in All Quotes, click Mark Sold, enter a note, and verify the quote becomes Sold with the activity visible in the Log.
