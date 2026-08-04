# Deployment and Rollback

Sales Reporting Center. Spec: `.kiro/specs/sales-reporting-center-redesign`.

## Current state

**The database changes are already live.** All eleven migrations were applied to project `kfbgftkjvtynfdwgcgeb` on 3 August 2026 and verified. This document is what a second environment needs, and what to do if the application deploy has to be undone.

**The application is not deployed.** The branch `feature/sales-reporting-center` is committed but not merged and not pushed. Nothing was deployed automatically.

## Why applying the database first was safe

Every object added is new. No existing table, column, view, function, policy, or row was altered, so the running application could not see any of it. The only user-visible changes are in the application code, which is still on the branch:

- the `Reporting Center` sidebar item,
- the `Reports` item relabelled `Legacy Reports`,
- the retention banner on each legacy report.

Until the branch is deployed, production behaves exactly as it did before, with eleven unused database objects sitting alongside it.

## Applying to another environment

Run in this order. Each file is idempotent, so a repeat is a no-op.

```
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.7-reporting-live-object-record.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.0-reporting-business-hours.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.1-reporting-quote-facts.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.2-reporting-workload-facts.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.3-reporting-indexes.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.4-reporting-rpcs.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.5-reporting-row-functions.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.6-reporting-integrity.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.8-fix-reporting-excluded-null.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.9-fix-queue-mismatch-signal.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.10-reporting-awaiting-decision.sql
```

`v1.12.7` runs **first** on purpose. It asserts that the seven live-only tables, the four live-only `work_items` columns, `attendance_policy.business_timezone`, and `can_manage_sales()` all exist, and names whichever is missing. Running it first turns a missing dependency into one clear error instead of a failure inside a view definition five files later.

`v1.12.8`, `v1.12.9` and `v1.12.10` replace objects created by `v1.12.1`, `v1.12.6` and `v1.12.4`. They must run after them, which numeric order gives.

## Verifying an environment

```
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-checks.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-rpc-checks.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-authorization-checks.sql
```

Expect 17 PASS, 14 matching pairs, and 21 PASS. A single FAIL means stop.

The three files simulate a session by setting `request.jwt.claims`, because the Management API connects with no JWT and the reporting functions correctly refuse an anonymous caller. **The profile ids in those files are specific to this project** and need substituting elsewhere: a `manager`, a `sales_supervisor`, and the `agent` with the most assigned quotes.

## Detecting integrity flags for the first time

Detection is not automatic. Either a manager presses **Re-scan this period** in the Review & Integrity view, or:

```sql
select public.reporting_detect_integrity_flags('2026-07-01', '2026-07-31');
```

It is an upsert keyed on `(subject_kind, subject_id, signal_key)` and never writes `review_status`, `reviewed_by`, `reviewed_at` or `manager_explanation`, so running it repeatedly is safe and cannot un-explain a reviewed flag.

## Deploying the application

1. Push the branch and open a pull request. **Do not push to `main`.**
2. Confirm `npx tsc --noEmit`, `npm test` and `npm run build` on the branch.
3. Confirm `serverExternalPackages: ['pdfkit', 'exceljs']` survived any merge. Without it the build fails on `fontkit`'s import of `applyDecoratedDescriptor` from `@swc/helpers`.
4. Confirm `exceljs@4.4.0`, `pdfkit@0.15.2` and `@types/pdfkit@0.13.9` are in the lockfile at those exact versions.
5. After deploying, sign in as a manager and check: the Reporting Center loads, a KPI opens its drawer, the record count in the drawer matches the KPI, and a Summary CSV export downloads with totals equal to the screen.

## Confirming business hours before anyone reads a report

The seed reproduces the previously hard-coded window: Monday to Saturday 08:30–17:30, Sunday closed, which Byron confirmed on 3 August 2026 as the regular business hours with everything outside them after hours.

**No holidays or closures are loaded.** Until they are, a holiday reads as an ordinary working day and after-hours figures will understate. Adding them:

```sql
insert into public.business_hours_closures (closure_date, label, closure_kind)
values ('2026-09-07', 'Labor Day', 'holiday')
on conflict (closure_date) do nothing;
```

Writes are reserved to `manager` and `super_admin`.

## Rollback

### Application only

Revert the deploy. The sidebar item disappears, the Reports tab is called `Reports` again, and the legacy reports are untouched throughout. The database objects stay and are inert. **This is the rollback to reach for**: it is complete, immediate, and loses nothing.

