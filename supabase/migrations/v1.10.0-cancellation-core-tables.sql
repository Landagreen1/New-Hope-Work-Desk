-- New Hope Work Desk v1.10.0 — Cancellations core tables (migration stage 1 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.1)
-- Requirements: 9.1, 10.6, 10.9, 22.8, 22.9, 24.1, 26.1, 26.2
--
-- Forward-only, first file of the v1.10.x series. Creates five new tables, one
-- trigger function, one trigger, and two role helper functions. Touches no table,
-- column, policy, function, or row created at v1.9.7 or earlier: nothing outside the
-- new cancellation_* objects is read, written, altered, dropped, or truncated
-- (Requirements 26.1, 26.2).
--
-- Contents:
--   1. cancellation_import_runs     one row per import, carries the audit counters
--   2. cancellation_cases           the Cancellation_Case, identity + raw-row preservation
--   3. cancellation_contacts        one row per phone or per email
--   4. cancellation_suppressions    channel-level opt-out keyed by normalized value
--   5. cancellation_events          append-only audit timeline + immutability trigger
--   6. cancellation_is_manager() / cancellation_can_read_all() role helpers
--   7. Post-conditions, including a live proof that the append-only trigger raises
--
-- ROW LEVEL SECURITY IS DELIBERATELY NOT ENABLED HERE.
--   v1.10.6-cancellation-rls.sql (task 7.7) runs `enable row level security` on every
--   cancellation_* table and adds every policy. Between this migration and that one the
--   five tables below are reachable by any `authenticated` session, so the intermediate
--   state must not be left deployed. The two helper functions the v1.10.6 policies are
--   built on are created here, as the design specifies, but no policy is added here.
--   The one exception to "no enforcement yet" is cancellation_events: its trigger and
--   the update/delete revokes below hold from this migration onward (Requirement 22.8).
--
-- ROLLBACK PATH
--   begin;
--     drop trigger if exists cancellation_events_no_update on public.cancellation_events;
--     drop function if exists public.cancellation_events_immutable();
--     drop function if exists public.cancellation_can_read_all();
--     drop function if exists public.cancellation_is_manager();
--     drop table if exists public.cancellation_events;
--     drop table if exists public.cancellation_suppressions;
--     drop table if exists public.cancellation_contacts;
--     drop table if exists public.cancellation_cases;
--     drop table if exists public.cancellation_import_runs;
--   commit;
--   Dropping the five tables drops their indexes, constraints, and the events trigger
--   with them. No pre-existing row is touched by the rollback, because none is touched
--   by the migration. Note this is the code-level rollback only; Requirement 26.3
--   keeps applied v1.10.x migrations in place when application code is rolled back.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. IMPORT RUNS — one row per confirmed import. Created first because
--    cancellation_cases.import_run_id references it.
--    The five counters plus the four detail arrays are what the import completion
--    summary and the unmatched-review surfaces read; every one is not null with a
--    zero or empty-array default so an absent count reads as zero rather than null.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_import_runs (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  column_set text not null check (column_set in ('eficacia', 'avisos')),
  imported_by uuid not null references public.profiles(id),
  confirmed_mapping jsonb not null,
  rows_total integer not null,
  rows_created integer not null,
  rows_updated integer not null,
  rows_rejected integer not null,
  rows_duplicate integer not null,
  rejected_rows jsonb not null default '[]',            -- [{ row_number, reason }]
  duplicate_rows jsonb not null default '[]',           -- [{ row_number }]
  unmatched_producer_labels jsonb not null default '[]', -- [{ label, row_number }]
  unmatched_customer_rows jsonb not null default '[]',  -- [{ row_number }]
  invalid_contact_count integer not null default 0,
  contact_overflow_count integer not null default 0,
  amount_due_absent_rows jsonb not null default '[]',   -- [{ row_number, reason }]
  completed_at timestamptz not null default now()
);

comment on table public.cancellation_import_runs is
  'One row per confirmed cancellation import. Carries the five row counters and the rejected, duplicate, unmatched-producer, unmatched-customer, and absent-amount detail lists reported by the import completion summary. Requirements 8.5, 8.7, 9.4, 9.11, 10.1, 10.8.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CANCELLATION CASES
