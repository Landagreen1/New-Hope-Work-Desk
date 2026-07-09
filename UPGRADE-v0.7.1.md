# Upgrade to v0.7.1

This is a UI and architecture-readiness release.

## Database

No new Supabase migration is required beyond the v0.7.0 migration.

## Changes

- Agent Performance now shows every agent's live availability status.
- Agent Performance now shows current open task counts.
- Unavailable or lunch agents with active work are highlighted as needing coverage.
- Quote Timing remains manager-only under Management → Reports → Quote Timing.
- Added future module architecture guidance and a central module registry scaffold.

## Upgrade

1. Keep the existing `.env.local`.
2. Replace the application code with v0.7.1.
3. Run `npm ci`.
4. Run `npm run build` or deploy through the existing Vercel repository.

No users, passwords, queue orders, sources, work, pricing, outcomes, or reports are reset.
