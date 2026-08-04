# Design Document

## Overview

One reporting surface, `Sales Reporting Center`, with four views over a server-side reporting data layer. Nothing displayed is aggregated in the browser.

The design has three layers:

1. **Definitions layer** — `src/features/reporting/definitions.ts`, pure TypeScript. The metric catalog, the credit rules, the business-hours classifier, and the integrity thresholds live here as data plus pure functions. This is the single written answer to "what does this number mean", it is what the tests target, and it is what the SQL is written to match.
2. **Data layer** — new `reporting_*` views, functions, and tables under `supabase/migrations/v1.12.*`. One `Quote_Fact` per quote, one `Workload_Fact` per workload, one `Integrity_Flag` per discrepancy. Every read is an RPC that checks the caller's role.
3. **Interface layer** — `src/features/reporting/`, a feature directory following the `cancellations` pattern: a page shell, presentational components, `api.ts` holding every Supabase call, and pure `derive.ts` helpers.

`src/components/work-desk-app.tsx` gains nothing. The 24 Legacy_Reports stay in it, untouched, behind a Legacy Reports heading. That file is 12,539 lines and already holds the whole legacy report system; adding to it is what this redesign exists to stop.

Branch: `feature/sales-reporting-center`. Six commits, one per phase.

---

## Why a fact-view layer rather than more client memos

The current `reportData` memo (lines 6571–7452 of `work-desk-app.tsx`) is 880 lines computing 24 reports from 15 unaggregated result sets capped at 5,000–30,000 rows. Three consequences drove this design:

- **The caps silently truncate.** Once `work_item_events` passes 30,000 rows, every timing and documentation metric quietly loses its oldest data with no error and no indication on screen.
- **The union is rebuilt per render.** A quote's identity has to be reassembled from three tables in JavaScript on every filter change, and the three branches were given different date bases, which is the root cause of the three-different-"pending" defect.
- **Aggregation and presentation share a scope.** Every metric can see every other metric's intermediate variables, so a denominator can be borrowed across definitions without anything failing.

Moving aggregation into the database fixes all three at once: the union becomes one view with one definition of identity, the row caps disappear because only aggregates and one page of details cross the wire, and each metric becomes a named SQL expression that a test can pin.

---

## Phase 1 — Definitions layer

### `src/features/reporting/definitions.ts`

Pure. No React, no Supabase, no `Date.now()` except inside an explicitly named clock helper. Exports:

| Export | Purpose |
| --- | --- |
| `METRIC_DEFINITIONS` | The metric catalog: id, label, definition prose, `countedBy` timestamp, `mode`, `denominator`, and `creditRole` for each metric. Drives both the KPI ribbon tooltips and the export header. |
| `REPORT_VIEWS`, `REPORT_MODES`, `HOURS_SEGMENTS`, `AFTER_HOURS_DIMENSIONS` | The closed value sets. The URL parser validates against these. |
| `resolveBusinessDate(instant, timeZone)` | The calendar date of an instant in Business_Timezone. |
| `classifyInstant(instant, settings)` | Returns `{ isBusinessHours, isAfterHours, isSunday, isWorkingDay, closureLabel }`. The single after-hours authority. |
| `afterHoursDimensions(quote, settings)` | The four independent flags of Requirement 8. |
| `CREDIT_ROLES`, `resolveCreditRoles(quote, events)` | Requirement 6's six roles from the event stream. |
| `metricDenominatorLabel(metricId)` | The stated denominator, so Conversion Rate and Quote-to-Sale Rate can never be shown unlabeled. |
| `INTEGRITY_FLAG_TYPES`, `INTEGRITY_SIGNALS` | The seven neutral Flag_Types and the signal catalog with each signal's threshold key. |
| `DEFAULT_INTEGRITY_THRESHOLDS` | The seeded threshold values, mirrored by the `reporting_thresholds` row. |
| `SOURCE_HEALTH_CONDITIONS` | The nine named source conditions with their threshold keys. |
| `LEGACY_REPORT_MAP` | Each of the 24 Legacy_Reports mapped to the Report_View that supersedes it, or `null` with a retirement reason. Drives Requirement 1.4 and the Phase 6 comparison. |

