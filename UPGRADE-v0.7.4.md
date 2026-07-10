# Upgrade to New Hope Work Desk v0.7.4

This release is a targeted production upgrade for the live Work Desk. It does not recreate users, sources, quotes, passwords, queue orders, or reports.

## What changes

1. **Empty queues at the start of every day**
   - All agent statuses reset to Unavailable.
   - All three queue pointers reset to no current agent.
   - The first eligible agent to click Available starts each queue.
   - If the current agent leaves and nobody else is available, the queue becomes empty instead of remaining blocked on that agent.

2. **Shared quote database for agents**
   - Agents receive an All Quotes tab.
   - Quotes can be searched by customer, source, agent, status, or input method.

3. **Linked Additional Workload**
   - Activations and changes are selected from an existing quote.
   - Customer, source, and original quote owner are copied from that quote.
   - No duplicate quote record is created.

4. **Persistent quote follow-up notes**
   - Notes are attached to the stable quote id.
   - Notes remain available as a quote moves from Active to Pending Pricing to Sold/Not Sold.
   - Agents and managers can add notes from Pending Pricing.

5. **Turn mismatch hardening**
   - The UI no longer invents a current agent when the database queue is empty.
   - Failed actions immediately refresh live data so stale screens self-correct.

## Files changed

Copy these files into the existing GitHub-connected project:

- `src/components/work-desk-app.tsx`
- `src/lib/dashboard-data.ts`
- `src/lib/types.ts`
- `supabase/migrations/v0.7.4.sql`

## Deployment order

### 1. Back up Supabase

Create a database backup before applying the migration.

### 2. Run the database migration first

Open:

`supabase/migrations/v0.7.4.sql`

Copy the complete file into:

Supabase → SQL Editor → New Query

Run it once.

Do not run `schema.sql` on the existing live database.

### 3. Verify the migration

Run:

```sql
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'add_quote_note',
    'claim_linked_workload_turn',
    'ensure_daily_availability_reset'
  )
order by routine_name;
```

You should see three rows.

Verify the notes table:

```sql
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name = 'quote_notes';
```

Verify the linked quote column:

```sql
select column_name
from information_schema.columns
where table_schema = 'public'
  and table_name = 'work_items'
  and column_name = 'related_quote_source_work_item_id';
```

### 4. Copy the application files

Replace the three application files listed above and add the migration file to the repository.

### 5. Test locally

```powershell
npm ci
npm run lint
npm run build
npm run dev
```

Test this sequence:

1. Confirm an empty queue displays `No agent yet`.
2. Set one agent to Available and confirm that agent becomes current.
3. Take a quote and confirm the queue advances.
4. Open Agent → All Quotes and search for the quote.
5. Take Additional Workload and link it to the existing quote.
6. Mark a quote Price Sent.
7. Add multiple follow-up notes.
8. Refresh the page and confirm the notes remain.
9. Finalize the quote and confirm it remains in All Quotes.

### 6. Push to GitHub

```powershell
git add src/components/work-desk-app.tsx src/lib/dashboard-data.ts src/lib/types.ts supabase/migrations/v0.7.4.sql
git commit -m "Fix daily queues and add shared quote workflow"
git push origin main
```

Vercel should automatically deploy the new main-branch commit to the live site.

## Existing data preserved

The migration preserves:

- Auth users and passwords
- Profile roles
- Queue order for all three rotations
- Sources
- Active work
- Pending Pricing
- Sold and Not Sold outcomes
- Notifications
- Performance data
- Timing history
- Audit log
