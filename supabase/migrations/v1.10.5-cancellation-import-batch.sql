-- New Hope Work Desk v1.10.5 — Cancellation import batch loader (migration stage 6 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.6)
-- Requirements: 8.5, 8.7, 8.8, 8.9, 9.2, 9.3, 9.8, 10.6, 15.9, 15.10, 15.11, 24.1, 26.1, 26.2
--
-- Forward-only, sixth file of the v1.10.x series. Creates two functions and nothing
-- else: no table, no column, no index, no constraint, no trigger, no policy, no row
-- outside the discarded post-condition probe. Touches no table, column, policy,
-- function, or row created at v1.9.7 or earlier (Requirements 26.1, 26.2). The reads
-- outside the cancellation_* objects are `auth.uid()` inside the loader and a single
-- `public.profiles` id in the post-condition block, used to prove the loader admits
-- Manager_Role; nothing outside cancellation_* is written anywhere. The only drops in
-- this file are the ones listed in the rollback path below, which name only the two
-- functions this file creates.
--
-- Contents:
--   1. cancellation_import_batch(text, text, jsonb, jsonb)
--        the security-definer loader: one transaction that inserts the import run,
--        upserts every accepted case on the identity constraint, inserts contacts,
--        writes one audit event per case, and returns the import run row
--   2. cancellation_recompute_communication_status(uuid, integer)
--        the nine-value Communication_Status precedence of Requirement 15.9
--   3. Post-conditions, including live proof that a non-manager is refused with
--      nothing written and that one small batch creates and then updates a case
--
-- ROLLBACK
--   begin;
--     drop function if exists public.cancellation_import_batch(text, text, jsonb, jsonb);
--     drop function if exists public.cancellation_recompute_communication_status(uuid, integer);
--   commit;
--   Nothing else is dropped, because nothing else is created. No pre-existing row is
--   touched by the rollback, because none is touched by the migration. This is the
--   code-level rollback only; Requirement 26.3 keeps applied v1.10.x migrations in
--   place when application code is rolled back.
--
-- ROW LEVEL SECURITY IS STILL NOT ENABLED ON THE CANCELLATION TABLES.
--   v1.10.6-cancellation-rls.sql (task 7.7) owns `enable row level security` and every
--   policy; this file adds neither and must not be read as adding either. Until task
--   7.7 lands, every cancellation_* table remains reachable by any `authenticated`
--   session, so this intermediate state must not be left deployed. What this file does
--   enforce is the one gate Requirement 8.5 puts on the loader itself: the function
--   below refuses every caller that is not Manager_Role, on a path that runs with the
--   owner's privileges and therefore would otherwise bypass row level security
--   entirely once it exists. The gate reuses public.cancellation_is_manager() from
--   v1.10.0 — manager plus super_admin — and defines no second role test.
--
-- WHAT THIS FUNCTION DELIBERATELY DOES NOT DO
--   * It does not parse, validate, reject, or deduplicate rows. Tasks 9.3–9.5 own that
--     and they are complete: `src/features/cancellations/import/{csv,classify,mapping,
--     fields,contacts,preview}.ts` parse the file, reject rows (Requirement 8.6), run
--     the Requirement 9.4 in-file duplicate contest, build the contact rows, and count
--     the five outcomes. The row-level rejections therefore arrive already computed, in
--     `p_rows.counts`, which is exactly why one rejected row aborts nothing here
--     (Requirement 8.9): a rejected row is simply not in the payload.
--   * It does not evaluate escalations. `evaluateEscalations(case, contacts,
--     communications, responses, businessDate)` is a pure TypeScript module per the
--     design, and the import route runs it after this function returns, which is what
--     creates the `cancellation_escalations` rows and their notifications. Reproducing
--     that decision table in SQL would give the module two definitions.
--   * It does not recompute Communication_Status for an updated case. Requirement 9.8
--     preserves the stored Communication_Status across an import, and Requirement 15.10
--     already fixes the created case at `Not Scheduled`, which is what the recompute
--     function returns for a case holding no Communication_Record and no pending send.
--     The recompute function exists here for the Requirement 15.9 callers — the
--     scheduler, a delivery-result change, a contact change — which arrive in later
--     tasks.
--
-- ═══════════════════════════════════════════════════════════════════════════════
-- THE PARAMETER CONTRACT
--
--   cancellation_import_batch(
--     p_file_name  text,   -> cancellation_import_runs.file_name
--     p_column_set text,   -> cancellation_import_runs.column_set, 'eficacia' | 'avisos'
--     p_mapping    jsonb,  -> cancellation_import_runs.confirmed_mapping, the
--                             ConfirmedMapping of mapping.ts. Its `header` array is
--                             also the source of cancellation_cases.raw_header, which
--                             is one value per file and therefore absent from every
--                             row (Requirement 24.1).
--     p_rows       jsonb)  -> the payload described below
--
-- p_rows is the object
--
--   { "counts": <ImportRunCounts>, "rows": [ <row element>, ... ] }
--
-- where <ImportRunCounts> is `toImportRunCounts(preview)` from preview.ts verbatim —
-- its keys are already the cancellation_import_runs column names — and each <row
-- element> is one entry of `preview.plan` with its `fields` flattened into the element
-- and its contact rows under `contacts`:
--
--   { ...PreviewedCaseRow.fields,          -- cancellation_cases column names
--     "row_number": 1,                     -- PreviewedCaseRow.rowNumber
--     "assigned_to": "<uuid>" | null,      -- resolved from producer_label (Req 9.6, 9.7)
--     "contacts": [ <ImportedContactRow>, ... ] }
--
-- Tolerated variants, so the caller may hand over what it already holds:
--   * p_rows as a bare array is the row array with no counts. rows_total then reads as
--     the array length and rows_rejected and rows_duplicate as zero.
--   * counts flattened into p_rows alongside `rows` instead of nested under `counts`.
--   * `rows` named `plan`, which is what `preview.plan` is called.
--   * a row element left in PreviewedCaseRow shape: `fields` still nested, `rowNumber`
--     in place of `row_number`, and `contacts` as the CaseContactBuildResult object
--     whose `rows` holds the contact rows.
-- No other shape is guessed at: an unexpected p_rows raises 22023 with nothing written.
--
-- Counts stored on the import run are the manager-confirmed preview counts, because
-- Requirement 8.8 records the five counts of Requirement 8.5 — the numbers shown
-- before confirmation. The one exception is the created/updated split, which is
-- overwritten with what the upsert actually did, because Requirements 9.2 and 9.3
-- define those two counts by outcome. The split's total is the row count either way,
-- so `rows_total = rows_created + rows_updated + rows_rejected + rows_duplicate`
-- survives (`countsPartitionRowsTotal` in preview.ts), and a supplied split whose
-- total is not the row count is rejected before anything is written.
-- ═══════════════════════════════════════════════════════════════════════════════

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. COMMUNICATION_STATUS RECOMPUTE — the nine-value precedence of Requirement 15.9.
--
--    Created before the loader so the loader can name it.
--
--    p_pending_sends is the count of pending Touchpoint channel sends: touchpoint and
--    channel pairs scheduled for the case under Requirement 12 criterion 2 for which
--    no Communication_Record is stored (Requirement 15.3). That number is a function
--    of the touchpoint schedule, the business calendar, and the settings row, all of
--    which live in the scheduler, so the caller that knows the schedule passes it.
--    It defaults to zero, which makes `cancellation_recompute_communication_status(
--    p_case_id)` — the one-argument call task 7.6 names — valid and exact for the two
--    cases that matter most: a freshly imported case, and any case whose touchpoints
--    have all come due.
--
--    Every branch reads only stored rows: Communication_Record delivery results
--    (Requirement 15.5, 15.6, 15.7), Contact_Recipient suppression (15.8), and
--    uncleared cancellation_escalations rows (20.11). The case row is locked first, so
--    two concurrent recomputes of one case serialize instead of racing.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_recompute_communication_status(
  p_case_id uuid,
  p_pending_sends integer default 0)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_total      bigint;
  v_failed     bigint;
  v_delivered  bigint;
  v_sent       bigint;
  v_contacts   bigint;
  v_phone_open bigint;
  v_email_open bigint;
  v_pending    integer := greatest(coalesce(p_pending_sends, 0), 0);
  v_escalated  boolean;
  v_status     text;
