# New Hope Internal Platform — Future Architecture

## Goal

Keep the current Work Desk live and stable while adding future internal tools without rebuilding the application from scratch.

## Recommended model: one platform, many modules

Keep one Next.js application, one authentication system, and one Supabase project. Add new internal tools as modules inside the same application.

Examples:

```text
NHPFS.COM
  /                 Work Desk
  /tools/intake     Master insurance intake
  /tools/documents  Document generator
  /tools/commissions Commission tracking
  /tools/compliance Compliance and audits
```

This is preferable to embedding separate websites with iframes because all modules can share:

- the same login;
- the same users and roles;
- the same sources and customer references;
- notifications;
- audit history;
- reports;
- deployment and backups.

## Core versus modules

### Platform core

Treat these as shared infrastructure:

- authentication and sessions;
- `profiles` and roles;
- application shell and navigation;
- notification delivery;
- audit logging;
- shared source directory when appropriate;
- Supabase client/server helpers.

### Work Desk module

Keep these as Work Desk-specific behavior:

- three rotations;
- active quote and service work;
- pending pricing;
- quote outcomes;
- performance calculations;
- turn events.

### Future modules

Each future tool should live under:

```text
src/features/<module-name>/
```

and route under:

```text
/tools/<module-name>
```

The module should own its own components, types, business logic, and database tables.

## Database rules

1. Never rerun `schema.sql` against the production database for an upgrade.
2. Every change receives a new migration file.
3. Never rename or delete production columns casually; add, migrate, then deprecate.
4. Future module tables should use clear prefixes, for example:

```text
intake_submissions
intake_documents
commission_periods
commission_entries
compliance_audits
compliance_findings
```

5. Keep central user identity in `profiles`; do not create a separate user table per tool.
6. Prefer UUID foreign keys to usernames or display names.

## Navigation and permissions

The project now includes:

```text
src/platform/module-registry.ts
```

Future modules should register there. The next platform phase can render an application launcher and role-based module navigation from this registry.

Recommended future permission model:

```text
module_access
  profile_id
  module_id
  access_level
```

This lets management decide who can open each future tool without creating new user accounts.

## How to add a future tool

1. Describe the workflow and users.
2. Decide whether it shares existing sources/customers or needs its own data.
3. Create a feature folder under `src/features`.
4. Create route pages under `/tools/<slug>`.
5. Add only the required Supabase migration.
6. Register the module in `src/platform/module-registry.ts`.
7. Add role/module permissions.
8. Test behind a feature flag before enabling it for everyone.

## What not to do

- Do not copy the entire project into a new app for every tool.
- Do not create a second login system.
- Do not use iframes for tools we own unless there is a strong technical reason.
- Do not put all future tools into `work-desk-app.tsx`.
- Do not overwrite the production database with a new schema.

## Recommended next architecture step

After launch, the first technical maintenance release should split the current large Work Desk component into smaller Work Desk feature components without changing behavior. This can be done incrementally while production stays live.
