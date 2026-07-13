# Upgrade New Hope Work Desk from v0.9.3 to v0.9.4.1

## 1. Back up first

- Create a Supabase database backup or confirm point-in-time recovery is available.
- Commit or copy the current v0.9.3 repository before applying this package.
- The included copy scripts create a separate file backup automatically, but they do not back up Supabase.

## 2. Apply the replacement files

### Windows PowerShell

From the extracted update folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\APPLY-UPDATE.ps1 -RepositoryPath "C:\path\to\New-Hope-Work-Desk"
```

### macOS / Linux

```bash
chmod +x ./apply-update.sh
./apply-update.sh /path/to/New-Hope-Work-Desk
```

The script copies the contents of `update-files/` into the repository and creates a timestamped backup beside the repository.

## 3. Run Supabase migration v0.9.4a alone

Open a new Supabase SQL Editor query and run only:

`update-files/supabase/migrations/v0.9.4a-add-manual-workload-enum.sql`

Wait for the success result before continuing. PostgreSQL must commit the new `manual_workload` enum value before another migration can use it.

## 4. Run Supabase migration v0.9.4b

Open another new SQL Editor query and run:

`update-files/supabase/migrations/v0.9.4b-team-database-salespeople.sql`

This adds salesperson records and lifecycle fields, manual workload, salesperson-aware quote wrappers, RLS policies, and safe user deactivation.

## 5. Run Supabase migration v0.9.4c

Run:

`update-files/supabase/migrations/v0.9.4c-allow-dealers-without-salespeople.sql`

This is safe whether you are applying the revised package from scratch or already ran the earlier v0.9.4b. It allows a source with no active salespeople to be quoted without a salesperson, while still requiring selection when active salespeople exist.

## 6. Verify Supabase

Run the read-only script:

`update-files/supabase/verification/v0.9.4-verification.sql`

The fourth result lists active sources with no active salesperson for informational review; those sources remain usable.

## 7. Configure source salespeople

Use either method:

- Edit and run `SALESPERSON-SETUP-TEMPLATE.sql`, or
- Deploy during a maintenance window, sign in as Manager, open **Sources**, and add the salespeople immediately.

If a source has no active salesperson, agents may submit without one. If the source has one or more active salespeople, selection is required.

## 8. Install, lint, and build

From the updated repository:

```bash
npm install
npm run lint
npm run build
```

`npm install` also synchronizes the package-lock file after the version changes to 0.9.4.1.

## 9. Commit and deploy

```bash
git add .
git commit -m "Release New Hope Work Desk v0.9.4.1"
git push origin main
```

Allow Vercel to deploy the new commit.

## 10. Required production tests

### Agent

- Keep two browser sessions open and confirm changes appear within one minute without manual refresh.
- Take one WhatsApp quote for a source with active salespeople and select both Source and Salesperson.
- Take one quote for a source with no active salespeople and confirm it submits without a salesperson.
- Take one RingCentral quote and confirm the salesperson follows it into Pending Pricing.
- Open **My Team** and confirm the latest quote appears first.
- Filter **Quotes Database** by Today, status, and update.
- Log Manual Workload and confirm the Additional Workload current agent does not change.

### Manager

- Add, deactivate, and reactivate a salesperson.
- Delete a test user with no active or pending work.
- Confirm the deleted user is hidden until **Show Deleted** is selected.
- Confirm deletion is blocked for a user with active tasks or Pending Pricing.

### Customer Service

- Confirm Customer Service login and existing overflow work remain functional.

## Rollback

The copy script prints the backup folder it created. Restore those files to roll back the application. Do not drop the new database columns or salesperson table during an emergency rollback; leaving unused additive database objects is safer than deleting quote data.