### Database, if it is ever required

Reverse order. Nothing pre-existing is touched, so nothing pre-existing is at risk.

```sql
begin;
  -- v1.12.10, v1.12.9, v1.12.8: replaced objects. To undo, re-apply the definitions
  -- from v1.12.4, v1.12.6 and v1.12.1 respectively. Doing so restores two defects and
  -- removes the awaiting-decision companion figure, so this is not advised.

  -- v1.12.6
  drop function if exists public.report_integrity_review(uuid, text, text);
  drop function if exists public.report_integrity_flags(jsonb, text, integer, integer);
  drop function if exists public.reporting_detect_queue_mismatches(date, date);
  drop function if exists public.reporting_detect_integrity_flags(date, date);
  drop trigger  if exists reporting_integrity_reviews_immutable on public.reporting_integrity_reviews;
  drop function if exists public.reporting_integrity_review_immutable();
  drop table    if exists public.reporting_integrity_reviews;
  drop table    if exists public.reporting_integrity_flags;
  drop table    if exists public.reporting_thresholds;

  -- v1.12.5
  drop function if exists public.report_reconciliation(date, date);
  drop function if exists public.report_after_hours_summary(jsonb);
  drop function if exists public.report_needs_attention(jsonb);
  drop function if exists public.report_records(jsonb, text, integer, integer, text);
  drop function if exists public.report_source_rows(jsonb);
  drop function if exists public.report_agent_rows(jsonb);

  -- v1.12.4
  drop function if exists public.report_filter_options();
  drop function if exists public.report_lifecycle(jsonb);
  drop function if exists public.reporting_summary_for_window(jsonb, date, date);
  drop function if exists public.report_summary(jsonb);
  drop function if exists public.reporting_filtered_workloads(jsonb);
  drop function if exists public.reporting_filtered_quotes(jsonb);
  drop function if exists public.report_normalize_filters(jsonb);
  drop function if exists public.reporting_can_read();
  drop function if exists public.reporting_self_scope();
  drop function if exists public.reporting_enum_array(jsonb, text[]);
  drop function if exists public.reporting_text_array(jsonb);
  drop function if exists public.reporting_uuid_array(jsonb);
  drop function if exists public.reporting_day_start(date);
  drop function if exists public.reporting_timezone();

  -- v1.12.3
  drop index if exists cs_intake_events_work_item_idx;
  drop index if exists audit_log_reassign_action_idx;
  drop index if exists quote_notes_source_created_idx;
  drop index if exists work_item_events_source_type_idx;
  drop index if exists quote_outcomes_method_finalized_idx;
  drop index if exists quote_outcomes_salesperson_finalized_idx;
  drop index if exists quote_outcomes_dealer_finalized_idx;
  drop index if exists quote_outcomes_decision_finalized_idx;
  drop index if exists quote_outcomes_source_finalized_idx;
  drop index if exists pending_pricing_salesperson_idx;
  drop index if exists pending_pricing_dealer_idx;
  drop index if exists pending_pricing_created_idx;
  drop index if exists work_items_voided_idx;
  drop index if exists work_items_created_by_idx;
  drop index if exists work_items_salesperson_created_idx;
  drop index if exists work_items_dealer_created_idx;
  drop index if exists work_items_quote_created_idx;

  -- v1.12.2, v1.12.1
  drop view if exists public.reporting_workload_facts;
  drop view if exists public.reporting_quote_facts;
  drop view if exists public.reporting_quote_field_changes;
  drop view if exists public.reporting_quote_event_rollup;
  drop view if exists public.reporting_quote_base;
  drop view if exists public.reporting_intake_quote_links;

  -- v1.12.0
  drop function if exists public.reporting_is_business_hours(timestamptz);
  drop table    if exists public.business_hours_settings;
  drop table    if exists public.business_hours_closures;
  drop table    if exists public.business_hours_days;

  -- v1.12.7 created nothing.
commit;
```

**Dropping `reporting_integrity_flags` and `reporting_integrity_reviews` destroys the review history**, which is the one genuinely irreversible part of this rollback. Every manager explanation and every review decision goes with it. Export both tables first if there is any chance the decisions matter.

## Not done, deliberately

- The branch is not merged and not pushed.
- No legacy report was removed. That needs explicit Manager_Role approval.
- No holidays or closures were loaded.
- Integrity detection was run once against live data to verify it; it is not scheduled.
