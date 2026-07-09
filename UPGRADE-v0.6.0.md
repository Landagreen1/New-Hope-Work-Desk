# Upgrade to New Hope Work Desk v0.6.0

Use this path when v0.5.0 is already connected to your live Supabase project.

1. Back up the Supabase project.
2. In Supabase → SQL Editor, run `supabase/migrations/v0.6.0.sql` once.
3. Confirm the final result says `New Hope Work Desk v0.6.0 migration complete`.
4. Replace the application code with v0.6.0 and deploy to Vercel.
5. Do not rerun `supabase/schema.sql` on the existing production database.
6. No password reset or user bootstrap is required for the upgrade.

## Acceptance test

- Manager → Dealers: create a test dealer, edit it, deactivate it, then reactivate it.
- Agent quote form: paste the dealer name and confirm the correct match can be selected.
- Manager → Team Controls: reorder each queue differently and save.
- Make all agents Unavailable. On the next business day, have one eligible agent click Available first and confirm that agent becomes current on all three eligible queues.
- Confirm each queue follows its own configured order after the starter takes or passes a turn.