--
--    Identity (Requirement 9.1) is the pair (normalized policy number, cancellation
--    effective date). policy_number_normalized is a stored generated column rather
--    than an importer-computed column so the normalization cannot drift between the
--    importer, the loader RPC, and a manager correction: upper-casing and whitespace
--    removal happen in one place, and the unique constraint is built on the result.
--    `\s` covers space, tab, CR, LF, FF, and VT, which is the "every leading,
--    trailing, and internal whitespace character" of Requirement 9.1; leading zeros,
--    hyphens, and every other character survive.
--
--    raw_row is a jsonb ARRAY, not an object: Requirement 24.2 requires field order
--    equality on the round trip and JSON object key order is not preserved. The check
--    below refuses anything but an array so an object can never be stored by a later
--    caller. raw_header holds the source header in the same order.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_cases (
  id uuid primary key default gen_random_uuid(),

  -- Identity
  policy_number text not null,
  policy_number_normalized text
    generated always as (upper(regexp_replace(policy_number, '\s', '', 'g'))) stored,
  cancellation_effective_date date not null,

  -- Imported descriptive values
  customer_name text,
  client_identifier text,                                -- exact decoded characters (Req 24.3)
  customer_match_key text,                               -- client id, else normalized name, null at zero chars
  carrier text,
  cancellation_reason text,
  amount_due numeric(12, 2) check (amount_due >= 0 and amount_due <= 999999999.99),

  -- Workflow state
  case_status text not null default 'Imported' check (case_status in (
    'Imported', 'Open', 'Payment Reported', 'Verification Pending', 'Reinstatement Pending',
    'Reinstated', 'Cancelled', 'Resolved', 'Invalid', 'Duplicate')),
  communication_status text not null default 'Not Scheduled' check (communication_status in (
    'Not Scheduled', 'Scheduled', 'Partially Sent', 'Sent', 'Delivered',
    'Partially Failed', 'Failed', 'Suppressed', 'Manual Follow-up Required')),
  next_required_action text check (next_required_action in (
    'Add Contact Information', 'Send Reminder Now', 'Retry Failed Communication',
    'Call Customer', 'Record Customer Response', 'Verify Payment',
    'Confirm Reinstatement', 'Confirm Cancellation', 'Mark Resolved')),
  assigned_to uuid references public.profiles(id),
  assignment_source text check (assignment_source in ('import', 'manager')),
  producer_label text,                                   -- raw import label
  follow_up_deadline timestamptz,
  assistance_requested boolean not null default false,

  -- Legacy passthrough. Stored verbatim, excluded from status derivation, touchpoint
  -- scheduling, and template selection (Requirements 8.11, 8.12).
  legacy_send_flag text,                                 -- Enviar
  legacy_state text,                                     -- Estado
  legacy_result text,                                    -- Resultado
  legacy_notices_sent text,                              -- AvisosEnviados
  legacy_first_notice text,                              -- PrimerAviso
  legacy_last_notice text,                               -- UltimoAviso
  legacy_days_remaining text,                            -- Days remaining
  legacy_notice_label text,                              -- Aviso
  legacy_subject text,                                   -- Asunto
  legacy_email_body text,                                -- MensajeEmail
  legacy_sms_body text,                                  -- MensajeSMS

  -- Raw-row preservation (Requirement 24.1)
  raw_row jsonb not null constraint cancellation_cases_raw_row_is_array
    check (jsonb_typeof(raw_row) = 'array'),
  raw_header text[] not null,

  -- Provenance
  import_run_id uuid references public.cancellation_import_runs(id),
  source_row_number integer,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cancellation_cases_identity_key
    unique (policy_number_normalized, cancellation_effective_date)
);

comment on table public.cancellation_cases is
  'One Cancellation_Case per (normalized policy number, cancellation effective date) pair. policy_number_normalized is generated stored so the Requirement 9.1 normalization has exactly one definition; raw_row is a jsonb array so field order survives the Requirement 24.2 round trip.';
