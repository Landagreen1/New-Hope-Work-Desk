# Put New Hope Work Desk Live

This guide takes the application from the ZIP file to a shared production website for both offices.


## Upgrading an existing production database

Before deploying v0.7.2, open the Supabase SQL Editor and run:

```text
supabase/migrations/v0.7.2.sql
```

This migration must be completed before the v0.7.2 application is deployed because the application calls the daily availability reset function on dashboard load. Do not rerun the full `schema.sql` against an existing production database.

The migration preserves users, passwords, sources, queue orders, current work, Pending Pricing, quote outcomes, alerts, and reports.

A database older than v0.7.0 must first receive the retained migrations in version order. In particular, a v0.6.x database needs `v0.7.0.sql` before `v0.7.2.sql`.

After the migration succeeds, deploy the new code to Vercel. No employee passwords are automatically reset.

## 1. Create a Supabase project

Create one Supabase project for the Work Desk.

Use a strong database password and store it securely. The office computers do not need this database password.

## 2. Create the database structure

In Supabase:

1. Open **SQL Editor**.
2. Create a new query.
3. Open `supabase/schema.sql` from this project.
4. Copy the entire file.
5. Paste it into the SQL Editor.
6. Run it once.

For an existing v0.3.x database, run `supabase/migrations/v0.4.0.sql` instead.

# Part 2 — Configure the application locally

## 3. Create `.env.local`

In PowerShell, from the project folder:

```powershell
Copy-Item .env.example .env.local
```

Open `.env.local` in Visual Studio Code.

Fill:

```text
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
NEXT_PUBLIC_AUTH_EMAIL_DOMAIN=workdesk.newhope.local
SUPABASE_SECRET_KEY=YOUR_SERVER_SIDE_SECRET_KEY
```

The `SUPABASE_SECRET_KEY` is a **server-only** credential. It is used locally for the initial account bootstrap and must also be added to the Vercel project environment so the manager **Users** tab can create usernames and reset passwords. It is never needed by employees, must never use a `NEXT_PUBLIC_` prefix, and is never sent to browser code.

## 4. Install dependencies

```powershell
npm ci
```

# Part 3 — Create the 12 real login accounts

## 5. Run the account bootstrap

```powershell
npm run bootstrap-users
```

The command creates:

### Agents

- Juliana
- Berenice
- Mauricio
- Galo
- Estefania
- Pablo
- Elvin
- Miguel
- Maria Z.
- Maria T.

### Managers

- Oscar Landaverde
- Jason Toro

Every newly created account must replace its temporary password on first login.

The temporary usernames and passwords are in:

```text
private/PRIVATE-USER-CREDENTIALS.txt
```

Do not email the full credential list to the whole team. Send each person only their own username and temporary password.

# Part 4 — Test locally before deployment

## 6. Start the application

```powershell
npm run dev
```

Open:

```text
http://localhost:3000
```

Sign in as Oscar using the private credential file.

Expected result:

1. Oscar is required to create a new private password.
2. Oscar enters the Manager interface.
3. There is no employee selector.
4. There is no Agent/Manager switch.

Then test one agent account.

Expected result:

1. The agent is required to create a new private password.
2. The agent enters only their own Agent workspace.
3. Their actions are recorded under their authenticated profile.

# Part 5 — Validate the production build

Run:

```powershell
npm run lint
npm run build
```

Both commands should finish without errors.

# Part 6 — Push to a private GitHub repository

## 7. Create a private repository

Create a new **private** GitHub repository named, for example:

```text
new-hope-work-desk
```

From the project folder:

```powershell
git init
git add .
git commit -m "New Hope Work Desk v0.4.0"
git branch -M main
```

Then connect and push using the repository commands GitHub shows you.

Before pushing, verify these do not appear in the staged files:

```text
.env.local
private/
```

They are already excluded by `.gitignore`.

# Part 7 — Deploy to Vercel

## 8. Import the private repository

In Vercel:

1. Create a new project.
2. Import the private GitHub repository.
3. Leave the framework as Next.js.

## 9. Add production environment variables

Add:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
NEXT_PUBLIC_AUTH_EMAIL_DOMAIN
SUPABASE_SECRET_KEY
```

`SUPABASE_SECRET_KEY` must be stored only as a protected server environment variable. Never prefix it with `NEXT_PUBLIC_`. The deployed server route `/api/admin/users` requires it for manager-created users and password resets.


Deploy the project.

# Part 8 — Configure the production URL

## 10. Update Supabase Auth URL settings

In Supabase Auth URL configuration:

- Set the Site URL to the final Vercel production URL.
- Add the production URL to the allowed redirect URLs.

## 11. Optional custom domain

After the Vercel deployment works, connect a company subdomain such as:

```text
workdesk.newhopeinsurance.com
```

or:

```text
turns.newhopeinsurance.com
```

# Part 9 — Production acceptance test

Use at least two computers simultaneously.

## Agent test

1. Agent A signs in.
2. Agent A takes the current WhatsApp turn.
3. Agent B's screen should update to the next turn without refreshing.

Repeat for RingCentral and Additional Workload.

## Manager test

1. An agent creates an active task.
2. Manager opens **Open Tasks**.
3. Manager reassigns the item.
4. The newly assigned agent should receive the item on their screen.

## Pending Pricing test

1. Agent marks a quote **Price Sent**.
2. It disappears from active workload.
3. It appears in Pending Pricing.
4. Manager sees it in the company-wide follow-up list.
5. Mark it Sold or Not Sold.
6. Verify the final status in Reports.

# Part 10 — Employee rollout

Give each employee only:

- the production website address;
- their username;
- their temporary password.

At first login they create their own private password.

After every account has been changed successfully, store the original temporary credential file in a secure offline location or delete it from the daily-use computer.

# Emergency reset

Only a manager with the private bootstrap credential file and server-side Supabase key should use this.

To reset all 12 accounts back to their original temporary passwords:

```powershell
node --env-file=.env.local scripts/bootstrap-users.mjs --reset-passwords
```

This also requires those users to change the temporary password again on next login.

Do not use the reset command as part of normal deployment.
