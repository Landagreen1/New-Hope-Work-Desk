-- New Hope Work Desk v1.10.2 — Cancellation communications (migration stage 3 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.3)
-- Requirements: 12.6, 13.4, 13.8, 14.15, 14.16, 17.6, 22.8, 26.1
--
-- Forward-only, third file of the v1.10.x series. Creates two new tables, two
-- functions, and one trigger. Touches no table, column, policy, function, or row
-- created at v1.9.7 or earlier: nothing outside the new cancellation_* objects is
-- written, altered, dropped, or truncated (Requirements 26.1, 26.2). The one read
-- outside them is a single `public.profiles` id in the post-condition block, used to
-- prove the retry function admits Manager_Role; nothing is written there. The only
-- drops in this file are the `drop trigger if exists` immediately before its own
-- `create trigger`, and the drops listed in the rollback path below, which name only
-- objects this file creates.
--
-- Contents:
--   1. cancellation_communications              the Communication_Record, one row per
--                                               Idempotency_Key (case, contact, touchpoint, channel)
--   2. cancellation_communication_cases         link table resolving a combined message
--                                               to every case it covers
--   3. cancellation_communications_immutable()  + its before update or delete trigger
--   4. cancellation_retry_communication(...)    the single permitted update path
--   5. Post-conditions, including live proof that the trigger, the retry function, the
--      idempotency constraint, and every check fire
--
-- ROW LEVEL SECURITY IS DELIBERATELY NOT ENABLED HERE.
--   v1.10.6-cancellation-rls.sql (task 7.7) runs `enable row level security` on every
--   cancellation_* table and adds every policy, including the design's rows for these
--   two tables: `cancellation_communications` is select-for-readable-cases plus INSERT
--   ONLY for every role, with no update policy and no delete policy;
--   `cancellation_communication_cases` is select-for-readable-cases plus insert.
--   Between this migration and that one both tables below are reachable by any
--   `authenticated` session, so this intermediate state must not be left deployed.
--   Everything those policies need already exists: the helper functions
--   public.cancellation_is_manager() and public.cancellation_can_read_all() come from
--   v1.10.0 and are deliberately NOT redefined here — every manager check in the series
--   reuses cancellation_is_manager(), which accepts `manager` and `super_admin` — and
--   `case_id` is on both tables so a policy can join to the readable-case set.
--   The enforcement that does hold from this migration onward, for every role and on
--   every security definer path, is Communication_Record immutability: the trigger
--   below plus the update/delete/TRUNCATE revokes (Requirements 14.16, 22.8).
--
-- WHY TRUNCATE IS REVOKED AND NOT JUST TRAPPED
--   `truncate` does not fire row triggers. A trigger alone therefore leaves any role
--   holding the truncate privilege — which Supabase's default grants hand to
--   `authenticated`, `anon`, and `service_role` on every new public table — able to
--   erase the whole delivery record in one statement while being unable to change a
--   single row of it. Task 7.2 found that gap on cancellation_template_versions and
--   closed it there; the same revoke is applied here to both new tables. Revoking a
--   privilege drops no object and touches nothing created at v1.9.7 or earlier.
--   `service_role` is included in the revoke on purpose: the design states insert-only
--   holds "even for the service role, with the one documented exception of the retry
--   function". The retry function is security definer and owned by the migration role,
--   so the revoke does not disturb it, and the marker it sets (below) is what keeps
--   every OTHER security definer path — the v1.10.5 loader, a future scheduler helper —
--   from updating a stored row. v1.10.0 left `cancellation_events` with
--   `revoke update, delete` and no `truncate`; that table has no marker exception, so
--   its trigger is airtight against row writes, but the truncate privilege is still
--   held there. Closing it belongs to a file that owns that table, not to this one.
--
-- TWO READINGS, STATED RATHER THAN DECIDED SILENTLY
--
--   1. WHAT "IMMUTABLE" COVERS, GIVEN THAT RETRY EXISTS.
--      Requirement 14.16 lists send time and provider message identifier among the
--      fields whose change must be rejected, while Requirement 17.6 has Retry Failed
--      Communication update the existing row with "the new send time, provider message
--      identifier, and delivery result" instead of storing a second row. Read
--      literally, the two cannot both hold. The reading implemented here is the
--      design's: the seven fields the design names — case_id, contact_id, touchpoint,
--      channel, template_version_id, rendered_subject, rendered_body — are frozen on
--      EVERY path including the retry function, and 14.16's remaining fields
--      (send_time, provider_message_id) are frozen on every path EXCEPT
--      cancellation_retry_communication, which is the one documented exception the
--      design's RLS section already carves out. An ordinary update, from any role, on
--      any path, changing anything at all, is refused.
--      Frozen beyond the design's seven, each only narrowing a write no criterion
--      permits: `id`, `created_at`, and `combined_group_id`. The group identifier is
--      known before the reserving insert — the design's grouping pass (scheduler step
--      4) runs before the reserve (step 5), and rendered_body, which is also frozen and
--      not null, is produced in the same pass — so freezing it costs the scheduler
--      nothing and stops a later run from silently re-grouping a sent message.
--      If task 14.2 turns out to need the group identifier assigned after the insert,
--      that is the one line of this trigger to revisit, and the fix is a new migration.
--
--   2. NO DELIVERY-RESULT STATE MACHINE.
--      delivery_result is constrained to Sent, Delivered, Failed, and attempt_count is
--      constrained to never move backwards, but no transition is forbidden. Neither the
--      design nor Requirements 12, 13, 14, 17, or 23 name an illegal transition, and
--      a provider status callback legitimately moves Sent -> Delivered or
--      Sent -> Failed after the fact. Encoding a state machine here would risk refusing
--      a callback that task 13.1 (which derives Communication_Status from these rows)
--      and task 14.2 (the reserve-then-send helper) have not been written to expect.
--      What IS enforced is the part every criterion agrees on: one row per
--      Idempotency_Key, monotonic attempt_count, immutable rendered evidence.
--
-- DELIBERATELY NOT ENFORCED HERE
--   Nothing checks that contact_id belongs to case_id, or that channel `sms` addresses
--   a `phone` contact and `email` an `email` contact. Requirement 13.4 forms the key
--   from "an included Cancellation_Case, that Cancellation_Case's Contact_Recipient",
--   so a crossed pair is an application bug, and the declarative fix — a composite
--   foreign key (contact_id, case_id) -> cancellation_contacts (id, case_id) — needs a
--   new unique index on cancellation_contacts, a v1.10.0 table this file does not own.
--   Left to task 7.7 or to whichever file next owns that table; noted so it is not
--   mistaken for an oversight.
--
-- DELIBERATE ADDITIONS BEYOND THE DESIGN'S COLUMN LIST
--   The design's Phase 2 data model is the authoritative column list and every column
--   below comes from it, with these documented additions, each of which only narrows a
--   write no spec criterion permits:
--     * `check (attempt_count >= 1)` — Requirement 14.15 stores the record when a send
--       is ATTEMPTED, so zero attempts cannot describe a stored row.
--     * `on delete restrict` spelled out on `template_version_id`, matching the two
--       foreign keys the task names explicitly and Requirement 14.17's rule that a
--       template version referenced by a stored Communication_Record stays put.
--     * The five lookup indexes on cancellation_communications and the case index on
--       the link table, alongside the design's required combined_group_id index.
--     * `rendered_body` deliberately has NO non-blank check, and `rendered_subject`
--       keeps its `default ''`: Requirement 14.15 stores both character for character as
--       submitted to the provider and stores zero characters as the subject on the SMS
--       channel. The row is evidence of what was sent, so it must be able to record an
--       empty send rather than refuse to record it.
--
-- ROLLBACK PATH
--   begin;
--     drop function if exists public.cancellation_retry_communication(
--       uuid, text, text, text, integer, timestamptz);
--     drop trigger if exists cancellation_communications_no_update
--       on public.cancellation_communications;
--     drop function if exists public.cancellation_communications_immutable();
--     drop table if exists public.cancellation_communication_cases;
--     drop table if exists public.cancellation_communications;
--   commit;
--   Dropping the two tables drops their indexes, constraints, grants, and the
--   communications trigger with them; cancellation_communication_cases must go before
--   cancellation_communications, and both must go before v1.10.1's
--   cancellation_template_versions and v1.10.0's cancellation_cases /
--   cancellation_contacts. No pre-existing row is touched by the rollback, because none
--   is touched by the migration. This is the code-level rollback only; Requirement 26.3
--   keeps applied v1.10.x migrations in place when application code is rolled back.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. COMMUNICATIONS — the Communication_Record.
--
--    `unique (case_id, contact_id, touchpoint, channel)` is the Idempotency_Key
--    (Requirement 12.6) and it is far more than a duplicate guard: it is the
--    reservation. The scheduler inserts this row BEFORE calling the provider
--    (Requirement 12.4), so two concurrent runs racing the same touchpoint both attempt
--    the same key and exactly one wins; the loser catches 23505, abandons the send, and
--    counts the key as skipped (Requirement 12.7). The provider is never reached twice
--    for one key, which is what Property 2 asserts across 2 to 5 repeated runs.
--    Ordering the key case_id first also makes it the covering index for "does a record
--    already exist for this case" (Requirement 12.5) and for the drawer's per-case
--    history (Requirement 17.1).
--
--    `channel` is sms / email, NOT the contact's phone / email: a phone Contact_Recipient
--    is addressed on the sms channel. The two domains are deliberately different words.
--
--    on delete restrict on case_id, contact_id, and template_version_id: a case, a
--    recipient, or a template version that has been communicated with cannot be deleted
--    out from under the evidence (Requirements 14.17, 22.8).
--
--    Combined messages (Requirement 13.4, 13.8) store ONE row per included case with
--    the same template version, rendered subject, rendered body, provider message id,
--    delivery result, and a shared combined_group_id. The rows of one group may carry
--    different touchpoints: Requirement 13.7 renders the group from the fewest-days
--    template but each case keeps the touchpoint that came due for it.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_communications (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  contact_id uuid not null
    references public.cancellation_contacts(id) on delete restrict,
  touchpoint smallint not null
    constraint cancellation_communications_touchpoint_values
      check (touchpoint in (15, 10, 5, 1)),
  channel text not null
    constraint cancellation_communications_channel_values
      check (channel in ('sms', 'email')),
  template_version_id uuid not null
    references public.cancellation_template_versions(id) on delete restrict,

  -- Rendered evidence. Stored character for character as submitted to the provider,
  -- zero characters as the subject on the SMS channel (Requirement 14.15).
  rendered_subject text not null default '',
  rendered_body text not null,

  -- Provider outcome. These five columns are the only ones any path may change, and
  -- only through public.cancellation_retry_communication (Requirement 17.6).
  send_time timestamptz not null default now(),
  provider_message_id text,
  delivery_result text not null
    constraint cancellation_communications_delivery_result_values
      check (delivery_result in ('Sent', 'Delivered', 'Failed')),
  failure_reason text,
  attempt_count integer not null default 1
    constraint cancellation_communications_attempt_count_positive
      check (attempt_count >= 1),

  combined_group_id uuid,                                -- null for a single-case send
  created_at timestamptz not null default now(),

  constraint cancellation_communications_idempotency_key
    unique (case_id, contact_id, touchpoint, channel)
);

