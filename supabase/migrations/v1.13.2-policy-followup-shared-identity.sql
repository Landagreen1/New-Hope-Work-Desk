-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.13.2 — The shared ownership identity on both domains, and the collector column set
--
-- Spec: .kiro/specs/policy-follow-up-assignment-workflow
-- Requirements: 2.2, 3.1, 3.2, 8.4, 10.3, 13.2
-- Design: 4.2, 4.3, 11.2
--
-- Forward-only and additive. Three things:
--
--   1. `cancellation_cases.carrier_key`, so the two domains can be joined on the same
--      `(carrier_key, policy_number_normalized)` pair the shared owner is keyed by
--      (Requirement 3.1). The cancellation table already carries
--      `policy_number_normalized` as a generated stored column; only the carrier half was
--      missing.
--
--   2. Triggers on both `renewal_records` and `cancellation_cases` that keep the identity
--      current. This is what makes the identity correct for writes the pre-existing
--      importers make: neither `renewal_import_batch` nor `cancellation_import_batch` is
--      modified here, and neither has to be, because the trigger fires for them too. A
--      manager correcting a carrier through `renewal_manager_update` or
--      `correctImportedCaseData` is likewise covered without either being touched.
--
--   3. `'collector'` added to the two `column_set` CHECK constraints, so the consolidated
--      PendingCancellation collector export can be recorded as its own source rather than
--      pretending to be one half of the legacy two-file pair (Requirement 2.2, design 11.2).
--
-- The carrier key cannot be a generated column: `policy_followup_normalize_carrier_key`
-- consults the confirmed-alias table, which makes it STABLE rather than IMMUTABLE, and
-- Postgres requires a generation expression be immutable. A trigger is the correct tool,
-- and it has a second advantage — adding a confirmed alias later can be followed by a
-- one-statement re-key rather than a table rewrite.
-- ═══════════════════════════════════════════════════════════════════════════════

do $pre$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'policy_followup_normalize_carrier_key'
  ) then
    raise exception 'v1.13.2 requires v1.13.0' using hint = 'Nothing was changed.';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'renewal_records' and column_name = 'carrier_key'
  ) then
    raise exception 'v1.13.2 requires v1.13.1' using hint = 'Nothing was changed.';
  end if;
end;
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE CARRIER HALF OF THE IDENTITY ON CANCELLATIONS (Requirement 3.1)
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_cases
  add column if not exists carrier_key text;

comment on column public.cancellation_cases.carrier_key is
  'The normalized carrier key of the shared ownership identity, maintained by trigger from `carrier`. Pairs with the generated policy_number_normalized to key public.policy_followup_policy_owners. Requirement 3.1.';

create index if not exists idx_cancellation_cases_policy_identity
  on public.cancellation_cases (carrier_key, policy_number_normalized)
  where carrier_key is not null;

create index if not exists idx_cancellation_cases_producer_unassigned
  on public.cancellation_cases (producer_label)
  where producer_label is not null and assigned_to is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. IDENTITY TRIGGERS
--
--    Both are BEFORE triggers that only ever write the two derived columns, so they
--    cannot interfere with any rule either importer or either manager-correction path
--    applies, and they add one function call per written row.
--
--    `renewal_records` needs both halves computed; `cancellation_cases` needs only the
--    carrier half, because its policy half is already a generated stored column.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.policy_followup_set_renewal_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  new.carrier_key := public.policy_followup_normalize_carrier_key(new.carrier);
  new.policy_number_normalized := public.policy_followup_normalize_policy_number(new.policy_number);
  return new;
end;
$fn$;

comment on function public.policy_followup_set_renewal_identity() is
  'Keeps renewal_records.carrier_key and .policy_number_normalized in step with carrier and policy_number, for every writer including renewal_import_batch and renewal_manager_update. Requirement 3.1.';

drop trigger if exists policy_followup_renewal_identity on public.renewal_records;
create trigger policy_followup_renewal_identity
  before insert or update of carrier, policy_number on public.renewal_records
  for each row execute function public.policy_followup_set_renewal_identity();

create or replace function public.policy_followup_set_cancellation_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  new.carrier_key := public.policy_followup_normalize_carrier_key(new.carrier);
  return new;
end;
$fn$;

comment on function public.policy_followup_set_cancellation_identity() is
  'Keeps cancellation_cases.carrier_key in step with carrier, for every writer including cancellation_import_batch and the manager correction path. The policy half is already a generated stored column. Requirement 3.1.';