`classifyInstant` is the reason this module exists. The current `getEstTime` round-trips through `toLocaleString('en-US', …)` and re-parses the result with `new Date(...)`, which depends on the host's locale formatting and silently misreads at daylight-saving boundaries. The replacement uses `Intl.DateTimeFormat` with explicit numeric parts and reads the parts directly, never re-parsing a formatted string:

```ts
const parts = new Intl.DateTimeFormat('en-US', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(instant));
```

The same classification exists twice — here for the browser and as `public.reporting_is_business_hours(timestamptz)` for SQL — because the browser needs it for labels and drawer rows while the queries need it for aggregation. The shared test corpus in `__tests__/business-hours.fixtures.ts` is run against both, so the two cannot drift silently.

### Documents produced in Phase 1

- `report-inventory.md` — every existing report, its metrics, its tables and fields, the timestamp each metric uses, which metrics duplicate one another, which calculations run in the browser, and which reports mishandle the date range.
- `metric-definitions.md` — the authoritative definitions, the agent-credit rules, the after-hours rules, the integrity signals, the data gaps, and the old-versus-new metric mapping.

---

## Phase 2 — Reporting data layer

Migrations are forward-only and begin at `v1.12.0`, the next version after `v1.11.6-zaira-ortiz-saturdays-only.sql`. No existing migration file is edited. No existing table, column, view, or function that a Legacy_Report reads is altered.

| Migration | Contents |
| --- | --- |
| `v1.12.0-reporting-business-hours.sql` | `business_hours_days`, `business_hours_closures`, `business_hours_settings`, `reporting_is_business_hours()`, seeded to reproduce today's Mon–Sat 08:30–17:30 behavior |
| `v1.12.1-reporting-quote-facts.sql` | `reporting_quote_base`, `reporting_quote_event_rollup`, `reporting_quote_facts` |
| `v1.12.2-reporting-workload-facts.sql` | `reporting_workload_facts` |
| `v1.12.3-reporting-indexes.sql` | The supporting indexes |
| `v1.12.4-reporting-rpcs.sql` | The read RPCs and `report_normalize_filters()` |
| `v1.12.5-reporting-integrity.sql` | `reporting_thresholds`, `reporting_integrity_flags`, `reporting_integrity_reviews`, the immutability trigger, `reporting_detect_integrity_flags()` |
| `v1.12.6-reporting-integrity-rpcs.sql` | `report_integrity_flags()`, `report_integrity_review()`, RLS |
| `v1.12.7-reporting-live-object-dump.sql` | `create table if not exists` statements recording the live definitions of the seven objects with no repository DDL (Requirement 17.9). Guarded by `if not exists` so it is a no-op against production. |

### Business hours

Business_Timezone is **not duplicated**. It is read from `attendance_policy.business_timezone`, which already exists and already defaults to `America/New_York`. Storing a second copy would create a second answer to when the office is open.

```sql
create table public.business_hours_days (
  day_of_week    smallint primary key check (day_of_week between 0 and 6),
  is_working_day boolean  not null,
  opens_at       time     not null,
  closes_at      time     not null,
  constraint business_hours_days_span check (closes_at > opens_at)
);

create table public.business_hours_closures (
  closure_date date primary key,
  label        text not null check (length(btrim(label)) > 0),
  closure_kind text not null check (closure_kind in ('holiday', 'special_closure')),
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);

create table public.business_hours_settings (
  singleton_key          boolean primary key default true check (singleton_key),
  sunday_is_working_day  boolean not null default false,
  updated_by             uuid references public.profiles(id),
  updated_at             timestamptz not null default now()
);
```

Seed: `day_of_week` 1–6 working, `08:30`–`17:30`; `day_of_week` 0 not working. That is exactly what `isAfterHours` hard-codes today, so the first legacy comparison starts from parity and any difference it reports is a definition difference rather than a settings difference.

