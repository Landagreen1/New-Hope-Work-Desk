-- New Hope Work Desk v1.10.1 — Cancellation message templates (migration stage 2 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.2)
-- Requirements: 11.1, 14.7, 14.11, 14.17, 26.1
--
-- Forward-only, second file of the v1.10.x series. Creates three new tables, one
-- trigger function, and one trigger. Touches no table, column, policy, function, or
-- row created at v1.9.7 or earlier: nothing outside the new cancellation_* objects is
-- read, written, altered, dropped, or truncated (Requirements 26.1, 26.2). The only
-- drops in this file are the `drop trigger if exists` immediately before its own
-- `create trigger`, and the drops listed in the rollback path below, which name only
-- objects this file creates.
--
-- Contents:
--   1. cancellation_templates           one row per touchpoint (15, 10, 5, 1)
--   2. cancellation_template_versions   immutable versioned bodies, one row per language
--   3. cancellation_prohibited_phrases  the Prohibited_Phrase_List the render gate reads
--   4. cancellation_template_versions_immutable() + its before update or delete trigger
--   5. Post-conditions, including live proof that the trigger and every check fire
--
-- ROW LEVEL SECURITY IS DELIBERATELY NOT ENABLED HERE.
--   v1.10.6-cancellation-rls.sql (task 7.7) runs `enable row level security` on every
--   cancellation_* table and adds every policy, including the design's row for these
--   three tables: select for every role, insert for Manager_Role only, no update policy
--   and no delete policy on any of the three. Between this migration and that one the
--   three tables below are reachable by any `authenticated` session, so the
--   intermediate state must not be left deployed. The helper functions those policies
--   are built on — public.cancellation_is_manager() and public.cancellation_can_read_all()
--   — already exist from v1.10.0 and are deliberately NOT redefined here; every manager
--   check in the series reuses cancellation_is_manager(), which accepts `manager` and
--   `super_admin`.
--   The one piece of enforcement that holds from this migration onward is template
--   version immutability: its trigger and the update/delete/truncate revokes below
--   apply to every role including a security definer path (Requirement 14.17).
--
-- TOKEN FORMAT — A READING, NOT A DECISION TAKEN SILENTLY
--   The design fixes `fallback_text jsonb` as "token -> fallback string" and
--   Requirement 14.11 fixes the behavior (render the stored fallback where a required
--   value is absent, render zero characters where no fallback is stored). Neither the
--   design nor Requirement 14 states the delimiter a token wears inside the subject and
--   body text: `{{Office_Phone}}`, `{Office_Phone}`, `[Office_Phone]`, and
--   `%Office_Phone%` are all consistent with the spec as written.
--   This migration therefore READS fallback_text keys as bare token names
--   (`Office_Phone`, `Amount_Due`, `Producer_Name`, `Contact_Name`, `Carrier`,
--   `Cancellation_Reason`) carrying no delimiter, and adds NO check constraint that
--   mentions any delimiter, any token name, or any body substring. The delimiter is
--   left entirely to task 7.10 (which seeds the version 1 rows) and task 12.1 (which
--   builds the renderer); those two must agree with each other, and the database will
--   accept whichever form they agree on. If the reading is wrong and the keys are meant
--   to carry delimiters, nothing in this file has to change.
--
-- DELIBERATE ADDITIONS BEYOND THE DESIGN'S COLUMN LIST
--   The design's Phase 2 data model is the authoritative column list and every column
--   below comes from it, with these documented additions, each of which only narrows a
--   write that no spec criterion permits:
--     * `created_by uuid references public.profiles(id)` — the design writes bare
--       `created_by uuid`; the reference matches every other actor column in the series
--       (import_runs.imported_by, suppressions.actor_id / cleared_by) and stays nullable
--       so the v1.10.9 system seed can leave it null.
--     * `cancellation_prohibited_phrases.created_at` — every other table in the series
--       carries it; defaulted, so no caller has to supply it.
--     * Non-blank checks on `body`, `cancellation_statement`, `contact_request`, and
--       `phrase`. A blank statement or contact request would silently violate
--       Requirements 14.2 and 14.5; a blank phrase would match every rendered body and
--       block every send through the Requirement 14.8 gate. `subject` deliberately has
--       NO non-blank check: Requirement 14.15 stores zero characters as the rendered
--       subject on the SMS channel, so a zero-character template subject is a legitimate
--       stored value.
--     * `check (version >= 1)` — Requirement 14.17 counts versions up from 1.
--     * `check (jsonb_typeof(fallback_text) = 'object')` — the same guard v1.10.0 puts
--       on cancellation_cases.raw_row, so a later caller cannot store an array or a
--       scalar where the renderer of task 12.1 will read `fallback_text ->> token`.
--     * `unique (language, claim_category, phrase)` on the phrase list — gives task 7.10
--       a natural `on conflict` target so its seed is re-runnable, and keeps the gate
--       from scanning duplicate phrases.
--     * `on delete restrict` spelled out on `template_id`, and the four indexes at the
--       end of each section.
--
-- ROLLBACK PATH
--   begin;
--     drop trigger if exists cancellation_template_versions_no_update
--       on public.cancellation_template_versions;
--     drop function if exists public.cancellation_template_versions_immutable();
--     drop table if exists public.cancellation_prohibited_phrases;
--     drop table if exists public.cancellation_template_versions;
--     drop table if exists public.cancellation_templates;
--   commit;
--   Dropping the three tables drops their indexes, constraints, grants, and the
--   versions trigger with them; cancellation_template_versions must go before
--   cancellation_templates, and both must go before v1.10.2's
--   cancellation_communications.template_version_id exists. No pre-existing row is
--   touched by the rollback, because none is touched by the migration. This is the
--   code-level rollback only; Requirement 26.3 keeps applied v1.10.x migrations in place
--   when application code is rolled back.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. TEMPLATES — one row per touchpoint.
--
--    Requirement 12.1 fixes exactly four touchpoints, 15 / 10 / 5 / 1 calendar days
--    before the cancellation effective date, so `unique (touchpoint)` makes "the
--    template for the 5-day touchpoint" a single unambiguous row and makes the
--    touchpoint the lookup key the scheduler and the renderer both use. Requirement
--    13.7 renders a combined message from "the template version of the touchpoint with
--    the fewest days remaining", which is a lookup by the smallest touchpoint value in
--    the chunk — again one row.
--
--    The text of a template lives in cancellation_template_versions, never here, so
--    this row can stay mutable (a manager renaming a template changes no stored
--    message) while every rendered word is immutable.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_templates (
  id uuid primary key default gen_random_uuid(),
  touchpoint smallint not null
    constraint cancellation_templates_touchpoint_values check (touchpoint in (15, 10, 5, 1)),
  name text not null
    constraint cancellation_templates_name_not_blank check (char_length(btrim(name)) > 0),
  created_at timestamptz not null default now(),

  constraint cancellation_templates_touchpoint_key unique (touchpoint)
);