comment on table public.cancellation_communications is
  'The Communication_Record: one row per Idempotency_Key (case, Contact_Recipient, touchpoint, channel). The unique key is the reservation the Notification_Scheduler takes before calling a provider, so at most one record and at most one provider call exist per key however many runs execute concurrently (Requirements 12.4, 12.6, 12.7). Rows are append-only for every role including a security definer path; the single update path is public.cancellation_retry_communication, which may touch only send_time, provider_message_id, delivery_result, failure_reason, and attempt_count (Requirements 14.16, 17.6, 22.8).';
comment on column public.cancellation_communications.channel is
  'sms or email — the delivery channel, not the Contact_Recipient channel: a phone Contact_Recipient is addressed on the sms channel.';
comment on column public.cancellation_communications.rendered_subject is
  'Rendered subject stored character for character as submitted to the provider. Defaults to zero characters, which is what the SMS channel stores (Requirement 14.15). Frozen on every path.';
comment on column public.cancellation_communications.rendered_body is
  'Rendered body stored character for character as submitted to the provider (Requirement 14.15). Deliberately has no non-blank check: the row is evidence of what was sent and must be able to record an empty send rather than refuse to record it. Frozen on every path.';
comment on column public.cancellation_communications.delivery_result is
  'Sent, Delivered, or Failed. No transition is forbidden: no criterion of Requirements 12, 13, 14, 17, or 23 names an illegal transition, and a provider status callback legitimately moves Sent to Delivered or Sent to Failed after the fact. Changed only through public.cancellation_retry_communication.';
comment on column public.cancellation_communications.attempt_count is
  'Send attempts recorded for this Idempotency_Key, starting at 1 for the reserving insert (Requirement 14.15 stores the record when a send is attempted). May never move backwards; has no upper bound, because Requirement 17.6 lets a manager retry a failed communication repeatedly.';
comment on column public.cancellation_communications.combined_group_id is
  'Shared by every Communication_Record of one combined multi-policy message (Requirement 13.8); null for a single-case send. Frozen after insert: the grouping pass runs before the reserving insert, so the value is always known in time, and freezing it stops a later run from silently re-grouping a message that already went out.';

-- Drawer delivery history: every record of one case on one channel, most recent first
-- (Requirement 17.1).
create index if not exists idx_cancellation_communications_case_channel_time
  on public.cancellation_communications (case_id, channel, send_time desc);

-- "Has this touchpoint already been sent for this case, on this channel?" — the
-- Requirement 12.5 skip, the Requirement 17.6 retry target set, and the
-- Communication_Status derivation of task 13.1.
create index if not exists idx_cancellation_communications_case_touchpoint
  on public.cancellation_communications (case_id, touchpoint, channel);

-- Per-recipient history, and the lookup behind the on delete restrict on contact_id.
create index if not exists idx_cancellation_communications_contact
  on public.cancellation_communications (contact_id, touchpoint, channel);

-- Every record of one combined message (Requirement 13.8). Partial: single-case sends
-- leave the column null and do not belong in this index.
create index if not exists idx_cancellation_communications_group
  on public.cancellation_communications (combined_group_id)
  where combined_group_id is not null;