comment on column public.cancellation_cases.policy_number_normalized is
  'Generated stored: upper(regexp_replace(policy_number, ''\s'', '''', ''g'')). Half of the case identity (Requirement 9.1).';
comment on column public.cancellation_cases.raw_row is
  'jsonb ARRAY of decoded field values in source column order, same length and order as raw_header. Never an object: JSON object key order is not preserved and Requirement 24.2 requires field order equality.';

create index if not exists idx_cancellation_cases_effective_date
  on public.cancellation_cases (cancellation_effective_date);

create index if not exists idx_cancellation_cases_status
  on public.cancellation_cases (case_status, cancellation_effective_date);

create index if not exists idx_cancellation_cases_assigned
  on public.cancellation_cases (assigned_to);

create index if not exists idx_cancellation_cases_match_key
  on public.cancellation_cases (customer_match_key)
  where customer_match_key is not null;

create index if not exists idx_cancellation_cases_import_run
  on public.cancellation_cases (import_run_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CONTACT RECIPIENTS — one row per phone, one row per email.
--    unique (case_id, channel, normalized_value) is the Requirement 10.6 dedup rule
--    in the database, so a second import of the same cell cannot add a second row for
--    the same value. segment_index carries imported cell order, which is what decides
--    the dedup winner and the primary row (Requirement 10.13).
--    Requirement 10.9 fixes the stored column set; the 20-rows-per-case-per-channel
--    cap is an importer rule, with the overflow counted in the import run.
--    on delete cascade: a contact carries no audit weight of its own, and every
--    audit-bearing child (communications, events) hangs off the case with
--    on delete restrict in later migrations.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_contacts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cancellation_cases(id) on delete cascade,
  channel text not null check (channel in ('phone', 'email')),
  normalized_value text not null,                        -- E.164 phone or lower-cased email
  raw_segment text not null,                             -- segment as it appeared in the cell
  validation_status text not null check (validation_status in ('valid', 'invalid')),
  authorization_status text not null default 'Unknown'
    check (authorization_status in ('Authorized', 'Unknown', 'Not Authorized')),
  sms_suppressed boolean not null default false,
  email_suppressed boolean not null default false,
  is_primary boolean not null default false,
  preferred_language text check (preferred_language in ('English', 'Spanish', 'Bilingual')),
  preferred_channel text check (preferred_channel in ('phone', 'email')),
  contact_name text,
  contact_role text,
  segment_index integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint cancellation_contacts_dedup_key
    unique (case_id, channel, normalized_value)
);

comment on table public.cancellation_contacts is
  'One Contact_Recipient row per phone value and per email value of a Cancellation_Case. unique (case_id, channel, normalized_value) enforces the Requirement 10.6 dedup; authorization_status Authorized and Unknown permit contact, Not Authorized prohibits it (Requirement 10.9).';

create index if not exists idx_cancellation_contacts_case
  on public.cancellation_contacts (case_id, channel, segment_index);

create index if not exists idx_cancellation_contacts_value
  on public.cancellation_contacts (channel, normalized_value);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. SUPPRESSIONS — channel-level, keyed by normalized contact value rather than by
--    contact row, so one opt-out applies to every case holding that value including
--    contacts created by later imports (Requirements 21.1–21.4).
--    A cleared suppression is retained as history: the partial unique index counts
--    only uncleared rows, so one value can be suppressed, cleared, and suppressed
--    again without losing either record.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_suppressions (
  id uuid primary key default gen_random_uuid(),
  channel text not null check (channel in ('sms', 'email')),
  normalized_value text not null,
  source text not null check (source in ('user-recorded', 'customer inbound message')),
  suppressed_at timestamptz not null default now(),
  actor_id uuid references public.profiles(id),          -- null for a customer inbound message
  reason text,
  cleared_at timestamptz,
  cleared_by uuid references public.profiles(id),
  clear_reason text
);

comment on table public.cancellation_suppressions is
  'Channel-level opt-out keyed by normalized contact value, so it applies across every Cancellation_Case holding that value. Cleared rows are retained as history; the partial unique index below allows at most one active row per (channel, normalized_value).';

create unique index if not exists cancellation_suppressions_active_key
  on public.cancellation_suppressions (channel, normalized_value)
  where cleared_at is null;

create index if not exists idx_cancellation_suppressions_value
  on public.cancellation_suppressions (normalized_value, channel);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. EVENTS — the chronological audit timeline. Append-only (Requirement 22.8).
--
--    `sequence bigserial` gives stored insertion order, so entries sharing an
--    event_time break to latest-recorded-first: order by event_time desc, sequence desc
--    (Requirement 17.7).
--
--    on delete restrict on case_id: a case that has history cannot be deleted out
--    from under it.
--
--    Immutability is enforced twice, exactly as attendance_audit_log does in v1.9.0.
--    The trigger refuses update and delete even on a security definer path, which is
--    what the v1.10.5 loader and the v1.10.2 retry function run on and which would
--    otherwise bypass row level security entirely. The revokes below make a client-role
--    attempt fail loudly at the privilege level instead of quietly matching zero rows.
--    v1.10.6 adds select and insert policies and deliberately adds no update or
--    delete policy.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_events (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.cancellation_cases(id) on delete restrict,
  actor_id uuid references public.profiles(id),          -- null for system-generated entries
  event_type text not null,
  detail jsonb,
  event_time timestamptz not null default now(),
  sequence bigserial not null
);

comment on table public.cancellation_events is
  'Append-only audit timeline for cancellation cases. Ordered event_time desc, sequence desc so entries sharing an event time break to latest-recorded-first (Requirement 17.7). Update and delete are refused by trigger for every role including a security definer path (Requirement 22.8).';

create index if not exists idx_cancellation_events_case_time
  on public.cancellation_events (case_id, event_time desc, sequence desc);

create index if not exists idx_cancellation_events_type
  on public.cancellation_events (event_type, event_time desc);

create or replace function public.cancellation_events_immutable()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'cancellation_events is append-only: stored audit entries cannot be changed or deleted'
    using errcode = 'restrict_violation',
          detail  = format('attempted %s on cancellation_events row %s',
                           lower(tg_op), coalesce(old.id::text, '(unknown)')),
          hint    = 'Requirement 22.8. Record a new audit entry instead.';
end;
$fn$;

comment on function public.cancellation_events_immutable() is
  'Trigger function refusing every update and delete on public.cancellation_events, including on a security definer path. Requirement 22.8.';

drop trigger if exists cancellation_events_no_update on public.cancellation_events;
create trigger cancellation_events_no_update
  before update or delete on public.cancellation_events
  for each row execute function public.cancellation_events_immutable();

revoke update, delete on public.cancellation_events from authenticated;
revoke update, delete on public.cancellation_events from anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ROLE HELPERS
--
--    Both are security definer with `set search_path = public`, so they read
--    public.profiles regardless of the caller's own read scope and cannot be steered
--    at a different schema. Every v1.10.6 policy is built on these two, which is what
--    keeps the manager set in one place.
--
--    cancellation_is_manager() accepts `manager` and `super_admin`: super_admin
--    inherits every manager permission (Requirement 22.5).
--    cancellation_can_read_all() adds `customer_service` and `sales_supervisor`, which
--    read every case but write only rows assigned to themselves (Requirement 22.12).
--
--    Execute is deliberately left at the default grant to PUBLIC, matching
--    public.is_manager() in v1.6.2. A row level security policy is evaluated as the
--    session role, so revoking execute would break policy evaluation for any role not
--    explicitly re-granted. Both functions read one row of public.profiles and return
--    a boolean, so the wide execute grant discloses nothing the caller does not
--    already know about its own session.
--
--    Unlike public.is_manager(), neither helper tests profiles.is_active: the design
--    fixes these two definitions and no criterion of Requirement 22 conditions
--    cancellation access on the active flag.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('manager', 'super_admin') from public.profiles where id = auth.uid()),
    false);
$$;

comment on function public.cancellation_is_manager() is
  'True when the signed-in profile holds Manager_Role, which is role manager or super_admin. Used by every cancellation_* policy that reserves an operation to Manager_Role. Requirements 22.3, 22.5.';

create or replace function public.cancellation_can_read_all()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select role in ('manager', 'super_admin', 'customer_service', 'sales_supervisor')
       from public.profiles where id = auth.uid()),
    false);
$$;

comment on function public.cancellation_can_read_all() is
  'True when the signed-in profile reads every Cancellation_Case regardless of assignment: manager, super_admin, customer_service, sales_supervisor. Requirements 22.1, 22.12.';

grant execute on function public.cancellation_is_manager() to authenticated;
grant execute on function public.cancellation_can_read_all() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than
--    leaving stages 2–10 to apply on top of a half-built schema.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing        text;
  v_generated      text;
  v_expression     text;
  v_secdef         integer;
  v_searchpath     integer;
  v_case_id        uuid;
  v_event_id       uuid;
  v_before         jsonb;
  v_after          jsonb;
  v_update_blocked boolean := false;
  v_delete_blocked boolean := false;
begin
  -- ── All five tables exist.
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('cancellation_import_runs'), ('cancellation_cases'),
                 ('cancellation_contacts'), ('cancellation_suppressions'),
                 ('cancellation_events')) as t(name)
   where not exists (select 1 from pg_tables
                      where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.10.0 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── policy_number_normalized is generated STORED, with the Requirement 9.1 expression.
  select a.attgenerated::text, pg_get_expr(d.adbin, d.adrelid)
    into v_generated, v_expression
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.cancellation_cases'::regclass
     and a.attname = 'policy_number_normalized';

  if coalesce(v_generated, '') <> 's' then
    raise exception 'v1.10.0 left cancellation_cases.policy_number_normalized not generated stored (attgenerated=%)',
                    coalesce(v_generated, 'absent')
      using detail = 'Requirement 9.1.', hint = 'Rolling back.';
  end if;
  if v_expression is null
     or strpos(v_expression, 'upper') = 0
     or strpos(v_expression, 'regexp_replace') = 0 then
    raise exception 'v1.10.0 left policy_number_normalized with an unexpected expression: %',
                    coalesce(v_expression, 'absent')
      using detail = 'Requirement 9.1 normalization must be upper(regexp_replace(policy_number, ''\s'', '''', ''g'')).',
            hint = 'Rolling back.';
  end if;

  -- ── The two unique constraints and the partial unique index.
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cancellation_cases'::regclass
                    and conname = 'cancellation_cases_identity_key'
                    and contype = 'u') then
    raise exception 'v1.10.0 did not create cancellation_cases_identity_key'
      using detail = 'Requirement 9.1 case identity.', hint = 'Rolling back.';
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cancellation_contacts'::regclass
                    and conname = 'cancellation_contacts_dedup_key'
                    and contype = 'u') then
    raise exception 'v1.10.0 did not create cancellation_contacts_dedup_key'
      using detail = 'Requirement 10.6 contact dedup.', hint = 'Rolling back.';
  end if;

  if not exists (select 1 from pg_indexes
                  where schemaname = 'public'
                    and indexname = 'cancellation_suppressions_active_key'
                    and indexdef like '%UNIQUE%'
                    and indexdef like '%cleared_at IS NULL%') then
    raise exception 'v1.10.0 did not create the partial unique index cancellation_suppressions_active_key'
      using detail = 'One active suppression per (channel, normalized_value); cleared rows stay as history.',
            hint = 'Rolling back.';
  end if;

  -- ── cancellation_events.sequence is a bigserial: int8 backed by an owned sequence.
  if not exists (
    select 1
      from pg_attribute a
      join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attrelid = 'public.cancellation_events'::regclass
       and a.attname = 'sequence'
       and a.atttypid = 'bigint'::regtype
       and a.attnotnull
       and pg_get_expr(d.adbin, d.adrelid) like 'nextval(%'
  ) then
    raise exception 'v1.10.0 left cancellation_events.sequence without a bigserial default'
      using detail = 'Requirement 17.7 orders equal event times by stored insertion order.',
            hint = 'Rolling back.';
  end if;

  -- ── The append-only trigger is attached for both update and delete.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.cancellation_events'::regclass
       and tgname = 'cancellation_events_no_update'
       and not tgisinternal
       and (tgtype & 16) <> 0   -- UPDATE
       and (tgtype & 8) <> 0    -- DELETE
       and (tgtype & 2) <> 0    -- BEFORE
  ) then
    raise exception 'v1.10.0 did not attach cancellation_events_no_update before update or delete'
      using detail = 'Requirement 22.8.', hint = 'Rolling back.';
  end if;

  -- ── Both helpers exist, return boolean, are security definer, and pin search_path.
  select count(*) into v_secdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('cancellation_is_manager', 'cancellation_can_read_all')
     and pg_get_function_result(p.oid) = 'boolean'
     and p.prosecdef;
  if v_secdef <> 2 then
    raise exception 'v1.10.0 created % of 2 role helpers as security definer booleans', v_secdef
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_searchpath
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('cancellation_is_manager', 'cancellation_can_read_all')
     and p.proconfig @> array['search_path=public'];
  if v_searchpath <> 2 then
    raise exception 'v1.10.0 created % of 2 role helpers with set search_path = public', v_searchpath
      using hint = 'Rolling back.';
  end if;

  -- ── cancellation_is_manager() accepts manager AND super_admin (Requirement 22.5).
  select pg_get_functiondef(p.oid) into v_expression
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cancellation_is_manager';
  if strpos(v_expression, 'manager') = 0 or strpos(v_expression, 'super_admin') = 0 then
    raise exception 'v1.10.0 left cancellation_is_manager() without both manager and super_admin'
      using detail = 'Requirement 22.5: super_admin holds every Manager_Role permission.',
            hint = 'Rolling back.';
  end if;

  -- ── Live proof that the append-only trigger raises. A throwaway case and event are
  --    inserted, updated, and deleted inside a subtransaction; catching each exception
  --    rolls the attempted write back to the savepoint, and the raise at the end of
  --    the block discards the two probe rows. plpgsql variables are not transactional,
  --    so the recorded outcomes survive the rollback.
  begin
    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, customer_name, raw_row, raw_header)
    values
      ('v1100 probe 0001', current_date, 'v1.10.0 post-condition probe',
       '["v1100 probe 0001"]'::jsonb, array['Poliza'])
    returning id into v_case_id;

    insert into public.cancellation_events (case_id, event_type, detail)
    values (v_case_id, 'probe.append_only_check', jsonb_build_object('probe', true))
    returning id into v_event_id;

    select to_jsonb(e) into v_before
      from public.cancellation_events e where e.id = v_event_id;

    begin
      update public.cancellation_events set event_type = 'probe.tampered' where id = v_event_id;
    exception when others then
      v_update_blocked := true;
    end;

    begin
      delete from public.cancellation_events where id = v_event_id;
    exception when others then
      v_delete_blocked := true;
    end;

    select to_jsonb(e) into v_after
      from public.cancellation_events e where e.id = v_event_id;

    raise exception 'v1100_probe_done' using errcode = 'RS001';
  exception when sqlstate 'RS001' then
    null;  -- probe rows discarded; outcomes retained in the variables below
  end;

  if not v_update_blocked then
    raise exception 'v1.10.0 left cancellation_events updatable'
      using detail = 'Requirement 22.8: a stored audit entry cannot be modified.', hint = 'Rolling back.';
  end if;
  if not v_delete_blocked then
    raise exception 'v1.10.0 left cancellation_events deletable'
      using detail = 'Requirement 22.8: a stored audit entry cannot be deleted.', hint = 'Rolling back.';
  end if;
  if v_after is distinct from v_before then
    raise exception 'v1.10.0 probe changed a cancellation_events row despite the trigger: % -> %',
                    v_before, v_after
      using detail = 'Requirement 22.8.', hint = 'Rolling back.';
  end if;

  -- ── Nothing at v1.9.7 or earlier was touched: this migration only ever created
  --    cancellation_* objects, and the probe rows above are rolled back. Assert the
  --    five tables are empty so no residue is committed.
  if (select count(*) from public.cancellation_cases) <> 0
     or (select count(*) from public.cancellation_events) <> 0
     or (select count(*) from public.cancellation_contacts) <> 0
     or (select count(*) from public.cancellation_suppressions) <> 0
     or (select count(*) from public.cancellation_import_runs) <> 0 then
    raise exception 'v1.10.0 left probe residue in the cancellation_* tables'
      using hint = 'Rolling back.';
  end if;
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_tables
     where schemaname = 'public'
       and tablename in ('cancellation_import_runs', 'cancellation_cases',
                         'cancellation_contacts', 'cancellation_suppressions',
                         'cancellation_events')) as tables_created,
  (select attgenerated from pg_attribute
     where attrelid = 'public.cancellation_cases'::regclass
       and attname = 'policy_number_normalized') as normalized_generated_s_is_stored,
  (select count(*) from pg_constraint
     where conname in ('cancellation_cases_identity_key', 'cancellation_contacts_dedup_key')
       and contype = 'u') as unique_constraints,
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname = 'cancellation_suppressions_active_key') as partial_unique_index,
  (select count(*) from pg_trigger
     where tgrelid = 'public.cancellation_events'::regclass
       and tgname = 'cancellation_events_no_update'
       and not tgisinternal) as append_only_trigger,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cancellation_is_manager', 'cancellation_can_read_all')
       and p.prosecdef) as security_definer_helpers,
  (select count(*) from pg_policies
     where schemaname = 'public' and tablename like 'cancellation%') as policies_expected_zero_until_v1_10_6,
  (select count(*) from pg_class
     where relname = 'cancellation_events_sequence_seq' and relkind = 'S') as bigserial_sequence;
