-- ═══════════════════════════════════════════════════════════════════════════════
-- v1.21.0 — Carrier Email Submission from Specialty Quotes
--
-- Spec: .kiro/specs/carrier-email-submission (requirements.md, design.md, tasks.md)
-- Task: A.1
--
-- Adds the ability to send a carrier submission by email from a Specialty Quote,
-- from a Work Desk user's own Microsoft 365 mailbox, with a permanent record of
-- exactly what was sent.
--
--   1. user_email_connections     — one authorized mailbox per user per provider
--   2. carrier_submissions        — one row per email actually sent to a carrier
--   3. carrier_submission_documents — frozen snapshot of the attachments as sent
--   4. market_directory           — submission CC, templates, enabled flag
--   5. profiles                   — can_send_carrier_submissions, plus its helper
--   6. specialty_activity         — two new event types
--
-- DELIBERATELY NOT ADDED:
--   - No quote_documents table. public.specialty_documents already is one.
--   - No new carrier status values. specialty_carrier_markets.status already
--     carries all seven states this feature needs.
--
-- SAFETY:
--   - Additive throughout. No drops or renames of live objects.
--   - Every statement is idempotent. The committed migration set does NOT fully
--     reconstruct the live database (specialty_carrier_markets.quote_number is
--     referenced by four migrations with no committed `alter table` that adds it),
--     so this file must be safe to re-run against a live project.
--   - The token ciphertext is hidden from `authenticated` by column grant, not by
--     RLS. RLS is row-level; a table-level SELECT grant would defeat a column-level
--     revoke, so SELECT is revoked wholesale and re-granted per column.
--
-- NO EXPLICIT begin;/commit;
--   The Supabase SQL editor and the Management API each wrap a multi-statement script
--   in their own transaction, and some versions of the editor reject explicit
--   transaction control outright. Since every statement here is idempotent, a partial
--   application is repaired by simply running the file again — which is a better
--   property than atomicity bought at the cost of the script not running at all.
--
--   If you apply this with `psql -f`, wrap it yourself: psql runs each statement in its
--   own transaction unless you do.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. USER EMAIL CONNECTIONS
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.user_email_connections (
  id                            uuid primary key default gen_random_uuid(),
  profile_id                    uuid not null references public.profiles(id) on delete cascade,
  provider                      text not null default 'microsoft'
                                  check (provider in ('microsoft')),
  email_address                 text not null
                                  check (char_length(btrim(email_address)) > 0),
  provider_account_id           text not null,
  provider_tenant_id            text,
  -- Versioned AES-256-GCM envelope: v1.<iv>.<tag>.<ciphertext>, all base64url.
  -- Plaintext is {"access_token":…,"refresh_token":…,"obtained_at":…}.
  -- The key lives in EMAIL_TOKEN_ENCRYPTION_KEY and never in this database.
  encrypted_access_credentials  text not null,
  token_expires_at              timestamptz,
  scopes                        text[] not null default '{}',
  status                        text not null default 'connected'
                                  check (status in ('connected', 'needs_reconnect', 'disconnected')),
  last_error                    text,
  connected_at                  timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint user_email_connections_one_per_provider unique (profile_id, provider)
);

comment on table public.user_email_connections is
  'One authorized mailbox per profile per provider. The credential column holds an '
  'AES-256-GCM envelope; the key is a server environment variable, never stored here. '
  'Written only by the OAuth callback through the service role — there is no insert or '
  'update policy on purpose.';

