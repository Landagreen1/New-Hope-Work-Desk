-- New Hope Work Desk v1.12.7 — record of live-only objects the reporting layer reads
--
-- Spec: .kiro/specs/sales-reporting-center-redesign
-- Requirements: 17.9
--
-- READ THIS FIRST: this file creates nothing. It is a record, not a migration.
--
-- Seven tables and four columns that the Sales Reporting Center queries exist only
-- in live Supabase and appear in no migration under supabase/. Without this record
-- the reporting views could not be reviewed against the schema they read. Every
-- statement below is guarded, so applying the file against production is a no-op
-- and applying it to a fresh project produces nothing either — the guards are
-- assertions, and a fresh project would fail them loudly rather than silently
-- getting a wrong-shaped table.
--
-- Captured from the live catalogue on 2026-08-03. Verify before trusting.
--
-- ── The four live-only columns on work_items ──────────────────────────────────
--
--   is_voided    boolean
--   voided_at    timestamptz
--   voided_by    uuid
--   void_reason  text
--
-- These are the real void mechanism. No repository migration mentions them and no
-- current report reads them, so a voided quote is counted by every existing sales
-- metric. reporting_quote_facts excludes on is_voided.
--
-- ── The stray quote_decision label ───────────────────────────────────────────
--
-- public.quote_decision has three labels: 'sold', 'not_sold', and 'Sold'. As of
-- 2026-08-03 no row uses 'Sold' (599 'sold', 613 'not_sold'), but the label exists
-- and can be written, so every reporting comparison lowercases the decision. The
-- label should be dropped once its absence is confirmed over a longer window;
-- dropping an enum label is not reversible, so it is not done here.
--
-- ── Live work_item_events types beyond the repository CHECK ───────────────────
--
-- The CHECK in v0.7.0 allows: created, assigned, accepted, reassigned, price_sent,
-- sold, not_sold, completed, cancelled. Live rows also carry:
--
--   activation                          created_from_cs_intake
--   change                              outcome_change
--   ringcentral_intake_claim_completed  taken
--   timer_claimed
--
-- outcome_change is what the "outcome changed after finalization" integrity signal
-- reads. It could not have been found from the repository alone.
--
-- ── Functions already live that this feature reuses rather than creating ──────
--
--   public.can_manage_sales()  -> role in ('manager', 'sales_supervisor', 'super_admin')
--   public.is_manager()        -> role in ('manager', 'super_admin')
--
-- can_manage_sales() already matches canManageSales in src/lib/permissions.ts.

begin;

-- Assert every object the reporting layer depends on is present, naming the one
-- that is missing rather than failing later inside a view definition.
do $assert$
declare
  v_missing text[] := '{}';
  v_table   text;
  v_column  text;
begin
  foreach v_table in array array[
    'cs_intake_submissions',
    'cs_intake_events',
    'cs_intake_drivers',
    'cs_intake_vehicles',
    'dealer_salespeople',
    'work_desk_settings',
    'quote_take_timers'
  ] loop
    if to_regclass('public.' || v_table) is null then
      v_missing := v_missing || ('table public.' || v_table);
    end if;
  end loop;

  foreach v_column in array array[
    'is_voided', 'voided_at', 'voided_by', 'void_reason', 'salesperson_id'
  ] loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'work_items'
        and column_name = v_column
    ) then
      v_missing := v_missing || ('column public.work_items.' || v_column);
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'attendance_policy'
      and column_name = 'business_timezone'
  ) then
    v_missing := v_missing || 'column public.attendance_policy.business_timezone';
  end if;

  if to_regprocedure('public.can_manage_sales()') is null then
    v_missing := v_missing || 'function public.can_manage_sales()';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception
      'v1.12.7: the Sales Reporting Center depends on objects this database does not have: %',
      array_to_string(v_missing, ', ');
  end if;
end
$assert$;

comment on column public.work_items.is_voided is
  'Live-only until v1.12.7 recorded it. The real void mechanism: a voided quote must be excluded from every sales metric. reporting_quote_facts.is_excluded reads this column. No report before the Sales Reporting Center did.';

commit;
