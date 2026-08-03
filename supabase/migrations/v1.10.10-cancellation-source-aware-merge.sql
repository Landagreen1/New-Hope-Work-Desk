-- New Hope Work Desk v1.10.10 — Cancellation operational hardening (forward-only)
--
-- Spec: .kiro/specs/cancellations-operational-hardening
-- Requirements: REQ-1.1, REQ-1.3, REQ-1.4, REQ-2.2, REQ-3.1, REQ-6.4, REQ-8.1
--
-- Forward-only, tenth file of the v1.10.x series. Does not modify historical
-- migrations. Does not alter any pre-v1.10.x table or function.
--
-- Contents:
--   1. Add 'Import Review Required' to cancellation_cases.case_status CHECK
--   2. Add 'follow_up' to cancellation_events.event_type CHECK
--   3. Create cancellation_import_case_rows table
--   4. Create cancellation_scheduler_runs table
--   5. Create cancellation_test_sends table
--   6. Default automatic_sending_enabled to false
--   7. Replace cancellation_import_batch with source-aware merge logic
--   8. RLS policies for new tables
--
-- ROLLBACK:
--   drop table if exists public.cancellation_test_sends;
--   drop table if exists public.cancellation_scheduler_runs;
--   drop table if exists public.cancellation_import_case_rows;
--   -- Restore original CHECK constraints and function from v1.10.5

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. Add 'Import Review Required' to case_status CHECK constraint
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_cases drop constraint if exists cancellation_cases_case_status_check;
alter table public.cancellation_cases add constraint cancellation_cases_case_status_check
  check (case_status in (
    'Imported', 'Open', 'Payment Reported', 'Verification Pending',
    'Reinstatement Pending', 'Reinstated', 'Cancelled', 'Resolved',
    'Invalid', 'Duplicate', 'Import Review Required'));

-- Also extend assignment_source to allow 'claim' (REQ-7.3)
alter table public.cancellation_cases drop constraint if exists cancellation_cases_assignment_source_check;
alter table public.cancellation_cases add constraint cancellation_cases_assignment_source_check
  check (assignment_source in ('import', 'manager', 'claim'));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. Add 'follow_up' to event_type CHECK constraint
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_events drop constraint if exists cancellation_events_event_type_check;
alter table public.cancellation_events add constraint cancellation_events_event_type_check
  check (event_type in (
    'imported', 'import_updated', 'status_change', 'assignment',
    'communication_sent', 'communication_failed', 'communication_retry',
    'suppression_set', 'suppression_cleared', 'escalation_raised',
    'escalation_cleared', 'payment_reported', 'verification',
    'note_added', 'correction', 'send_blocked', 'follow_up'));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. Create cancellation_import_case_rows — preserves every raw row per import
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.cancellation_import_case_rows (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cancellation_cases(id) on delete cascade,
  import_run_id uuid not null references public.cancellation_import_runs(id) on delete cascade,
  source_row_number integer not null,
  raw_row jsonb not null check (jsonb_typeof(raw_row) = 'array'),
  raw_header text[] not null,
  column_set text not null check (column_set in ('eficacia', 'avisos')),
  created_at timestamptz not null default now()
);

create index if not exists idx_cancellation_import_case_rows_case
  on public.cancellation_import_case_rows(case_id);
create index if not exists idx_cancellation_import_case_rows_run
  on public.cancellation_import_case_rows(import_run_id);

comment on table public.cancellation_import_case_rows is
  'Preserves every imported raw row per case per import run (REQ-1.4). Unlike cancellation_cases.raw_row which holds only the most recent, this table retains the full audit trail across eficacia and avisos imports.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. Create cancellation_scheduler_runs — logs every scheduler invocation
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.cancellation_scheduler_runs (
  id uuid primary key default gen_random_uuid(),
  business_date date not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  automatic_sending_enabled boolean not null default false,
  cases_evaluated integer not null default 0,
  sent integer not null default 0,
  skipped integer not null default 0,
  failed integer not null default 0,
  summary jsonb,
  actor_kind text check (actor_kind in ('cron', 'session')),
  actor_profile_id uuid references public.profiles(id)
);

create index if not exists idx_cancellation_scheduler_runs_date
  on public.cancellation_scheduler_runs(business_date desc);

comment on table public.cancellation_scheduler_runs is
  'Audit log of every Notification_Scheduler invocation (REQ-3.2, REQ-8.1). The readiness panel reads the most recent row to display last-run information.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. Create cancellation_test_sends — test-send audit (never customer-facing)
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.cancellation_test_sends (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cancellation_cases(id),
  touchpoint integer not null check (touchpoint in (15, 10, 5, 1)),
  channel text not null check (channel in ('sms', 'email')),
  recipient text not null,
  rendered_subject text,
  rendered_body text not null,
  sent_at timestamptz not null default now(),
  actor_id uuid not null references public.profiles(id),
  delivery_result text check (delivery_result in ('Sent', 'Delivered', 'Failed')),
  provider_message_id text,
  failure_reason text
);