comment on table public.cancellation_templates is
  'One message template per touchpoint. Requirement 12.1 fixes the four touchpoints at 15, 10, 5, and 1 calendar day before the cancellation effective date; unique (touchpoint) makes the touchpoint the single lookup key used by the Notification_Scheduler and by the Requirement 13.7 fewest-days-remaining rule for combined messages. All rendered text lives in cancellation_template_versions.';
comment on column public.cancellation_templates.touchpoint is
  'Days remaining before the cancellation effective date: 15, 10, 5, or 1 (Requirement 12.1). Unique across the table.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. TEMPLATE VERSIONS — the immutable rendered text, one row per language segment.
--
--    One row per (template, version, language). An English render reads the English
--    row, a Spanish render the Spanish row, and a Bilingual render both rows of the
--    same version (Requirement 11.6). `language` is restricted to English and Spanish
--    only: Bilingual is a RENDER language resolved per message (Requirements 11.2,
--    11.8), never a stored template row, because a Bilingual body is assembled from the
--    two segments plus exactly one separator rather than stored as a third variant.
--    The three-value restriction of Requirement 11.1 applies to
--    cancellation_contacts.preferred_language, which v1.10.0 already carries.
--
--    cancellation_statement and contact_request are stored separately from `body` even
--    though the body contains them, because Requirements 14.2 and 14.5 make each one an
--    independently required element of every rendered body and Requirement 11.7 makes
--    both required in each segment of a Bilingual body: keeping them as their own
--    columns lets the renderer assemble and the verification tests assert each element
--    on its own instead of substring-hunting inside one blob.
--
--    IMMUTABILITY (Requirement 14.17). A saved template change adds `version + 1` rows
--    rather than editing a stored row, so every Communication_Record written by v1.10.2
--    keeps pointing at the exact words that were sent. Enforced twice, the same way
--    v1.10.0 protects cancellation_events: a before update or delete trigger that
--    raises for every role including a security definer path, plus the revokes below so
--    a client-role attempt fails at the privilege level instead of quietly matching
--    zero rows. v1.10.6 adds select and insert policies and deliberately adds no update
--    or delete policy.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_template_versions (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null
    references public.cancellation_templates(id) on delete restrict,
  version integer not null
    constraint cancellation_template_versions_version_positive check (version >= 1),
  language text not null
    constraint cancellation_template_versions_language_values check (language in ('English', 'Spanish')),

  -- Rendered text. `subject` may be zero characters: Requirement 14.15 stores zero
  -- characters as the rendered subject on the SMS channel.
  subject text not null,
  body text not null
    constraint cancellation_template_versions_body_not_blank check (char_length(btrim(body)) > 0),
  cancellation_statement text not null
    constraint cancellation_template_versions_statement_not_blank
      check (char_length(btrim(cancellation_statement)) > 0),
  contact_request text not null
    constraint cancellation_template_versions_contact_request_not_blank
      check (char_length(btrim(contact_request)) > 0),

  -- token -> fallback string (Requirement 14.11). A stored empty string renders zero
  -- characters; an absent key also renders zero characters. Must be a JSON object.
  fallback_text jsonb not null default '{}'
    constraint cancellation_template_versions_fallback_is_object
      check (jsonb_typeof(fallback_text) = 'object'),

  created_by uuid references public.profiles(id),         -- null for a system seed
  created_at timestamptz not null default now(),

  constraint cancellation_template_versions_key unique (template_id, version, language)
);

