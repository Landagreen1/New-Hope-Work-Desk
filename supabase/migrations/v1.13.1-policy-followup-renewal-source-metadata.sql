-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.13.1 — Renewal collector source lineage
--
-- Spec: .kiro/specs/policy-follow-up-assignment-workflow
-- Requirements: 1.1, 1.2, 1.3, 1.4, 11.2, 11.3, 13.1
-- Design: 3.3, 11.1
--
-- Forward-only and additive: every column is nullable with no default that rewrites a
-- stored row, so applying this migration changes no existing renewal record and no
-- existing behaviour. `renewal_records` already carries `powerbi_raw` and
-- `source_sync_state` from v0.9.13; those keep their meaning and are not touched.
--
-- Why the raw and the normalized value are both stored:
--
--   Requirement 1.1 requires the collector's own words survive for audit — a manager has
--   to be able to answer "what did the carrier actually say about this policy" months
--   later. Requirement 1.2 requires agents never have to read those words. A UI-only
--   translation satisfies neither: it loses the audit answer the moment the mapping
--   changes, and it cannot be filtered or counted. So the interpretation is persisted
--   beside the raw value, and `src/features/policy-follow-up/normalization.ts` is the one
--   module that produces it.
--
-- `assignment_source` is widened rather than reused: design 11.1 forbids labelling a
-- collector row `powerbi`, because a manager reading the record must be able to tell
-- which importer wrote it and which precedence step chose its owner.
-- ═══════════════════════════════════════════════════════════════════════════════

do $pre$
begin
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'renewal_records') then
    raise exception 'v1.13.1 requires public.renewal_records' using hint = 'Nothing was changed.';
  end if;
end;
$pre$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. SOURCE LINEAGE COLUMNS (Requirement 1.1)
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.renewal_records
  add column if not exists source_system text,
  add column if not exists source_record_type text,
  add column if not exists source_status_raw text,
  add column if not exists source_state_normalized text,
  add column if not exists source_match_status text,
  add column if not exists source_match_method text,
  add column if not exists source_match_status_raw text,
  add column if not exists source_file_name text,
  add column if not exists source_row_number integer,
  add column if not exists source_warning text,
  add column if not exists source_review_required boolean,
  add column if not exists source_communication_blocked boolean,
  add column if not exists source_payload jsonb,
  -- The shared ownership identity, stored so the manager overview and the search surface
  -- can group by carrier without recomputing the normalization per row. Written by the
  -- collector importer and by the ownership sync; never by hand.
  add column if not exists carrier_key text,
  add column if not exists policy_number_normalized text,
  add column if not exists producer_label text;

comment on column public.renewal_records.source_system is
  'Which importer wrote the record. `renewal_collector` for a consolidated Renewals collector export; null for a record the legacy Power BI / HawkSoft import created.';
comment on column public.renewal_records.source_record_type is
  'TipoRegistro exactly as the collector wrote it, Spanish included. Never replaced by its interpretation. Requirement 1.1.';
comment on column public.renewal_records.source_status_raw is
  'EstadoEnReporte exactly as the carrier report wrote it. Free carrier prose, retained for audit and never allowed to override source_record_type. Requirement 1.1.';
comment on column public.renewal_records.source_state_normalized is
  'The interpretation of source_record_type as a PolicySourceState: renewal, carrier_nonrenewal, pending_cancellation, payment_signal, cancelled_signal, or review_required. Produced by src/features/policy-follow-up/normalization.ts. Requirement 1.2.';
comment on column public.renewal_records.source_match_status is
  'The interpretation of Cruce: exact, probable, no_match, or unknown. Anything but exact holds the record for manager review before automatic customer communication. Requirement 1.4.';
comment on column public.renewal_records.source_match_status_raw is
  'Cruce exactly as written. Requirement 1.1.';
comment on column public.renewal_records.source_warning is
  'AvisosImportacion: the collector''s own warning text for the row. Requirement 1.1.';
comment on column public.renewal_records.source_review_required is
  'True where the row is held for manager review. Requirements 1.3, 1.4.';
comment on column public.renewal_records.source_communication_blocked is
  'True where automatic customer communication is withheld for this record. The import-side half of Requirement 12.2; the domain send gates still run on top of it.';
comment on column public.renewal_records.source_payload is
  'The whole source row keyed by header name, so a manager can read one record''s lineage by column name. Requirement 11.3.';
comment on column public.renewal_records.carrier_key is
  'The normalized carrier key of the shared ownership identity. policy_followup_normalize_carrier_key(carrier). Requirement 3.1.';
comment on column public.renewal_records.policy_number_normalized is
  'The normalized policy number of the shared ownership identity. policy_followup_normalize_policy_number(policy_number). Requirement 3.1.';
comment on column public.renewal_records.producer_label is
  'Productor exactly as the collector wrote it, which the producer mapping of Requirement 3.3 step 4 resolves. Distinct from producer_name, which the HawkSoft export writes.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. VALUE CONSTRAINTS
--
--    Both are written as `is null or in (...)` so every pre-existing row, which carries
--    null, satisfies them without being touched. Adding a NOT VALID constraint and
--    validating it separately is unnecessary here for the same reason.
-- ═══════════════════════════════════════════════════════════════════════════════

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.renewal_records'::regclass
       and conname = 'renewal_source_state_normalized_check'
  ) then
    alter table public.renewal_records
      add constraint renewal_source_state_normalized_check check (
        source_state_normalized is null or source_state_normalized in (
          'renewal', 'carrier_nonrenewal', 'pending_cancellation',
          'payment_signal', 'cancelled_signal', 'review_required'));
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.renewal_records'::regclass
       and conname = 'renewal_source_match_status_check'
  ) then
    alter table public.renewal_records
      add constraint renewal_source_match_status_check check (
        source_match_status is null or source_match_status in (
          'exact', 'probable', 'no_match', 'unknown'));
  end if;