```sql
create or replace function public.reporting_is_business_hours(p_at timestamptz)
returns boolean
language sql stable security definer set search_path = public as $$
  with tz as (select business_timezone from public.attendance_policy where singleton_key),
       local as (select (p_at at time zone (select business_timezone from tz)) as ts)
  select case
    when exists (select 1 from public.business_hours_closures c
                  where c.closure_date = (select ts::date from local)) then false
    else coalesce((
      select d.is_working_day
             and (select ts::time from local) >= d.opens_at
             and (select ts::time from local) <  d.closes_at
        from public.business_hours_days d
       where d.day_of_week = extract(dow from (select ts from local))::smallint
    ), false)
  end;
$$;
```

`at time zone` performs the conversion in Postgres using the IANA database, so daylight-saving transitions are handled by the same rules the attendance module already relies on. Opening time inclusive, closing time exclusive (Requirement 7.9). A closure date is After_Hours all day (Requirement 7.6).

### Quote fact

`reporting_quote_base` resolves Quote_Identity once. Precedence is outcome → pending → active, because a quote physically moves between the three tables and only the furthest-along row describes its present state:

```sql
create or replace view public.reporting_quote_base
with (security_invoker = true) as
with outcome_ranked as (
  select q.*, row_number() over (
           partition by q.source_work_item_id
           order by q.finalized_at desc, q.id desc) as rn,
         count(*) over (partition by q.source_work_item_id) as outcome_count
    from public.quote_outcomes q
)
select
  coalesce(o.source_work_item_id, p.source_work_item_id, w.id) as quote_id,
  case when o.id is not null then 'finalized'
       when p.id is not null then 'pending_pricing'
       else 'active' end                                       as lifecycle_stage,
  coalesce(o.quote_created_at, p.quote_created_at, w.created_at) as created_at,
  coalesce(o.assigned_at, p.assigned_at, w.assigned_at)         as assigned_at,
  nullif(coalesce(o.accepted_at, p.accepted_at, w.accepted_at),
         coalesce(o.quote_created_at, p.quote_created_at, w.created_at)) as accepted_at_raw,
  coalesce(o.price_sent_at, p.price_sent_at)                    as price_sent_at_row,
  o.finalized_at,
  o.decision                                                    as final_outcome,
  o.not_sold_reason, o.not_sold_reason_other,
  coalesce(o.customer_name, p.customer_name, w.customer_name)   as customer_name,
  coalesce(o.dealer_id, p.dealer_id, w.dealer_id)               as dealer_id,
  coalesce(o.salesperson_id, p.salesperson_id, w.salesperson_id) as salesperson_id,
  coalesce(o.work_type, p.work_type, w.work_type)               as work_type,
  coalesce(o.assignment_method, p.assignment_method, w.assignment_method) as assignment_method,
  coalesce(o.received_through, p.received_through, w.received_through)    as received_through,
  coalesce(o.assigned_profile_id, p.assigned_profile_id, w.assigned_profile_id) as assigned_profile_id,
  coalesce(o.original_owner_profile_id, p.original_owner_profile_id,
           w.original_owner_profile_id)                         as original_owner_profile_id,
  w.created_by, w.status as work_item_status,
  w.related_quote_source_work_item_id,
  coalesce(o.outcome_count, 0)                                  as outcome_record_count
from public.work_items w
full join public.pending_pricing_quotes p on p.source_work_item_id = w.id
full join (select * from outcome_ranked where rn = 1) o
       on o.source_work_item_id = coalesce(p.source_work_item_id, w.id)
where coalesce(o.work_type, p.work_type, w.work_type) in ('new_quote', 'requote');
```

Two decisions in that view matter to the metrics:

- **`accepted_at_raw` nulls out a coalesced value.** `v0.7.0` backfilled `accepted_at` from `quote_created_at`, and `dashboard-data.ts` lines 394 and 421 coalesce it again on read, which is why "time to accept" currently reports zero for backfilled rows. Nulling the equal case means the metric reports *unknown* rather than *instant*.
- **`outcome_record_count`** is carried forward so Requirement 4.6 can raise a Timing Conflict on a quote holding more than one outcome record. `quote_outcomes` has no unique constraint on `source_work_item_id`, so this is a live possibility rather than a hypothetical.