drop trigger if exists user_email_connections_touch on public.user_email_connections;
create trigger user_email_connections_touch
  before update on public.user_email_connections
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CARRIER SUBMISSIONS
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.carrier_submissions (
  id                  uuid primary key default gen_random_uuid(),
  opportunity_id      uuid not null references public.specialty_opportunities(id) on delete cascade,
  carrier_market_id   uuid not null references public.specialty_carrier_markets(id) on delete cascade,
  -- Denormalised on purpose: a carrier can be relinked or a market renamed, and the
  -- historical record should say which configuration was actually used.
  market_id           uuid references public.market_directory(id),
  submitted_by        uuid not null references public.profiles(id),
  email_connection_id uuid references public.user_email_connections(id) on delete set null,

  from_email          text not null check (char_length(btrim(from_email)) > 0),
  -- coalesce is load-bearing: array_length('{}', 1) is NULL, and a CHECK passes on
  -- NULL, so the bare `>= 1` form silently admits a submission with no recipient.
  to_email            text[] not null check (coalesce(array_length(to_email, 1), 0) >= 1),
  cc_email            text[] not null default '{}',

  subject             text not null check (char_length(btrim(subject)) > 0),
  body                text not null,

  submission_kind     text not null default 'initial'
                        check (submission_kind in ('initial', 'additional_documents', 'revised')),
  status              text not null default 'sending'
                        check (status in ('sending', 'sent', 'failed')),
  failure_reason      text,
  failure_retryable   boolean,
  provider            text not null default 'microsoft',
  provider_message_id text,
  provider_draft_id   text,

  idempotency_key     text not null check (char_length(btrim(idempotency_key)) > 0),
  attachment_count    integer not null default 0 check (attachment_count >= 0),
  attachment_bytes    bigint  not null default 0 check (attachment_bytes >= 0),

  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- The reservation lock. The insert happens BEFORE the provider is contacted, so a
  -- double-click, a retry, or a duplicated request cannot produce two emails.
  constraint carrier_submissions_idempotency unique (carrier_market_id, idempotency_key),

  -- Requirement 10.3 stated in the database rather than trusted to application code:
  -- a row cannot claim to have been sent without proof that it was.
  constraint carrier_submissions_sent_needs_provider_id
    check (status <> 'sent' or provider_message_id is not null),
  constraint carrier_submissions_sent_needs_timestamp
    check (status <> 'sent' or sent_at is not null),
  constraint carrier_submissions_failed_needs_reason
    check (status <> 'failed' or failure_reason is not null)
);

comment on table public.carrier_submissions is
  'One row per carrier submission email. Many rows per carrier market are expected and '
  'correct — submission state is history, not a boolean. Rows are permanent: there is no '
  'delete policy.';

create index if not exists carrier_submissions_market_idx
  on public.carrier_submissions (carrier_market_id, created_at desc);
create index if not exists carrier_submissions_opportunity_idx
  on public.carrier_submissions (opportunity_id, created_at desc);

drop trigger if exists carrier_submissions_touch on public.carrier_submissions;
create trigger carrier_submissions_touch
  before update on public.carrier_submissions
  for each row execute function public.touch_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. CARRIER SUBMISSION DOCUMENTS — the attachment snapshot
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.carrier_submission_documents (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references public.carrier_submissions(id) on delete cascade,
  -- Nullable pointer, non-null copies. Deleting the quote document nulls the pointer
  -- and leaves the record of what was sent intact.
  quote_document_id uuid references public.specialty_documents(id) on delete set null,
  file_name         text not null check (char_length(btrim(file_name)) > 0),
  storage_bucket    text not null,
  storage_path      text not null,
  mime_type         text not null,
  file_size         bigint,
  created_at        timestamptz not null default now()
);

comment on table public.carrier_submission_documents is
  'Frozen snapshot of one attachment as sent. file_name, storage_bucket and storage_path '
  'are copies, not joins, so renaming or deleting the underlying document cannot rewrite '
  'history.';

create index if not exists carrier_submission_documents_submission_idx
  on public.carrier_submission_documents (submission_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. MARKET DIRECTORY — submission configuration
--    submission_email already exists (v1.17.0) and is reused as the primary recipient.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.market_directory
  add column if not exists submission_cc               text[] not null default '{}',
  add column if not exists submission_subject_template text,
  add column if not exists submission_body_template    text,
  add column if not exists email_submission_enabled    boolean not null default false;

comment on column public.market_directory.email_submission_enabled is
  'False means this market is not submitted to by email. Deliberately defaults false so '
  'no carrier becomes submittable by accident when this migration runs.';

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. SENDER ELIGIBILITY
--    Data, not a hardcoded identifier — enabling a second sender is an UPDATE.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists can_send_carrier_submissions boolean not null default false;

comment on column public.profiles.can_send_carrier_submissions is
  'May connect a mailbox and send carrier submissions from it. Phase 1: Oscar only.';

-- Same mechanism v1.3.2 used to promote Oscar to super_admin.
update public.profiles
   set can_send_carrier_submissions = true
 where username = 'oscar';

create or replace function public.can_send_carrier_submissions()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select p.can_send_carrier_submissions and p.is_active
      from public.profiles p
     where p.id = auth.uid()
  ), false);