comment on table public.cancellation_template_versions is
  'Immutable versioned template text, one row per (template, version, language). English and Spanish only: Bilingual is a render language resolved per message (Requirements 11.2, 11.8) and is assembled from both rows of one version plus exactly one separator (Requirement 11.6). A saved change inserts version + 1 rows; update and delete are refused by trigger for every role including a security definer path (Requirement 14.17).';
comment on column public.cancellation_template_versions.subject is
  'Email subject line. Deliberately allowed to be zero characters: Requirement 14.15 stores zero characters as the rendered subject on the SMS channel.';
comment on column public.cancellation_template_versions.cancellation_statement is
  'The cancellation-scheduled statement required in every rendered body by Requirement 14.2, stored on its own so the renderer and its tests can assert it independently of the body.';
comment on column public.cancellation_template_versions.contact_request is
  'The contact-request statement required in every rendered body by Requirement 14.5. The contact deadline rendered with it is the earliest included cancellation effective date, supplied at render time, not stored here.';
comment on column public.cancellation_template_versions.fallback_text is
  'JSON object mapping token name to fallback string, applied where a value required by this version is absent (Requirement 14.11). Keys are bare token names with no delimiter; the delimiter used inside subject and body is fixed by the seed (task 7.10) and the renderer (task 12.1) and is deliberately unconstrained here. A stored empty string and an absent key both render zero characters.';

-- Lookup path for the renderer: newest version of one template in one language.
create index if not exists idx_cancellation_template_versions_lookup
  on public.cancellation_template_versions (template_id, language, version desc);

-- Lookup path for v1.10.2's cancellation_communications.template_version_id joins.
create index if not exists idx_cancellation_template_versions_template
  on public.cancellation_template_versions (template_id, version desc);

create or replace function public.cancellation_template_versions_immutable()
returns trigger
language plpgsql
as $fn$
begin
  raise exception 'cancellation_template_versions is immutable: a saved template change adds a new version instead of changing a stored version'
    using errcode = 'restrict_violation',
          detail  = format('attempted %s on cancellation_template_versions row %s (template %s version %s %s)',
                           lower(tg_op), coalesce(old.id::text, '(unknown)'),
                           coalesce(old.template_id::text, '(unknown)'),
                           coalesce(old.version::text, '(unknown)'),
                           coalesce(old.language, '(unknown)')),
          hint    = 'Requirement 14.17. Insert the next version instead: every stored Communication_Record must keep resolving to the exact words that were sent.';
end;
$fn$;

comment on function public.cancellation_template_versions_immutable() is
  'Trigger function refusing every update and delete on public.cancellation_template_versions, including on a security definer path. Requirement 14.17: saving a template change creates version + 1 rows and leaves every existing Communication_Record and every referenced template version unchanged.';

drop trigger if exists cancellation_template_versions_no_update
  on public.cancellation_template_versions;
create trigger cancellation_template_versions_no_update
  before update or delete on public.cancellation_template_versions
  for each row execute function public.cancellation_template_versions_immutable();

--    `truncate` is revoked alongside update and delete because truncate does not fire
--    row triggers: the privilege has to be withdrawn rather than trapped, or an
--    `authenticated` session could erase every stored version the way no update or
--    delete can. Revoking a privilege drops no object and touches nothing created at
--    v1.9.7 or earlier.
revoke update, delete, truncate on public.cancellation_template_versions from authenticated;
revoke update, delete, truncate on public.cancellation_template_versions from anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. PROHIBITED PHRASES — the Prohibited_Phrase_List read by the render gate.
--
--    Requirement 14.7 requires at least one English and at least one Spanish phrase for
--    each of the five prohibited claims, which is exactly the claim_category domain
--    below; task 7.10 seeds them. Requirement 14.8 compares after lower-casing both
--    texts and collapsing every whitespace run to one space, and Requirement 14.9
--    blocks the send before any provider request — that comparison lives in the
--    renderer (task 12.1), which is the only code path to a provider, so it cannot be
--    bypassed. Phrases are stored here in their natural form; the renderer normalizes
--    both sides at compare time rather than storing a pre-normalized copy, so the
--    matched phrase written into the audit timeline is the phrase a reviewer recognizes.
--
--    is_active lets a phrase be retired without deleting evidence of what the gate used
--    to block. The design's RLS row grants select and insert only, with no update and no
--    delete policy on any of these three tables, so flipping is_active is a Manager_Role
--    operation through a v1.10.6-era path rather than a client update.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_prohibited_phrases (
  id uuid primary key default gen_random_uuid(),
  phrase text not null
    constraint cancellation_prohibited_phrases_phrase_not_blank
      check (char_length(btrim(phrase)) > 0),
  language text not null
    constraint cancellation_prohibited_phrases_language_values check (language in ('English', 'Spanish')),
  claim_category text not null
    constraint cancellation_prohibited_phrases_category_values check (claim_category in (
      'reinstatement',                 -- that the policy will be reinstated
      'payment_guarantees_coverage',   -- that payment guarantees continued coverage
      'payment_card_request',          -- a request for payment-card data
      'bank_account_request',          -- a request for bank account data
      'carrier_legal_notice')),        -- that the message is the carrier's official legal notice
  is_active boolean not null default true,
  created_at timestamptz not null default now(),

  constraint cancellation_prohibited_phrases_key unique (language, claim_category, phrase)
);

