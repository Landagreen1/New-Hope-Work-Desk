# New Hope Work Desk v0.9.1

## Purpose

This is a user-interface-only release. No Supabase migration is required.

## Changes

- Replaced the horizontal Reports navigation strip with a grouped vertical Report Library.
- Added six prioritized report sections: Command Center, Sales, People, Queues, Service, and Control.
- Added a mobile report selector so report navigation never requires horizontal scrolling.
- Reduced the top report summary to the six most important KPIs.
- Added a clear selected-report title and description.
- Reorganized export buttons into a responsive grid.
- Simplified the login screen to one centered sign-in card.
- Added guaranteed Enter-key submission from the password field.

## Deployment

1. Replace `src/components/work-desk-app.tsx`.
2. Replace `src/components/login-form.tsx`.
3. Replace `package.json` and `package-lock.json`.
4. Add this upgrade guide to the repository.
5. Run `npm run lint`.
6. Run `npx tsc --noEmit`.
7. Run `npm run build`.
8. Commit and push to the production branch.

No SQL should be run for this release.