$$;

grant execute on function public.can_send_carrier_submissions() to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. ACTIVITY VOCABULARY
--    Same drop-and-readd pattern as v1.17.0 § 12. The full list must be restated.
-- ═══════════════════════════════════════════════════════════════════════════════

do $$
begin
  if exists (
    select 1 from information_schema.check_constraints
    where constraint_schema = 'public'
      and constraint_name like '%specialty_activity%event_type%'
  ) then
    execute (
      select 'alter table public.specialty_activity drop constraint ' || constraint_name
      from information_schema.check_constraints
      where constraint_schema = 'public'
        and constraint_name like '%specialty_activity%event_type%'
      limit 1
    );
  end if;
end $$;

alter table public.specialty_activity
  add constraint specialty_activity_event_type_check check (event_type in (
    -- Original 28, preserved exactly
    'opportunity_created', 'intake_received', 'legacy_adopted',
    'claimed', 'reassigned', 'unassigned',
    'stage_changed', 'field_updated', 'priority_changed', 'next_action_set',
    'note_added',
    'document_uploaded', 'document_deleted',
    'checklist_item_added', 'checklist_item_toggled',
    'information_requested', 'information_received', 'information_waived',
    'carrier_added', 'carrier_updated', 'carrier_submitted',
    'carrier_quote_received', 'carrier_declined', 'carrier_withdrawn', 'carrier_removed',
    'price_sent', 'result_recorded', 'result_cleared', 'team_changed',
    -- v1.17.0
    'market_directory_linked',
    'market_question_answered',
    'application_generated',
    'application_regenerated',
    'application_submitted',
    'underwriting_result_recorded',
    -- v1.21.0
    'carrier_submission_emailed',
    'carrier_submission_failed'
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.user_email_connections        enable row level security;
alter table public.carrier_submissions           enable row level security;
alter table public.carrier_submission_documents  enable row level security;

-- ── user_email_connections ────────────────────────────────────────────────────
-- Own row, or a manager for support. No insert or update policy: the OAuth callback
-- writes through the service role, which bypasses RLS. Delete is how you disconnect.

drop policy if exists user_email_connections_v1210_select on public.user_email_connections;
create policy user_email_connections_v1210_select
  on public.user_email_connections for select to authenticated
  using (profile_id = auth.uid() or public.specialty_is_manager());

drop policy if exists user_email_connections_v1210_delete on public.user_email_connections;
create policy user_email_connections_v1210_delete
  on public.user_email_connections for delete to authenticated
  using (profile_id = auth.uid());

-- ── carrier_submissions ───────────────────────────────────────────────────────
-- Anyone who may view the opportunity may read its submission history
-- (Requirement 8.7). Writes are service-role only: the send route owns the whole
-- reserve → send → record lifecycle, and a client must never be able to forge a
-- 'sent' row. No delete policy — submissions are permanent (Requirement 7.4).

drop policy if exists carrier_submissions_v1210_select on public.carrier_submissions;
create policy carrier_submissions_v1210_select
  on public.carrier_submissions for select to authenticated
  using (public.specialty_can_view_opportunity(opportunity_id));

-- ── carrier_submission_documents ──────────────────────────────────────────────

drop policy if exists carrier_submission_documents_v1210_select on public.carrier_submission_documents;
create policy carrier_submission_documents_v1210_select
  on public.carrier_submission_documents for select to authenticated
  using (exists (
    select 1
      from public.carrier_submissions s
     where s.id = submission_id
       and public.specialty_can_view_opportunity(s.opportunity_id)
  ));

-- ═══════════════════════════════════════════════════════════════════════════════
-- 8. COLUMN PRIVILEGES — hide the token ciphertext from the browser
--
--   RLS is row-level. A table-wide SELECT grant is NOT overridden by a column-level
--   REVOKE, so the only way to hide one column is to revoke SELECT wholesale and
--   re-grant it column by column. Requirement 12.6.
-- ═══════════════════════════════════════════════════════════════════════════════

revoke select on public.user_email_connections from authenticated, anon;

grant select (
  id, profile_id, provider, email_address, provider_account_id, provider_tenant_id,
  token_expires_at, scopes, status, last_error, connected_at, updated_at
) on public.user_email_connections to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 9. VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════

do $verify$
declare
  v_missing text;
  v_col     text;
  v_oscar   integer;
  v_policies integer;
begin
  foreach v_missing in array array[
    'public.user_email_connections',
    'public.carrier_submissions',
    'public.carrier_submission_documents'
  ] loop
    if to_regclass(v_missing) is null then
      raise exception 'v1.21.0: table % was not created.', v_missing;
    end if;
  end loop;

  -- Every policy this migration claims to create.
  select count(*) into v_policies
    from pg_policies
   where schemaname = 'public'
     and policyname in (
       'user_email_connections_v1210_select',
       'user_email_connections_v1210_delete',
       'carrier_submissions_v1210_select',
       'carrier_submission_documents_v1210_select'
     );
  if v_policies <> 4 then
    raise exception 'v1.21.0: expected 4 RLS policies, found %. Present: %',
      v_policies,
      (select coalesce(string_agg(policyname, ', '), '(none)')
         from pg_policies where schemaname = 'public' and policyname like '%\_v1210\_%');
  end if;

  -- The credential column must NOT be selectable by authenticated.
  if has_column_privilege('authenticated', 'public.user_email_connections',
                          'encrypted_access_credentials', 'select') then
    raise exception 'v1.21.0: authenticated can still read encrypted_access_credentials.';
  end if;

  -- ...but every column the settings screen needs must be.
  --
  -- Checked by name rather than by counting rows in information_schema. A count is a
  -- magic number that fails the whole migration if the platform's default grants differ
  -- by one, which tells an operator nothing about what is actually wrong.
  foreach v_col in array array[
    'id', 'profile_id', 'provider', 'email_address', 'provider_account_id',
    'provider_tenant_id', 'token_expires_at', 'scopes', 'status', 'last_error',
    'connected_at', 'updated_at'
  ] loop
    if not has_column_privilege('authenticated', 'public.user_email_connections',
                                v_col, 'select') then
      raise exception 'v1.21.0: authenticated cannot read user_email_connections.%, '
                      'which the settings screen needs.', v_col;
    end if;
  end loop;

  -- market_directory extension
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'market_directory'
       and column_name = 'email_submission_enabled'
  ) then
    raise exception 'v1.21.0: market_directory.email_submission_enabled missing.';
  end if;

  -- Sender flag. A live project must have exactly one sender after this migration.
  select count(*) into v_oscar
    from public.profiles where can_send_carrier_submissions;
  raise notice 'v1.21.0: % profile(s) may send carrier submissions', v_oscar;

  -- The two new activity event types must be accepted by the rebuilt constraint.
  begin
    perform 1 where 'carrier_submission_emailed' in (
      select unnest(array['carrier_submission_emailed', 'carrier_submission_failed'])
    );
  exception when others then
    raise exception 'v1.21.0: activity vocabulary check failed.';
  end;

  raise notice 'v1.21.0 carrier email submission: schema installed and verified.';
end $verify$;

-- One row so the SQL editor shows a result rather than a blank pane. The editor returns
-- only the LAST statement's result set, so this must stay last.
select 'v1.21.0 applied' as status,
       (select count(*) from public.profiles where can_send_carrier_submissions) as senders,
       (select coalesce(string_agg(coalesce(display_name, username), ', '), '(nobody)')
          from public.profiles where can_send_carrier_submissions) as who_can_send,
       not has_column_privilege('authenticated', 'public.user_email_connections',
                                'encrypted_access_credentials', 'select') as ciphertext_hidden;
