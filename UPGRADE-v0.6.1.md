# Upgrade to New Hope Work Desk v0.6.1

## Database requirement

This release does not add database columns or tables. If your database has already successfully run `supabase/migrations/v0.6.0.sql`, deploy v0.6.1 directly.

If you still see `column profiles.whatsapp_position does not exist`, run the v0.6.0 migration first.

## Upgrade steps

1. Stop the old local server.
2. Replace the application code with v0.6.1.
3. Run `npm ci`.
4. Run `npm run build`.
5. Deploy to Vercel.

## What changes

- Completion Efficiency counts only Sold and Not Sold as completed.
- Pending Pricing is not counted as completed.
- Sales Conversion remains Sold divided by finalized decisions.
- Dealers are shown as Sources throughout the interface and reports.
- Input Method remains a separate field and report dimension.
- Source search alignment and login placeholder are corrected.

The physical Supabase table is still named `dealers` internally to preserve existing data and avoid a risky production migration. The application presents these records as Sources everywhere users see them.
