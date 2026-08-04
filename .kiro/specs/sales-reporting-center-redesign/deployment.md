# Deployment and Rollback

Sales Reporting Center. Spec: `.kiro/specs/sales-reporting-center-redesign`.

## Deploy record

**Both halves are live.**

| | |
| --- | --- |
| Database | All eleven migrations applied to project `kfbgftkjvtynfdwgcgeb`, 3 August 2026 |
| Application | `origin/main` fast-forwarded from `b34184c` to `6905e6e`, 4 August 2026 |
| Branch | `origin/feature/sales-reporting-center` at the same commit, kept for review |

Five commits went to `main`:

```
6905e6e  fix(reporting): clear every lint problem in the new code
b485143  docs(reporting): record legacy comparison and evidence
831066e  feat(reporting): add the Sales Reporting Center interface
113c69a  feat(reporting): add sales reporting data layer
b710413  feat(reporting): document sales metric definitions and credit rules
```

Pushed as `git push origin feature/sales-reporting-center:main`, a fast-forward. `origin/main` had not moved since the branch was cut, so nothing was merged and no history was rewritten. The push was done without checking out `main`, deliberately, so that unrelated uncommitted work in the tree could not be disturbed.

Vercel builds on push to `main` through its GitHub integration, per Part 7 of `LIVE-DEPLOYMENT-GUIDE.md`.

**No environment variable changes are needed.** The export route uses the same `createClient()` server helper as every other route, and `exceljs` and `pdfkit` are ordinary dependencies. Nothing new is read from the environment.

### Verified after the push

| Check | Result |
| --- | --- |
| `v1.12-reporting-checks.sql` | 17 of 17 PASS |
| `v1.12-reporting-authorization-checks.sql` | 21 of 21 PASS |
| Smoke: last 7 days, as a manager | 357 received, 306 priced, 4 awaiting pricing, **60 awaiting customer decision**, 157 sold, 170 not sold, 48% conversion, 9.3 min median |
| Smoke: 11 agent rows, 136 source rows, 569 open flags, 6 working days | as expected |

That **60** is worth noting: it is exactly the figure the legacy "Pending Pricing" card shows. The companion metric added in `v1.12.10` lands on the number managers already recognise, which is the outcome that change was for.

### Not verified

The deployed site itself was not requested. The production URL is configured in the Vercel dashboard and in the Supabase Site URL setting, not recorded in this repository, so there was nothing to check against without guessing at a hostname. Confirm in Vercel that the deployment for `6905e6e` succeeded, then sign in as a manager and check the five points under "Deploying the application" below.

## Outstanding: no holidays are loaded

`business_hours_closures` is empty. Until it is populated a holiday reads as an ordinary working day, and after-hours figures understate on those dates. See "Confirming business hours" below for the insert. This is the one known correctness gap in what is now live.

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
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.11-fix-ambiguous-column-references.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/migrations/v1.12.12-reporting-filter-performance.sql
```

`v1.12.7` runs **first** on purpose. It asserts that the seven live-only tables, the four live-only `work_items` columns, `attendance_policy.business_timezone`, and `can_manage_sales()` all exist, and names whichever is missing. Running it first turns a missing dependency into one clear error instead of a failure inside a view definition five files later.

`v1.12.8`, `v1.12.9` and `v1.12.10` replace objects created by `v1.12.1`, `v1.12.6` and `v1.12.4`. They must run after them, which numeric order gives.

## Verifying an environment

```
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-checks.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-rpc-checks.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-authorization-checks.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-execution-checks.sql
node --env-file=.env.local scripts/run-sql.mjs supabase/verification/v1.12-reporting-drilldown-checks.sql
```

Expect 17 PASS, 14 matching pairs, 21 PASS, 12 PASS with none SLOW, and 40 PASS. A single
FAIL means stop.

**Run the last two.** They are the ones that catch a function that is reachable but
raises. The first three would have passed while two functions were broken on every call,
because an anonymous probe returns before the query body runs. Reachability is not
execution.

The three files simulate a session by setting `request.jwt.claims`, because the Management API connects with no JWT and the reporting functions correctly refuse an anonymous caller. **The profile ids in those files are specific to this project** and need substituting elsewhere: a `manager`, a `sales_supervisor`, and the `agent` with the most assigned quotes.

## Detecting integrity flags for the first time

Detection is not automatic. Either a manager presses **Re-scan this period** in the Review & Integrity view, or:

```sql
select public.reporting_detect_integrity_flags('2026-07-01', '2026-07-31');
```

It is an upsert keyed on `(subject_kind, subject_id, signal_key)` and never writes `review_status`, `reviewed_by`, `reviewed_at` or `manager_explanation`, so running it repeatedly is safe and cannot un-explain a reviewed flag.

## Deploying the application

Done for this environment; kept for the next one.

1. Confirm `npx tsc --noEmit`, `npm run lint` over the feature directories, `npm test` and `npm run build` on the branch. If `next build` reports "Another next build process is already running", delete `.next` and rerun — a stale lock, not a failure.
2. Confirm `serverExternalPackages: ['pdfkit', 'exceljs']` survived any merge. Without it the build fails on `fontkit`'s import of `applyDecoratedDescriptor` from `@swc/helpers`.
3. Confirm `exceljs@4.4.0`, `pdfkit@0.15.2` and `@types/pdfkit@0.13.9` are in the lockfile at those exact versions.
4. Push. Vercel builds from `main`.
5. Sign in as a manager and check five things:
   - **Sales → Reporting Center** loads on Overview with eight KPIs populated.
   - Selecting a KPI opens the right-side drawer, and the drawer's total matches the KPI.
   - **Sales → Legacy Reports** still lists all 24 views, each with a retention banner.
   - **Review & Integrity** lists flags, and a supervisor can record a decision.
   - **Export Current View → Summary CSV** downloads, and its totals equal the screen.

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

- **No legacy report was removed.** That needs explicit Manager_Role approval, per Requirements 1.2 and 20.3.
- **No holidays or closures were loaded.** Which dates the office closes is a business decision, not one to infer.
- **Integrity detection is not scheduled.** It was run once against live data to verify it, producing the 569 flags now in the queue. A manager refreshes it from the Review & Integrity view. Scheduling it would need a cron route like the renewals SMS scheduler already has.
- **The duplicate-quote defect in `.kiro/specs/rc-claim-duplicate-quote-fix/` was not fixed.** This feature reports duplicates; it does not change the path that creates them.
- **The claim RPCs were not changed to populate `turn_events.work_item_id`.** Doing so would switch queue reconciliation from the systemic finding to per-record flags with no reporting change, but it touches the queue rotation path, which is out of scope here and governed by its own rules.