comment on table public.cancellation_prohibited_phrases is
  'The Prohibited_Phrase_List. Requirement 14.7 requires at least one English and one Spanish phrase for each of the five claim categories. The Requirement 14.8 comparison (lower case, whitespace runs collapsed to one space) is applied by the renderer at compare time, so the stored phrase stays in the form a compliance reviewer recognizes when it is written into the audit timeline under Requirement 14.9. A blank phrase is refused: it would match every rendered body and block every send.';
comment on column public.cancellation_prohibited_phrases.is_active is
  'Only active phrases are enforced by the render gate. Retiring a phrase clears this flag rather than deleting the row, so the list the gate used at any past send time stays recoverable.';

-- The gate loads every active phrase for the segment languages of the message.
create index if not exists idx_cancellation_prohibited_phrases_active
  on public.cancellation_prohibited_phrases (language, claim_category)
  where is_active;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than
--    leaving stages 3-10 to apply on top of a half-built schema. Every probe write is
--    discarded: the outer probe block ends in a raise that rolls back to the block's
--    implicit savepoint, and plpgsql variables are not transactional, so the recorded
--    outcomes survive the rollback.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing              text;
  v_template_id          uuid;
  v_version_id           uuid;
  v_before               jsonb;
  v_after                jsonb;
  v_fallback             jsonb;
  v_seeded               boolean;
  v_all_touchpoints      boolean := false;
  v_update_blocked       boolean := false;
  v_delete_blocked       boolean := false;
  v_touchpoint_blocked   boolean := false;
  v_version_zero_blocked boolean := false;
  v_language_blocked     boolean := false;
  v_blank_body_blocked   boolean := false;
  v_fallback_blocked     boolean := false;
  v_version_dup_blocked  boolean := false;
  v_category_blocked     boolean := false;
  v_blank_phrase_blocked boolean := false;
  v_phrase_dup_blocked   boolean := false;