begin
  if p_case_id is null then
    raise exception 'cancellation_recompute_communication_status needs a Cancellation_Case id'
      using errcode = 'invalid_parameter_value',
            hint    = 'Nothing was changed.';
  end if;

  perform 1 from public.cancellation_cases where id = p_case_id for update;
  if not found then
    raise exception 'cancellation_recompute_communication_status found no Cancellation_Case %', p_case_id
      using errcode = 'no_data_found',
            hint    = 'Nothing was changed.';
  end if;

  -- The Idempotency_Key of Requirement 12.6 includes case_id, so a combined message
  -- stores one Communication_Record per covered case and this count needs no join to
  -- cancellation_communication_cases.
  select count(*),
         count(*) filter (where delivery_result = 'Failed'),
         count(*) filter (where delivery_result = 'Delivered'),
         count(*) filter (where delivery_result = 'Sent')
    into v_total, v_failed, v_delivered, v_sent
    from public.cancellation_communications
   where case_id = p_case_id;

  -- "Suppression set on every recipient carrying a phone value, and on every recipient
  --  carrying an email value" (Requirement 15.8) is "zero unsuppressed rows of either
  --  channel", counted here as the two `*_open` figures.
  select count(*),
         count(*) filter (where channel = 'phone' and not sms_suppressed),
         count(*) filter (where channel = 'email' and not email_suppressed)
    into v_contacts, v_phone_open, v_email_open
    from public.cancellation_contacts
   where case_id = p_case_id;

  select exists (select 1
                   from public.cancellation_escalations
                  where case_id = p_case_id
                    and cleared_at is null)
    into v_escalated;

  -- Requirement 15.9, in its stated order. The first matching branch wins.
  v_status := case
    when v_escalated
      then 'Manual Follow-up Required'
    when v_total > 0 and v_failed = v_total
      then 'Failed'
    when v_failed > 0
      then 'Partially Failed'
    when v_total = 0 and v_contacts > 0 and v_phone_open = 0 and v_email_open = 0
      then 'Suppressed'
    when v_total > 0 and v_pending > 0
      then 'Partially Sent'
    when v_total > 0 and v_pending = 0 and v_delivered = v_total
      then 'Delivered'
    when v_total > 0 and v_pending = 0 and v_sent + v_delivered = v_total
      then 'Sent'
    when v_total = 0 and v_pending > 0
      then 'Scheduled'
    else 'Not Scheduled'
  end;

  update public.cancellation_cases
     set communication_status = v_status,
         updated_at           = now()
   where id = p_case_id
     and communication_status is distinct from v_status;

  return v_status;
end;
$fn$;

comment on function public.cancellation_recompute_communication_status(uuid, integer) is
  'Recomputes and stores Communication_Status for one Cancellation_Case using the nine-value precedence of Requirement 15.9: Manual Follow-up Required for an uncleared cancellation_escalations row (20.11), then Failed (15.7), Partially Failed (15.6), Suppressed (15.8), Partially Sent, Delivered (15.5), Sent, Scheduled, Not Scheduled. p_pending_sends is the count of pending Touchpoint channel sends (Requirement 15.3), which only the caller holding the touchpoint schedule can know; it defaults to 0, so the one-argument call is exact for a case with no touchpoint still to send. Locks the case row, writes only communication_status and updated_at, leaves Case_Status untouched (15.3), and returns the stored value.';