`reporting_quote_event_rollup` supplies everything derived from the event stream — First_Pricing_Sent_At, the credit actors, the counts, and the after-hours work flag:

```sql
create or replace view public.reporting_quote_event_rollup
with (security_invoker = true) as
select
  e.source_work_item_id as quote_id,
  min(e.created_at) filter (where e.event_type = 'price_sent') as first_price_sent_event_at,
  (array_agg(e.actor_profile_id order by e.created_at)
     filter (where e.event_type = 'price_sent'))[1]            as pricing_actor_profile_id,
  (array_agg(e.actor_profile_id order by e.created_at)
     filter (where e.event_type = 'accepted'))[1]              as claim_actor_profile_id,
  (array_agg(e.assigned_profile_id order by e.created_at)
     filter (where e.event_type = 'assigned'))[1]              as first_assigned_profile_id,
  (array_agg(e.actor_profile_id order by e.created_at desc)
     filter (where e.event_type in ('sold', 'not_sold')))[1]   as outcome_actor_profile_id,
  count(*) filter (where e.event_type in ('assigned', 'reassigned')) as assignment_event_count,
  bool_or(not public.reporting_is_business_hours(e.created_at)
          and e.event_type <> 'created')                       as worked_after_hours_events
from public.work_item_events e
group by e.source_work_item_id;
```

`reporting_quote_facts` joins base, rollup, notes, take events, and intake links, and computes the derived fields:

- `first_pricing_sent_at` = `least(price_sent_at_row, first_price_sent_event_at)` (Requirement 4.2). A quote with neither is not counted in Pricing Sent.
- `is_manual_quote` = `assignment_method = 'manual_quote'` (Requirement 5.1). Nothing else contributes.
- `is_requote` = `work_type = 'requote' or related_quote_source_work_item_id is not null`.
- `is_cs_intake` = an intake row links to this `quote_id`.
- `is_duplicate_retry` = this quote is not the earliest quote linked to its intake, where that intake links to two or more quotes. This is the Duplicate_Retry exclusion, and it is derived rather than read because the defect recorded in `.kiro/specs/rc-claim-duplicate-quote-fix/bugfix.md` produces two quote records with no flag on either.
- `is_excluded` = `work_items.is_voided`, or `work_item_status = 'cancelled'`, or `is_duplicate_retry`. `is_voided` / `voided_at` / `voided_by` / `void_reason` exist live and appear in no repository migration; they are the real void mechanism and the reason a status check alone is not enough.
- `sales_credit_profile_id` = the assigned profile on the outcome record (Requirement 6.7).
- `received_after_hours`, `worked_after_hours`, `finalized_after_hours`, `manual_entry_after_hours` per Requirement 8.
- `notes_count`, `follow_up_count`, `source_change_count`, `salesperson_change_count`, `attachment_count`.

A deleted quote needs no exclusion clause: `manager_delete_quote` hard-deletes from `work_items`, `pending_pricing_quotes`, `quote_outcomes`, `quote_notes`, `quote_take_events`, `work_item_events`, and `user_notifications`, leaving only an `audit_log` row with `action = 'quote_deleted'`. That is also why deletion is a documented historical-accuracy limitation rather than something the fact view can preserve: a report for a closed period shrinks when a manager deletes one of its quotes. `report_reconciliation()` counts those `audit_log` rows per period so a legacy-versus-new difference caused by a deletion can be explained instead of investigated.

### Workload fact

`reporting_workload_facts` is one row per `work_items` row whose `work_type` is not a quote type — `activation`, `change`, `payment`, `whatsapp_update`. It carries `is_manual_workload` (`assignment_method = 'manual_workload'`), `is_queue_workload` (`assignment_method = 'workload_turn'`), the related quote from `related_quote_source_work_item_id`, the timestamps, the note and evidence counts, its after-hours flag, and its status. Requirement 5.3 is why this is a separate view: a Manual_Workload count must never be able to pick up a workload turn, a quote, or a CS intake claim.

### Integrity flags

