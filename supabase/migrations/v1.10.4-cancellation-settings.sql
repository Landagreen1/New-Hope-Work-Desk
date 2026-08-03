-- New Hope Work Desk v1.10.4 — Cancellation settings (migration stage 5 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.5)
-- Requirements: 14.1, 14.4, 18.4, 26.4 (and 26.1, 26.2 for the forward-only rules)
--
-- Forward-only, fifth file of the v1.10.x series. Creates one new table and seeds its
-- one row. Touches no table, column, policy, function, or row created at v1.9.7 or
-- earlier: nothing outside the new cancellation_settings object is read, written,
-- altered, dropped, or truncated (Requirements 26.1, 26.2). The only drops anywhere in
-- this file are in the rollback path below, and that path names only the one object
-- this file creates.
--
-- Contents:
--   1. cancellation_settings   single row: the global kill switch plus render constants
--   2. Seed of that single row
--   3. Post-conditions, including live proof that the single-row guard, every check,
--      and the profiles foreign key all fire
--
-- NO DEPENDENCY ON v1.10.2 OR v1.10.3
--   This table has exactly one foreign key, `updated_by -> public.profiles(id)`, and
--   public.profiles predates the series. It references no communications table
--   (v1.10.2, task 7.3) and no case-activity table (v1.10.3, task 7.4), so this file
--   applies whether or not those two have been applied, and neither of them has to be
--   written before this one. A post-condition below asserts that foreign key count is
--   exactly 1 so a forward dependency cannot be introduced here later without failing.
--   The one object this file does depend on is public.cancellation_is_manager() from
--   v1.10.0, and it is depended on only in the sense that v1.10.6's policies for this
--   table will be built on it: no new role test is defined here.
--
-- ROW LEVEL SECURITY IS DELIBERATELY NOT ENABLED HERE.
--   v1.10.6-cancellation-rls.sql (task 7.7) runs `enable row level security` on every
--   cancellation_* table and adds every policy, including this table's: select for every
--   role that reaches the workspace, update reserved to Manager_Role through
--   public.cancellation_is_manager(), and no delete policy. Requirement 26.4 reserves a
--   change to automatic_sending_enabled to Manager_Role, and that reservation is
--   enforced by that policy plus the server-side check in the settings route — not here.
--   Between this migration and v1.10.6 the table below is readable AND UPDATABLE by any
--   `authenticated` session, which means the kill switch is flippable by a non-manager
--   in that window. The intermediate state must not be left deployed.
--   Two pieces of protection do hold from this migration onward, because neither is a
--   policy: the revokes of delete and truncate below, and every check constraint.
--
-- SINGLE-ROW GUARD — WHICH FORM AND WHY
--   The design fixes `id boolean primary key default true check (id)`, so that is what
--   is used: the check restricts the key domain to the single value `true` and the
--   primary key makes that value unique, which together cap the table at one row. A
--   unique index on a constant expression would cap it too, but this form is the one the
--   design names, it needs no extra index, and it fails a second insert at the primary
--   key rather than at a lookalike index. Configuration therefore cannot fork into two
--   rows: every reader can use `select ... from public.cancellation_settings` with no
--   ordering, no limit, and no "which row is current" rule. Both halves are proven live
--   in the post-condition block (a second `true` row and any `false` row are refused).
--
-- DELIBERATE ADDITIONS BEYOND THE DESIGN'S COLUMN LIST
--   The design's Phase 2 data model is the authoritative column list; all eight columns
--   below come from it verbatim, with these additions, each of which only refuses a
--   write that no spec criterion permits:
--     * `cancellation_settings_office_phone_has_digits` — Requirement 14.4 matches
--       Office_Phone in a rendered body as its digit sequence after punctuation is
--       stripped. A stored value carrying zero digits makes that criterion unsatisfiable
--       for every message the renderer produces, so it is refused here rather than at
--       send time.
--     * `cancellation_settings_agency_name_not_blank` — Requirement 14.1 matches
--       Agency_Name as an exact literal string. A blank value would match every body
--       trivially and silently disable the assertion.
--     * `cancellation_settings_separator_not_empty` — Requirement 11.7 places exactly
--       one separator between the English and Spanish segments of a bilingual body. A
--       zero-character separator runs the two segments together. Note this is a
--       character-count check, not a btrim check: a whitespace-only separator such as
--       two line feeds is a legitimate configured value.
--     * `cancellation_settings_holidays_well_formed` — Requirement 18.4 excludes
--       agency-configured holidays when counting business days. A null element or a
--       multidimensional array cannot be counted, and either would make the deadline
--       computation return null or raise rather than skip a date. The check is written
--       as a CASE so the dimension test is evaluated before the null-element test:
--       array_position raises on a multidimensional array instead of returning a value.
--   `updated_by` deliberately stays NULLABLE: the seed below records no actor, and a
--   later change made by a server process rather than by a person has none either.
--   No `before update` trigger stamps updated_at. The series does not use one (v1.10.0
--   defaults created_at/updated_at the same way) and Requirement 26.4 has the writer
--   supply the changing profile and the change time together, which a trigger stamping
--   only the time would half-satisfy and half-hide.
--
-- WHY delete AND truncate ARE REVOKED BUT update IS NOT
--   This table is not append-only and not immutable: Requirement 26.4 requires the kill
--   switch to be changeable, so update must survive for v1.10.6's Manager_Role policy to
--   allow. Delete and truncate are a different matter — there is no legitimate removal of
--   the one settings row, and losing it would leave the renderer with no Office_Phone and
--   the scheduler with no kill switch value. v1.10.6 adds no delete policy, which stops a
--   client-role delete, but TRUNCATE is not subject to row level security at all and
--   fires no row trigger, so the privilege has to be withdrawn rather than trapped.
--   Revoking a privilege drops no object and touches nothing created at v1.9.7 or
--   earlier. `service_role` deliberately keeps its grants: server code runs as that role,
--   matching the rest of the series.
--
-- THE DESIGN'S "NO FOREIGN KEYS" LINE
--   The design's ER-diagram note calls this table "a standalone single-row table with no
--   foreign keys", while its column list for the same table writes
--   `updated_by uuid references public.profiles(id)`. The column list is authoritative
--   and Requirement 26.4 requires the changing profile to be stored, so the reference is
--   created. The note is read as being about the diagram: this table joins no
--   cancellation_* table, which is why it is omitted from the ER diagram.
--
-- ROLLBACK PATH
--   begin;
--     drop table if exists public.cancellation_settings;
--   commit;
--   Dropping the table drops its primary key, its five check constraints, its foreign
--   key, and the seeded row with it. No pre-existing row is touched by the rollback,
--   because none is touched by the migration. Re-running this file afterwards restores
--   the table and re-seeds the row, but a manager-changed office_phone, holidays list, or
--   kill switch value is NOT restored — the seed only fills an absent row. Note this is
--   the code-level rollback only; Requirement 26.3 keeps applied v1.10.x migrations in
--   place when application code is rolled back, and Requirement 26.4's fastest
--   mitigation is setting automatic_sending_enabled to false, not dropping this table.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. CANCELLATION SETTINGS — one row, forever.
--
--    automatic_sending_enabled is the Requirement 26.4 control: default enabled, read by
--    the scheduler before every automatic send, and deliberately NOT read by the
--    Send Reminder Now and Retry Failed Communication paths (Requirement 26.6 keeps
--    those working while automatic sending is disabled).
--
--    office_phone, agency_name, and bilingual_separator are the render constants the
--    Message_Renderer reads (Requirements 14.1, 14.4, 11.7). They live in the database
--    rather than in the environment so a manager can correct the rendered phone number
--    without a deploy, and so a stored Communication_Record can be read back against the
--    constants that were in force.
--
--    holidays is the agency-configured holiday list excluded from the business-day count
--    of Requirement 18.4 (and of the three-business-day deadline in Requirement 19.4).
--    An empty array is the correct starting state: Saturday and Sunday are excluded by
--    the weekday rule itself, not by this list.
--
--    No index is created. The table holds one row reachable only by its primary key, so
--    every access path is already the primary key index.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_settings (
  -- Single-row guard: the check pins the key domain to one value, the primary key makes
  -- it unique. Together they permit exactly one row (design Phase 2 data model).
  id boolean primary key default true
    constraint cancellation_settings_single_row check (id),

  -- Requirement 26.4: the global automatic-sending control, defaulted to enabled.
  automatic_sending_enabled boolean not null default true,

  -- Requirement 14.4: rendered in every body, matched as its digit sequence. No default:
  -- the seed below supplies the agency number explicitly rather than hiding it in DDL.
  office_phone text not null
    constraint cancellation_settings_office_phone_has_digits
      check (char_length(regexp_replace(office_phone, '\D', '', 'g')) > 0),

  -- Requirement 14.1 / glossary: the literal string "New Hope Insurance Agency".
  agency_name text not null default 'New Hope Insurance Agency'
    constraint cancellation_settings_agency_name_not_blank
      check (char_length(btrim(agency_name)) > 0),

  -- Requirement 11.7: exactly one of these is placed between the English and Spanish
  -- segments of a bilingual body.
  bilingual_separator text not null default E'\n---\n'
    constraint cancellation_settings_separator_not_empty
      check (char_length(bilingual_separator) > 0),

  -- Requirement 18.4: agency-configured holidays excluded from business-day counting.
  holidays date[] not null default '{}'
    constraint cancellation_settings_holidays_well_formed
      check (case
               when coalesce(array_ndims(holidays), 1) <> 1 then false
               else array_position(holidays, null::date) is null
             end),

  -- Requirement 26.4: the changing profile and the change time. updated_by stays
  -- nullable for the seed and for a change made by a server process.
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

comment on table public.cancellation_settings is
  'Exactly one row: the global automatic-sending kill switch (Requirement 26.4) plus the render constants the Message_Renderer reads (Office_Phone per Requirement 14.4, Agency_Name per Requirement 14.1, the bilingual separator per Requirement 11.7) and the agency holiday list excluded from business-day counting (Requirement 18.4). The boolean primary key with its check (id) constraint caps the table at one row, so every reader selects without ordering or limit. Row level security and the Manager_Role write reservation are added by v1.10.6 (task 7.7).';

comment on column public.cancellation_settings.id is
  'Single-row guard, not an identifier: check (id) pins the domain to true and the primary key makes it unique, so at most one row can ever exist. Never referenced by another table.';
comment on column public.cancellation_settings.automatic_sending_enabled is
  'Requirement 26.4: automatic Touchpoint sending for every Cancellation_Case, defaulted to enabled. While false the Notification_Scheduler sends zero automatic messages, creates zero Communication_Record rows for the Touchpoints it would have sent, and reports them as skipped (Requirement 26.5); Send Reminder Now and Retry Failed Communication keep working (Requirement 26.6). Changeable only by Manager_Role, enforced by the v1.10.6 policy and the server-side route check.';
comment on column public.cancellation_settings.office_phone is
  'Requirement 14.4: Office_Phone, rendered at least once in every rendered body and matched as its digit sequence after spaces, hyphens, parentheses, periods, and plus signs are removed. Stored in the agency''s customer-facing form; at least one digit is required.';
comment on column public.cancellation_settings.agency_name is
  'Requirement 14.1 and the glossary: Agency_Name, rendered at least once in every rendered body and matched as an exact literal string. Also the sender name where the assigned employee is absent, inactive, deleted, or blank-named (Requirement 14.14).';
comment on column public.cancellation_settings.bilingual_separator is
  'Requirement 11.7: placed exactly once between the English segment and the Spanish segment of a bilingual rendered body. May be whitespace, may not be zero characters.';
comment on column public.cancellation_settings.holidays is
  'Requirement 18.4: agency-configured holidays excluded, along with Saturday and Sunday, when counting business days for a follow-up deadline. One-dimensional, no null elements. Empty is the correct starting state: weekends are excluded by the weekday rule, not by this list.';
comment on column public.cancellation_settings.updated_by is
  'Requirement 26.4: the profile that made the last change. Nullable — the seeded row has no actor, and neither does a change made by a server process.';
comment on column public.cancellation_settings.updated_at is
  'Requirement 26.4: the time of the last change. Supplied by the writer together with updated_by; no trigger stamps it, so the two are always recorded by the same statement.';

-- Delete and truncate are withdrawn from the client roles: there is no legitimate
-- removal of the one settings row, v1.10.6 adds no delete policy, and truncate is
-- subject to neither row level security nor row triggers. Update is deliberately left
-- in place for v1.10.6's Manager_Role policy to allow (Requirement 26.4).
revoke delete, truncate on public.cancellation_settings from authenticated;
revoke delete, truncate on public.cancellation_settings from anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. SEED THE SINGLE ROW
--
--    office_phone is the only column with no default, so it is the only one that has to
--    be supplied. The value is the agency office number already rendered in this
--    repository's renewal SMS bodies, `(704) 824-3130` in src/lib/ringcentral-sms.ts,
--    whose digit sequence 7048243130 is the RINGCENTRAL_OFFICE_PHONE number +17048243130
--    without the country code. The customer-facing punctuated form is stored because it
--    is what appears inside a message body; Requirement 14.4 matches on digits, so the
--    punctuation costs nothing. A manager corrects it in place with an update — no
--    migration is needed to change it.
--
--    `on conflict (id) do nothing` makes this file safely re-appliable: a re-run leaves a
--    manager-changed office_phone, holiday list, or kill switch value exactly as it is
--    rather than resetting it. That is also why the post-conditions below assert the
--    column DEFAULT of automatic_sending_enabled is true (Requirement 26.4) instead of
--    asserting the stored value is true, which a manager is entitled to have set to false.
-- ═══════════════════════════════════════════════════════════════════════════════
insert into public.cancellation_settings (id, office_phone)
values (true, '(704) 824-3130')
on conflict (id) do nothing;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than leaving
--    stages 6–10 to apply on top of a half-built or unseeded settings table.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing              text;
  v_default              text;
  v_pk                   text;
  v_before               jsonb;
  v_after                jsonb;
  v_rows                 integer;
  v_fk_count             integer;
  v_dup_true_blocked     boolean := false;
  v_false_row_blocked    boolean := false;
  v_id_flip_blocked      boolean := false;
  v_blank_agency_blocked boolean := false;
  v_no_digit_blocked     boolean := false;
  v_empty_sep_blocked    boolean := false;
  v_null_holiday_blocked boolean := false;
  v_2d_holiday_blocked   boolean := false;
  v_bad_actor_blocked    boolean := false;
  v_kill_switch_writable boolean := false;
  v_holiday_writable     boolean := false;
begin
  -- ── The table exists.
  if not exists (select 1 from pg_tables
                  where schemaname = 'public' and tablename = 'cancellation_settings') then
    raise exception 'v1.10.4 did not create public.cancellation_settings'
      using hint = 'Rolling back.';
  end if;

  -- ── Every column of the design's data model exists, with the stated type.
  select string_agg(format('%s %s', c.col, c.typ), ', ' order by c.col) into v_missing
    from (values
      ('id',                        'boolean'),
      ('automatic_sending_enabled', 'boolean'),
      ('office_phone',              'text'),
      ('agency_name',               'text'),
      ('bilingual_separator',       'text'),
      ('holidays',                  'ARRAY'),
      ('updated_by',                'uuid'),
      ('updated_at',                'timestamp with time zone')
    ) as c(col, typ)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = 'cancellation_settings'
        and ic.column_name = c.col
        and ic.data_type = c.typ);
  if v_missing is not null then
    raise exception 'v1.10.4 left these columns absent or of the wrong type: %', v_missing
      using detail = 'Column list is the design Phase 2 data model.', hint = 'Rolling back.';
  end if;

  -- ── holidays is specifically an array OF date, not of something else.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_settings'
       and column_name = 'holidays' and udt_name = '_date') then
    raise exception 'v1.10.4 left cancellation_settings.holidays as something other than date[]'
      using detail = 'Requirement 18.4 excludes agency-configured holiday DATES.',
            hint = 'Rolling back.';
  end if;

  -- ── The table has exactly eight columns: nothing extra crept in.
  select count(*) into v_rows from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings';
  if v_rows <> 8 then
    raise exception 'v1.10.4 created % columns on cancellation_settings, expected 8', v_rows
      using hint = 'Rolling back.';
  end if;

  -- ── Every not-null column of the design's data model is actually not null.
  select string_agg(c.col, ', ' order by c.col) into v_missing
    from (values
      ('id'), ('automatic_sending_enabled'), ('office_phone'), ('agency_name'),
      ('bilingual_separator'), ('holidays'), ('updated_at')
    ) as c(col)
   where exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public' and ic.table_name = 'cancellation_settings'
        and ic.column_name = c.col and ic.is_nullable = 'YES');
  if v_missing is not null then
    raise exception 'v1.10.4 left these columns nullable: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── updated_by stays NULLABLE: the seed records no actor.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_settings'
       and column_name = 'updated_by' and is_nullable = 'YES') then
    raise exception 'v1.10.4 made cancellation_settings.updated_by not null'
      using detail = 'The seeded row and server-process changes have no actor.',
            hint = 'Rolling back.';
  end if;

  -- ── Requirement 26.4: automatic sending DEFAULTS to enabled. Asserted on the column
  --    default, not on the stored row, because a manager may legitimately have set the
  --    stored value to false before this file was re-applied.
  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings'
     and column_name = 'automatic_sending_enabled';
  if coalesce(v_default, '') not like '%true%' then
    raise exception 'v1.10.4 left automatic_sending_enabled without a default of true (got %)',
                    coalesce(v_default, 'absent')
      using detail = 'Requirement 26.4 defaults automatic Touchpoint sending to enabled.',
            hint = 'Rolling back.';
  end if;

  -- ── id defaults to true, so an insert that names no key still lands on the one row.
  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings' and column_name = 'id';
  if coalesce(v_default, '') not like '%true%' then
    raise exception 'v1.10.4 left cancellation_settings.id without a default of true (got %)',
                    coalesce(v_default, 'absent')
      using hint = 'Rolling back.';
  end if;

  -- ── agency_name defaults to the Requirement 14.1 literal.
  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings' and column_name = 'agency_name';
  if coalesce(v_default, '') not like '%New Hope Insurance Agency%' then
    raise exception 'v1.10.4 left agency_name without its default of New Hope Insurance Agency (got %)',
                    coalesce(v_default, 'absent')
      using detail = 'Requirement 14.1 and the glossary fix Agency_Name.', hint = 'Rolling back.';
  end if;

  -- ── bilingual_separator carries the design's default separator.
  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings'
     and column_name = 'bilingual_separator';
  if coalesce(v_default, '') not like '%---%' then
    raise exception 'v1.10.4 left bilingual_separator without its default separator (got %)',
                    coalesce(v_default, 'absent')
      using detail = 'Requirement 11.7 places exactly one separator between the two segments.',
            hint = 'Rolling back.';
  end if;

  -- ── holidays defaults to the empty array, and updated_at to now().
  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings' and column_name = 'holidays';
  if coalesce(v_default, '') not like '%{}%' then
    raise exception 'v1.10.4 left holidays without its empty-array default (got %)',
                    coalesce(v_default, 'absent')
      using hint = 'Rolling back.';
  end if;

  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings' and column_name = 'updated_at';
  if coalesce(v_default, '') not like '%now()%' then
    raise exception 'v1.10.4 left updated_at without its now() default (got %)',
                    coalesce(v_default, 'absent')
      using hint = 'Rolling back.';
  end if;

  -- ── office_phone deliberately has NO default: the seed supplies the agency number.
  select column_default into v_default from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_settings' and column_name = 'office_phone';
  if v_default is not null then
    raise exception 'v1.10.4 gave office_phone a default (%); the seed is the only source', v_default
      using detail = 'A defaulted phone number would be rendered to customers unnoticed.',
            hint = 'Rolling back.';
  end if;

  -- ── The primary key is on id alone: that is half of the single-row guard.
  select string_agg(a.attname, ', ' order by a.attnum) into v_pk
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.conrelid = 'public.cancellation_settings'::regclass and c.contype = 'p';
  if coalesce(v_pk, '') <> 'id' then
    raise exception 'v1.10.4 left cancellation_settings with primary key (%), expected (id)',
                    coalesce(v_pk, 'none')
      using hint = 'Rolling back.';
  end if;

  -- ── Every named check constraint exists.
  select string_agg(c.con, ', ' order by c.con) into v_missing
    from (values
      ('cancellation_settings_single_row'),
      ('cancellation_settings_office_phone_has_digits'),
      ('cancellation_settings_agency_name_not_blank'),
      ('cancellation_settings_separator_not_empty'),
      ('cancellation_settings_holidays_well_formed')
    ) as c(con)
   where not exists (
     select 1 from pg_constraint
      where conrelid = 'public.cancellation_settings'::regclass
        and conname = c.con and contype = 'c');
  if v_missing is not null then
    raise exception 'v1.10.4 did not create these check constraints: %', v_missing
      using hint = 'Rolling back.';
  end if;

  -- ── Exactly one foreign key, and it points at public.profiles. This is what keeps the
  --    file independent of v1.10.2 and v1.10.3: no communications or case-activity table
  --    is referenced.
  select count(*) into v_fk_count from pg_constraint
   where conrelid = 'public.cancellation_settings'::regclass and contype = 'f';
  if v_fk_count <> 1 then
    raise exception 'v1.10.4 created % foreign keys on cancellation_settings, expected 1', v_fk_count
      using detail = 'Only updated_by -> public.profiles(id). A reference to a v1.10.2 or v1.10.3 table would be a forward dependency.',
            hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cancellation_settings'::regclass
       and contype = 'f'
       and confrelid = 'public.profiles'::regclass) then
    raise exception 'v1.10.4 left cancellation_settings.updated_by without its profiles reference'
      using detail = 'Requirement 26.4 stores the changing profile.', hint = 'Rolling back.';
  end if;

  -- ── The single row is seeded, and it is the only row.
  select count(*) into v_rows from public.cancellation_settings;
  if v_rows <> 1 then
    raise exception 'v1.10.4 left % rows in cancellation_settings, expected exactly 1', v_rows
      using detail = 'The kill switch and every render constant are read from one row.',
            hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from public.cancellation_settings
     where id
       and char_length(regexp_replace(office_phone, '\D', '', 'g')) > 0
       and char_length(btrim(agency_name)) > 0
       and char_length(bilingual_separator) > 0
       and holidays is not null) then
    raise exception 'v1.10.4 seeded a row that is not usable by the renderer'
      using detail = 'Requirements 14.1, 14.4, 11.7, 18.4 all read this row.',
            hint = 'Rolling back.';
  end if;

  -- ── This file adds no policy and does not enable row level security; v1.10.6 owns
  --    both. A policy present while row level security is still off means a policy was
  --    added out of order. After v1.10.6 both are true, which keeps this file
  --    re-appliable.
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'cancellation_settings')
     and not (select relrowsecurity from pg_class
               where oid = 'public.cancellation_settings'::regclass) then
    raise exception 'a policy exists on cancellation_settings while row level security is disabled'
      using detail = 'v1.10.6 (task 7.7) owns enable row level security and every cancellation_* policy.',
            hint = 'Rolling back.';
  end if;

  -- ── The Manager_Role test the v1.10.6 policy for this table will use already exists,
  --    and this file defines no replacement for it.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancellation_is_manager' and p.prosecdef) then
    raise exception 'public.cancellation_is_manager() is absent: v1.10.0 must be applied before v1.10.4'
      using detail = 'Requirement 26.4 reserves the kill switch to Manager_Role through that helper.',
            hint = 'Rolling back.';
  end if;

  -- ── authenticated and anon hold no delete or truncate privilege on this table.
  select string_agg(format('%s:%s', g.grantee, g.privilege_type), ', '
                    order by g.grantee, g.privilege_type)
    into v_missing
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name = 'cancellation_settings'
     and g.grantee in ('authenticated', 'anon')
     and g.privilege_type in ('DELETE', 'TRUNCATE');
  if v_missing is not null then
    raise exception 'v1.10.4 left these privileges on cancellation_settings: %', v_missing
      using detail = 'The one settings row must not be removable; truncate obeys neither row level security nor row triggers.',
            hint = 'Rolling back.';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- LIVE PROOF. Every write below is discarded by the raise at the end of the block.
  -- Each expected failure runs in its own nested block, so catching it rolls that one
  -- statement back to its own savepoint and the probe continues. plpgsql variables are
  -- not transactional, so the recorded outcomes survive the rollback.
  -- ═════════════════════════════════════════════════════════════════════════════
  select to_jsonb(s) into v_before from public.cancellation_settings s;

  begin
    -- A second row keyed true is refused by the primary key.
    begin
      insert into public.cancellation_settings (id, office_phone)
      values (true, '(704) 824-3130');
    exception when unique_violation then
      v_dup_true_blocked := true;
    end;

    -- A second row keyed false is refused by the single-row check.
    begin
      insert into public.cancellation_settings (id, office_phone)
      values (false, '(704) 824-3130');
    exception when others then
      v_false_row_blocked := true;
    end;

    -- The stored row cannot be re-keyed to false either.
    begin
      update public.cancellation_settings set id = false;
    exception when others then
      v_id_flip_blocked := true;
    end;

    -- A blank Agency_Name is refused (Requirement 14.1).
    begin
      update public.cancellation_settings set agency_name = '   ';
    exception when others then
      v_blank_agency_blocked := true;
    end;

    -- An Office_Phone carrying no digits is refused (Requirement 14.4).
    begin
      update public.cancellation_settings set office_phone = 'call the office';
    exception when others then
      v_no_digit_blocked := true;
    end;

    -- A zero-character bilingual separator is refused (Requirement 11.7).
    begin
      update public.cancellation_settings set bilingual_separator = '';
    exception when others then
      v_empty_sep_blocked := true;
    end;

    -- A null holiday element is refused (Requirement 18.4).
    begin
      update public.cancellation_settings set holidays = array[null]::date[];
    exception when others then
      v_null_holiday_blocked := true;
    end;

    -- A multidimensional holiday array is refused (Requirement 18.4).
    begin
      update public.cancellation_settings
         set holidays = array[array['2026-12-25'::date], array['2027-01-01'::date]];
    exception when others then
      v_2d_holiday_blocked := true;
    end;

    -- An updated_by that is not a profile is refused (Requirement 26.4).
    begin
      update public.cancellation_settings set updated_by = gen_random_uuid();
    exception when foreign_key_violation then
      v_bad_actor_blocked := true;
    end;

    -- POSITIVE: the kill switch flips and a real holiday list stores. Both are ordinary
    -- writes that Requirement 26.4 and Requirement 18.4 depend on, so a check that
    -- accidentally blocked them would be as much a defect as a missing check.
    update public.cancellation_settings
       set automatic_sending_enabled = false,
           holidays = array['2026-12-25'::date, '2027-01-01'::date],
           updated_at = now();

    select not automatic_sending_enabled, cardinality(holidays) = 2
      into v_kill_switch_writable, v_holiday_writable
      from public.cancellation_settings;

    raise exception 'v1104_probe_done' using errcode = 'RS001';
  exception when sqlstate 'RS001' then
    null;  -- probe writes discarded; outcomes retained in the variables below
  end;

  if not v_dup_true_blocked then
    raise exception 'v1.10.4 accepted a second cancellation_settings row keyed true'
      using detail = 'The single-row guard must stop configuration from forking into two rows.',
            hint = 'Rolling back.';
  end if;
  if not v_false_row_blocked then
    raise exception 'v1.10.4 accepted a cancellation_settings row keyed false'
      using detail = 'check (id) must pin the key domain to the single value true.',
            hint = 'Rolling back.';
  end if;
  if not v_id_flip_blocked then
    raise exception 'v1.10.4 allowed the stored settings row to be re-keyed to false'
      using detail = 'check (id) is enforced on update as well as on insert.',
            hint = 'Rolling back.';
  end if;
  if not v_blank_agency_blocked then
    raise exception 'v1.10.4 accepted a blank agency_name'
      using detail = 'Requirement 14.1 matches Agency_Name as an exact literal in every rendered body.',
            hint = 'Rolling back.';
  end if;
  if not v_no_digit_blocked then
    raise exception 'v1.10.4 accepted an office_phone carrying zero digits'
      using detail = 'Requirement 14.4 matches Office_Phone as its digit sequence in every rendered body.',
            hint = 'Rolling back.';
  end if;
  if not v_empty_sep_blocked then
    raise exception 'v1.10.4 accepted a zero-character bilingual_separator'
      using detail = 'Requirement 11.7 places exactly one separator between the two segments.',
            hint = 'Rolling back.';
  end if;
  if not v_null_holiday_blocked then
    raise exception 'v1.10.4 accepted a null element in holidays'
      using detail = 'Requirement 18.4 counts business days against this list; a null cannot be counted.',
            hint = 'Rolling back.';
  end if;
  if not v_2d_holiday_blocked then
    raise exception 'v1.10.4 accepted a multidimensional holidays array'
      using detail = 'Requirement 18.4 excludes a flat list of dates.', hint = 'Rolling back.';
  end if;
  if not v_bad_actor_blocked then
    raise exception 'v1.10.4 accepted an updated_by that is not a profile'
      using detail = 'Requirement 26.4 stores the changing profile.', hint = 'Rolling back.';
  end if;
  if not v_kill_switch_writable then
    raise exception 'v1.10.4 blocked setting automatic_sending_enabled to false'
      using detail = 'Requirement 26.4 requires the control to be changeable; disabling it is the fastest rollback mitigation.',
            hint = 'Rolling back.';
  end if;
  if not v_holiday_writable then
    raise exception 'v1.10.4 blocked storing a two-date holiday list'
      using detail = 'Requirement 18.4 excludes agency-configured holidays from business-day counting.',
            hint = 'Rolling back.';
  end if;

  -- ── The probe writes are gone: the committed row is byte for byte what the seed left,
  --    and there is still exactly one of it.
  select to_jsonb(s) into v_after from public.cancellation_settings s;
  if v_after is distinct from v_before then
    raise exception 'v1.10.4 left probe residue in the settings row: % -> %', v_before, v_after
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_rows from public.cancellation_settings;
  if v_rows <> 1 then
    raise exception 'v1.10.4 left % rows in cancellation_settings after the probe, expected 1', v_rows
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
     where schemaname = 'public' and tablename = 'cancellation_settings') as table_created_expect_1,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_settings') as columns_expect_8,
  (select count(*) from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_settings'
       and is_nullable = 'NO') as not_null_columns_expect_7,
  (select count(*) from pg_constraint
     where conrelid = 'public.cancellation_settings'::regclass
       and contype = 'c' and conname like 'cancellation_settings%') as named_check_constraints_expect_5,
  (select count(*) from pg_constraint
     where conrelid = 'public.cancellation_settings'::regclass and contype = 'p') as primary_key_expect_1,
  (select count(*) from pg_constraint
     where conrelid = 'public.cancellation_settings'::regclass and contype = 'f') as foreign_keys_expect_1,
  (select count(*) from public.cancellation_settings) as rows_expect_exactly_1,
  (select automatic_sending_enabled from public.cancellation_settings) as sending_enabled_seeded_true,
  (select office_phone from public.cancellation_settings) as seeded_office_phone,
  (select agency_name from public.cancellation_settings) as seeded_agency_name,
  (select cardinality(holidays) from public.cancellation_settings) as seeded_holiday_count_expect_0,
  (select char_length(bilingual_separator) from public.cancellation_settings) as separator_length_expect_5,
  (select count(*) from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'cancellation_settings'
       and grantee in ('authenticated', 'anon')
       and privilege_type in ('DELETE', 'TRUNCATE')) as client_delete_truncate_expect_0,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename = 'cancellation_settings') as policies_expected_zero_until_v1_10_6,
  (select relrowsecurity from pg_class
     where oid = 'public.cancellation_settings'::regclass) as rls_expected_false_until_v1_10_6;