grant execute on function public.cancellation_recompute_communication_status(uuid, integer) to authenticated;
grant execute on function public.cancellation_recompute_communication_status(uuid, integer) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. THE IMPORT BATCH LOADER
--
--    One statement from the client, one transaction here: either the import run row,
--    every accepted case, every new contact row, and every audit event are committed,
--    or none of them is. A row that failed validation is not in the payload at all, so
--    Requirement 8.9 holds by construction rather than by trapping per-row errors.
--
--    Identity is the unique constraint, never a lookup: `on conflict on constraint
--    cancellation_cases_identity_key` routes each row by the stored generated column
--    policy_number_normalized, so the Requirement 9.1 normalization keeps its single
--    definition in v1.10.0 and this file restates none of it. `xmax` on the RETURNING
--    clause is what distinguishes the two outcomes: zero means the row was inserted
--    (Requirement 9.3, a create), non-zero means the conflict target matched and the
--    DO UPDATE branch ran (Requirement 9.2, an update).
--
--    The update branch overwrites exactly the values Requirement 9.2 names — customer
--    name, carrier, amount due, client identifier, the customer matching key derived
--    from them, producer label, the eleven legacy passthrough values, and the raw
--    imported row — plus the provenance of the import that last touched the row. It
--    names case_status and communication_status nowhere, so Requirements 9.8 and 15.11
--    hold by omission; notes, communications, responses, evidence, and audit rows live
--    in other tables and are never reached. policy_number itself is left as stored: the
--    normalized forms are equal by definition on this path, and Requirement 9.2 does
--    not list it among the overwritten values, so a manager's corrected spelling
--    survives a reimport of the original.
--
--    An employee assignment recorded by Manager_Role outranks the import (Requirement
--    9.8): where assignment_source is already 'manager', both assigned_to and
--    assignment_source are held. Otherwise a resolved import assignment is written
--    with assignment_source 'import', and an unresolved one (Requirement 9.7, no
--    match or a "(Deleted)" label) leaves the stored assignment alone rather than
--    clearing it.
--
--    Contacts insert with `on conflict ... do nothing` on the Requirement 10.6 dedup
--    key. That is the whole of Requirement 9.8's contact clause: a value the case
--    already holds keeps its stored preferred language, suppression states, and
--    authorization status, however many times a later file repeats the cell.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_import_batch(
  p_file_name text,
  p_column_set text,
  p_mapping jsonb,
  p_rows jsonb)
returns public.cancellation_import_runs
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_actor            uuid := auth.uid();
  v_run              public.cancellation_import_runs;
  v_rows             jsonb;
  v_counts           jsonb;
  v_element          jsonb;
  v_fields           jsonb;
  v_contacts         jsonb;
  v_header           text[];
  v_row_header       text[];
  v_row_number       integer;
  v_assigned         uuid;
  v_raw_row          jsonb;
  v_case_id          uuid;
  v_created          boolean;
  v_row_contacts     bigint;
  v_row_invalid      bigint;
  v_rows_created     integer := 0;
  v_rows_updated     integer := 0;
  v_contacts_stored  bigint := 0;
  v_invalid_stored   bigint := 0;
  v_rows_total       integer;
  v_rows_rejected    integer;
  v_rows_duplicate   integer;
  v_split            integer;