Physical tables, because Review_Status is user state that a view cannot hold.

```sql
create table public.reporting_integrity_flags (
  id            uuid primary key default gen_random_uuid(),
  subject_kind  text not null check (subject_kind in ('quote', 'workload')),
  subject_id    uuid not null,
  flag_type     text not null check (flag_type in (
                  'Needs Review', 'Attribution Conflict', 'Missing Documentation',
                  'Queue Mismatch', 'Manual Entry Pattern', 'Duplicate Activity',
                  'Timing Conflict')),
  signal_key    text not null,
  severity      text not null check (severity in ('low', 'medium', 'high')),
  explanation   text not null,
  evidence      jsonb not null,
  detected_on   date not null default current_date,
  review_status text not null default 'Open' check (review_status in (
                  'Open', 'Explained', 'Confirmed Data Issue', 'Dismissed')),
  reviewed_by   uuid references public.profiles(id),
  reviewed_at   timestamptz,
  manager_explanation text,
  resolution    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (subject_kind, subject_id, signal_key)
);
```

The unique key is `(subject_kind, subject_id, signal_key)` rather than `flag_type`, because two signals can share a Flag_Type — "Sold with no pricing event" and "Not Sold with no reason" are both Missing Documentation, and they must be reviewable separately. `reporting_detect_integrity_flags()` upserts with `on conflict … do update` that writes `explanation`, `evidence`, and `severity` but never `review_status`, `reviewed_by`, `reviewed_at`, or `manager_explanation`, which is Requirement 14.10: re-detecting a discrepancy must not un-explain it.

`reporting_integrity_reviews` is append-only with a trigger refusing `update` and `delete`, following `attendance_audit_immutable()` from `v1.9.0-attendance-foundations.sql`. Reopening appends a row and retains every earlier one, so the explanation recorded before a reopen survives (Requirement 15.5).

Every signal's threshold lives in `reporting_thresholds`, a singleton whose columns match `DEFAULT_INTEGRITY_THRESHOLDS` in `definitions.ts`. No signal has a literal threshold in SQL, and no signal fires because a record is merely manual (Requirement 14.4).

### RPC surface

Reads are RPCs rather than API routes: writes in this codebase already go through RPCs, the client already calls `supabase.rpc(...)` everywhere, and one `security definer` function per report gives authorization exactly one place to live. Today's report gating is UI-only — `supabase/schema.sql` lines 1027–1055 let any authenticated user read every underlying table — so authorization has to be added, not merely relocated.

| Function | Returns |
| --- | --- |
| `report_filter_options()` | Agents, teams, sources, salespeople (with their source), channels, assignment methods, statuses, outcomes |
| `report_summary(p_filters jsonb)` | One row: the eight KPIs, plus the same eight over the comparison period |
| `report_lifecycle(p_filters jsonb)` | Cohort funnel counts and percentages |
| `report_needs_attention(p_filters jsonb)` | One row per Needs Attention condition with its count and its drill-down key |
| `report_agent_rows(p_filters jsonb)` | One row per employee, default and expandable columns, keyed by profile id |
| `report_source_rows(p_filters jsonb)` | One row per source |
| `report_source_detail(p_filters jsonb, p_dealer_id uuid)` | The source expansion breakdowns |
| `report_after_hours_summary(p_filters jsonb)` | The ten after-hours measures of Requirement 8.8 |
| `report_records(p_filters jsonb, p_metric text, p_limit int, p_offset int, p_sort text)` | A page of drill-down records plus `total_count` |
| `report_integrity_flags(p_filters jsonb, p_saved_filter text, p_limit int, p_offset int)` | A page of flags plus `total_count` |
| `report_integrity_review(p_flag_id uuid, p_action text, p_explanation text)` | The updated flag |
| `report_reconciliation(p_start date, p_end date)` | New metric, legacy metric, difference, and the differing record ids, per metric |

Every function is `security definer`, `set search_path = public`, and begins with the same guard:

```sql
if not public.can_manage_sales() then
  return; -- zero rows, per Requirement 19.6
end if;
```