end;
$constraints$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. WIDEN assignment_source (Requirement 13.2, design 11.1)
--
--    The three pre-existing values keep their meaning exactly:
--      powerbi  — the legacy Power BI / HawkSoft import resolved an assignee label
--      manager  — renewal_assign stamped a manager decision
--      manual   — set by hand
--    The four new values name the Requirement 3.3 precedence steps:
--      collector       — a collector import created or updated the record
--      shared_owner    — the existing shared policy owner was preserved (step 2 or 3)
--      producer_mapping — the imported Productor label resolved to an employee (step 4)
--      weighted_auto   — weighted workload balancing chose the employee (step 5)
--
--    The existing constraint is dropped and re-added rather than altered because Postgres
--    has no `alter constraint` for a check expression. Every stored value satisfies the
--    new expression, so no row is rewritten and no scan can fail.
-- ═══════════════════════════════════════════════════════════════════════════════

do $assignment_source$
declare
  v_unexpected text;
begin
  select string_agg(distinct assignment_source, ', ')
    into v_unexpected
    from public.renewal_records
   where assignment_source is not null
     and assignment_source not in (
       'powerbi', 'manager', 'manual',
       'collector', 'shared_owner', 'producer_mapping', 'weighted_auto');

  if v_unexpected is not null then
    raise exception 'renewal_records holds assignment_source values the new constraint would reject: %',
                    v_unexpected
      using hint = 'Nothing was changed. Reconcile the stored values first.';
  end if;

  alter table public.renewal_records
    drop constraint if exists renewal_assignment_source_check;

  alter table public.renewal_records
    add constraint renewal_assignment_source_check check (
      assignment_source is null or assignment_source in (
        'powerbi', 'manager', 'manual',
        'collector', 'shared_owner', 'producer_mapping', 'weighted_auto'));
end;
$assignment_source$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. INDEXES
--
--    Every one supports a query this spec adds: the ownership join, the Manager Overview
--    review-required and non-renewal counts, and the producer-label review list. All are
--    partial where the interesting rows are a small subset, so none of them grows with the
--    legacy book.
-- ═══════════════════════════════════════════════════════════════════════════════

create index if not exists idx_renewal_records_policy_identity
  on public.renewal_records (carrier_key, policy_number_normalized)
  where carrier_key is not null and policy_number_normalized is not null;

create index if not exists idx_renewal_records_source_state
  on public.renewal_records (source_state_normalized)
  where source_state_normalized is not null;

create index if not exists idx_renewal_records_review_required
  on public.renewal_records (renewal_date)
  where source_review_required;

create index if not exists idx_renewal_records_producer_label
  on public.renewal_records (producer_label)
  where producer_label is not null and assigned_to is null;

create index if not exists idx_renewal_records_assigned_open
  on public.renewal_records (assigned_to, renewal_date)
  where status in ('imported', 'assigned', 'in_progress', 'monitoring', 'requote_sent');

create index if not exists idx_renewal_records_source_run
  on public.renewal_records (source_file_name, source_row_number)
  where source_file_name is not null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. BACKFILL THE OWNERSHIP IDENTITY ONLY (Requirement 13.1)
--
--    Both identity columns are derived from values already stored on the row, so filling
--    them is a computation rather than a source update: no human-owned field is touched,
--    no status changes, no assignment changes, and `updated_at` is deliberately left alone
--    so this migration does not look like an edit in any audit or "recently changed" view.
--
--    Every other new column stays null on a legacy record, which is correct: the legacy
--    Power BI import never carried a record type, a match result, or a collector warning,
--    and inventing one would be exactly the guess Requirement 1.3 forbids.
-- ═══════════════════════════════════════════════════════════════════════════════

update public.renewal_records record
   set carrier_key = public.policy_followup_normalize_carrier_key(record.carrier),
       policy_number_normalized = public.policy_followup_normalize_policy_number(record.policy_number)
 where record.carrier_key is null
    or record.policy_number_normalized is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. POST-CONDITIONS
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing text;
  v_unnormalized bigint;
begin
  select string_agg(c.name, ', ' order by c.name) into v_missing
    from (values ('source_system'), ('source_record_type'), ('source_status_raw'),
                 ('source_state_normalized'), ('source_match_status'), ('source_match_method'),
                 ('source_match_status_raw'), ('source_file_name'), ('source_row_number'),
                 ('source_warning'), ('source_review_required'), ('source_communication_blocked'),
                 ('source_payload'), ('carrier_key'), ('policy_number_normalized'),
                 ('producer_label')) as c(name)
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'renewal_records' and column_name = c.name);
  if v_missing is not null then
    raise exception 'v1.13.1 did not add: %', v_missing using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.renewal_records'::regclass
       and conname = 'renewal_assignment_source_check'
       and pg_get_constraintdef(oid) like '%weighted_auto%'
  ) then
    raise exception 'v1.13.1 did not widen renewal_assignment_source_check'
      using detail = 'Design 11.1.', hint = 'Rolling back.';
  end if;

  -- Every row that names a carrier and a policy now carries its ownership identity.
  select count(*) into v_unnormalized
    from public.renewal_records
   where policy_number_normalized is null
     and nullif(btrim(policy_number), '') is not null;
  if v_unnormalized > 0 then
    raise exception 'v1.13.1 left % renewal rows without a normalized policy number', v_unnormalized
      using detail = 'Requirement 3.1.', hint = 'Rolling back.';
  end if;

  raise notice 'v1.13.1 applied: renewal collector lineage columns and the ownership identity are in place.';
end;
$post$;