drop trigger if exists policy_followup_cancellation_identity on public.cancellation_cases;
create trigger policy_followup_cancellation_identity
  before insert or update of carrier on public.cancellation_cases
  for each row execute function public.policy_followup_set_cancellation_identity();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. BACKFILL
--
--    A computation from values already on the row, so no human-owned field is touched and
--    no status changes. `updated_at` is written on cancellation_cases only because that
--    table has no touch trigger to avoid; the renewal backfill in v1.13.1 already ran
--    without it. Neither table's audit timeline gains an entry: this writes no event.
-- ═══════════════════════════════════════════════════════════════════════════════

update public.cancellation_cases
   set carrier_key = public.policy_followup_normalize_carrier_key(carrier)
 where carrier_key is null
   and nullif(btrim(coalesce(carrier, '')), '') is not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. THE COLLECTOR COLUMN SET (Requirement 2.2, design 11.2)
--
--    `eficacia` and `avisos` are the legacy two-file pair, each owning half the fields.
--    A consolidated collector export owns every field it carries, contacts included, so it
--    needs its own identifier — labelling it `eficacia` would silently drop the columns only
--    the collector has, and labelling it `avisos` would drop the amount and the producer.
--
--    Both constraints are re-added rather than altered because Postgres has no
--    `alter constraint` for a check expression. Every stored value satisfies the widened
--    expression, so no row is rewritten.
-- ═══════════════════════════════════════════════════════════════════════════════

do $column_set$
begin
  alter table public.cancellation_import_runs
    drop constraint if exists cancellation_import_runs_column_set_check;
  alter table public.cancellation_import_runs
    add constraint cancellation_import_runs_column_set_check
      check (column_set in ('eficacia', 'avisos', 'collector'));

  if exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'cancellation_import_case_rows') then
    alter table public.cancellation_import_case_rows
      drop constraint if exists cancellation_import_case_rows_column_set_check;
    alter table public.cancellation_import_case_rows
      add constraint cancellation_import_case_rows_column_set_check
        check (column_set in ('eficacia', 'avisos', 'collector'));
  end if;
end;
$column_set$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_unkeyed bigint;
  v_case_id uuid;
  v_probe_key text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_cases' and column_name = 'carrier_key'
  ) then
    raise exception 'v1.13.2 did not add cancellation_cases.carrier_key' using hint = 'Rolling back.';
  end if;

  for v_probe_key in
    select unnest(array['cancellation_import_runs_column_set_check',
                        'cancellation_import_case_rows_column_set_check'])
  loop
    if exists (select 1 from pg_constraint where conname = v_probe_key)
       and not exists (
         select 1 from pg_constraint
          where conname = v_probe_key and pg_get_constraintdef(oid) like '%collector%')
    then
      raise exception 'v1.13.2 did not widen % to accept the collector column set', v_probe_key
        using detail = 'Requirement 2.2.', hint = 'Rolling back.';
    end if;
  end loop;

  -- Every case naming a carrier now carries its carrier key.
  select count(*) into v_unkeyed
    from public.cancellation_cases
   where carrier_key is null
     and nullif(btrim(coalesce(carrier, '')), '') is not null;
  if v_unkeyed > 0 then
    raise exception 'v1.13.2 left % cancellation cases without a carrier key', v_unkeyed
      using detail = 'Requirement 3.1.', hint = 'Rolling back.';
  end if;

  -- The two triggers really fire, and they agree with each other about one policy. Run
  -- inside a subtransaction that is discarded, so no probe row survives.
  begin
    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, carrier, raw_row, raw_header)
    values (' v1132 probe ', current_date, 'Progressive Insurance', '[]'::jsonb, array['probe'])
    returning id, carrier_key into v_case_id, v_probe_key;

    if v_probe_key is distinct from 'PROGRESSIVE' then
      raise exception 'the cancellation identity trigger did not set the carrier key (got %)',
                      coalesce(v_probe_key, 'null');
    end if;

    if (select policy_number_normalized from public.cancellation_cases where id = v_case_id)
       is distinct from public.policy_followup_normalize_policy_number(' v1132 probe ') then
      raise exception 'the generated policy number and policy_followup_normalize_policy_number disagree';
    end if;

    raise exception '__v1132_probe_rollback__';
  exception
    when others then
      if sqlerrm is distinct from '__v1132_probe_rollback__' then raise; end if;
  end;

  raise notice 'v1.13.2 applied: both domains share one ownership identity and the collector column set is accepted.';
end;
$post$;