`public.can_manage_sales()` **already exists live** and already matches `canManageSales` in `src/lib/permissions.ts`: `manager`, `sales_supervisor`, `super_admin`. It is reused, not recreated. `report_integrity_review` uses the same `can_manage_sales()` guard: Byron confirmed on 2026-08-03 that sales supervisors may review flags. A Self_Scoped_Reader calling any read function receives only rows in which it holds a Credit_Role, enforced inside the function rather than by a filter the client supplies.

`p_filters` is `jsonb` normalized by `report_normalize_filters()`, which drops unknown keys, clamps `p_limit`, and defaults every absent value. A composite type would need a migration for every new filter; jsonb lets a filter be added without changing eleven signatures.

**Sales-supervisor scope, settled.** Report_Reader_Role and Integrity_Reviewer_Role are both `can_manage_sales()` — `manager`, `sales_supervisor`, `super_admin`. Byron confirmed on 2026-08-03 that supervisors may review flags. Business_Hours_Settings writes stay narrower, at `is_manager()`, because office hours are an agency-wide setting rather than a sales decision.

### Indexes

```sql
create index if not exists work_items_quote_created_idx
  on public.work_items (created_at desc) where work_type in ('new_quote','requote');
create index if not exists work_items_dealer_created_idx      on public.work_items (dealer_id, created_at desc);
create index if not exists work_items_salesperson_created_idx on public.work_items (salesperson_id, created_at desc);
create index if not exists work_items_created_by_idx          on public.work_items (created_by, created_at desc);
create index if not exists pending_pricing_created_idx        on public.pending_pricing_quotes (quote_created_at desc);
create index if not exists pending_pricing_dealer_idx         on public.pending_pricing_quotes (dealer_id, price_sent_at desc);
create index if not exists quote_outcomes_source_finalized_idx on public.quote_outcomes (source_work_item_id, finalized_at desc);
create index if not exists quote_outcomes_decision_finalized_idx on public.quote_outcomes (decision, finalized_at desc);
create index if not exists quote_outcomes_dealer_finalized_idx  on public.quote_outcomes (dealer_id, finalized_at desc);
create index if not exists quote_outcomes_method_finalized_idx  on public.quote_outcomes (assignment_method, finalized_at desc);
create index if not exists work_item_events_source_type_idx  on public.work_item_events (source_work_item_id, event_type, created_at);
create index if not exists quote_notes_source_created_idx     on public.quote_notes (source_work_item_id, created_at desc);
create index if not exists reporting_flags_status_idx  on public.reporting_integrity_flags (review_status, detected_on desc);
create index if not exists reporting_flags_subject_idx on public.reporting_integrity_flags (subject_kind, subject_id);
```

`work_items_assigned_status_idx`, `work_items_created_at_idx`, `work_items_method_idx`, `quote_outcomes_created_idx`, `quote_outcomes_finalized_idx`, and `quote_outcomes_agent_idx` already exist in `schema.sql` and are not recreated.

### If the views become slow

Consumers only ever call RPCs, so the fact views can be replaced by materialized derivatives refreshed on a schedule without a single consumer changing. That is the escape hatch, not the starting point: a materialized view is stale, and a report a manager does not trust is worse than a report that takes an extra second. At the current data volume — 5,000 work items, 10,000 outcomes, 30,000 events — the lateral joins are inexpensive.

---

## Phase 3–5 — Interface layer

### Files

```
src/features/reporting/
  SalesReportingCenter.tsx          shell: filter bar + mode selector + view switch + drawer host
  api.ts                            every supabase.rpc call, one function per RPC
  types.ts                          ReportFilters, QuoteFactRow, AgentRow, SourceRow, IntegrityFlag
  definitions.ts                    Phase 1, above
  derive.ts                         pure formatting, comparison deltas, undefined-rate handling
  url-state.ts                      ReportFilters <-> URLSearchParams, validated against definitions.ts
  components/
    ReportingFilters.tsx            global filter bar, linked source/salesperson, debounced
    ReportModeSelector.tsx
    KpiRibbon.tsx                   eight KPIs, definition tooltip, comparison delta, selectable
    QuoteLifecycle.tsx              cohort funnel as labeled counts and percentages
    NeedsAttention.tsx
    RecordDrawer.tsx                right-side drawer, paginated, Log action per quote row
    ExportCurrentView.tsx           one control, four formats
    MetricDefinitionPopover.tsx
  views/
    OverviewReport.tsx
    AgentsReport.tsx
    SourcesReport.tsx
    IntegrityReport.tsx
  __tests__/
```

