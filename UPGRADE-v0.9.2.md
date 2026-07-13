# New Hope Work Desk v0.9.2 Upgrade

This release replaces the old multi-agent Take windows with a single-current-agent rescue timer and adds manager-controlled Customer Service overflow for Activations and Changes.

## What changes

### Quote rescue timer
- Any other Available agent who is active in the WhatsApp or RingCentral queue may start a rescue timer.
- The employee currently holding the turn receives an immediate alert.
- A second alert is recorded when 30 seconds remain.
- The response deadline is three minutes after the entered quote-received time.
- After expiration, any other eligible agent may steal the quote.
- Only the missed current employee's turn is consumed.
- The queue advances from the missed employee, never from the stealer.
- A stealer who is next in the queue keeps that next regular turn.
- The successful stolen quote records the taker, missed employee, received time, taken time, and elapsed seconds.

### Customer Service overflow
- Management controls this from **Management → Reports → Queue Health**.
- Management selects one active agent profile as the Customer Service assignee.
- When enabled, an agent who has taken and accepted an Activation or Change sees **Pass to CS**.
- The handoff requires a reason and detailed work note.
- The original agent keeps credit for taking the Additional Workload turn.
- The handoff adds one workload pass to that original agent.
- The Additional Workload queue does not move a second time.
- Customer Service receives the active assignment and must accept it.

## Important deployment order

1. Back up the production Supabase project.
2. Run `supabase/migrations/v0.9.2.sql` in Supabase SQL Editor.
3. Verify the new tables and RPCs.
4. Replace the application files.
5. Run lint, TypeScript, and production build checks.
6. Test with temporary records.
7. Push to the production Git branch and verify Vercel.

Do not rerun `schema.sql` or an earlier migration against the existing production database.

## Supabase verification

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('quote_take_timers', 'work_desk_settings')
order by table_name;
```

Expected:

- `quote_take_timers`
- `work_desk_settings`

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'start_quote_take_timer',
    'send_quote_take_timer_warning',
    'claim_timed_quote',
    'steal_timed_quote',
    'manager_update_customer_service_overflow',
    'pass_workload_to_customer_service'
  )
order by routine_name;
```

Expected: all six functions.

```sql
select customer_service_overflow_enabled, customer_service_profile_id
from public.work_desk_settings
where singleton_id = true;
```

Expected: one settings row. Overflow is disabled by default.

## Files changed

- `src/components/work-desk-app.tsx`
- `src/lib/dashboard-data.ts`
- `src/lib/types.ts`
- `supabase/migrations/v0.9.2.sql`
- `package.json`
- `package-lock.json`

## Local validation

```powershell
npm run lint
npx tsc --noEmit
npm run build
```

## Rescue-timer test

1. Set Agent A as current in WhatsApp.
2. Log in as Agent B, who must be Available and active in WhatsApp.
3. Click **Start Timer** and enter a temporary customer and the actual received time.
4. Confirm Agent A receives **Rescue timer started**.
5. Confirm the card counts down from the calculated deadline.
6. Confirm Agent A receives **30 seconds remaining**.
7. Before expiration, Agent B cannot steal.
8. After expiration, Agent B or any other eligible agent may click **Steal Quote**.
9. Confirm the queue advances from Agent A.
10. When Agent B was next, confirm Agent B remains current for the next regular turn.
11. Open the quote Log and Taken Quotes report to confirm the missed agent and elapsed time.

## Customer Service test

1. Create or choose an active agent profile for Customer Service.
2. In **Management → Reports → Queue Health**, select that profile and enable overflow.
3. As another agent, take an Activation or Change from Additional Workload.
4. Accept the task.
5. Click **Pass to CS**.
6. Enter the required reason and detailed handoff instructions.
7. Confirm the task moves to Customer Service and requires acceptance.
8. Confirm the original agent's Workload count remains credited.
9. Confirm the original agent's Turns Passed count increases by one.
10. Confirm the Additional Workload queue did not advance a second time.

## Production deployment

```powershell
git add src/components/work-desk-app.tsx src/lib/dashboard-data.ts src/lib/types.ts supabase/migrations/v0.9.2.sql UPGRADE-v0.9.2.md package.json package-lock.json
git commit -m "Add single-agent rescue timer and customer service overflow"
git push origin main
```

Wait for Vercel to show **Ready**, then hard-refresh the live application.