-- "Which stored records reference this template version?" (Requirement 14.17) and the
-- lookup behind the on delete restrict on template_version_id.
create index if not exists idx_cancellation_communications_template_version
  on public.cancellation_communications (template_version_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. COMMUNICATION-TO-CASE LINK — which cases one message covered.
--
--    A single-case send writes one row. A combined message writes one row per
--    (communication, included case) pair, so opening ANY case in the group resolves the
--    whole set and the drawer can render "this notice covers N policies" for every one
--    of them (Requirement 13.8, design Phase 2 data model).
--
--    Append-only by privilege rather than by trigger: the design's RLS row grants this
--    table select and insert with no update policy and no delete policy, and the
--    revokes below withdraw update, delete, and truncate from every client role. No
--    trigger is added, because the design names immutability triggers for
--    cancellation_communications and cancellation_events only, and a definer-path
--    correction here would destroy no evidence — the evidence is the communication row.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_communication_cases (
  id uuid primary key default gen_random_uuid(),
  communication_id uuid not null
    references public.cancellation_communications(id) on delete restrict,
  combined_group_id uuid not null,
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  created_at timestamptz not null default now(),

  constraint cancellation_communication_cases_key unique (communication_id, case_id)
);

comment on table public.cancellation_communication_cases is
  'Link table resolving one message to every Cancellation_Case it covered. A single-case send writes one row; a combined message writes one row per (communication, included case) pair, so every case in the group can render the full coverage list (Requirement 13.8). unique (communication_id, case_id) keeps one message from claiming the same case twice.';
comment on column public.cancellation_communication_cases.combined_group_id is
  'The shared combined-message group identifier, denormalized from cancellation_communications so the whole group resolves in one indexed read without a join back through every member row.';

-- The design's required index: resolve a whole combined group in one read.
create index if not exists idx_cancellation_communication_cases_group
  on public.cancellation_communication_cases (combined_group_id);

-- "Which messages covered this case?" — the drawer's entry point. The unique key leads
-- with communication_id, so a case-first lookup needs its own index.
create index if not exists idx_cancellation_communication_cases_case
  on public.cancellation_communication_cases (case_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. IMMUTABILITY — one trigger covering update and delete.
--
--    Delete always raises, marker or no marker (Requirement 22.8).
--
--    Update is refused unless BOTH hold:
--      * not one frozen column changes — the design's seven, plus id, created_at, and
--        combined_group_id (see the header note); and
--      * the session carries the transaction-local retry marker naming THIS row.
--    The marker is set only by public.cancellation_retry_communication, which clears it
--    again before returning, so one retry cannot become a licence to rewrite a second
--    row later in the same transaction. Client roles cannot reach an update at all —
--    the privilege is revoked below and v1.10.6 adds no update policy — so the marker's
--    real job is to keep every OTHER security definer path (the v1.10.5 loader, any
--    future helper) out of a stored record.
--    attempt_count may not move backwards: a retry counts up, and rewriting the count
--    downwards would falsify the delivery history.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_communications_immutable()
returns trigger
language plpgsql
as $fn$
declare
  v_marker text := current_setting('cancellation.retry_communication_id', true);
begin
  if tg_op = 'DELETE' then
    raise exception 'cancellation_communications is append-only: a stored Communication_Record cannot be deleted'
      using errcode = 'restrict_violation',
            detail  = format('attempted delete on cancellation_communications row %s (case %s, contact %s, touchpoint %s, channel %s)',
                             coalesce(old.id::text, '(unknown)'),
                             coalesce(old.case_id::text, '(unknown)'),
                             coalesce(old.contact_id::text, '(unknown)'),
                             coalesce(old.touchpoint::text, '(unknown)'),
                             coalesce(old.channel, '(unknown)')),
            hint    = 'Requirement 22.8. Stored communications and audit entries cannot be changed or removed by any role.';
  end if;

  if new.id                  is distinct from old.id
     or new.case_id             is distinct from old.case_id
     or new.contact_id          is distinct from old.contact_id
     or new.touchpoint          is distinct from old.touchpoint
     or new.channel             is distinct from old.channel
     or new.template_version_id is distinct from old.template_version_id
     or new.rendered_subject    is distinct from old.rendered_subject
     or new.rendered_body       is distinct from old.rendered_body
     or new.combined_group_id   is distinct from old.combined_group_id
     or new.created_at          is distinct from old.created_at then
    raise exception 'stored Communication_Record % is immutable: the case, recipient, touchpoint, channel, template version, rendered subject, rendered body, combined group, and created_at of a sent message cannot be changed', old.id
      using errcode = 'restrict_violation',
            detail  = 'Requirements 14.16, 14.17, 22.8: every stored field of the record is left unchanged.',
            hint    = 'Only send_time, provider_message_id, delivery_result, failure_reason, and attempt_count may change, and only through public.cancellation_retry_communication.';
  end if;

  if v_marker is null or v_marker <> old.id::text then
    raise exception 'stored Communication_Record % may be updated only through public.cancellation_retry_communication', old.id
      using errcode = 'restrict_violation',
            detail  = format('update attempted without the transaction-local retry marker for this row (marker %s)',
                             coalesce(nullif(v_marker, ''), '(absent)')),
            hint    = 'Requirements 14.16, 17.6, 22.8. Call public.cancellation_retry_communication(id, delivery_result, ...) instead.';
  end if;

  if new.attempt_count < old.attempt_count then
    raise exception 'stored Communication_Record % cannot lower attempt_count from % to %',
                    old.id, old.attempt_count, new.attempt_count
      using errcode = 'restrict_violation',
            detail  = 'A retry counts attempts up; rewriting the count downwards would falsify the delivery history.',
            hint    = 'Requirement 17.6.';
  end if;

  return new;
end;
$fn$;

comment on function public.cancellation_communications_immutable() is
  'Trigger function refusing every delete on public.cancellation_communications, and every update that either changes a frozen column (case_id, contact_id, touchpoint, channel, template_version_id, rendered_subject, rendered_body, id, created_at, combined_group_id), or lowers attempt_count, or arrives without the transaction-local retry marker naming that row. Applies on every path including a security definer path. Requirements 14.16, 17.6, 22.8.';

drop trigger if exists cancellation_communications_no_update
  on public.cancellation_communications;
create trigger cancellation_communications_no_update
  before update or delete on public.cancellation_communications
  for each row execute function public.cancellation_communications_immutable();

--    `truncate` is revoked alongside update and delete because truncate does not fire
--    row triggers: the privilege has to be withdrawn rather than trapped, or a session
--    holding it could erase the entire delivery record the way no update or delete can.
--    service_role is included so that insert-only holds for it too, leaving the retry
--    function (security definer, owned by the migration role) as the single update path
--    the design documents. Revoking a privilege drops no object.
revoke update, delete, truncate on public.cancellation_communications from authenticated;
revoke update, delete, truncate on public.cancellation_communications from anon;
revoke update, delete, truncate on public.cancellation_communications from service_role;

revoke update, delete, truncate on public.cancellation_communication_cases from authenticated;
revoke update, delete, truncate on public.cancellation_communication_cases from anon;
revoke update, delete, truncate on public.cancellation_communication_cases from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. RETRY — the single permitted update path (Requirement 17.6).
--
--    Callable by Manager_Role (manager or super_admin, via cancellation_is_manager()),
--    by the service role the scheduler runs as, and on a direct database connection
--    carrying no request role and no JWT — which is what applies this migration, runs
--    its probe, and runs scripts/run-sql.mjs. Every other caller gets 42501 and the row
--    is left alone.
--    The request role is read from the `role` setting, which PostgREST assigns per
--    request (`authenticated`, `anon`, `service_role`) and which a security definer
--    switch does not alter — unlike current_user, which would report the function owner
--    for every caller and admit everyone. `none` is what an ordinary database session
--    reports before any `set role`, so it identifies a direct server-side connection.
--    A superuser test is deliberately NOT used: the migration role on this project is
--    not a superuser.
--
--    security definer so it can write a table whose update privilege is revoked from
--    every client role, with `set search_path = public` so it cannot be steered at a
--    different schema. It takes a row lock before validating, so two concurrent retries
--    of one record serialize instead of interleaving their attempt counts — the same
--    reason the reserving insert, not this function, is what claims an Idempotency_Key.
--
--    Parameter semantics, stated because the design fixes the column set but not the
--    call shape:
--      p_delivery_result     required, one of Sent / Delivered / Failed.
--      p_provider_message_id written verbatim INCLUDING null, so a success carrying no
--                            provider identifier stores an absent value (Requirement 23.4).
--      p_failure_reason      written verbatim including null, so a successful retry
--                            clears the reason left by the failed attempt.
--      p_attempt_count       null leaves the stored count alone — the reserve-then-send
--                            path records the outcome of attempt 1 and is not a retry.
--                            A value below the stored count is refused.
--      p_send_time           null means now(); Requirement 17.6's "new send time".
--    Returns the updated row so a caller reads back exactly what was stored.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_retry_communication(
  p_communication_id uuid,
  p_delivery_result text,
  p_provider_message_id text default null,
  p_failure_reason text default null,
  p_attempt_count integer default null,
  p_send_time timestamptz default null)
returns public.cancellation_communications
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row         public.cancellation_communications;
  v_claims      text;
  v_jwt_role    text;
  v_request_role text;
  v_trusted     boolean := false;
begin
  -- ── Caller authorization.
  begin
    v_claims := nullif(current_setting('request.jwt.claims', true), '');
    if v_claims is not null then
      v_jwt_role := v_claims::jsonb ->> 'role';
    end if;
  exception when others then
    v_jwt_role := null;                                  -- unparseable claims: not trusted
  end;
  if v_jwt_role is null then
    v_jwt_role := nullif(current_setting('request.jwt.claim.role', true), '');
  end if;

  v_request_role := nullif(current_setting('role', true), '');

  v_trusted := coalesce(v_jwt_role, '') = 'service_role'
    or coalesce(v_request_role, 'none') = 'service_role'
    or (v_claims is null
        and v_jwt_role is null
        and coalesce(v_request_role, 'none') in ('none', session_user));

  if not (v_trusted or public.cancellation_is_manager()) then
    raise exception 'cancellation_retry_communication is reserved to Manager_Role and the service role'
      using errcode = 'insufficient_privilege',
            detail  = 'Requirements 17.6, 22.6, 22.8: a stored Communication_Record is updated only by manager, super_admin, or the server-side scheduler.',
            hint    = 'Every stored value is left unchanged.';
  end if;

  if p_delivery_result is null
     or p_delivery_result not in ('Sent', 'Delivered', 'Failed') then
    raise exception 'cancellation_retry_communication needs a delivery result of Sent, Delivered, or Failed (got %)',
                    coalesce(p_delivery_result, 'null')
      using errcode = 'invalid_parameter_value',
            hint    = 'Requirement 14.15.';
  end if;

  select * into v_row
    from public.cancellation_communications
   where id = p_communication_id
     for update;

  if not found then
    raise exception 'cancellation_retry_communication found no Communication_Record %', p_communication_id
      using errcode = 'no_data_found',
            detail  = 'An Idempotency_Key is reserved by an insert before its provider outcome can be recorded (Requirement 12.4).',
            hint    = 'Nothing was changed.';
  end if;

  if p_attempt_count is not null and p_attempt_count < v_row.attempt_count then
    raise exception 'cancellation_retry_communication cannot lower attempt_count of % from % to %',
                    p_communication_id, v_row.attempt_count, p_attempt_count
      using errcode = 'invalid_parameter_value',
            detail  = 'A retry counts attempts up.',
            hint    = 'Pass null to leave the stored count unchanged.';
  end if;

  -- ── The transaction-local marker the trigger recognizes, set for THIS row only and
  --    cleared again below so it cannot be reused later in the same transaction.
  perform set_config('cancellation.retry_communication_id', p_communication_id::text, true);

  update public.cancellation_communications
     set send_time           = coalesce(p_send_time, now()),
         provider_message_id = p_provider_message_id,
         delivery_result     = p_delivery_result,
         failure_reason      = p_failure_reason,
         attempt_count       = coalesce(p_attempt_count, v_row.attempt_count)
   where id = p_communication_id
  returning * into v_row;

  perform set_config('cancellation.retry_communication_id', '', true);

  return v_row;
end;
$fn$;

comment on function public.cancellation_retry_communication(uuid, text, text, text, integer, timestamptz) is
  'The single permitted update path for a stored Communication_Record (Requirement 17.6). Reserved to Manager_Role, the service role, and a direct database connection carrying no request role and no JWT; every other caller gets 42501 with nothing changed. Locks the row, then sets a transaction-local marker the immutability trigger recognizes and clears it again, changing only send_time, provider_message_id, delivery_result, failure_reason, and attempt_count. The template version, rendered subject, and rendered body are left unchanged (Requirements 14.16, 22.8). p_provider_message_id and p_failure_reason are written verbatim including null; p_attempt_count null keeps the stored count and may never lower it; p_send_time null means now(). Returns the updated row.';

grant execute on function public.cancellation_retry_communication(
  uuid, text, text, text, integer, timestamptz) to authenticated;
grant execute on function public.cancellation_retry_communication(
  uuid, text, text, text, integer, timestamptz) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than
--    leaving stages 4-10 to apply on top of a half-built schema. Every probe write is
--    discarded: the outer probe block ends in a raise that rolls back to the block's
--    implicit savepoint, and plpgsql variables are not transactional, so the recorded
--    outcomes survive the rollback.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing                 text;
  v_def                     text;
  v_seeded                  boolean;
  v_template_id             uuid;
  v_version_id              uuid;
  v_case_a                  uuid;
  v_case_b                  uuid;
  v_case_c                  uuid;
  v_contact_a               uuid;
  v_contact_b               uuid;
  v_comm_a                  uuid;
  v_comm_b                  uuid;
  v_group                   uuid := gen_random_uuid();
  v_manager_id              uuid;
  v_row                     public.cancellation_communications;
  v_before                  jsonb;
  v_after                   jsonb;
  v_subject                 text;
  v_attempts                integer;
  v_send_time               timestamptz;
  v_created_at              timestamptz;
  v_idem_blocked            boolean := false;
  v_touchpoint_key_ok       boolean := false;
  v_touchpoint_blocked      boolean := false;
  v_channel_blocked         boolean := false;
  v_result_blocked          boolean := false;
  v_attempts_blocked        boolean := false;
  v_plain_update_blocked    boolean := false;
  v_frozen_body_blocked     boolean := false;
  v_frozen_group_blocked    boolean := false;
  v_delete_blocked          boolean := false;
  v_marked_delete_blocked   boolean := false;
  v_retry_ok                boolean := false;
  v_marker_cleared          boolean := false;
  v_retry_lower_blocked     boolean := false;
  v_retry_result_blocked    boolean := false;
  v_retry_missing_blocked   boolean := false;
  v_retry_agent_blocked     boolean := false;
  v_retry_service_ok        boolean := false;
  v_retry_manager_ran       boolean := false;
  v_retry_manager_ok        boolean := false;
  v_case_restrict_blocked   boolean := false;
  v_contact_restrict_block  boolean := false;
  v_link_dup_blocked        boolean := false;
  v_link_restrict_blocked   boolean := false;
  v_link_rows               integer := 0;
begin
  -- ── Both tables exist.
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from (values ('cancellation_communications'), ('cancellation_communication_cases')) as t(name)
   where not exists (select 1 from pg_tables
                      where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.10.2 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── Every column of the design's data model exists, with the stated type.
  select string_agg(format('%s.%s %s', c.tbl, c.col, c.typ), ', ' order by c.tbl, c.col)
    into v_missing
    from (values
      ('cancellation_communications',      'id',                  'uuid'),
      ('cancellation_communications',      'case_id',             'uuid'),
      ('cancellation_communications',      'contact_id',          'uuid'),
      ('cancellation_communications',      'touchpoint',          'smallint'),
      ('cancellation_communications',      'channel',             'text'),
      ('cancellation_communications',      'template_version_id', 'uuid'),
      ('cancellation_communications',      'rendered_subject',    'text'),
      ('cancellation_communications',      'rendered_body',       'text'),
      ('cancellation_communications',      'send_time',           'timestamp with time zone'),
      ('cancellation_communications',      'provider_message_id', 'text'),
      ('cancellation_communications',      'delivery_result',     'text'),
      ('cancellation_communications',      'failure_reason',      'text'),
      ('cancellation_communications',      'attempt_count',       'integer'),
      ('cancellation_communications',      'combined_group_id',   'uuid'),
      ('cancellation_communications',      'created_at',          'timestamp with time zone'),
      ('cancellation_communication_cases', 'id',                  'uuid'),
      ('cancellation_communication_cases', 'communication_id',    'uuid'),
      ('cancellation_communication_cases', 'combined_group_id',   'uuid'),
      ('cancellation_communication_cases', 'case_id',             'uuid'),
      ('cancellation_communication_cases', 'created_at',          'timestamp with time zone')
    ) as c(tbl, col, typ)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = c.tbl
        and ic.column_name = c.col
        and ic.data_type = c.typ);
  if v_missing is not null then
    raise exception 'v1.10.2 left these columns absent or of the wrong type: %', v_missing
      using detail = 'Column list is the design Phase 2 data model.', hint = 'Rolling back.';
  end if;

  -- ── Every not-null column of the design's data model is actually not null.
  select string_agg(format('%s.%s', c.tbl, c.col), ', ' order by c.tbl, c.col) into v_missing
    from (values
      ('cancellation_communications',      'case_id'),
      ('cancellation_communications',      'contact_id'),
      ('cancellation_communications',      'touchpoint'),
      ('cancellation_communications',      'channel'),
      ('cancellation_communications',      'template_version_id'),
      ('cancellation_communications',      'rendered_subject'),
      ('cancellation_communications',      'rendered_body'),
      ('cancellation_communications',      'send_time'),
      ('cancellation_communications',      'delivery_result'),
      ('cancellation_communications',      'attempt_count'),
      ('cancellation_communications',      'created_at'),
      ('cancellation_communication_cases', 'communication_id'),
      ('cancellation_communication_cases', 'combined_group_id'),
      ('cancellation_communication_cases', 'case_id'),
      ('cancellation_communication_cases', 'created_at')
    ) as c(tbl, col)
   where exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public' and ic.table_name = c.tbl
        and ic.column_name = c.col and ic.is_nullable = 'YES');
  if v_missing is not null then
    raise exception 'v1.10.2 left these columns nullable: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── These three stay NULLABLE: a reserved row has no provider id yet, a success has
  --    no failure reason, and a single-case send has no combined group.
  select string_agg(c.col, ', ' order by c.col) into v_missing
    from (values ('provider_message_id'), ('failure_reason'), ('combined_group_id')) as c(col)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public' and ic.table_name = 'cancellation_communications'
        and ic.column_name = c.col and ic.is_nullable = 'YES');
  if v_missing is not null then
    raise exception 'v1.10.2 made these cancellation_communications columns not null: %', v_missing
      using detail = 'A reserved row carries no provider id, a success no failure reason, a single-case send no combined group.',
            hint = 'Rolling back.';
  end if;

  -- ── rendered_subject defaults to zero characters (Requirement 14.15).
  select column_default into v_def from information_schema.columns
   where table_schema = 'public' and table_name = 'cancellation_communications'
     and column_name = 'rendered_subject';
  if coalesce(v_def, '') not like '''''::text%' then
    raise exception 'v1.10.2 left rendered_subject without its empty-string default (default is %)',
                    coalesce(v_def, '(none)')
      using detail = 'Requirement 14.15 stores zero characters as the rendered subject on the SMS channel.',
            hint = 'Rolling back.';
  end if;

  -- ── Every named constraint exists, of the right kind.
  select string_agg(format('%s on %s', c.con, c.tbl), ', ' order by c.con) into v_missing
    from (values
      ('cancellation_communications',      'cancellation_communications_idempotency_key',           'u'),
      ('cancellation_communications',      'cancellation_communications_touchpoint_values',         'c'),
      ('cancellation_communications',      'cancellation_communications_channel_values',            'c'),
      ('cancellation_communications',      'cancellation_communications_delivery_result_values',    'c'),
      ('cancellation_communications',      'cancellation_communications_attempt_count_positive',    'c'),
      ('cancellation_communication_cases', 'cancellation_communication_cases_key',                  'u')
    ) as c(tbl, con, kind)
   where not exists (
     select 1 from pg_constraint
      where conrelid = format('public.%s', c.tbl)::regclass
        and conname = c.con
        and contype = c.kind::"char");
  if v_missing is not null then
    raise exception 'v1.10.2 did not create these constraints: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── The Idempotency_Key is exactly (case_id, contact_id, touchpoint, channel), in
  --    that order. Read from the stored definition: a narrower key would let two
  --    records exist for one key and a wider one would let two sends through.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.cancellation_communications'::regclass
     and conname = 'cancellation_communications_idempotency_key';
  if v_def is distinct from 'UNIQUE (case_id, contact_id, touchpoint, channel)' then
    raise exception 'v1.10.2 stored the wrong Idempotency_Key: %', coalesce(v_def, '(absent)')
      using detail = 'Requirement 12.6 fixes the key tuple as (Cancellation_Case, Contact_Recipient, Touchpoint, channel).',
            hint = 'Rolling back.';
  end if;

  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.cancellation_communication_cases'::regclass
     and conname = 'cancellation_communication_cases_key';
  if v_def is distinct from 'UNIQUE (communication_id, case_id)' then
    raise exception 'v1.10.2 stored the wrong link-table key: %', coalesce(v_def, '(absent)')
      using hint = 'Rolling back.';
  end if;

  -- ── The three domains are exactly the spec's values.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.cancellation_communications'::regclass
     and conname = 'cancellation_communications_touchpoint_values';
  if v_def !~ '\m15\M' or v_def !~ '\m10\M' or v_def !~ '\m5\M' or v_def !~ '\m1\M' then
    raise exception 'v1.10.2 left the touchpoint domain incomplete: %', v_def
      using detail = 'Requirement 12.1 fixes exactly four touchpoints: 15, 10, 5, 1.', hint = 'Rolling back.';
  end if;

  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.cancellation_communications'::regclass
     and conname = 'cancellation_communications_channel_values';
  if strpos(v_def, '''sms''') = 0 or strpos(v_def, '''email''') = 0 or strpos(v_def, '''phone''') > 0 then
    raise exception 'v1.10.2 left the channel domain wrong: %', v_def
      using detail = 'A Communication_Record channel is sms or email; phone is a Contact_Recipient channel.',
            hint = 'Rolling back.';
  end if;

  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.cancellation_communications'::regclass
     and conname = 'cancellation_communications_delivery_result_values';
  if strpos(v_def, '''Sent''') = 0 or strpos(v_def, '''Delivered''') = 0
     or strpos(v_def, '''Failed''') = 0 then
    raise exception 'v1.10.2 left the delivery_result domain incomplete: %', v_def
      using detail = 'The design fixes Sent, Delivered, Failed.', hint = 'Rolling back.';
  end if;

  -- ── Every foreign key is single-column, points where the design says, and restricts.
  select string_agg(format('%s.%s -> %s', f.tbl, f.col, f.ref), ', ' order by f.tbl, f.col)
    into v_missing
    from (values
      ('cancellation_communications',      'case_id',             'cancellation_cases'),
      ('cancellation_communications',      'contact_id',          'cancellation_contacts'),
      ('cancellation_communications',      'template_version_id', 'cancellation_template_versions'),
      ('cancellation_communication_cases', 'communication_id',    'cancellation_communications'),
      ('cancellation_communication_cases', 'case_id',             'cancellation_cases')
    ) as f(tbl, col, ref)
   where not exists (
     select 1 from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
      where c.conrelid = format('public.%s', f.tbl)::regclass
        and c.contype = 'f'
        and c.confrelid = format('public.%s', f.ref)::regclass
        and a.attname = f.col
        and array_length(c.conkey, 1) = 1
        and c.confdeltype = 'r');
  if v_missing is not null then
    raise exception 'v1.10.2 left these foreign keys absent or not restricting: %', v_missing
      using detail = 'Every foreign key to or from a Communication_Record is on delete restrict.',
            hint = 'Rolling back.';
  end if;

  -- ── The seven indexes exist, and the group index is the partial one.
  select string_agg(i.name, ', ' order by i.name) into v_missing
    from (values ('idx_cancellation_communications_case_channel_time'),
                 ('idx_cancellation_communications_case_touchpoint'),
                 ('idx_cancellation_communications_contact'),
                 ('idx_cancellation_communications_group'),
                 ('idx_cancellation_communications_template_version'),
                 ('idx_cancellation_communication_cases_group'),
                 ('idx_cancellation_communication_cases_case')) as i(name)
   where not exists (select 1 from pg_indexes
                      where schemaname = 'public' and indexname = i.name);
  if v_missing is not null then
    raise exception 'v1.10.2 did not create these indexes: %', v_missing using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and indexname = 'idx_cancellation_communications_group'
       and indexdef like '%combined_group_id IS NOT NULL%') then
    raise exception 'v1.10.2 left idx_cancellation_communications_group without its not-null predicate'
      using hint = 'Rolling back.';
  end if;

  -- ── The immutability trigger is attached for BOTH update and delete, before row.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.cancellation_communications'::regclass
       and tgname = 'cancellation_communications_no_update'
       and not tgisinternal
       and (tgtype & 16) <> 0   -- UPDATE
       and (tgtype & 8) <> 0    -- DELETE
       and (tgtype & 2) <> 0    -- BEFORE
       and (tgtype & 1) <> 0    -- FOR EACH ROW
  ) then
    raise exception 'v1.10.2 did not attach cancellation_communications_no_update before update or delete for each row'
      using detail = 'Requirements 14.16, 22.8.', hint = 'Rolling back.';
  end if;

  -- ── The retry function exists with the documented signature, security definer, and
  --    a pinned search_path. The argument list is read with oidvectortypes(proargtypes),
  --    which yields the bare type list; pg_get_function_identity_arguments is NOT used
  --    here because it prefixes each type with the parameter name, so a comparison
  --    against a type-only string can never match.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'cancellation_retry_communication'
       and oidvectortypes(p.proargtypes)
             = 'uuid, text, text, text, integer, timestamp with time zone'
       and p.prosecdef
       and p.proconfig @> array['search_path=public']) then
    raise exception 'v1.10.2 did not create public.cancellation_retry_communication(uuid, text, text, text, integer, timestamptz) as security definer with search_path = public'
      using detail = 'Requirement 17.6.', hint = 'Rolling back.';
  end if;

  -- ── authenticated, anon, and service_role hold no update, delete, or truncate
  --    privilege on either table. The trigger refuses row writes on every path;
  --    truncate does not fire row triggers, so that privilege is withdrawn instead.
  select string_agg(format('%s %s:%s', g.table_name, g.grantee, g.privilege_type), ', '
                    order by g.table_name, g.grantee, g.privilege_type)
    into v_missing
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.table_name in ('cancellation_communications', 'cancellation_communication_cases')
     and g.grantee in ('authenticated', 'anon', 'service_role')
     and g.privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE');
  if v_missing is not null then
    raise exception 'v1.10.2 left these privileges in place: %', v_missing
      using detail = 'Requirement 22.8: a stored Communication_Record is insert-only for every client role, and truncate does not fire the trigger.',
            hint = 'Rolling back.';
  end if;

  -- ── Insert is still granted, or nothing could reserve an Idempotency_Key.
  select string_agg(format('%s %s', t.tbl, t.grantee), ', ' order by t.tbl, t.grantee)
    into v_missing
    from (values ('cancellation_communications', 'authenticated'),
                 ('cancellation_communications', 'service_role'),
                 ('cancellation_communication_cases', 'authenticated'),
                 ('cancellation_communication_cases', 'service_role')) as t(tbl, grantee)
   where not exists (
     select 1 from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = t.tbl
        and g.grantee = t.grantee and g.privilege_type = 'INSERT');
  if v_missing is not null then
    raise exception 'v1.10.2 removed the insert privilege from: %', v_missing
      using detail = 'The reserving insert of Requirement 12.4 must stay available to both roles.',
            hint = 'Rolling back.';
  end if;

  -- ── This migration adds no policy: v1.10.6 (task 7.7) owns RLS for every
  --    cancellation_* table, and v1.10.0 owns the role helpers every policy uses.
  if exists (select 1 from pg_policies
              where schemaname = 'public'
                and tablename in ('cancellation_communications',
                                  'cancellation_communication_cases')) then
    raise exception 'v1.10.2 added a policy; v1.10.6 owns every cancellation_* policy'
      using hint = 'Rolling back.';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancellation_is_manager' and p.prosecdef) then
    raise exception 'public.cancellation_is_manager() is absent: v1.10.0 must be applied before v1.10.2'
      using detail = 'Every manager check in the series reuses that helper; this file defines no new role test.',
            hint = 'Rolling back.';
  end if;

  if not exists (select 1 from pg_tables
                  where schemaname = 'public' and tablename = 'cancellation_template_versions') then
    raise exception 'public.cancellation_template_versions is absent: v1.10.1 must be applied before v1.10.2'
      using detail = 'cancellation_communications.template_version_id references it.',
            hint = 'Rolling back.';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- LIVE PROOF. Every write below is discarded by the raise at the end of the block.
  -- Each expected failure runs in its own nested block, so catching it rolls that one
  -- statement back to its own savepoint and the probe continues.
  -- ═════════════════════════════════════════════════════════════════════════════
  begin
    -- ── Fixtures: a template version to point at, three cases, two recipients.
    select exists (select 1 from public.cancellation_templates) into v_seeded;
    if v_seeded then
      select id into v_template_id from public.cancellation_templates order by touchpoint limit 1;
    else
      insert into public.cancellation_templates (touchpoint, name)
      values (15, 'v1.10.2 post-condition probe')
      returning id into v_template_id;
    end if;

    insert into public.cancellation_template_versions
      (template_id, version, language, subject, body, cancellation_statement, contact_request)
    values (v_template_id, 2147483642, 'English', 'v1.10.2 probe subject', 'v1.10.2 probe body',
            'v1.10.2 probe statement', 'v1.10.2 probe contact request')
    returning id into v_version_id;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header)
    values ('V1102-PROBE-A', current_date + 15, '[]'::jsonb, array['probe'])
    returning id into v_case_a;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header)
    values ('V1102-PROBE-B', current_date + 10, '[]'::jsonb, array['probe'])
    returning id into v_case_b;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header)
    values ('V1102-PROBE-C', current_date + 5, '[]'::jsonb, array['probe'])
    returning id into v_case_c;

    insert into public.cancellation_contacts
      (case_id, channel, normalized_value, raw_segment, validation_status, segment_index)
    values (v_case_a, 'phone', '+15550100001', '5550100001', 'valid', 0)
    returning id into v_contact_a;

    insert into public.cancellation_contacts
      (case_id, channel, normalized_value, raw_segment, validation_status, segment_index)
    values (v_case_b, 'email', 'v1102-probe@example.invalid', 'V1102-Probe@example.invalid', 'valid', 0)
    returning id into v_contact_b;

    -- ── The reserving insert: rendered_subject, send_time, attempt_count, created_at
    --    all take their defaults (Requirements 12.4, 14.15).
    insert into public.cancellation_communications
      (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body,
       delivery_result, combined_group_id)
    values (v_case_a, v_contact_a, 15, 'sms', v_version_id, 'v1.10.2 probe body',
            'Sent', v_group)
    returning id, rendered_subject, attempt_count, send_time, created_at
      into v_comm_a, v_subject, v_attempts, v_send_time, v_created_at;

    if v_subject is distinct from '' then
      raise exception 'v1.10.2 stored % as the reserved rendered_subject instead of zero characters',
                      quote_literal(v_subject)
        using detail = 'Requirement 14.15.', hint = 'Rolling back.';
    end if;
    if v_attempts is distinct from 1 or v_send_time is null or v_created_at is null then
      raise exception 'v1.10.2 left the reserved row without its defaults (attempt_count %, send_time %, created_at %)',
                      v_attempts, v_send_time, v_created_at
        using hint = 'Rolling back.';
    end if;

    -- ── Second row of the same combined group, different case, different touchpoint
    --    (Requirements 13.4, 13.7, 13.8).
    insert into public.cancellation_communications
      (case_id, contact_id, touchpoint, channel, template_version_id, rendered_subject,
       rendered_body, delivery_result, combined_group_id)
    values (v_case_b, v_contact_b, 10, 'email', v_version_id, 'v1.10.2 probe subject',
            'v1.10.2 probe body', 'Sent', v_group)
    returning id into v_comm_b;

    -- ── THE IDEMPOTENCY KEY. The same tuple a second time is refused (Requirements
    --    12.6, 12.7): this is the reservation two concurrent runs race for.
    begin
      insert into public.cancellation_communications
        (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body, delivery_result)
      values (v_case_a, v_contact_a, 15, 'sms', v_version_id, 'v1.10.2 probe body', 'Sent');
    exception when unique_violation then
      v_idem_blocked := true;
    end;

    -- ── A different touchpoint for the same case and recipient IS a different key.
    insert into public.cancellation_communications
      (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body, delivery_result)
    values (v_case_a, v_contact_a, 10, 'sms', v_version_id, 'v1.10.2 probe body', 'Sent');
    v_touchpoint_key_ok := true;

    -- ── Domain checks.
    begin
      insert into public.cancellation_communications
        (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body, delivery_result)
      values (v_case_a, v_contact_a, 7, 'sms', v_version_id, 'v1.10.2 probe body', 'Sent');
    exception when others then
      v_touchpoint_blocked := true;
    end;

    begin
      insert into public.cancellation_communications
        (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body, delivery_result)
      values (v_case_a, v_contact_a, 5, 'phone', v_version_id, 'v1.10.2 probe body', 'Sent');
    exception when others then
      v_channel_blocked := true;
    end;

    begin
      insert into public.cancellation_communications
        (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body, delivery_result)
      values (v_case_a, v_contact_a, 5, 'sms', v_version_id, 'v1.10.2 probe body', 'Pending');
    exception when others then
      v_result_blocked := true;
    end;

    begin
      insert into public.cancellation_communications
        (case_id, contact_id, touchpoint, channel, template_version_id, rendered_body,
         delivery_result, attempt_count)
      values (v_case_a, v_contact_a, 5, 'sms', v_version_id, 'v1.10.2 probe body', 'Sent', 0);
    exception when others then
      v_attempts_blocked := true;
    end;

    select to_jsonb(c) into v_before
      from public.cancellation_communications c where c.id = v_comm_a;

    -- ── IMMUTABILITY. An ordinary update carrying no retry marker is refused, whatever
    --    it touches (Requirements 14.16, 22.8).
    begin
      update public.cancellation_communications
         set delivery_result = 'Delivered' where id = v_comm_a;
    exception when others then
      v_plain_update_blocked := true;
    end;

    -- ── Even WITH the marker, a frozen column cannot change.
    perform set_config('cancellation.retry_communication_id', v_comm_a::text, true);
    begin
      update public.cancellation_communications
         set rendered_body = 'v1.10.2 tampered body' where id = v_comm_a;
    exception when others then
      v_frozen_body_blocked := true;
    end;

    begin
      update public.cancellation_communications
         set combined_group_id = gen_random_uuid() where id = v_comm_a;
    exception when others then
      v_frozen_group_blocked := true;
    end;

    -- ── Delete raises with the marker set, exactly as without it.
    begin
      delete from public.cancellation_communications where id = v_comm_a;
    exception when others then
      v_marked_delete_blocked := true;
    end;
    perform set_config('cancellation.retry_communication_id', '', true);

    begin
      delete from public.cancellation_communications where id = v_comm_a;
    exception when others then
      v_delete_blocked := true;
    end;

    select to_jsonb(c) into v_after
      from public.cancellation_communications c where c.id = v_comm_a;

    -- ── THE ONE PERMITTED UPDATE PATH (Requirement 17.6). Runs here as a direct
    --    superuser connection with no JWT.
    select * into v_row
      from public.cancellation_retry_communication(
             v_comm_a, 'Failed', 'v1102-provider-id', 'v1.10.2 probe failure reason', 2,
             v_send_time + interval '1 minute');

    v_retry_ok := v_row.delivery_result = 'Failed'
      and v_row.provider_message_id = 'v1102-provider-id'
      and v_row.failure_reason = 'v1.10.2 probe failure reason'
      and v_row.attempt_count = 2
      and v_row.send_time = v_send_time + interval '1 minute'
      -- and every frozen field survived
      and v_row.id = v_comm_a
      and v_row.case_id = v_case_a
      and v_row.contact_id = v_contact_a
      and v_row.touchpoint = 15
      and v_row.channel = 'sms'
      and v_row.template_version_id = v_version_id
      and v_row.rendered_subject = ''
      and v_row.rendered_body = 'v1.10.2 probe body'
      and v_row.combined_group_id = v_group
      and v_row.created_at = v_created_at;

    -- ── The function clears its marker, so a bare update straight afterwards, in the
    --    same transaction, is refused again.
    begin
      update public.cancellation_communications
         set delivery_result = 'Delivered' where id = v_comm_a;
    exception when others then
      v_marker_cleared := true;
    end;

    -- ── The function refuses to lower attempt_count, to store an unknown delivery
    --    result, or to act on a row that was never reserved.
    begin
      perform public.cancellation_retry_communication(v_comm_a, 'Sent', null, null, 1, null);
    exception when others then
      v_retry_lower_blocked := true;
    end;

    begin
      perform public.cancellation_retry_communication(v_comm_a, 'Queued', null, null, null, null);
    exception when others then
      v_retry_result_blocked := true;
    end;

    begin
      perform public.cancellation_retry_communication(gen_random_uuid(), 'Sent', null, null, null, null);
    exception when others then
      v_retry_missing_blocked := true;
    end;

    -- ── Authorization. A non-manager session is refused; the service role is admitted;
    --    a real Manager_Role profile, where one exists, is admitted.
    perform set_config('request.jwt.claims',
                       json_build_object('role', 'authenticated',
                                         'sub', gen_random_uuid()::text)::text, true);
    begin
      perform public.cancellation_retry_communication(v_comm_a, 'Sent', null, null, null, null);
    exception when insufficient_privilege then
      v_retry_agent_blocked := true;
    end;

    perform set_config('request.jwt.claims',
                       json_build_object('role', 'service_role')::text, true);
    select * into v_row
      from public.cancellation_retry_communication(
             v_comm_a, 'Delivered', 'v1102-provider-id-2', null, 3, null);
    v_retry_service_ok := v_row.delivery_result = 'Delivered'
      and v_row.provider_message_id = 'v1102-provider-id-2'
      and v_row.failure_reason is null
      and v_row.attempt_count = 3
      and v_row.rendered_body = 'v1.10.2 probe body';

    select id into v_manager_id from public.profiles
     where role in ('manager', 'super_admin') order by id limit 1;
    if v_manager_id is not null then
      v_retry_manager_ran := true;
      perform set_config('request.jwt.claims',
                         json_build_object('role', 'authenticated',
                                           'sub', v_manager_id::text)::text, true);
      select * into v_row
        from public.cancellation_retry_communication(
               v_comm_a, 'Sent', null, 'v1.10.2 manager probe', 4, null);
      v_retry_manager_ok := v_row.delivery_result = 'Sent'
        and v_row.provider_message_id is null
        and v_row.attempt_count = 4;
    end if;
    perform set_config('request.jwt.claims', '', true);

    -- ── on delete restrict: neither the case nor the recipient of a stored record can
    --    be deleted out from under it (Requirement 22.8).
    begin
      delete from public.cancellation_cases where id = v_case_a;
    exception when foreign_key_violation then
      v_case_restrict_blocked := true;
    end;

    begin
      delete from public.cancellation_contacts where id = v_contact_a;
    exception when foreign_key_violation then
      v_contact_restrict_block := true;
    end;

    -- ── The link table: one row per (communication, included case) pair, the same pair
    --    refused twice, and a linked case that cannot be deleted (Requirement 13.8).
    insert into public.cancellation_communication_cases
      (communication_id, combined_group_id, case_id)
    values (v_comm_a, v_group, v_case_a),
           (v_comm_a, v_group, v_case_b),
           (v_comm_a, v_group, v_case_c),
           (v_comm_b, v_group, v_case_a),
           (v_comm_b, v_group, v_case_b),
           (v_comm_b, v_group, v_case_c);

    select count(*) into v_link_rows
      from public.cancellation_communication_cases where combined_group_id = v_group;

    begin
      insert into public.cancellation_communication_cases
        (communication_id, combined_group_id, case_id)
      values (v_comm_a, v_group, v_case_a);
    exception when unique_violation then
      v_link_dup_blocked := true;
    end;

    -- case C has no Communication_Record of its own, so only the link row can be what
    -- refuses its deletion.
    begin
      delete from public.cancellation_cases where id = v_case_c;
    exception when foreign_key_violation then
      v_link_restrict_blocked := true;
    end;

    raise exception 'v1102_probe_done' using errcode = 'RS001';
  exception when sqlstate 'RS001' then
    null;  -- probe rows discarded; outcomes retained in the variables below
  end;

  if not v_idem_blocked then
    raise exception 'v1.10.2 accepted two Communication_Record rows for one Idempotency_Key'
      using detail = 'Requirement 12.6: the unique constraint is what stops two concurrent runs from both sending.',
            hint = 'Rolling back.';
  end if;
  if not v_touchpoint_key_ok then
    raise exception 'v1.10.2 refused a second touchpoint for the same case and recipient'
      using detail = 'The Idempotency_Key includes the touchpoint (Requirement 12.6).', hint = 'Rolling back.';
  end if;
  if not v_touchpoint_blocked then
    raise exception 'v1.10.2 accepted a touchpoint outside 15, 10, 5, 1'
      using detail = 'Requirement 12.1.', hint = 'Rolling back.';
  end if;
  if not v_channel_blocked then
    raise exception 'v1.10.2 accepted a Communication_Record channel outside sms and email'
      using hint = 'Rolling back.';
  end if;
  if not v_result_blocked then
    raise exception 'v1.10.2 accepted a delivery_result outside Sent, Delivered, Failed'
      using hint = 'Rolling back.';
  end if;
  if not v_attempts_blocked then
    raise exception 'v1.10.2 accepted attempt_count 0'
      using detail = 'Requirement 14.15 stores the record when a send is attempted.', hint = 'Rolling back.';
  end if;
  if not v_plain_update_blocked then
    raise exception 'v1.10.2 left cancellation_communications updatable without the retry marker'
      using detail = 'Requirements 14.16, 22.8.', hint = 'Rolling back.';
  end if;
  if not v_frozen_body_blocked then
    raise exception 'v1.10.2 allowed rendered_body to change on a stored Communication_Record'
      using detail = 'Requirement 14.16: the rendered evidence is frozen on every path, retry included.',
            hint = 'Rolling back.';
  end if;
  if not v_frozen_group_blocked then
    raise exception 'v1.10.2 allowed combined_group_id to change on a stored Communication_Record'
      using detail = 'Requirement 13.8; see the header note on this deliberate narrowing.',
            hint = 'Rolling back.';
  end if;
  if not v_marked_delete_blocked then
    raise exception 'v1.10.2 allowed a delete while the retry marker was set'
      using detail = 'Requirement 22.8: the marker unlocks five columns, never a delete.',
            hint = 'Rolling back.';
  end if;
  if not v_delete_blocked then
    raise exception 'v1.10.2 left cancellation_communications deletable'
      using detail = 'Requirement 22.8.', hint = 'Rolling back.';
  end if;
  if v_after is distinct from v_before then
    raise exception 'v1.10.2 probe changed a cancellation_communications row despite the trigger: % -> %',
                    v_before, v_after
      using detail = 'Requirement 14.16.', hint = 'Rolling back.';
  end if;
  if not v_retry_ok then
    raise exception 'v1.10.2 retry function did not record the provider outcome while leaving every frozen field alone'
      using detail = 'Requirement 17.6: new send time, provider message id, and delivery result; template version, rendered subject, and rendered body unchanged.',
            hint = 'Rolling back.';
  end if;
  if not v_marker_cleared then
    raise exception 'v1.10.2 left the retry marker set after the function returned'
      using detail = 'One retry must not license a second, unaudited update later in the same transaction.',
            hint = 'Rolling back.';
  end if;
  if not v_retry_lower_blocked then
    raise exception 'v1.10.2 retry function lowered attempt_count' using hint = 'Rolling back.';
  end if;
  if not v_retry_result_blocked then
    raise exception 'v1.10.2 retry function accepted a delivery result outside Sent, Delivered, Failed'
      using hint = 'Rolling back.';
  end if;
  if not v_retry_missing_blocked then
    raise exception 'v1.10.2 retry function accepted an unreserved Idempotency_Key'
      using detail = 'Requirement 12.4: the row is reserved by an insert first.', hint = 'Rolling back.';
  end if;
  if not v_retry_agent_blocked then
    raise exception 'v1.10.2 retry function admitted a session that holds neither Manager_Role nor the service role'
      using detail = 'Requirements 22.6, 22.8.', hint = 'Rolling back.';
  end if;
  if not v_retry_service_ok then
    raise exception 'v1.10.2 retry function refused the service role or mis-stored its outcome'
      using detail = 'The Notification_Scheduler runs as the service role.', hint = 'Rolling back.';
  end if;
  if v_retry_manager_ran and not v_retry_manager_ok then
    raise exception 'v1.10.2 retry function refused a manager or super_admin profile'
      using detail = 'Requirement 17.6 gives Retry Failed Communication to Manager_Role.', hint = 'Rolling back.';
  end if;
  if not v_case_restrict_blocked then
    raise exception 'v1.10.2 allowed a Cancellation_Case with a stored Communication_Record to be deleted'
      using hint = 'Rolling back.';
  end if;
  if not v_contact_restrict_block then
    raise exception 'v1.10.2 allowed a Contact_Recipient with a stored Communication_Record to be deleted'
      using hint = 'Rolling back.';
  end if;
  if v_link_rows is distinct from 6 then
    raise exception 'v1.10.2 stored % link rows for a two-record combined group covering three cases, expected 6',
                    v_link_rows
      using detail = 'Requirement 13.8: one row per (communication, included case) pair.', hint = 'Rolling back.';
  end if;
  if not v_link_dup_blocked then
    raise exception 'v1.10.2 accepted the same (communication_id, case_id) pair twice'
      using hint = 'Rolling back.';
  end if;
  if not v_link_restrict_blocked then
    raise exception 'v1.10.2 allowed a Cancellation_Case named by a link row to be deleted'
      using hint = 'Rolling back.';
  end if;

  -- ── No probe residue is committed, in either new table or in the v1.10.0/v1.10.1
  --    tables the fixtures borrowed.
  if exists (select 1 from public.cancellation_communications
              where rendered_body = 'v1.10.2 probe body')
     or exists (select 1 from public.cancellation_communication_cases cc
                 join public.cancellation_cases c on c.id = cc.case_id
                where c.policy_number like 'V1102-PROBE-%')
     or exists (select 1 from public.cancellation_cases
                 where policy_number like 'V1102-PROBE-%')
     or exists (select 1 from public.cancellation_template_versions where version = 2147483642)
     or exists (select 1 from public.cancellation_templates
                 where name = 'v1.10.2 post-condition probe') then
    raise exception 'v1.10.2 left probe residue behind' using hint = 'Rolling back.';
  end if;

  if nullif(current_setting('cancellation.retry_communication_id', true), '') is not null
     or nullif(current_setting('request.jwt.claims', true), '') is not null then
    raise exception 'v1.10.2 left a probe session setting behind (marker %, claims %)',
                    coalesce(current_setting('cancellation.retry_communication_id', true), '(unset)'),
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
  (select count(*) from pg_tables
     where schemaname = 'public'
       and tablename in ('cancellation_communications',
                         'cancellation_communication_cases')) as tables_created_expect_2,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
       and table_name in ('cancellation_communications',
                          'cancellation_communication_cases')) as columns_created_expect_20,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_communications'::regclass,
                        'public.cancellation_communication_cases'::regclass)
       and contype = 'u') as unique_constraints_expect_2,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_communications'::regclass,
                        'public.cancellation_communication_cases'::regclass)
       and contype = 'c'
       and conname like 'cancellation%') as named_check_constraints_expect_4,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_communications'::regclass,
                        'public.cancellation_communication_cases'::regclass)
       and contype = 'f') as foreign_keys_expect_5,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_communications'::regclass,
                        'public.cancellation_communication_cases'::regclass)
       and contype = 'f' and confdeltype = 'r') as restricting_foreign_keys_expect_5,
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('idx_cancellation_communications_case_channel_time',
                         'idx_cancellation_communications_case_touchpoint',
                         'idx_cancellation_communications_contact',
                         'idx_cancellation_communications_group',
                         'idx_cancellation_communications_template_version',
                         'idx_cancellation_communication_cases_group',
                         'idx_cancellation_communication_cases_case')) as indexes_expect_7,
  (select count(*) from pg_trigger
     where tgrelid = 'public.cancellation_communications'::regclass
       and tgname = 'cancellation_communications_no_update'
       and not tgisinternal) as immutability_trigger_expect_1,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('cancellation_communications_immutable',
                         'cancellation_retry_communication')) as functions_expect_2,
  (select count(*) from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('cancellation_communications', 'cancellation_communication_cases')
       and grantee in ('authenticated', 'anon', 'service_role')
       and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')) as write_privileges_expect_0,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename in ('cancellation_communications',
                         'cancellation_communication_cases')) as policies_expected_zero_until_v1_10_6,
  (select count(*) from public.cancellation_communications) as communication_rows_expect_0,
  (select count(*) from public.cancellation_communication_cases) as link_rows_expect_0;