Conventions followed from `src/features/cancellations/`: `'use client'` at the top of client modules, `getSupabase()` from `../nhwd-shared/client`, `ui.*` class tokens from `nhwd-shared/ui.ts`, every screen taking `{ initialProfile: ProfileLite; embedded?: boolean }`, all Supabase access confined to `api.ts`, and pure logic in `derive.ts` / `definitions.ts` where tests can reach it without a DOM.

### Registration

Three coordinated edits, the same three every other module uses:

1. `src/components/app-sidebar.tsx` — add `sales_reporting_center` to the `SubNavId` union and a `{ id: 'sales_reporting_center', label: 'Reporting Center', icon: BarChart3 }` item behind `permissions.manageSales`, above the existing `sales_reports` item, which is relabeled **Legacy Reports**.
2. `src/components/role-workspace.tsx` — render `SalesReportingCenter` for `sales_reporting_center` inside a `Suspense` boundary, leaving `sales_reports` mapped to the existing `reports` manager tab.
3. `src/components/work-desk-app.tsx` — one string change: the Reports tab label becomes "Legacy Reports". No other change.

The Legacy_Reports view keeps its own date state, its own `reportData` memo, and its own eight export buttons. It is not migrated, not refactored, and not wired to the new filter bar. Leaving it frozen is what makes the Phase 6 comparison meaningful: both sides must be computed the way they are computed in production.

### URL state

`url-state.ts` is the only place that reads or writes the query string. `parseReportUrl(params)` validates every value against the closed sets in `definitions.ts`, drops what this build does not offer, returns the dropped keys so the shell can state them (Requirement 9.10), and returns a fully defaulted `ReportFilters`. `writeReportUrl(filters)` produces a stable key order so two identical states produce one identical URL, and pushes with `router.push` so Back restores the previous state without a reload.

### Drill-down

One `RecordDrawer`, opened with a `{ metricId, drillKey, filters }` triple. It calls `report_records` with the same normalized filters that produced the number, so the drawer and the KPI cannot disagree by construction. The drawer states the metric's definition from `METRIC_DEFINITIONS`, reports the total matching count next to the page it shows, and renders a Log action per quote row wired to `QuoteActivityModal` with that row's `source_work_item_id`. Requirement 10.5 extends that Log action to every quote row in all four views, closing the gap where 21 of the 24 legacy views are unwired, seven of which list quote rows.

### Export

`POST /api/reports/sales/export` takes the normalized `ReportFilters`, the Report_View, the Report_Mode, the sort order, and the format. It re-runs the same RPCs server-side and formats the result. Routing all four formats through one server endpoint is what makes "export totals match the screen" structural rather than a thing to remember: there is one query path, and the browser never recomputes a total for an export.

Sequencing, because two formats need new dependencies:

- **Phase 3** ships Summary CSV and Underlying records CSV. No new dependency; reuses the `csvEscape` conventions already in the codebase.
- **Phase 4** adds the Excel workbook and the PDF snapshot through `exceljs` and `pdfkit`, pinned to exact versions. Byron approved both dependencies on 2026-08-03.

Every export carries a header stating the Report_View, Report_Mode, Reporting_Window, Hours_Segment, dimension filters, and generation time in Business_Timezone, and refuses beyond the configured maximum record count rather than streaming an unbounded file.

---

## Phase 6 — Legacy comparison

`report_reconciliation(p_start, p_end)` computes each new metric and its legacy counterpart over the same window and returns both values, the difference, and the ids of the records the two counted differently. The legacy side is computed in SQL from the same three tables using the *legacy* rules — creation-date basis for active and pending rows, finalization-date basis for outcomes, `pendingPricing.length` with no date filter for Pending Pricing — so the comparison reproduces the defects rather than quietly correcting them. A difference that the new definitions intend is then distinguishable from a difference that is a bug in the new query.