begin
  -- ── Caller authorization. Requirement 8.5 reserves confirming an import to
  --    Manager_Role, and this function runs with the owner's privileges, so the gate
  --    is the only thing standing between an Agent_Role session and a write of every
  --    Cancellation_Case in a file. Refusal happens before the first insert, so a
  --    refused caller leaves zero import runs, zero cases, and zero contacts behind.
  if not public.cancellation_is_manager() then
    raise exception 'cancellation_import_batch is reserved to Manager_Role'
      using errcode = 'insufficient_privilege',
            detail  = 'Requirement 8.5: no Cancellation_Case row and no Contact_Recipient row is created until a manager confirms the displayed preview.',
            hint    = 'Nothing was written.';
  end if;

  if v_actor is null then
    raise exception 'cancellation_import_batch could not identify the importing profile'
      using errcode = 'insufficient_privilege',
            detail  = 'cancellation_import_runs.imported_by is the confirming manager (Requirement 8.8).',
            hint    = 'Nothing was written.';
  end if;

  if p_file_name is null or length(btrim(p_file_name)) = 0 then
    raise exception 'cancellation_import_batch needs the imported file name'
      using errcode = 'invalid_parameter_value',
            detail  = 'Requirement 8.8 records the file name on the import audit entry.',
            hint    = 'Nothing was written.';
  end if;

  if p_column_set is null or p_column_set not in ('eficacia', 'avisos') then
    raise exception 'cancellation_import_batch needs a column set of eficacia or avisos (got %)',
                    coalesce(p_column_set, 'null')
      using errcode = 'invalid_parameter_value',
            detail  = 'Requirements 8.2, 8.3: the classified column set of the uploaded file.',
            hint    = 'Nothing was written.';
  end if;

  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' then
    raise exception 'cancellation_import_batch needs the confirmed mapping as a JSON object'
      using errcode = 'invalid_parameter_value',
            detail  = 'Requirement 8.4: the mapping the manager confirmed, stored verbatim.',
            hint    = 'Nothing was written.';
  end if;

  -- ── The payload. Both accepted p_rows shapes resolve to one row array and at most
  --    one counts object; anything else is refused rather than guessed at.
  if p_rows is null then
    raise exception 'cancellation_import_batch needs a row payload'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  elsif jsonb_typeof(p_rows) = 'array' then
    v_rows   := p_rows;
    v_counts := null;
  elsif jsonb_typeof(p_rows) = 'object' then
    v_rows   := coalesce(p_rows -> 'rows', p_rows -> 'plan');
    v_counts := coalesce(p_rows -> 'counts', p_rows - 'rows' - 'plan');
  else
    raise exception 'cancellation_import_batch needs p_rows as a JSON array or object (got %)',
                    jsonb_typeof(p_rows)
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  if v_rows is null or jsonb_typeof(v_rows) <> 'array' then
    raise exception 'cancellation_import_batch found no row array in p_rows'
      using errcode = 'invalid_parameter_value',
            detail  = 'Expected p_rows as an array, or as an object carrying "rows" (or "plan") as an array.',
            hint    = 'Nothing was written.';
  end if;

  if v_counts is not null and jsonb_typeof(v_counts) <> 'object' then
    v_counts := null;
  end if;

  -- ── raw_header is one value per file, so it comes from the confirmed mapping's own
  --    header rather than from every row (Requirement 24.1). A row may still carry its
  --    own raw_header, which wins for that row.
  if jsonb_typeof(p_mapping -> 'header') = 'array' then
    select array_agg(value order by ord)
      into v_header
      from jsonb_array_elements_text(p_mapping -> 'header') with ordinality as t(value, ord);
  end if;

  if v_header is null or cardinality(v_header) = 0 then
    raise exception 'cancellation_import_batch needs the source header in p_mapping.header'
      using errcode = 'invalid_parameter_value',
            detail  = 'cancellation_cases.raw_header is the source header in source column order (Requirement 24.1).',
            hint    = 'Nothing was written.';
  end if;

  -- ── The five counts of Requirement 8.5, as confirmed. The created/updated split is
  --    written again below from what the upsert actually did.
  v_rows_total     := coalesce((v_counts ->> 'rows_total')::integer, jsonb_array_length(v_rows));
  v_rows_rejected  := coalesce((v_counts ->> 'rows_rejected')::integer, 0);
  v_rows_duplicate := coalesce((v_counts ->> 'rows_duplicate')::integer, 0);
  v_split          := coalesce((v_counts ->> 'rows_created')::integer, 0)
                    + coalesce((v_counts ->> 'rows_updated')::integer, 0);

  if v_counts ? 'rows_created' and v_counts ? 'rows_updated'
     and v_split <> jsonb_array_length(v_rows) then
    raise exception 'cancellation_import_batch got a created/updated split of % for % rows',
                    v_split, jsonb_array_length(v_rows)
      using errcode = 'invalid_parameter_value',
            detail  = 'Requirements 9.2, 9.3: every row in the payload creates or updates exactly one Cancellation_Case.',
            hint    = 'Nothing was written.';
  end if;

  if v_rows_total <> jsonb_array_length(v_rows) + v_rows_rejected + v_rows_duplicate then
    raise exception 'cancellation_import_batch got rows_total % for % loading, % rejected, % duplicate rows',
                    v_rows_total, jsonb_array_length(v_rows), v_rows_rejected, v_rows_duplicate
      using errcode = 'invalid_parameter_value',
            detail  = 'The four outcome counts partition the data rows of the file (Requirement 8.5).',
            hint    = 'Nothing was written.';
  end if;

  -- ── The import audit entry (Requirement 8.8). Inserted first: every case row
  --    references it.
  insert into public.cancellation_import_runs (
    file_name, column_set, imported_by, confirmed_mapping,
    rows_total, rows_created, rows_updated, rows_rejected, rows_duplicate,
    rejected_rows, duplicate_rows, unmatched_producer_labels, unmatched_customer_rows,
    amount_due_absent_rows, invalid_contact_count, contact_overflow_count)
  values (
    p_file_name, p_column_set, v_actor, p_mapping,
    v_rows_total, 0, 0, v_rows_rejected, v_rows_duplicate,
    case when jsonb_typeof(v_counts -> 'rejected_rows') = 'array'
         then v_counts -> 'rejected_rows' else '[]'::jsonb end,
    case when jsonb_typeof(v_counts -> 'duplicate_rows') = 'array'
         then v_counts -> 'duplicate_rows' else '[]'::jsonb end,
    case when jsonb_typeof(v_counts -> 'unmatched_producer_labels') = 'array'
         then v_counts -> 'unmatched_producer_labels' else '[]'::jsonb end,
    case when jsonb_typeof(v_counts -> 'unmatched_customer_rows') = 'array'
         then v_counts -> 'unmatched_customer_rows' else '[]'::jsonb end,
    case when jsonb_typeof(v_counts -> 'amount_due_absent_rows') = 'array'
         then v_counts -> 'amount_due_absent_rows' else '[]'::jsonb end,
    coalesce((v_counts ->> 'invalid_contact_count')::integer, 0),
    coalesce((v_counts ->> 'contact_overflow_count')::integer, 0))
  returning * into v_run;

  -- ── One row element at a time, in payload order.
  for v_element in
    select t.value
      from jsonb_array_elements(v_rows) with ordinality as t(value, ord)
     order by t.ord
  loop
    if jsonb_typeof(v_element) <> 'object' then
      raise exception 'cancellation_import_batch got a % where a row object was expected',
                      jsonb_typeof(v_element)
        using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
    end if;

    -- PreviewedCaseRow keeps the case columns under `fields`; the loader flattens
    -- them. Accept both, with the flattened keys winning.
    v_fields := case when v_element ? 'fields'
                     then (v_element -> 'fields') || (v_element - 'fields' - 'contacts')
                     else v_element - 'contacts' end;

    -- CaseContactBuildResult holds the rows under `rows`; the loader sends the array.
    v_contacts := case
      when jsonb_typeof(v_element -> 'contacts') = 'array' then v_element -> 'contacts'
      when jsonb_typeof(v_element -> 'contacts' -> 'rows') = 'array' then v_element -> 'contacts' -> 'rows'
      else '[]'::jsonb
    end;

    v_row_number := coalesce(nullif(v_fields ->> 'source_row_number', '')::integer,
                             nullif(v_fields ->> 'row_number', '')::integer,
                             nullif(v_fields ->> 'rowNumber', '')::integer);
    v_assigned   := nullif(v_fields ->> 'assigned_to', '')::uuid;
    v_raw_row    := v_fields -> 'raw_row';

    if nullif(btrim(coalesce(v_fields ->> 'policy_number', '')), '') is null then
      raise exception 'cancellation_import_batch got row % with no policy number',
                      coalesce(v_row_number, 0)
        using errcode = 'invalid_parameter_value',
              detail  = 'Requirement 8.6 rejects such a row before confirmation; it must not reach the loader.',
              hint    = 'Nothing was written.';
    end if;

    if nullif(v_fields ->> 'cancellation_effective_date', '') is null then
      raise exception 'cancellation_import_batch got row % with no cancellation effective date',
                      coalesce(v_row_number, 0)
        using errcode = 'invalid_parameter_value',
              detail  = 'Requirement 9.1: the cancellation effective date is half of the case identity.',
              hint    = 'Nothing was written.';
    end if;

    if v_raw_row is null or jsonb_typeof(v_raw_row) <> 'array' then
      raise exception 'cancellation_import_batch got row % without raw_row as a JSON array',
                      coalesce(v_row_number, 0)
        using errcode = 'invalid_parameter_value',
              detail  = 'Requirement 24.1 stores the complete original row, field order preserved.',
              hint    = 'Nothing was written.';
    end if;

    if jsonb_typeof(v_fields -> 'raw_header') = 'array' then
      select array_agg(value order by ord)
        into v_row_header
        from jsonb_array_elements_text(v_fields -> 'raw_header') with ordinality as t(value, ord);
    else
      v_row_header := v_header;
    end if;

    insert into public.cancellation_cases (
      policy_number, cancellation_effective_date,
      customer_name, client_identifier, customer_match_key, carrier, amount_due,
      case_status, communication_status,
      assigned_to, assignment_source, producer_label,
      legacy_send_flag, legacy_state, legacy_result, legacy_notices_sent,
      legacy_first_notice, legacy_last_notice, legacy_days_remaining,
      legacy_notice_label, legacy_subject, legacy_email_body, legacy_sms_body,
      raw_row, raw_header, import_run_id, source_row_number)
    values (
      v_fields ->> 'policy_number',
      (v_fields ->> 'cancellation_effective_date')::date,
      v_fields ->> 'customer_name',
      v_fields ->> 'client_identifier',
      v_fields ->> 'customer_match_key',
      v_fields ->> 'carrier',
      nullif(v_fields ->> 'amount_due', '')::numeric,
      -- Requirement 15.10: a created case starts here and only here.
      'Imported',
      'Not Scheduled',
      v_assigned,
      case when v_assigned is not null then 'import' end,
      v_fields ->> 'producer_label',
      v_fields ->> 'legacy_send_flag',
      v_fields ->> 'legacy_state',
      v_fields ->> 'legacy_result',
      v_fields ->> 'legacy_notices_sent',
      v_fields ->> 'legacy_first_notice',
      v_fields ->> 'legacy_last_notice',
      v_fields ->> 'legacy_days_remaining',
      v_fields ->> 'legacy_notice_label',
      v_fields ->> 'legacy_subject',
      v_fields ->> 'legacy_email_body',
      v_fields ->> 'legacy_sms_body',
      v_raw_row,
      v_row_header,
      v_run.id,
      v_row_number)
    on conflict on constraint cancellation_cases_identity_key do update
       set customer_name      = excluded.customer_name,
           client_identifier  = excluded.client_identifier,
           customer_match_key = excluded.customer_match_key,
           carrier            = excluded.carrier,
           amount_due         = excluded.amount_due,
           producer_label     = excluded.producer_label,
           legacy_send_flag      = excluded.legacy_send_flag,
           legacy_state          = excluded.legacy_state,
           legacy_result         = excluded.legacy_result,
           legacy_notices_sent   = excluded.legacy_notices_sent,
           legacy_first_notice   = excluded.legacy_first_notice,
           legacy_last_notice    = excluded.legacy_last_notice,
           legacy_days_remaining = excluded.legacy_days_remaining,
           legacy_notice_label   = excluded.legacy_notice_label,
           legacy_subject        = excluded.legacy_subject,
           legacy_email_body     = excluded.legacy_email_body,
           legacy_sms_body       = excluded.legacy_sms_body,
           raw_row           = excluded.raw_row,
           raw_header        = excluded.raw_header,
           import_run_id     = excluded.import_run_id,
           source_row_number = excluded.source_row_number,
           -- Requirement 9.8: a Manager_Role assignment outranks the import, and an
           -- unresolved import assignment clears nothing.
           assigned_to = case
             when cancellation_cases.assignment_source = 'manager'
               then cancellation_cases.assigned_to
             else coalesce(excluded.assigned_to, cancellation_cases.assigned_to)
           end,
           assignment_source = case
             when cancellation_cases.assignment_source = 'manager' then 'manager'
             when excluded.assigned_to is not null then 'import'
             else cancellation_cases.assignment_source
           end,
           updated_at = now()
    returning id, (xmax::text = '0') into v_case_id, v_created;

    if v_created then
      v_rows_created := v_rows_created + 1;
    else
      v_rows_updated := v_rows_updated + 1;
    end if;

    -- ── Contact rows. `distinct on` keeps the earliest segment of a repeated value,
    --    which is the Requirement 10.6 winner, and `do nothing` keeps the row the case
    --    already holds, which is Requirement 9.8.
    if jsonb_typeof(v_contacts) = 'array' and jsonb_array_length(v_contacts) > 0 then
      with incoming as (
        select distinct on (c.channel, c.normalized_value)
               c.channel,
               c.normalized_value,
               c.raw_segment,
               c.validation_status,
               c.authorization_status,
               c.sms_suppressed,
               c.email_suppressed,
               c.is_primary,
               c.preferred_language,
               c.preferred_channel,
               c.contact_name,
               c.contact_role,
               c.segment_index
          from jsonb_to_recordset(v_contacts) as c(
                 channel              text,
                 normalized_value     text,
                 raw_segment          text,
                 validation_status    text,
                 authorization_status text,
                 sms_suppressed       boolean,
                 email_suppressed     boolean,
                 is_primary           boolean,
                 preferred_language   text,
                 preferred_channel    text,
                 contact_name         text,
                 contact_role         text,
                 segment_index        integer)
         order by c.channel, c.normalized_value, coalesce(c.segment_index, 0)
      ), stored as (
        insert into public.cancellation_contacts (
          case_id, channel, normalized_value, raw_segment, validation_status,
          authorization_status, sms_suppressed, email_suppressed, is_primary,
          preferred_language, preferred_channel, contact_name, contact_role, segment_index)
        select v_case_id,
               i.channel,
               i.normalized_value,
               coalesce(i.raw_segment, i.normalized_value),
               i.validation_status,
               coalesce(i.authorization_status, 'Unknown'),
               coalesce(i.sms_suppressed, false),
               coalesce(i.email_suppressed, false),
               coalesce(i.is_primary, false),
               i.preferred_language,
               i.preferred_channel,
               i.contact_name,
               i.contact_role,
               coalesce(i.segment_index, 0)
          from incoming i
        on conflict on constraint cancellation_contacts_dedup_key do nothing
        returning validation_status
      )
      select count(*), count(*) filter (where validation_status = 'invalid')
        into v_row_contacts, v_row_invalid
        from stored;
    else
      v_row_contacts := 0;
      v_row_invalid  := 0;
    end if;

    v_contacts_stored := v_contacts_stored + coalesce(v_row_contacts, 0);
    v_invalid_stored  := v_invalid_stored + coalesce(v_row_invalid, 0);

    -- ── The chronological audit timeline (Requirement 17.7). Append-only: v1.10.0's
    --    trigger refuses an update or a delete even on this security definer path.
    insert into public.cancellation_events (case_id, actor_id, event_type, detail)
    values (
      v_case_id,
      v_actor,
      case when v_created then 'imported' else 'import_updated' end,
      jsonb_build_object(
        'import_run_id',     v_run.id,
        'file_name',         p_file_name,
        'column_set',        p_column_set,
        'source_row_number', v_row_number,
        'outcome',           case when v_created then 'created' else 'updated' end,
        'contacts_created',  coalesce(v_row_contacts, 0),
        'producer_label',    v_fields ->> 'producer_label',
        'import_assignment', v_assigned));
  end loop;

  -- ── The created/updated split as it happened (Requirements 9.2, 9.3). Its total is
  --    the payload row count, so the Requirement 8.5 partition of rows_total holds.
  update public.cancellation_import_runs
     set rows_created = v_rows_created,
         rows_updated = v_rows_updated,
         invalid_contact_count = case
           when v_counts ? 'invalid_contact_count' then invalid_contact_count
           else v_invalid_stored
         end
   where id = v_run.id
  returning * into v_run;

  return v_run;