create index if not exists idx_cancellation_test_sends_actor
  on public.cancellation_test_sends(actor_id, sent_at desc);

comment on table public.cancellation_test_sends is
  'Records test-send attempts (REQ-3.4). These never target customer contacts and never create cancellation_communications rows. Managers verify template rendering and provider connectivity here.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. Default automatic_sending_enabled to false for new installations
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_settings
  alter column automatic_sending_enabled set default false;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. Replace cancellation_import_batch with source-aware merge logic
--
--    The ON CONFLICT DO UPDATE branch now uses COALESCE to prevent null values from
--    one source overwriting populated values from the other source. Field ownership
--    is determined by p_column_set:
--      - eficacia owns: customer_name, carrier, amount_due, client_identifier,
--        producer_label, legacy_send_flag through legacy_last_notice
--      - avisos owns: legacy_notice_label through legacy_sms_body, contacts
--      - avisos may update customer_name/carrier only when non-empty
--    Additionally inserts into cancellation_import_case_rows for audit trail,
--    and respects case_status from the payload for eficacia imports.
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
  v_case_status      text;
begin
  -- ── Caller authorization (Requirement 8.5)
  if not public.cancellation_is_manager() then
    raise exception 'cancellation_import_batch is reserved to Manager_Role'
      using errcode = 'insufficient_privilege',
            detail  = 'Requirement 8.5: no Cancellation_Case row and no Contact_Recipient row is created until a manager confirms the displayed preview.',
            hint    = 'Nothing was written.';
  end if;

  if v_actor is null then
    raise exception 'cancellation_import_batch could not identify the importing profile'
      using errcode = 'insufficient_privilege', hint = 'Nothing was written.';
  end if;

  if p_file_name is null or length(btrim(p_file_name)) = 0 then
    raise exception 'cancellation_import_batch needs the imported file name'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  if p_column_set is null or p_column_set not in ('eficacia', 'avisos') then
    raise exception 'cancellation_import_batch needs a column set of eficacia or avisos (got %)',
                    coalesce(p_column_set, 'null')
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' then
    raise exception 'cancellation_import_batch needs the confirmed mapping as a JSON object'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  -- ── Payload resolution (same as v1.10.5)
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
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  if v_counts is not null and jsonb_typeof(v_counts) <> 'object' then
    v_counts := null;
  end if;

  -- ── raw_header from confirmed mapping
  if jsonb_typeof(p_mapping -> 'header') = 'array' then
    select array_agg(value order by ord)
      into v_header
      from jsonb_array_elements_text(p_mapping -> 'header') with ordinality as t(value, ord);
  end if;

  if v_header is null or cardinality(v_header) = 0 then
    raise exception 'cancellation_import_batch needs the source header in p_mapping.header'
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  -- ── Count validation
  v_rows_total     := coalesce((v_counts ->> 'rows_total')::integer, jsonb_array_length(v_rows));
  v_rows_rejected  := coalesce((v_counts ->> 'rows_rejected')::integer, 0);
  v_rows_duplicate := coalesce((v_counts ->> 'rows_duplicate')::integer, 0);
  v_split          := coalesce((v_counts ->> 'rows_created')::integer, 0)
                    + coalesce((v_counts ->> 'rows_updated')::integer, 0);

  if v_counts ? 'rows_created' and v_counts ? 'rows_updated'
     and v_split <> jsonb_array_length(v_rows) then
    raise exception 'cancellation_import_batch got a created/updated split of % for % rows',
                    v_split, jsonb_array_length(v_rows)
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  if v_rows_total <> jsonb_array_length(v_rows) + v_rows_rejected + v_rows_duplicate then
    raise exception 'cancellation_import_batch got rows_total % for % loading, % rejected, % duplicate rows',
                    v_rows_total, jsonb_array_length(v_rows), v_rows_rejected, v_rows_duplicate
      using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
  end if;

  -- ── Import audit entry (Requirement 8.8)
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

  -- ── Process each row
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

    v_fields := case when v_element ? 'fields'
                     then (v_element -> 'fields') || (v_element - 'fields' - 'contacts')
                     else v_element - 'contacts' end;

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
    v_case_status := nullif(btrim(coalesce(v_fields ->> 'case_status', '')), '');

    if nullif(btrim(coalesce(v_fields ->> 'policy_number', '')), '') is null then
      raise exception 'cancellation_import_batch got row % with no policy number',
                      coalesce(v_row_number, 0)
        using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
    end if;

    if nullif(v_fields ->> 'cancellation_effective_date', '') is null then
      raise exception 'cancellation_import_batch got row % with no cancellation effective date',
                      coalesce(v_row_number, 0)
        using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
    end if;

    if v_raw_row is null or jsonb_typeof(v_raw_row) <> 'array' then
      raise exception 'cancellation_import_batch got row % without raw_row as a JSON array',
                      coalesce(v_row_number, 0)
        using errcode = 'invalid_parameter_value', hint = 'Nothing was written.';
    end if;

    if jsonb_typeof(v_fields -> 'raw_header') = 'array' then
      select array_agg(value order by ord)
        into v_row_header
        from jsonb_array_elements_text(v_fields -> 'raw_header') with ordinality as t(value, ord);
    else
      v_row_header := v_header;
    end if;

    -- ── Upsert with SOURCE-AWARE MERGE (REQ-1.1, REQ-1.2, REQ-1.3)
    -- The ON CONFLICT DO UPDATE branch uses COALESCE to never overwrite populated
    -- values with null from the other source. Field ownership is determined by
    -- p_column_set parameter.
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
      -- REQ-2.1: use derived status for creates, default to Imported if absent
      coalesce(v_case_status, 'Imported'),
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
    on conflict on constraint cancellation_cases_identity_key do update set
       -- EFICACIA-owned fields: written by eficacia, preserved by avisos
       -- Avisos may update customer_name/carrier only when non-empty (REQ-1.2)
       customer_name = case
         when p_column_set = 'eficacia' then coalesce(excluded.customer_name, cancellation_cases.customer_name)
         else coalesce(nullif(btrim(excluded.customer_name), ''), cancellation_cases.customer_name)
       end,
       carrier = case
         when p_column_set = 'eficacia' then coalesce(excluded.carrier, cancellation_cases.carrier)
         else coalesce(nullif(btrim(excluded.carrier), ''), cancellation_cases.carrier)
       end,
       -- These are eficacia-only; avisos never carries them
       client_identifier = case
         when p_column_set = 'eficacia' then coalesce(excluded.client_identifier, cancellation_cases.client_identifier)
         else cancellation_cases.client_identifier
       end,
       customer_match_key = case
         when p_column_set = 'eficacia' then coalesce(excluded.customer_match_key, cancellation_cases.customer_match_key)
         else cancellation_cases.customer_match_key
       end,
       amount_due = case
         when p_column_set = 'eficacia' then coalesce(excluded.amount_due, cancellation_cases.amount_due)
         else cancellation_cases.amount_due
       end,
       producer_label = case
         when p_column_set = 'eficacia' then coalesce(excluded.producer_label, cancellation_cases.producer_label)
         else cancellation_cases.producer_label
       end,
       -- Eficacia legacy fields
       legacy_send_flag = case
         when p_column_set = 'eficacia' then coalesce(excluded.legacy_send_flag, cancellation_cases.legacy_send_flag)
         else cancellation_cases.legacy_send_flag
       end,
       legacy_state = case
         when p_column_set = 'eficacia' then coalesce(excluded.legacy_state, cancellation_cases.legacy_state)
         else cancellation_cases.legacy_state
       end,
       legacy_result = case
         when p_column_set = 'eficacia' then coalesce(excluded.legacy_result, cancellation_cases.legacy_result)
         else cancellation_cases.legacy_result
       end,
       legacy_notices_sent = case
         when p_column_set = 'eficacia' then coalesce(excluded.legacy_notices_sent, cancellation_cases.legacy_notices_sent)
         else cancellation_cases.legacy_notices_sent
       end,
       legacy_first_notice = case
         when p_column_set = 'eficacia' then coalesce(excluded.legacy_first_notice, cancellation_cases.legacy_first_notice)
         else cancellation_cases.legacy_first_notice
       end,
       legacy_last_notice = case
         when p_column_set = 'eficacia' then coalesce(excluded.legacy_last_notice, cancellation_cases.legacy_last_notice)
         else cancellation_cases.legacy_last_notice
       end,
       -- AVISOS-owned legacy fields: written by avisos, preserved by eficacia
       legacy_days_remaining = case
         when p_column_set = 'avisos' then coalesce(excluded.legacy_days_remaining, cancellation_cases.legacy_days_remaining)
         else cancellation_cases.legacy_days_remaining
       end,
       legacy_notice_label = case
         when p_column_set = 'avisos' then coalesce(excluded.legacy_notice_label, cancellation_cases.legacy_notice_label)
         else cancellation_cases.legacy_notice_label
       end,
       legacy_subject = case
         when p_column_set = 'avisos' then coalesce(excluded.legacy_subject, cancellation_cases.legacy_subject)
         else cancellation_cases.legacy_subject
       end,
       legacy_email_body = case
         when p_column_set = 'avisos' then coalesce(excluded.legacy_email_body, cancellation_cases.legacy_email_body)
         else cancellation_cases.legacy_email_body
       end,
       legacy_sms_body = case
         when p_column_set = 'avisos' then coalesce(excluded.legacy_sms_body, cancellation_cases.legacy_sms_body)
         else cancellation_cases.legacy_sms_body
       end,
       -- case_status: only update if eficacia provides a non-null derived status
       -- and the current status is still 'Imported' (never downgrade manager changes)
       case_status = case
         when p_column_set = 'eficacia' and v_case_status is not null
              and cancellation_cases.case_status = 'Imported'
           then v_case_status
         else cancellation_cases.case_status
       end,
       -- Raw row and provenance: always update to latest
       raw_row           = excluded.raw_row,
       raw_header        = excluded.raw_header,
       import_run_id     = excluded.import_run_id,
       source_row_number = excluded.source_row_number,
       -- Assignment: manager outranks, unresolved clears nothing (Req 9.8)
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

    -- ── Preserve raw row in audit table (REQ-1.4)
    insert into public.cancellation_import_case_rows (
      case_id, import_run_id, source_row_number, raw_row, raw_header, column_set)
    values (
      v_case_id, v_run.id, coalesce(v_row_number, 0), v_raw_row, v_row_header, p_column_set);

    -- ── Contact rows (same dedup logic as v1.10.5)
    if jsonb_typeof(v_contacts) = 'array' and jsonb_array_length(v_contacts) > 0 then
      with incoming as (
        select distinct on (c.channel, c.normalized_value)
               c.channel, c.normalized_value, c.raw_segment, c.validation_status,
               c.authorization_status, c.sms_suppressed, c.email_suppressed,
               c.is_primary, c.preferred_language, c.preferred_channel,
               c.contact_name, c.contact_role, c.segment_index
          from jsonb_to_recordset(v_contacts) as c(
                 channel text, normalized_value text, raw_segment text,
                 validation_status text, authorization_status text,
                 sms_suppressed boolean, email_suppressed boolean,
                 is_primary boolean, preferred_language text, preferred_channel text,
                 contact_name text, contact_role text, segment_index integer)
         order by c.channel, c.normalized_value, coalesce(c.segment_index, 0)
      ), stored as (
        insert into public.cancellation_contacts (
          case_id, channel, normalized_value, raw_segment, validation_status,
          authorization_status, sms_suppressed, email_suppressed, is_primary,
          preferred_language, preferred_channel, contact_name, contact_role, segment_index)
        select v_case_id, i.channel, i.normalized_value,
               coalesce(i.raw_segment, i.normalized_value), i.validation_status,
               coalesce(i.authorization_status, 'Unknown'),
               coalesce(i.sms_suppressed, false), coalesce(i.email_suppressed, false),
               coalesce(i.is_primary, false), i.preferred_language, i.preferred_channel,
               i.contact_name, i.contact_role, coalesce(i.segment_index, 0)
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

    -- ── Audit timeline event
    insert into public.cancellation_events (case_id, actor_id, event_type, detail)
    values (
      v_case_id, v_actor,
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

  -- ── Final counts
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
  'Source-aware import batch loader (v1.10.10). Replaces v1.10.5 version with COALESCE-based merge: eficacia-owned fields are preserved when avisos imports, and vice versa. Additionally stores every raw row in cancellation_import_case_rows for full audit trail, and supports a case_status field in the payload for status-mapped imports.';

grant execute on function public.cancellation_import_batch(text, text, jsonb, jsonb) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. RLS policies for new tables
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.cancellation_import_case_rows enable row level security;
alter table public.cancellation_scheduler_runs enable row level security;
alter table public.cancellation_test_sends enable row level security;

-- import_case_rows: managers can read all
create policy cancellation_import_case_rows_manager_read
  on public.cancellation_import_case_rows for select
  using (public.cancellation_is_manager());

-- scheduler_runs: managers can read and insert
create policy cancellation_scheduler_runs_manager_read
  on public.cancellation_scheduler_runs for select
  using (public.cancellation_is_manager());

create policy cancellation_scheduler_runs_service_all
  on public.cancellation_scheduler_runs for all
  using (true)
  with check (true);

-- test_sends: managers can read and insert
create policy cancellation_test_sends_manager_read
  on public.cancellation_test_sends for select
  using (public.cancellation_is_manager());

create policy cancellation_test_sends_manager_insert
  on public.cancellation_test_sends for insert
  with check (public.cancellation_is_manager());

-- Grant service_role full access to new tables
grant all on public.cancellation_import_case_rows to service_role;
grant all on public.cancellation_scheduler_runs to service_role;
grant all on public.cancellation_test_sends to service_role;

-- Grant authenticated basic access
grant select on public.cancellation_import_case_rows to authenticated;
grant select, insert on public.cancellation_scheduler_runs to authenticated;
grant select, insert on public.cancellation_test_sends to authenticated;

commit;