Differences known in advance, from the audit:

| Metric | Expected difference | Cause |
| --- | --- | --- |
| Pending Pricing | New value differs materially | Legacy card ignores the date range entirely and counts every pending row; new metric is as-of the Report_End_Instant |
| Quotes Received | New value less than or equal to legacy | Legacy counts a quote once per lifecycle table it appears in during the window; new counts one per Quote_Identity, and excludes Duplicate_Retry and cancelled records |
| Conversion | Unchanged | Both are Sold ÷ Finalized |
| Efficiency | Retired | `finalized ÷ quotes` mixes a Quote Cohort denominator with Operational Activity numerators; replaced by the cohort funnel |
| Agent totals | Differ where an employee was renamed | Legacy joins agents by display name; new joins by profile id |
| Time to accept | New value often undefined where legacy showed zero | Legacy coalesces `accepted_at` to `quote_created_at` |
| Agent 360 score | Retired | A single weighted composite is out of scope for this phase by requirement |
| After-hours counts | New value differs where a holiday or closure falls in the window | Legacy has no holiday or closure awareness |

Every material difference is recorded in `legacy-comparison.md` with the metric, both values, the definition that changed, the timestamp that changed, and the differing record ids. No Legacy_Report is removed in this phase.

---

## Testing

| Layer | Where | How |
| --- | --- | --- |
| Definitions | `src/features/reporting/__tests__/definitions.test.ts` | Pure unit tests over the metric catalog, credit rules, and classifier |
| Business hours | `src/features/reporting/__tests__/business-hours.test.ts` + `business-hours.fixtures.ts` | A shared corpus of instants with expected classifications, covering Sunday, holidays, closures, both DST transitions, and the inclusive-open / exclusive-close boundaries |
| Metric arithmetic | `src/features/reporting/__tests__/metrics.test.ts` | Cohort versus activity for a quote created before the window and priced or sold inside it; pending as of period end; finalized after period end; duplicate retries; multiple outcome records |
| Credit attribution | `src/features/reporting/__tests__/credit.test.ts` | Created by one employee and priced by another; assigned to one and sold by another; manager reassignment; source or salesperson changed after creation; sales credit differing from outcome actor |
| Integrity signals | `src/features/reporting/__tests__/integrity.test.ts` | Each signal at, just below, and just above its threshold; Explained, Dismissed, and Reopened preserving history |
| URL state | `src/features/reporting/__tests__/url-state.test.ts` | Round-trip stability, unknown-value dropping, pagination and sort persistence |
| Data layer | `src/features/reporting/__tests__/reporting-rpc.integration.test.ts` | Real Supabase via `npm run test:integration`: RPC totals, pagination, role refusal, export parity |
| Property tests | `*.property.test.ts` with `fast-check` | A quote is counted in exactly one lifecycle bucket; a metric total equals the length of its own drill-down; a re-detected flag preserves its Review_Status |

`vitest.config.ts` sets `environment: 'node'`, so any component test added later needs a `// @vitest-environment jsdom` docblock. There is no `typecheck` script; the type check is `npx tsc --noEmit`.

A passing build is not evidence that a metric is correct. Every phase gate is `npx tsc --noEmit`, `npm test`, and `npm run build`, and the metric phases additionally require the reconciliation output.

---

## Out of scope

- Any change to the 24 Legacy_Reports beyond the Reports tab label.
- Any change to queue rotation behavior, the claim RPCs, or `turn_events`. Queue reconciliation in the Review & Integrity view **reads** rotation data and writes nothing to it.
- Queue Health, Pass Behavior, Missed Turns, and Recovered Quotes as primary views.
- A composite agent score or a composite source score.
- The commercial reports in `src/features/commercial/` and the attendance reports.
- Repairing the duplicate-quote defect in `.kiro/specs/rc-claim-duplicate-quote-fix/`. This feature reports duplicates; it does not fix the path that creates them.