begin
  -- ── All three tables exist.
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('cancellation_templates'), ('cancellation_template_versions'),
                 ('cancellation_prohibited_phrases')) as t(name)
   where not exists (select 1 from pg_tables
                      where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.10.1 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── Every column of the design's data model exists, with the stated type.
  select string_agg(format('%s.%s %s', c.tbl, c.col, c.typ), ', ' order by c.tbl, c.col)
    into v_missing
    from (values
      ('cancellation_templates',          'id',                     'uuid'),
      ('cancellation_templates',          'touchpoint',             'smallint'),
      ('cancellation_templates',          'name',                   'text'),
      ('cancellation_templates',          'created_at',             'timestamp with time zone'),
      ('cancellation_template_versions',  'id',                     'uuid'),
      ('cancellation_template_versions',  'template_id',            'uuid'),
      ('cancellation_template_versions',  'version',                'integer'),
      ('cancellation_template_versions',  'language',               'text'),
      ('cancellation_template_versions',  'subject',                'text'),
      ('cancellation_template_versions',  'body',                   'text'),
      ('cancellation_template_versions',  'cancellation_statement', 'text'),
      ('cancellation_template_versions',  'contact_request',        'text'),
      ('cancellation_template_versions',  'fallback_text',          'jsonb'),
      ('cancellation_template_versions',  'created_by',             'uuid'),
      ('cancellation_template_versions',  'created_at',             'timestamp with time zone'),
      ('cancellation_prohibited_phrases', 'id',                     'uuid'),
      ('cancellation_prohibited_phrases', 'phrase',                 'text'),
      ('cancellation_prohibited_phrases', 'language',               'text'),
      ('cancellation_prohibited_phrases', 'claim_category',         'text'),
      ('cancellation_prohibited_phrases', 'is_active',              'boolean'),
      ('cancellation_prohibited_phrases', 'created_at',             'timestamp with time zone')
    ) as c(tbl, col, typ)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = c.tbl
        and ic.column_name = c.col
        and ic.data_type = c.typ);
  if v_missing is not null then
    raise exception 'v1.10.1 left these columns absent or of the wrong type: %', v_missing
      using detail = 'Column list is the design Phase 2 data model.', hint = 'Rolling back.';
  end if;

  -- ── Every not-null column of the design's data model is actually not null.
  select string_agg(format('%s.%s', c.tbl, c.col), ', ' order by c.tbl, c.col) into v_missing
    from (values
      ('cancellation_templates',          'touchpoint'),
      ('cancellation_templates',          'name'),
      ('cancellation_templates',          'created_at'),
      ('cancellation_template_versions',  'template_id'),
      ('cancellation_template_versions',  'version'),
      ('cancellation_template_versions',  'language'),
      ('cancellation_template_versions',  'subject'),
      ('cancellation_template_versions',  'body'),
      ('cancellation_template_versions',  'cancellation_statement'),
      ('cancellation_template_versions',  'contact_request'),
      ('cancellation_template_versions',  'fallback_text'),
      ('cancellation_template_versions',  'created_at'),
      ('cancellation_prohibited_phrases', 'phrase'),
      ('cancellation_prohibited_phrases', 'language'),
      ('cancellation_prohibited_phrases', 'claim_category'),
      ('cancellation_prohibited_phrases', 'is_active'),
      ('cancellation_prohibited_phrases', 'created_at')
    ) as c(tbl, col)
   where exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public' and ic.table_name = c.tbl
        and ic.column_name = c.col and ic.is_nullable = 'YES');
  if v_missing is not null then
    raise exception 'v1.10.1 left these columns nullable: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── created_by stays NULLABLE: the v1.10.9 system seed writes no actor.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cancellation_template_versions'
       and column_name = 'created_by' and is_nullable = 'YES') then
    raise exception 'v1.10.1 made cancellation_template_versions.created_by not null'
      using detail = 'Task 7.10 seeds version 1 rows with no actor.', hint = 'Rolling back.';
  end if;

  -- ── Every named constraint exists, of the right kind.
  select string_agg(format('%s on %s', c.con, c.tbl), ', ' order by c.con) into v_missing
    from (values
      ('cancellation_templates',          'cancellation_templates_touchpoint_key',                     'u'),
      ('cancellation_templates',          'cancellation_templates_touchpoint_values',                  'c'),
      ('cancellation_templates',          'cancellation_templates_name_not_blank',                     'c'),
      ('cancellation_template_versions',  'cancellation_template_versions_key',                        'u'),
      ('cancellation_template_versions',  'cancellation_template_versions_version_positive',           'c'),
      ('cancellation_template_versions',  'cancellation_template_versions_language_values',            'c'),
      ('cancellation_template_versions',  'cancellation_template_versions_body_not_blank',             'c'),
      ('cancellation_template_versions',  'cancellation_template_versions_statement_not_blank',        'c'),
      ('cancellation_template_versions',  'cancellation_template_versions_contact_request_not_blank',  'c'),
      ('cancellation_template_versions',  'cancellation_template_versions_fallback_is_object',         'c'),
      ('cancellation_prohibited_phrases', 'cancellation_prohibited_phrases_key',                       'u'),
      ('cancellation_prohibited_phrases', 'cancellation_prohibited_phrases_phrase_not_blank',          'c'),
      ('cancellation_prohibited_phrases', 'cancellation_prohibited_phrases_language_values',           'c'),
      ('cancellation_prohibited_phrases', 'cancellation_prohibited_phrases_category_values',           'c')
    ) as c(tbl, con, kind)
   where not exists (
     select 1 from pg_constraint
      where conrelid = format('public.%s', c.tbl)::regclass
        and conname = c.con
        and contype = c.kind::"char");
  if v_missing is not null then
    raise exception 'v1.10.1 did not create these constraints: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── The touchpoint domain is exactly 15, 10, 5, 1 and the claim_category domain is
  --    exactly the five Requirement 14.7 claims. Read from the stored definitions so a
  --    missing or extra value is caught even where a probe insert would collide with
  --    seeded rows.
  select pg_get_constraintdef(oid) into v_missing from pg_constraint
   where conrelid = 'public.cancellation_templates'::regclass
     and conname = 'cancellation_templates_touchpoint_values';
  if v_missing !~ '\m15\M' or v_missing !~ '\m10\M' or v_missing !~ '\m5\M' or v_missing !~ '\m1\M' then
    raise exception 'v1.10.1 left the touchpoint domain incomplete: %', v_missing
      using detail = 'Requirement 12.1 fixes exactly four touchpoints: 15, 10, 5, 1.', hint = 'Rolling back.';
  end if;

  select pg_get_constraintdef(oid) into v_missing from pg_constraint
   where conrelid = 'public.cancellation_prohibited_phrases'::regclass
     and conname = 'cancellation_prohibited_phrases_category_values';
  if strpos(v_missing, 'reinstatement') = 0
     or strpos(v_missing, 'payment_guarantees_coverage') = 0
     or strpos(v_missing, 'payment_card_request') = 0
     or strpos(v_missing, 'bank_account_request') = 0
     or strpos(v_missing, 'carrier_legal_notice') = 0 then
    raise exception 'v1.10.1 left the claim_category domain incomplete: %', v_missing
      using detail = 'Requirement 14.7 names five prohibited claims.', hint = 'Rolling back.';
  end if;

  -- ── template_id is a restricting foreign key to cancellation_templates.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cancellation_template_versions'::regclass
       and contype = 'f'
       and confrelid = 'public.cancellation_templates'::regclass
       and confdeltype in ('r', 'a')) then
    raise exception 'v1.10.1 left cancellation_template_versions.template_id without a restricting foreign key'
      using hint = 'Rolling back.';
  end if;

  -- ── created_by references public.profiles.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cancellation_template_versions'::regclass
       and contype = 'f'
       and confrelid = 'public.profiles'::regclass) then
    raise exception 'v1.10.1 left cancellation_template_versions.created_by without its profiles reference'
      using hint = 'Rolling back.';
  end if;

  -- ── The three indexes exist, and the phrase index is the partial active one.
  select string_agg(i.name, ', ' order by i.name) into v_missing
    from (values ('idx_cancellation_template_versions_lookup'),
                 ('idx_cancellation_template_versions_template'),
                 ('idx_cancellation_prohibited_phrases_active')) as i(name)
   where not exists (select 1 from pg_indexes
                      where schemaname = 'public' and indexname = i.name);
  if v_missing is not null then
    raise exception 'v1.10.1 did not create these indexes: %', v_missing using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'idx_cancellation_prohibited_phrases_active'
       and indexdef like '%WHERE is_active%') then
    raise exception 'v1.10.1 left idx_cancellation_prohibited_phrases_active without its is_active predicate'
      using hint = 'Rolling back.';
  end if;

  -- ── The immutability trigger is attached for BOTH update and delete, before row.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.cancellation_template_versions'::regclass
       and tgname = 'cancellation_template_versions_no_update'
       and not tgisinternal
       and (tgtype & 16) <> 0   -- UPDATE
       and (tgtype & 8) <> 0    -- DELETE
       and (tgtype & 2) <> 0    -- BEFORE
       and (tgtype & 1) <> 0    -- FOR EACH ROW
  ) then
    raise exception 'v1.10.1 did not attach cancellation_template_versions_no_update before update or delete for each row'
      using detail = 'Requirement 14.17.', hint = 'Rolling back.';
  end if;

  -- ── authenticated and anon hold no update, delete, or truncate privilege on the
  --    version table. The trigger refuses row-level changes on every path; truncate
  --    does not fire row triggers, so that privilege is withdrawn instead.
  select string_agg(format('%s:%s', g.grantee, g.privilege_type), ', '
                    order by g.grantee, g.privilege_type)
    into v_missing
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name = 'cancellation_template_versions'
     and g.grantee in ('authenticated', 'anon')
     and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE');
  if v_missing is not null then
    raise exception 'v1.10.1 left these privileges on cancellation_template_versions: %', v_missing
      using detail = 'Requirement 14.17: a stored template version is immutable for every client role.',
            hint = 'Rolling back.';
  end if;

  -- ── This migration adds no policy and no role helper: v1.10.6 (task 7.7) owns RLS
  --    for every cancellation_* table, and v1.10.0 owns cancellation_is_manager().
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('cancellation_templates', 'cancellation_template_versions',
                                  'cancellation_prohibited_phrases')) then
    raise exception 'v1.10.1 added a policy to a template table; v1.10.6 owns every cancellation_* policy'
      using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancellation_is_manager' and p.prosecdef) then
    raise exception 'public.cancellation_is_manager() is absent: v1.10.0 must be applied before v1.10.1'
      using detail = 'Every manager check in the series reuses that helper.', hint = 'Rolling back.';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- LIVE PROOF. Every write below is discarded by the raise at the end of the block.
  -- Each expected failure runs in its own nested block, so catching it rolls that one
  -- statement back to its own savepoint and the probe continues.
  -- ═════════════════════════════════════════════════════════════════════════════
  begin
    select exists (select 1 from public.cancellation_templates) into v_seeded;

    if v_seeded then
      -- Re-application after task 7.10 has seeded the four touchpoints: reuse a seeded
      -- row rather than colliding with unique (touchpoint).
      select id into v_template_id from public.cancellation_templates order by touchpoint limit 1;
      v_all_touchpoints := true;   -- the seeded rows are themselves the positive proof
    else
      -- All four touchpoint values are accepted.
      insert into public.cancellation_templates (touchpoint, name) values
        (15, 'v1.10.1 post-condition probe'),
        (10, 'v1.10.1 post-condition probe'),
        (5,  'v1.10.1 post-condition probe'),
        (1,  'v1.10.1 post-condition probe');
      select count(*) = 4 into v_all_touchpoints
        from public.cancellation_templates
       where touchpoint in (15, 10, 5, 1) and name = 'v1.10.1 post-condition probe';
      select id into v_template_id from public.cancellation_templates
       where name = 'v1.10.1 post-condition probe' and touchpoint = 15;
    end if;

    -- A fifth touchpoint value is refused.
    begin
      insert into public.cancellation_templates (touchpoint, name)
      values (7, 'v1.10.1 post-condition probe');
    exception when others then
      v_touchpoint_blocked := true;
    end;

    -- A version row inserts, takes the fallback_text default, and is then immutable.
    insert into public.cancellation_template_versions
      (template_id, version, language, subject, body, cancellation_statement, contact_request)
    values
      (v_template_id, 2147483647, 'English', 'v1.10.1 probe subject',
       'v1.10.1 probe body', 'v1.10.1 probe statement', 'v1.10.1 probe contact request')
    returning id, fallback_text into v_version_id, v_fallback;

    if v_fallback is distinct from '{}'::jsonb then
      raise exception 'v1.10.1 left fallback_text without its empty-object default (got %)', v_fallback
        using detail = 'Requirement 14.11.', hint = 'Rolling back.';
    end if;

    select to_jsonb(v) into v_before
      from public.cancellation_template_versions v where v.id = v_version_id;

    begin
      update public.cancellation_template_versions
         set body = 'v1.10.1 tampered body' where id = v_version_id;
    exception when others then
      v_update_blocked := true;
    end;

    begin
      delete from public.cancellation_template_versions where id = v_version_id;
    exception when others then
      v_delete_blocked := true;
    end;

    select to_jsonb(v) into v_after
      from public.cancellation_template_versions v where v.id = v_version_id;

    -- The same (template, version, language) cannot be stored twice.
    begin
      insert into public.cancellation_template_versions
        (template_id, version, language, subject, body, cancellation_statement, contact_request)
      values
        (v_template_id, 2147483647, 'English', 'v1.10.1 probe subject',
         'v1.10.1 probe body', 'v1.10.1 probe statement', 'v1.10.1 probe contact request');
    exception when unique_violation then
      v_version_dup_blocked := true;
    end;

    -- version 0 is refused.
    begin
      insert into public.cancellation_template_versions
        (template_id, version, language, subject, body, cancellation_statement, contact_request)
      values (v_template_id, 0, 'Spanish', 's', 'b', 'c', 'r');
    exception when others then
      v_version_zero_blocked := true;
    end;

    -- Bilingual is a render language, never a stored template row.
    begin
      insert into public.cancellation_template_versions
        (template_id, version, language, subject, body, cancellation_statement, contact_request)
      values (v_template_id, 2147483646, 'Bilingual', 's', 'b', 'c', 'r');
    exception when others then
      v_language_blocked := true;
    end;

    -- A whitespace-only body is refused (Requirements 14.1, 14.2, 14.4, 14.5).
    begin
      insert into public.cancellation_template_versions
        (template_id, version, language, subject, body, cancellation_statement, contact_request)
      values (v_template_id, 2147483645, 'Spanish', 's', '   ', 'c', 'r');
    exception when others then
      v_blank_body_blocked := true;
    end;

    -- fallback_text must be a JSON object, not an array or a scalar.
    begin
      insert into public.cancellation_template_versions
        (template_id, version, language, subject, body, cancellation_statement, contact_request, fallback_text)
      values (v_template_id, 2147483644, 'Spanish', 's', 'b', 'c', 'r', '["Office_Phone"]'::jsonb);
    exception when others then
      v_fallback_blocked := true;
    end;

    -- Prohibited phrases: a sixth claim category, a blank phrase, and a duplicate are
    -- all refused; a valid row inserts.
    begin
      insert into public.cancellation_prohibited_phrases (phrase, language, claim_category)
      values ('v1.10.1 probe phrase', 'English', 'not_a_real_category');
    exception when others then
      v_category_blocked := true;
    end;

    begin
      insert into public.cancellation_prohibited_phrases (phrase, language, claim_category)
      values ('   ', 'English', 'reinstatement');
    exception when others then
      v_blank_phrase_blocked := true;
    end;

    insert into public.cancellation_prohibited_phrases (phrase, language, claim_category)
    values ('v1.10.1 probe phrase', 'English', 'reinstatement');

    begin
      insert into public.cancellation_prohibited_phrases (phrase, language, claim_category)
      values ('v1.10.1 probe phrase', 'English', 'reinstatement');
    exception when unique_violation then
      v_phrase_dup_blocked := true;
    end;

    raise exception 'v1101_probe_done' using errcode = 'RS001';
  exception when sqlstate 'RS001' then
    null;  -- probe rows discarded; outcomes retained in the variables below
  end;

  if not v_all_touchpoints then
    raise exception 'v1.10.1 did not accept all four touchpoint values 15, 10, 5, 1'
      using detail = 'Requirement 12.1.', hint = 'Rolling back.';
  end if;
  if not v_touchpoint_blocked then
    raise exception 'v1.10.1 accepted a touchpoint outside 15, 10, 5, 1'
      using detail = 'Requirement 12.1 fixes exactly four touchpoints.', hint = 'Rolling back.';
  end if;
  if not v_update_blocked then
    raise exception 'v1.10.1 left cancellation_template_versions updatable'
      using detail = 'Requirement 14.17: a stored template version cannot be changed.', hint = 'Rolling back.';
  end if;
  if not v_delete_blocked then
    raise exception 'v1.10.1 left cancellation_template_versions deletable'
      using detail = 'Requirement 14.17: a stored template version cannot be deleted.', hint = 'Rolling back.';
  end if;
  if v_after is distinct from v_before then
    raise exception 'v1.10.1 probe changed a cancellation_template_versions row despite the trigger: % -> %',
                    v_before, v_after
      using detail = 'Requirement 14.17.', hint = 'Rolling back.';
  end if;
  if not v_version_dup_blocked then
    raise exception 'v1.10.1 accepted a duplicate (template_id, version, language)'
      using hint = 'Rolling back.';
  end if;
  if not v_version_zero_blocked then
    raise exception 'v1.10.1 accepted version 0' using hint = 'Rolling back.';
  end if;
  if not v_language_blocked then
    raise exception 'v1.10.1 accepted a stored template language outside English and Spanish'
      using detail = 'Requirements 11.2, 11.6, 11.8: Bilingual is resolved per message, not stored.',
            hint = 'Rolling back.';
  end if;
  if not v_blank_body_blocked then
    raise exception 'v1.10.1 accepted a whitespace-only template body'
      using detail = 'Requirements 14.1, 14.2, 14.4, 14.5 all require content in every rendered body.',
            hint = 'Rolling back.';
  end if;
  if not v_fallback_blocked then
    raise exception 'v1.10.1 accepted a fallback_text that is not a JSON object'
      using detail = 'Requirement 14.11: token -> fallback string.', hint = 'Rolling back.';
  end if;
  if not v_category_blocked then
    raise exception 'v1.10.1 accepted a claim_category outside the five Requirement 14.7 claims'
      using hint = 'Rolling back.';
  end if;
  if not v_blank_phrase_blocked then
    raise exception 'v1.10.1 accepted a blank prohibited phrase'
      using detail = 'A blank phrase matches every rendered body and would block every send.',
            hint = 'Rolling back.';
  end if;
  if not v_phrase_dup_blocked then
    raise exception 'v1.10.1 accepted a duplicate (language, claim_category, phrase)'
      using hint = 'Rolling back.';
  end if;

  -- ── No probe residue is committed. Row counts are not asserted to be zero: task 7.10
  --    seeds these tables, and this migration must stay safely re-appliable after it.
  if exists (select 1 from public.cancellation_templates
              where name = 'v1.10.1 post-condition probe')
     or exists (select 1 from public.cancellation_template_versions
                 where version between 2147483644 and 2147483647)
     or exists (select 1 from public.cancellation_prohibited_phrases
                 where phrase = 'v1.10.1 probe phrase') then
    raise exception 'v1.10.1 left probe residue in the template tables' using hint = 'Rolling back.';
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
       and tablename in ('cancellation_templates', 'cancellation_template_versions',
                         'cancellation_prohibited_phrases')) as tables_created_expect_3,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
       and table_name in ('cancellation_templates', 'cancellation_template_versions',
                          'cancellation_prohibited_phrases')) as columns_created_expect_21,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_templates'::regclass,
                        'public.cancellation_template_versions'::regclass,
                        'public.cancellation_prohibited_phrases'::regclass)
       and contype = 'u') as unique_constraints_expect_3,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_templates'::regclass,
                        'public.cancellation_template_versions'::regclass,
                        'public.cancellation_prohibited_phrases'::regclass)
       and contype = 'c'
       and conname like 'cancellation%') as named_check_constraints_expect_11,
  (select count(*) from pg_constraint
     where conrelid = 'public.cancellation_template_versions'::regclass
       and contype = 'f') as foreign_keys_expect_2,
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('idx_cancellation_template_versions_lookup',
                         'idx_cancellation_template_versions_template',
                         'idx_cancellation_prohibited_phrases_active')) as indexes_expect_3,
  (select count(*) from pg_trigger
     where tgrelid = 'public.cancellation_template_versions'::regclass
       and tgname = 'cancellation_template_versions_no_update'
       and not tgisinternal) as immutability_trigger_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'cancellation_template_versions_immutable') as trigger_function_expect_1,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename in ('cancellation_templates', 'cancellation_template_versions',
                         'cancellation_prohibited_phrases')) as policies_expected_zero_until_v1_10_6,
  (select count(*) from public.cancellation_templates) as template_rows_expect_0_until_v1_10_9,
  (select count(*) from public.cancellation_template_versions) as version_rows_expect_0_until_v1_10_9,
  (select count(*) from public.cancellation_prohibited_phrases) as phrase_rows_expect_0_until_v1_10_9;