end;
$fn$;

comment on function public.cancellation_import_batch(text, text, jsonb, jsonb) is
  'The single write path of the Cancellation_Importer (Requirements 8.7, 8.8, 9.2, 9.3, 9.8, 15.10, 15.11, 24.1). Reserved to Manager_Role by public.cancellation_is_manager(); every other caller gets 42501 with nothing written (Requirement 8.5). One transaction: inserts the cancellation_import_runs audit entry, upserts every payload row on cancellation_cases_identity_key, inserts contact rows with the Requirement 10.6 dedup key as on-conflict-do-nothing, writes one cancellation_events row per case, then stores the created/updated split the upsert actually produced and returns the run row. p_rows is { counts: toImportRunCounts(preview), rows: [ ...preview.plan with fields flattened and contacts attached ] }; a bare array, flattened counts, `plan` for `rows`, and unflattened PreviewedCaseRow elements are all accepted. Validation, rejection, and in-file duplicate detection happen before this call, so a rejected row is simply absent from the payload and aborts nothing (Requirement 8.9). The update branch names neither case_status nor communication_status and overwrites only import-sourced values, so Requirements 9.8 and 15.11 hold; an assignment whose assignment_source is manager is never overwritten.';

grant execute on function public.cancellation_import_batch(text, text, jsonb, jsonb) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than
--    leaving stages 7-10 to apply on top of a half-built schema. Every probe write is
--    discarded: the probe block ends in a raise that rolls back to the block's
--    implicit savepoint, and plpgsql variables are not transactional, so the recorded
--    outcomes survive the rollback.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_sig_batch      text;
  v_sig_recompute  text;
  v_secdef         boolean;
  v_manager        uuid;
  v_other          uuid;
  v_ran            boolean := false;
  v_denied         boolean := false;
  v_denied_clean   boolean := false;
  v_runs_before    bigint;
  v_runs_after     bigint;
  v_run            public.cancellation_import_runs;
  v_run2           public.cancellation_import_runs;
  v_case           public.cancellation_cases;
  v_contact_rows   bigint;
  v_events         bigint;
  v_counts_ok      boolean := false;
  v_create_ok      boolean := false;
  v_contacts_ok    boolean := false;
  v_recompute_ok   boolean := false;
  v_escalated_ok   boolean := false;
  v_update_ok      boolean := false;
  v_preserve_ok    boolean := false;
  v_dedup_ok       boolean := false;
  v_events_ok      boolean := false;
  v_policy         text := 'V1105-PROBE-' || replace(gen_random_uuid()::text, '-', '');
  v_mapping        jsonb := jsonb_build_object(
                              'columnSet', 'eficacia',
                              'header', jsonb_build_array('Poliza', 'FechaCancelacion', 'Nombre'));
  v_payload        jsonb;
begin
  -- ── The two functions exist with the signatures the loader and the scheduler call.
  --    oidvectortypes, not pg_get_function_identity_arguments: the latter prefixes each
  --    type with its parameter name, which is not what a caller has to match.
  select oidvectortypes(p.proargtypes), p.prosecdef
    into v_sig_batch, v_secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cancellation_import_batch';

  if v_sig_batch is distinct from 'text, text, jsonb, jsonb' then
    raise exception 'v1.10.5 created cancellation_import_batch with signature (%), expected (text, text, jsonb, jsonb)',
                    coalesce(v_sig_batch, 'missing')
      using hint = 'Rolling back.';
  end if;
  if not coalesce(v_secdef, false) then
    raise exception 'v1.10.5 created cancellation_import_batch without security definer'
      using detail = 'The loader writes on behalf of a manager whose session cannot reach the tables directly.',
            hint = 'Rolling back.';
  end if;

  select oidvectortypes(p.proargtypes), p.prosecdef
    into v_sig_recompute, v_secdef
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cancellation_recompute_communication_status';

  if v_sig_recompute is distinct from 'uuid, integer' then
    raise exception 'v1.10.5 created cancellation_recompute_communication_status with signature (%), expected (uuid, integer)',
                    coalesce(v_sig_recompute, 'missing')
      using detail = 'p_pending_sends defaults to 0, so the one-argument call of task 7.6 resolves to this function.',
            hint = 'Rolling back.';
  end if;
  if not coalesce(v_secdef, false) then
    raise exception 'v1.10.5 created cancellation_recompute_communication_status without security definer'
      using hint = 'Rolling back.';
  end if;

  select id into v_manager
    from public.profiles
   where role in ('manager', 'super_admin')
   order by is_active desc nulls last, created_at
   limit 1;

  select id into v_other
    from public.profiles
   where id is distinct from v_manager
   order by created_at
   limit 1;

  -- ── Live probe. Everything written below is rolled back by the terminal raise.
  begin
    select count(*) into v_runs_before
      from public.cancellation_import_runs where file_name like 'v1.10.5 probe%';

    -- A session holding no Manager_Role is refused, and writes nothing (Req 8.5).
    perform set_config('request.jwt.claims',
                       json_build_object('role', 'authenticated',
                                         'sub', gen_random_uuid()::text)::text, true);
    begin
      perform public.cancellation_import_batch('v1.10.5 probe denied', 'eficacia', v_mapping,
                                               '[]'::jsonb);
    exception when insufficient_privilege then
      v_denied := true;
    end;

    select count(*) into v_runs_after
      from public.cancellation_import_runs where file_name like 'v1.10.5 probe%';
    v_denied_clean := v_runs_after = v_runs_before;

    if v_manager is not null then
      v_ran := true;
      perform set_config('request.jwt.claims',
                         json_build_object('role', 'authenticated',
                                           'sub', v_manager::text)::text, true);

      -- ── Batch one: one loading row out of three data rows, one rejected and one
      --    in-file duplicate already excluded by the preview.
      v_payload := jsonb_build_object(
        'counts', jsonb_build_object(
          'rows_total', 3, 'rows_created', 1, 'rows_updated', 0,
          'rows_rejected', 1, 'rows_duplicate', 1,
          'rejected_rows', jsonb_build_array(
            jsonb_build_object('row_number', 2, 'reason', 'policy number is empty')),
          'duplicate_rows', jsonb_build_array(
            jsonb_build_object('row_number', 3, 'duplicate_of_row_number', 1)),
          'unmatched_producer_labels', '[]'::jsonb,
          'unmatched_customer_rows', '[]'::jsonb,
          'amount_due_absent_rows', '[]'::jsonb,
          'invalid_contact_count', 1,
          'contact_overflow_count', 0),
        'rows', jsonb_build_array(jsonb_build_object(
          'row_number', 1,
          'policy_number', v_policy,
          'cancellation_effective_date', '2099-12-31',
          'customer_name', 'PROBE CREATE',
          'client_identifier', '00123',
          'customer_match_key', '00123',
          'carrier', 'Probe Carrier',
          'amount_due', '123.45',
          'producer_label', 'PROBE PRODUCER',
          'legacy_state', 'Activa',
          'raw_row', jsonb_build_array(v_policy, '2099-12-31', 'PROBE CREATE'),
          'contacts', jsonb_build_array(
            jsonb_build_object('channel', 'phone', 'normalized_value', '+13055550100',
                               'raw_segment', ' 305-555-0100 ', 'validation_status', 'valid',
                               'is_primary', true, 'segment_index', 0),
            jsonb_build_object('channel', 'email', 'normalized_value', 'probe@example.com',
                               'raw_segment', 'Probe@Example.com', 'validation_status', 'invalid',
                               'segment_index', 0)))));

      select * into v_run
        from public.cancellation_import_batch('v1.10.5 probe create', 'eficacia',
                                              v_mapping, v_payload);

      v_counts_ok := v_run.rows_total = 3
        and v_run.rows_created = 1 and v_run.rows_updated = 0
        and v_run.rows_rejected = 1 and v_run.rows_duplicate = 1
        and v_run.imported_by = v_manager
        and v_run.column_set = 'eficacia'
        and v_run.invalid_contact_count = 1
        and jsonb_array_length(v_run.rejected_rows) = 1
        and jsonb_array_length(v_run.duplicate_rows) = 1;

      select * into v_case
        from public.cancellation_cases where policy_number = v_policy;

      v_create_ok := found
        and v_case.case_status = 'Imported'
        and v_case.communication_status = 'Not Scheduled'
        and v_case.customer_name = 'PROBE CREATE'
        and v_case.amount_due = 123.45
        and v_case.customer_match_key = '00123'
        and v_case.legacy_state = 'Activa'
        and v_case.import_run_id = v_run.id
        and v_case.source_row_number = 1
        and v_case.raw_header = array['Poliza', 'FechaCancelacion', 'Nombre']
        and jsonb_array_length(v_case.raw_row) = 3
        and v_case.policy_number_normalized = upper(v_policy);

      select count(*) into v_contact_rows
        from public.cancellation_contacts where case_id = v_case.id;
      v_contacts_ok := v_contact_rows = 2;

      -- ── The recompute: no Communication_Record and no pending send is Not Scheduled
      --    (Requirement 15.9 last branch), and an uncleared escalation outranks it
      --    (Requirement 20.11, first branch).
      v_recompute_ok := public.cancellation_recompute_communication_status(v_case.id) = 'Not Scheduled';

      insert into public.cancellation_escalations (case_id, reason)
      values (v_case.id, 'No Valid Contact');
      v_escalated_ok := public.cancellation_recompute_communication_status(v_case.id)
                          = 'Manual Follow-up Required';
      update public.cancellation_escalations
         set cleared_at = now() where case_id = v_case.id;
      v_escalated_ok := v_escalated_ok
        and public.cancellation_recompute_communication_status(v_case.id) = 'Not Scheduled';

      -- ── Work the case the way a user would, then reimport the same identity.
      update public.cancellation_cases
         set case_status          = 'Open',
             communication_status = 'Delivered',
             assigned_to          = v_manager,
             assignment_source    = 'manager',
             next_required_action = 'Call Customer'
       where id = v_case.id;

      update public.cancellation_contacts
         set authorization_status = 'Authorized',
             preferred_language   = 'Spanish',
             sms_suppressed       = true
       where case_id = v_case.id and channel = 'phone';

      -- Same identity through a different spelling: lower case plus trailing spaces
      -- normalize to the stored policy_number_normalized.
      v_payload := jsonb_build_object(
        'counts', jsonb_build_object(
          'rows_total', 1, 'rows_created', 0, 'rows_updated', 1,
          'rows_rejected', 0, 'rows_duplicate', 0),
        'rows', jsonb_build_array(jsonb_build_object(
          'row_number', 7,
          'policy_number', lower(v_policy) || '  ',
          'cancellation_effective_date', '2099-12-31',
          'customer_name', 'PROBE UPDATE',
          'client_identifier', '00123',
          'customer_match_key', '00123',
          'carrier', 'Probe Carrier Two',
          'amount_due', '200.00',
          'producer_label', 'PROBE PRODUCER',
          'assigned_to', v_other,
          'raw_row', jsonb_build_array(lower(v_policy), '2099-12-31', 'PROBE UPDATE'),
          'contacts', jsonb_build_array(
            jsonb_build_object('channel', 'phone', 'normalized_value', '+13055550100',
                               'raw_segment', '305-555-0100', 'validation_status', 'valid',
                               'authorization_status', 'Unknown', 'sms_suppressed', false,
                               'segment_index', 0),
            jsonb_build_object('channel', 'phone', 'normalized_value', '+13055550199',
                               'raw_segment', '305-555-0199', 'validation_status', 'valid',
                               'segment_index', 1)))));

      select * into v_run2
        from public.cancellation_import_batch('v1.10.5 probe update', 'eficacia',
                                              v_mapping, v_payload);

      select * into v_case
        from public.cancellation_cases where policy_number = v_policy;

      v_update_ok := v_run2.rows_created = 0 and v_run2.rows_updated = 1
        and v_run2.rows_total = 1
        and v_case.customer_name = 'PROBE UPDATE'
        and v_case.carrier = 'Probe Carrier Two'
        and v_case.amount_due = 200.00
        and v_case.source_row_number = 7
        and v_case.import_run_id = v_run2.id
        and v_case.policy_number = v_policy;

      v_preserve_ok := v_case.case_status = 'Open'
        and v_case.communication_status = 'Delivered'
        and v_case.assigned_to = v_manager
        and v_case.assignment_source = 'manager'
        and v_case.next_required_action = 'Call Customer';

      select count(*) into v_contact_rows
        from public.cancellation_contacts where case_id = v_case.id;
      v_dedup_ok := v_contact_rows = 3
        and exists (select 1 from public.cancellation_contacts
                     where case_id = v_case.id
                       and channel = 'phone'
                       and normalized_value = '+13055550100'
                       and authorization_status = 'Authorized'
                       and preferred_language = 'Spanish'
                       and sms_suppressed);

      select count(*) into v_events
        from public.cancellation_events where case_id = v_case.id;
      v_events_ok := v_events = 2
        and exists (select 1 from public.cancellation_events
                     where case_id = v_case.id and event_type = 'imported')
        and exists (select 1 from public.cancellation_events
                     where case_id = v_case.id and event_type = 'import_updated');
    end if;

    raise exception 'v1105_probe_done' using errcode = 'RS005';
  exception when sqlstate 'RS005' then
    null;  -- probe rows discarded; outcomes retained in the variables below
  end;

  perform set_config('request.jwt.claims', '', true);

  if not v_denied then
    raise exception 'v1.10.5 cancellation_import_batch admitted a caller holding no Manager_Role'
      using detail = 'Requirement 8.5 reserves confirming an import to Manager_Role.',
            hint = 'Rolling back.';
  end if;
  if not v_denied_clean then
    raise exception 'v1.10.5 cancellation_import_batch wrote an import run for a refused caller'
      using detail = 'Requirement 8.5: zero rows are written until a manager confirms.',
            hint = 'Rolling back.';
  end if;

  if v_ran then
    if not v_counts_ok then
      raise exception 'v1.10.5 import run row did not carry the confirmed counts (total %, created %, updated %, rejected %, duplicate %, invalid contacts %)',
                      v_run.rows_total, v_run.rows_created, v_run.rows_updated,
                      v_run.rows_rejected, v_run.rows_duplicate, v_run.invalid_contact_count
        using detail = 'Requirement 8.8 records the five counts of Requirement 8.5 plus the rejected list.',
              hint = 'Rolling back.';
    end if;
    if not v_create_ok then
      raise exception 'v1.10.5 create path did not load the row as specified'
        using detail = 'Requirements 15.10 (Imported / Not Scheduled), 24.1 (raw_row, raw_header), 9.5 (customer matching key).',
              hint = 'Rolling back.';
    end if;
    if not v_contacts_ok then
      raise exception 'v1.10.5 create path stored % contact rows for a two-segment row', v_contact_rows
        using detail = 'Requirement 10.1: one row per phone value and one per email value.',
              hint = 'Rolling back.';
    end if;
    if not v_recompute_ok then
      raise exception 'v1.10.5 recompute did not return Not Scheduled for a case with no record and no pending send'
        using detail = 'Requirement 15.9, last branch.', hint = 'Rolling back.';
    end if;
    if not v_escalated_ok then
      raise exception 'v1.10.5 recompute did not honor the uncleared escalation override'
        using detail = 'Requirements 15.9, 20.11: Manual Follow-up Required outranks every derived value until the escalation is cleared.',
              hint = 'Rolling back.';
    end if;
    if not v_update_ok then
      raise exception 'v1.10.5 update path did not overwrite the import-sourced values of the matched case'
        using detail = 'Requirement 9.2: customer name, carrier, amount due, client identifier, producer label, legacy values, raw row.',
              hint = 'Rolling back.';
    end if;
    if not v_preserve_ok then
      raise exception 'v1.10.5 update path did not preserve worked state (status %, communication %, assignment % from %)',
                      v_case.case_status, v_case.communication_status,
                      coalesce(v_case.assigned_to::text, 'null'),
                      coalesce(v_case.assignment_source, 'null')
        using detail = 'Requirements 9.8, 15.11: Case_Status, Communication_Status, and a Manager_Role assignment survive a reimport.',
              hint = 'Rolling back.';
    end if;
    if not v_dedup_ok then
      raise exception 'v1.10.5 update path did not honor the contact dedup key or overwrote a stored contact (% rows)',
                      v_contact_rows
        using detail = 'Requirements 10.6, 9.8: a repeated value adds no row and keeps its stored language, suppression, and authorization.',
              hint = 'Rolling back.';
    end if;
    if not v_events_ok then
      raise exception 'v1.10.5 wrote % audit events for a create followed by an update', v_events
        using detail = 'Requirement 17.7: the chronological timeline records both loads.',
              hint = 'Rolling back.';
    end if;
  end if;

  -- ── No probe residue is committed, in the tables this file writes or in the
  --    v1.10.0/v1.10.3 tables the fixtures borrowed.
  if exists (select 1 from public.cancellation_import_runs where file_name like 'v1.10.5 probe%')
     or exists (select 1 from public.cancellation_cases where policy_number like 'V1105-PROBE-%')
     or exists (select 1 from public.cancellation_contacts
                 where normalized_value in ('+13055550100', '+13055550199', 'probe@example.com')) then
    raise exception 'v1.10.5 left probe residue behind' using hint = 'Rolling back.';
  end if;

  if nullif(current_setting('request.jwt.claims', true), '') is not null then
    raise exception 'v1.10.5 left a probe session setting behind (claims %)',
                    coalesce(current_setting('request.jwt.claims', true), '(unset)')
      using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cancellation_import_batch',
                         'cancellation_recompute_communication_status')) as functions_expect_2,
  (select oidvectortypes(p.proargtypes) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cancellation_import_batch')
    as batch_signature_expect_text_text_jsonb_jsonb,
  (select oidvectortypes(p.proargtypes) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'cancellation_recompute_communication_status')
    as recompute_signature_expect_uuid_integer,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cancellation_import_batch',
                         'cancellation_recompute_communication_status')
       and p.prosecdef
       and p.proconfig @> array['search_path=public']) as secdef_with_search_path_expect_2,
  (select has_function_privilege('authenticated',
            'public.cancellation_import_batch(text, text, jsonb, jsonb)', 'execute'))
    as authenticated_may_call_loader_expect_true,
  (select has_function_privilege('service_role',
            'public.cancellation_recompute_communication_status(uuid, integer)', 'execute'))
    as service_role_may_recompute_expect_true,
  (select count(*) from public.cancellation_import_runs
     where file_name like 'v1.10.5 probe%') as probe_import_runs_expect_0,
  (select count(*) from public.cancellation_cases
     where policy_number like 'V1105-PROBE-%') as probe_cases_expect_0,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename like 'cancellation%') as policies_expected_zero_until_v1_10_6;
