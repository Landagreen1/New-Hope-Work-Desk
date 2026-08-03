-- New Hope Work Desk v1.10.6 — Cancellations row level security (migration stage 7 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.7)
-- Requirements: 19.11, 22.1, 22.2, 22.3, 22.5, 22.8, 22.9, 22.10, 22.12
--               (and 20.12, 21.9, 26.1, 26.2, 26.4 where noted inline)
--
-- Forward-only, seventh file of the v1.10.x series. Enables row level security on every
-- cancellation_* table and creates every policy in the design's RLS table. Touches no
-- table, column, policy, function, or row created at v1.9.7 or earlier: every object
-- named below is a cancellation_* object created at v1.10.0 through v1.10.4, and a
-- post-condition proves that not one policy outside `public.cancellation_*` — including
-- the two storage.objects policies created at v1.10.8 — was added, removed, or left with
-- a different row-level-security flag by this file (Requirements 26.1, 26.2).
--
-- WHY THIS FILE IS THE SECURITY BOUNDARY OF THE WHOLE SERIES
--   v1.10.0 through v1.10.5 each deliberately deferred row level security to this file
--   and said so in their headers. Until this file is applied every cancellation_* table
--   is reachable — read AND write — by any `authenticated` session: any signed-in profile
--   can read every Cancellation_Case regardless of assignment, insert a payment
--   verification outcome that Requirement 19.11 reserves to Manager_Role, and flip the
--   `automatic_sending_enabled` kill switch that Requirement 26.4 reserves to
--   Manager_Role. Nothing is protected until this lands.
--
-- CONTENTS
--   1. public.cancellation_case_stored_status(uuid) — the one new function, and it is
--      NOT a role test (see the note on it below)
--   2. `enable row level security` on all sixteen tables, enumerated from the catalog
--   3. The privilege sweep: the TRUNCATE hole that row level security cannot close
--   4. The policies, table by table, each preceded by `drop policy if exists`
--   5. Post-conditions: a catalog sweep that fails on any unprotected table, a live
--      enforcement proof under a simulated session per role, and the Requirement
--      26.1 / 26.2 guard
--   6. Verification select
--
-- THE ROLE TESTS ARE v1.10.0'S. NO NEW ONE IS DEFINED HERE.
--   public.cancellation_is_manager()   -> role in ('manager','super_admin')          (Req 22.5)
--   public.cancellation_can_read_all() -> those two plus customer_service and
--                                         sales_supervisor                           (Req 22.12)
--   public.cancellation_can_access_evidence(text) from v1.10.8 governs the evidence
--   bucket and is not touched here; neither are its two storage.objects policies.
--
--   Every policy below is built on those two helpers, so the manager set has exactly one
--   definition and `super_admin` inherits every Manager_Role permission by construction.
--
-- THE CANCELLATION_CASES READ SCOPE, WHICH EVERY OTHER TABLE JOINS TO
--   public.cancellation_can_read_all()
--     or auth.uid() is not null and (assigned_to = auth.uid() or assigned_to is null)
--
--   The `auth.uid() is not null` guard is the same guard v1.10.8 put at the top of
--   cancellation_can_access_evidence, and for the same reason: without it a session
--   holding the `authenticated` role but carrying no JWT subject would satisfy
--   `assigned_to is null` and read every unassigned case. cancellation_can_read_all()
--   already answers false for a null subject (its subselect finds no profile row), so
--   the guard is only needed on the ownership branch.
--
-- THE ONE NEW FUNCTION, AND WHY IT IS NOT A ROLE TEST
--   Requirement 22.10 limits an Agent_Role profile to setting Case_Status to exactly
--   Open, Payment Reported, Verification Pending, and Reinstatement Pending. A WITH CHECK
--   expression sees only the NEW row, so `case_status in (those four)` alone would also
--   reject an update that never touched case_status — an agent flipping
--   `assistance_requested` on a case still sitting at `Imported` (Requirement 21.7) would
--   be denied for a column it did not write. Reading the stored value back inside a
--   policy on the same table raises "infinite recursion detected in policy", so the read
--   goes through a one-line security-definer accessor:
--   public.cancellation_case_stored_status(uuid). It is STABLE, so it answers from the
--   command snapshot and therefore returns the PRE-update value, which is exactly the
--   comparison Requirement 22.10 needs. It tests no role and decides no access on its
--   own; it only lets the policy tell "did not change the status" apart from "changed the
--   status to a value this profile may not set".
--
-- THE LIVE GAP THIS FILE CLOSES: TRUNCATE
--   Row level security is not consulted for TRUNCATE. v1.10.0 revoked `update, delete`
--   on public.cancellation_events from authenticated and anon but not `truncate`, so a
--   signed-in session could erase the entire audit timeline in one statement, and the
--   append-only trigger would never fire because TRUNCATE fires no row trigger. Tasks
--   7.2, 7.3, and 7.4 closed this on their own tables by revoking `truncate` alongside
--   `update, delete`; v1.10.0 (five tables) and v1.10.1 (two of its three tables) did
--   not. This file is the natural home for the sweep, so it revokes TRUNCATE from
--   authenticated, anon, and service_role on all sixteen tables, and revokes DELETE from
--   authenticated and anon on all sixteen because the design grants delete to no role on
--   any table. Section 3 lists which grants were still live when this file was written.
--
-- POLICY MATRIX (38 policies; the design's RLS table is the authoritative source)
--   table                              select                     insert                       update
--   ---------------------------------- -------------------------- ---------------------------- --------------------------
--   cancellation_import_runs           read_all only              manager, imported_by = self  none
--   cancellation_cases                 read scope above           manager                      manager any; own row with
--                                                                                              status in the Req 22.10
--                                                                                              four or unchanged
--   cancellation_contacts              readable case              manager or own case          manager or own case
--   cancellation_suppressions          any subject                self-recorded, uncleared     manager, clear-only
--   cancellation_events                readable case              readable case, actor = self  none (append-only)
--   cancellation_templates             any subject                manager                      none
--   cancellation_template_versions     any subject                manager, created_by = self   none (append-only)
--   cancellation_prohibited_phrases    any subject                manager                      none
--   cancellation_communications        readable case              manager or own case          none (retry fn only)
--   cancellation_communication_cases   readable case              manager or own case          none
--   cancellation_settings              any subject                none                         manager, updated_by=self
--   cancellation_notes                 readable case              own case, created_by = self  none (append-only)
--   cancellation_customer_responses    readable case              own case, created_by = self  none (append-only)
--   cancellation_payment_reports       readable case              own case, reported_by = self none (append-only)
--   cancellation_verification_outcomes readable case              MANAGER ONLY (Req 19.11)     none (append-only)
--   cancellation_escalations           readable case              manager or own case          manager any; own case
--                                                                                              uncleared -> cleared_by
--                                                                                              = self
--
--   No table gets a DELETE policy and no table gets a FOR ALL policy. Every policy is
--   granted `to authenticated` only: `anon` is named by no policy, so with row level
--   security on it reads and writes nothing regardless of the grants it still carries.
--   `service_role` and `postgres` both hold rolbypassrls, so the server-side scheduler,
--   the v1.10.5 security-definer loader, and the v1.10.2 retry function are unaffected
--   by every policy below — which is the point: the policies constrain browser sessions.
--
-- TWO DELIBERATE DEVIATIONS FROM THE DESIGN'S RLS TABLE, BOTH NARROWING OR REQUIRED
--   * cancellation_escalations insert. The design's table lists insert for Manager_Role
--     only. Requirement 20.10 runs an escalation evaluation "after every change to a
--     Contact_Recipient of that Cancellation_Case", and Requirement 22.2 lets an
--     Agent_Role profile add Contact_Recipient information on a case assigned to itself,
--     so that evaluation runs under an agent's session and must be able to record the
--     escalation row it finds. Insert is therefore `manager or own case` — still no
--     unassigned case and still no other profile's case (Requirement 22.12).
--   * cancellation_escalations update. The design says agent may update "only cleared_at
--     / cleared_by on own cases". `notified_at` is also written after insert, by the same
--     escalation path (Requirement 20.8), so the own-case policy is expressed as: the row
--     must currently be uncleared, and the resulting row must either still be uncleared
--     (the notified_at stamp) or be cleared by the acting profile (Requirement 20.12).
--     A cleared escalation is untouchable by a non-manager, so no profile can un-clear
--     one to re-raise Manual Follow-up Required.
--
-- WHAT ROW LEVEL SECURITY CANNOT DO, AND WHERE THE REST LIVES
--   A policy filters rows, not columns. "Update only cleared_at, cleared_by, clear_reason"
--   and "change automatic_sending_enabled only as Manager_Role" are expressed here as
--   constraints on the resulting row (the row must end up cleared by the actor; the row
--   must carry updated_by = the actor and the actor must be a manager). The per-column
--   part of those rules also lives in the server-side authorization checks Requirement
--   22.9 requires in addition to these policies.
--
-- ROLLBACK PATH
--   begin;
--     -- policies, in the order created; only names this file creates are named
--     drop policy if exists cancellation_import_runs_v1106_select on public.cancellation_import_runs;
--     drop policy if exists cancellation_import_runs_v1106_insert on public.cancellation_import_runs;
--     drop policy if exists cancellation_cases_v1106_select on public.cancellation_cases;
--     drop policy if exists cancellation_cases_v1106_insert on public.cancellation_cases;
--     drop policy if exists cancellation_cases_v1106_update_manager on public.cancellation_cases;
--     drop policy if exists cancellation_cases_v1106_update_own on public.cancellation_cases;
--     drop policy if exists cancellation_contacts_v1106_select on public.cancellation_contacts;
--     drop policy if exists cancellation_contacts_v1106_insert on public.cancellation_contacts;
--     drop policy if exists cancellation_contacts_v1106_update on public.cancellation_contacts;
--     drop policy if exists cancellation_suppressions_v1106_select on public.cancellation_suppressions;
--     drop policy if exists cancellation_suppressions_v1106_insert on public.cancellation_suppressions;
--     drop policy if exists cancellation_suppressions_v1106_update_manager on public.cancellation_suppressions;
--     drop policy if exists cancellation_events_v1106_select on public.cancellation_events;
--     drop policy if exists cancellation_events_v1106_insert on public.cancellation_events;
--     drop policy if exists cancellation_templates_v1106_select on public.cancellation_templates;
--     drop policy if exists cancellation_templates_v1106_insert on public.cancellation_templates;
--     drop policy if exists cancellation_template_versions_v1106_select on public.cancellation_template_versions;
--     drop policy if exists cancellation_template_versions_v1106_insert on public.cancellation_template_versions;
--     drop policy if exists cancellation_prohibited_phrases_v1106_select on public.cancellation_prohibited_phrases;
--     drop policy if exists cancellation_prohibited_phrases_v1106_insert on public.cancellation_prohibited_phrases;
--     drop policy if exists cancellation_communications_v1106_select on public.cancellation_communications;
--     drop policy if exists cancellation_communications_v1106_insert on public.cancellation_communications;
--     drop policy if exists cancellation_communication_cases_v1106_select on public.cancellation_communication_cases;
--     drop policy if exists cancellation_communication_cases_v1106_insert on public.cancellation_communication_cases;
--     drop policy if exists cancellation_settings_v1106_select on public.cancellation_settings;
--     drop policy if exists cancellation_settings_v1106_update_manager on public.cancellation_settings;
--     drop policy if exists cancellation_notes_v1106_select on public.cancellation_notes;
--     drop policy if exists cancellation_notes_v1106_insert on public.cancellation_notes;
--     drop policy if exists cancellation_customer_responses_v1106_select on public.cancellation_customer_responses;
--     drop policy if exists cancellation_customer_responses_v1106_insert on public.cancellation_customer_responses;
--     drop policy if exists cancellation_payment_reports_v1106_select on public.cancellation_payment_reports;
--     drop policy if exists cancellation_payment_reports_v1106_insert on public.cancellation_payment_reports;
--     drop policy if exists cancellation_verification_outcomes_v1106_select on public.cancellation_verification_outcomes;
--     drop policy if exists cancellation_verification_outcomes_v1106_insert on public.cancellation_verification_outcomes;
--     drop policy if exists cancellation_escalations_v1106_select on public.cancellation_escalations;
--     drop policy if exists cancellation_escalations_v1106_insert on public.cancellation_escalations;
--     drop policy if exists cancellation_escalations_v1106_update_manager on public.cancellation_escalations;
--     drop policy if exists cancellation_escalations_v1106_update_own on public.cancellation_escalations;
--     -- then, for each of the sixteen tables:
--     --   alter table public.<table> disable row level security;
--     drop function if exists public.cancellation_case_stored_status(uuid);
--   commit;
--   Rolling this file back returns every cancellation_* table to "reachable by any
--   authenticated session", which is the state Requirement 26.1's forward-only rule
--   expects to be transient. Do not roll it back to fix an application bug: disable the
--   feature in the UI instead. The privilege sweep in section 3 is NOT part of the
--   rollback: re-granting TRUNCATE or DELETE to a client role would reopen the audit-wipe
--   hole this file exists to close. Requirement 26.3 keeps applied v1.10.x migrations in
--   place when application code is rolled back, and this file writes no row, so nothing
--   is lost either way.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 0. BASELINE FOR THE REQUIREMENTS 26.1 / 26.2 GUARD
--
--    Captured before the first DDL statement so the post-condition block can prove, by
--    difference rather than by assertion, that this file added or removed no policy
--    outside public.cancellation_* and changed no other table's row-level-security flag.
--    That covers the two cancellation_evidence_v1108_* policies on storage.objects,
--    which belong to task 7.9 and are not this file's to touch, and every policy created
--    at v1.9.7 or earlier. `on commit drop` keeps the file re-appliable.
-- ═══════════════════════════════════════════════════════════════════════════════
create temp table _v1106_policy_baseline on commit drop as
select schemaname::text as schemaname, tablename::text as tablename, policyname::text as policyname
  from pg_policies
 where not (schemaname = 'public' and tablename like 'cancellation%');

create temp table _v1106_rls_baseline on commit drop as
select n.nspname::text as schemaname, c.relname::text as tablename, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where c.relkind = 'r'
   and n.nspname in ('public', 'storage', 'auth')
   and not (n.nspname = 'public' and c.relname like 'cancellation%');

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. THE ONE NEW FUNCTION — a status accessor, not a role test.
--
--    security definer + owned by the table owner, so it is not filtered by
--    cancellation_cases' own policies and cannot trip the recursion detector.
--    stable, so it answers from the calling command's snapshot: during an UPDATE that
--    is the row as it stands BEFORE the update, which is the value Requirement 22.10
--    needs to compare against. set search_path = public, matching v1.10.0 and v1.10.8,
--    so it cannot be steered at a different schema's cancellation_cases.
--    Returns null for a case id that does not exist, which makes the
--    "status unchanged" branch of the policy false rather than true.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_case_stored_status(p_case_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  select c.case_status from public.cancellation_cases c where c.id = p_case_id;
$fn$;

comment on function public.cancellation_case_stored_status(uuid) is
  'The Case_Status currently stored for a Cancellation_Case, read past row level security so a policy on cancellation_cases can compare the NEW row against it without recursion. STABLE, so during an UPDATE it returns the pre-update value. Tests no role and grants no access: used only by cancellation_cases_v1106_update_own to tell an update that did not touch case_status apart from an update that set a value Requirement 22.10 reserves to Manager_Role.';

grant execute on function public.cancellation_case_stored_status(uuid) to authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. ENABLE ROW LEVEL SECURITY ON ALL SIXTEEN TABLES
--
--    Enumerated from the catalog rather than from a hand-written list: any table whose
--    name starts with `cancellation` gets row level security, including one added
--    between the writing of this file and its application. A table silently missed is
--    the whole failure mode of this task, so the enumeration is the source of truth and
--    the post-condition block re-reads the catalog to confirm the result.
--
--    `alter table ... enable row level security` is idempotent, so the loop is safe to
--    re-run. It is deliberately NOT `force row level security`: postgres and service_role
--    hold rolbypassrls, and forcing it on the table owner would break the v1.10.5
--    security-definer loader and the v1.10.2 retry function, which run as the owner.
-- ═══════════════════════════════════════════════════════════════════════════════
do $rls$
declare
  v_table  text;
  v_count  integer := 0;
begin
  for v_table in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cancellation%'
     order by c.relname
  loop
    execute format('alter table public.%I enable row level security', v_table);
    v_count := v_count + 1;
  end loop;

  if v_count < 16 then
    raise exception 'v1.10.6 found only % cancellation_* tables to protect, expected at least 16', v_count
      using detail = 'v1.10.0 through v1.10.4 create sixteen. A missing table means an earlier stage did not apply.',
            hint = 'Rolling back.';
  end if;

  raise notice 'v1.10.6 enabled row level security on % cancellation_* tables', v_count;
end
$rls$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. THE PRIVILEGE SWEEP — the part row level security cannot do
--
--    TRUNCATE is never checked against a policy. A client role holding TRUNCATE empties
--    a table in one statement no matter what the policies below say, and TRUNCATE fires
--    no row trigger, so the append-only triggers on cancellation_events,
--    cancellation_communications, cancellation_notes, cancellation_customer_responses,
--    cancellation_payment_reports, cancellation_verification_outcomes, and
--    cancellation_template_versions do not stop it either.
--
--    Live grants when this file was written (privilege still held by the role shown):
--      TRUNCATE, authenticated + anon + service_role:
--        cancellation_events            <- the one named in the task: v1.10.0 revoked
--                                          update, delete but not truncate
--        cancellation_cases, cancellation_contacts, cancellation_suppressions,
--        cancellation_import_runs       <- same v1.10.0 omission
--        cancellation_templates, cancellation_prohibited_phrases  <- v1.10.1 revoked
--                                          nothing on these two
--      TRUNCATE, service_role only:
--        cancellation_template_versions <- v1.10.1 revoked from authenticated + anon only
--        cancellation_settings          <- v1.10.4 revoked from authenticated + anon only
--      DELETE, authenticated + anon:
--        cancellation_cases, cancellation_contacts, cancellation_suppressions,
--        cancellation_import_runs, cancellation_templates,
--        cancellation_prohibited_phrases
--      UPDATE, service_role, on two append-only tables:
--        cancellation_events, cancellation_template_versions
--
--    The sweep below is written as a catalog loop for the same reason section 2 is: it
--    cannot miss a table. It revokes
--      * TRUNCATE from authenticated, anon, service_role on every cancellation_* table —
--        no role has a spec'd reason to truncate any of them, and the audit tables must
--        survive even a service-key mistake;
--      * DELETE from authenticated and anon on every cancellation_* table — the design
--        grants delete to no role on any table, and no policy below is a delete policy,
--        so this only turns a silent "0 rows deleted" into a loud privilege error;
--      * UPDATE from authenticated and anon on the tables the design gives no update to
--        any role, which makes the absence of an update policy explicit at the privilege
--        level as well.
--    It does NOT revoke DELETE or UPDATE from service_role on the mutable business
--    tables: the server-side scheduler and the correction paths of Requirement 9 write
--    through that role, and narrowing it is not this task's call.
-- ═══════════════════════════════════════════════════════════════════════════════
do $sweep$
declare
  v_table       text;
  v_no_update   text[] := array[
    'cancellation_import_runs',
    'cancellation_events',
    'cancellation_templates',
    'cancellation_template_versions',
    'cancellation_prohibited_phrases',
    'cancellation_communications',
    'cancellation_communication_cases',
    'cancellation_notes',
    'cancellation_customer_responses',
    'cancellation_payment_reports',
    'cancellation_verification_outcomes'
  ];
begin
  for v_table in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cancellation%'
     order by c.relname
  loop
    execute format('revoke truncate on public.%I from authenticated, anon, service_role', v_table);
    execute format('revoke delete on public.%I from authenticated, anon', v_table);

    if v_table = any (v_no_update) then
      execute format('revoke update on public.%I from authenticated, anon', v_table);
    end if;
  end loop;

  -- The two append-only tables whose earlier stage stopped at authenticated + anon.
  -- The design is explicit that insert-only holds "even for the service role" on the
  -- audit surfaces, with the single documented exception of
  -- cancellation_retry_communication, which is security definer and runs as the owner,
  -- not as service_role, so it is unaffected by this.
  revoke update, delete on public.cancellation_events from service_role;
  revoke update, delete on public.cancellation_template_versions from service_role;
end
$sweep$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. THE POLICIES
--
--    Every policy is dropped by name before it is created, so the file is re-appliable,
--    and no name outside the 38 created here is ever dropped (Requirement 26.1).
--    Every policy is `to authenticated`.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 4.1 cancellation_import_runs ──────────────────────────────────────────────
--    Requirement 22.1 does not give Agent_Role any reason to see who imported what, and
--    the design's table says "no select" for `agent`: an import run row carries the
--    rejected, duplicate, and unmatched-label detail of an entire file, which spans
--    cases the agent cannot read. Read is therefore cancellation_can_read_all() —
--    manager, super_admin, customer_service, sales_supervisor — and insert is
--    Manager_Role only, because importing files is reserved to Manager_Role
--    (Requirement 22.3). The v1.10.5 loader is security definer and runs as the owner,
--    so it is not filtered by either policy.
drop policy if exists cancellation_import_runs_v1106_select on public.cancellation_import_runs;
create policy cancellation_import_runs_v1106_select on public.cancellation_import_runs
for select to authenticated
using (public.cancellation_can_read_all());

drop policy if exists cancellation_import_runs_v1106_insert on public.cancellation_import_runs;
create policy cancellation_import_runs_v1106_insert on public.cancellation_import_runs
for insert to authenticated
with check (
  public.cancellation_is_manager()
  and imported_by = auth.uid()
);

-- ── 4.2 cancellation_cases ────────────────────────────────────────────────────
--    Read: the design's read scope (Requirements 22.1, 22.12).
--    Insert: Manager_Role only. A case is created by an import or by a manager; no
--            criterion lets an Agent_Role profile conjure one.
--    Update: two permissive policies. Permissive policies OR together, so the manager
--            policy is the wide one and the own-row policy is what an Agent_Role,
--            customer_service, or sales_supervisor profile falls back to.
--            The own-row policy's USING clause excludes a case already at a terminal
--            status, which is the second half of Requirement 22.10: every status change
--            on a case at Reinstated, Cancelled, Resolved, Invalid, or Duplicate is
--            Manager_Role's. Its WITH CHECK keeps the row assigned to the same profile
--            (so no self-assignment and no hand-off) and allows the resulting status
--            only if it is one of the four values Requirement 22.10 permits or is the
--            value already stored (an update that did not touch the status at all).
drop policy if exists cancellation_cases_v1106_select on public.cancellation_cases;
create policy cancellation_cases_v1106_select on public.cancellation_cases
for select to authenticated
using (
  public.cancellation_can_read_all()
  or (
    auth.uid() is not null
    and (assigned_to = auth.uid() or assigned_to is null)
  )
);

drop policy if exists cancellation_cases_v1106_insert on public.cancellation_cases;
create policy cancellation_cases_v1106_insert on public.cancellation_cases
for insert to authenticated
with check (public.cancellation_is_manager());

drop policy if exists cancellation_cases_v1106_update_manager on public.cancellation_cases;
create policy cancellation_cases_v1106_update_manager on public.cancellation_cases
for update to authenticated
using (public.cancellation_is_manager())
with check (public.cancellation_is_manager());

drop policy if exists cancellation_cases_v1106_update_own on public.cancellation_cases;
create policy cancellation_cases_v1106_update_own on public.cancellation_cases
for update to authenticated
using (
  auth.uid() is not null
  and assigned_to = auth.uid()
  and case_status not in ('Reinstated', 'Cancelled', 'Resolved', 'Invalid', 'Duplicate')
)
with check (
  auth.uid() is not null
  and assigned_to = auth.uid()
  and (
    case_status in ('Open', 'Payment Reported', 'Verification Pending', 'Reinstatement Pending')
    or case_status = public.cancellation_case_stored_status(id)
  )
);

-- ── 4.3 cancellation_contacts ─────────────────────────────────────────────────
--    Read follows the case (a contact of a readable case is readable). Write is the case
--    being assigned to the acting profile, or Manager_Role: Requirement 22.2 lets an
--    Agent_Role profile add contact information and set preferred language on a case
--    assigned to itself, and Requirement 22.12 reserves every write to an unassigned
--    case and to another profile's case to Manager_Role. No delete policy: a contact is
--    corrected, not removed.
drop policy if exists cancellation_contacts_v1106_select on public.cancellation_contacts;
create policy cancellation_contacts_v1106_select on public.cancellation_contacts
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_contacts.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_contacts_v1106_insert on public.cancellation_contacts;
create policy cancellation_contacts_v1106_insert on public.cancellation_contacts
for insert to authenticated
with check (
  public.cancellation_is_manager()
  or exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_contacts.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
);

drop policy if exists cancellation_contacts_v1106_update on public.cancellation_contacts;
create policy cancellation_contacts_v1106_update on public.cancellation_contacts
for update to authenticated
using (
  public.cancellation_is_manager()
  or exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_contacts.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
)
with check (
  public.cancellation_is_manager()
  or exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_contacts.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
);

-- ── 4.4 cancellation_suppressions ─────────────────────────────────────────────
--    Not case-scoped: a suppression is keyed by normalized contact value and applies to
--    every case holding that value (Requirements 21.1–21.4). Every role that reaches the
--    workspace reads all of them, because a send decision on a readable case depends on
--    a row that names no case.
--    Insert is any signed-in profile recording an opt-out, constrained so the row cannot
--    lie about who recorded it and cannot arrive pre-cleared. `source` is pinned to
--    'user-recorded': the other permitted value, 'customer inbound message', is written
--    by the inbound-SMS webhook, which has no browser session and runs as service_role.
--    Update is Manager_Role and clear-only, which is Requirement 21.9: reason text of
--    1 to 2,000 non-whitespace-trimmed characters, the clearing profile stored, and the
--    resulting row actually cleared. A non-manager cannot clear a suppression at all.
drop policy if exists cancellation_suppressions_v1106_select on public.cancellation_suppressions;
create policy cancellation_suppressions_v1106_select on public.cancellation_suppressions
for select to authenticated
using (auth.uid() is not null);

drop policy if exists cancellation_suppressions_v1106_insert on public.cancellation_suppressions;
create policy cancellation_suppressions_v1106_insert on public.cancellation_suppressions
for insert to authenticated
with check (
  auth.uid() is not null
  and source = 'user-recorded'
  and actor_id = auth.uid()
  and cleared_at is null
  and cleared_by is null
);

drop policy if exists cancellation_suppressions_v1106_update_manager on public.cancellation_suppressions;
create policy cancellation_suppressions_v1106_update_manager on public.cancellation_suppressions
for update to authenticated
using (public.cancellation_is_manager())
with check (
  public.cancellation_is_manager()
  and cleared_at is not null
  and cleared_by = auth.uid()
  and char_length(btrim(coalesce(clear_reason, ''))) between 1 and 2000
);

-- ── 4.5 cancellation_events ───────────────────────────────────────────────────
--    The audit timeline. Select follows the case read scope (Requirement 22.1 applies the
--    same restriction to "audit timeline reads"). Insert is scoped to a readable case
--    rather than to an owned one: the timeline entry for an action is written by whatever
--    session performed the action, including an entry with no actor for a
--    system-generated evaluation, and blocking an audit write silently loses history.
--    It is not wider than the read scope, so no profile can forge history onto a case it
--    cannot see, and `actor_id` must be either absent (a system entry) or the acting
--    profile, so no entry can be attributed to somebody else.
--    NO update policy and NO delete policy, deliberately: Requirement 22.8. The
--    append-only trigger from v1.10.0 and the revokes in section 3 hold the same line for
--    the roles that bypass policies.
drop policy if exists cancellation_events_v1106_select on public.cancellation_events;
create policy cancellation_events_v1106_select on public.cancellation_events
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_events.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_events_v1106_insert on public.cancellation_events;
create policy cancellation_events_v1106_insert on public.cancellation_events
for insert to authenticated
with check (
  (actor_id is null or actor_id = auth.uid())
  and exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_events.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

-- ── 4.6 cancellation_templates ────────────────────────────────────────────────
--    Every role renders messages from these, so every role reads them. Insert is
--    Manager_Role (configuring templates is reserved by Requirement 22.3). No update and
--    no delete policy: a template's touchpoint and name are fixed, and a wording change
--    is a new cancellation_template_versions row, never an edit.
drop policy if exists cancellation_templates_v1106_select on public.cancellation_templates;
create policy cancellation_templates_v1106_select on public.cancellation_templates
for select to authenticated
using (auth.uid() is not null);

drop policy if exists cancellation_templates_v1106_insert on public.cancellation_templates;
create policy cancellation_templates_v1106_insert on public.cancellation_templates
for insert to authenticated
with check (public.cancellation_is_manager());

-- ── 4.7 cancellation_template_versions ────────────────────────────────────────
--    Same shape. Insert is Manager_Role and must name the acting profile as author, so a
--    version cannot be attributed to another manager. No update and no delete policy:
--    v1.10.1's trigger already refuses both, so a saved change can only add a
--    version + 1 row (Requirement 14.17).
drop policy if exists cancellation_template_versions_v1106_select on public.cancellation_template_versions;
create policy cancellation_template_versions_v1106_select on public.cancellation_template_versions
for select to authenticated
using (auth.uid() is not null);

drop policy if exists cancellation_template_versions_v1106_insert on public.cancellation_template_versions;
create policy cancellation_template_versions_v1106_insert on public.cancellation_template_versions
for insert to authenticated
with check (
  public.cancellation_is_manager()
  and (created_by is null or created_by = auth.uid())
);

-- ── 4.8 cancellation_prohibited_phrases ───────────────────────────────────────
--    The renderer's gate reads these on every render, so every role reads them. Insert is
--    Manager_Role. No update and no delete policy: a phrase is retired by clearing
--    is_active, which is an update — and the design's table says no update for this
--    table, so retiring a phrase is a migration or a service-role act, not a browser one.
drop policy if exists cancellation_prohibited_phrases_v1106_select on public.cancellation_prohibited_phrases;
create policy cancellation_prohibited_phrases_v1106_select on public.cancellation_prohibited_phrases
for select to authenticated
using (auth.uid() is not null);

drop policy if exists cancellation_prohibited_phrases_v1106_insert on public.cancellation_prohibited_phrases;
create policy cancellation_prohibited_phrases_v1106_insert on public.cancellation_prohibited_phrases
for insert to authenticated
with check (public.cancellation_is_manager());

-- ── 4.9 cancellation_communications ───────────────────────────────────────────
--    Insert-only for every role (Requirement 22.8). Insert is Manager_Role or the case
--    being assigned to the acting profile, which is what Requirement 22.2's Send Reminder
--    Now and Retry Failed Communication need.
--    NO update policy, deliberately: the one documented update path is
--    public.cancellation_retry_communication(...), which is security definer, runs as the
--    owner, and sets the transaction-local marker v1.10.2's trigger recognizes. Adding an
--    update policy here would create a second path and defeat that design.
drop policy if exists cancellation_communications_v1106_select on public.cancellation_communications;
create policy cancellation_communications_v1106_select on public.cancellation_communications
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_communications.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_communications_v1106_insert on public.cancellation_communications;
create policy cancellation_communications_v1106_insert on public.cancellation_communications
for insert to authenticated
with check (
  public.cancellation_is_manager()
  or exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_communications.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
);

-- ── 4.10 cancellation_communication_cases ─────────────────────────────────────
--    The link table for a combined multi-policy message. Same read scope and same insert
--    scope as the communication it links, so a combined send by an Agent_Role profile can
--    only link cases that profile may write.
drop policy if exists cancellation_communication_cases_v1106_select on public.cancellation_communication_cases;
create policy cancellation_communication_cases_v1106_select on public.cancellation_communication_cases
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_communication_cases.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_communication_cases_v1106_insert on public.cancellation_communication_cases;
create policy cancellation_communication_cases_v1106_insert on public.cancellation_communication_cases
for insert to authenticated
with check (
  public.cancellation_is_manager()
  or exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_communication_cases.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
);

-- ── 4.11 cancellation_settings ────────────────────────────────────────────────
--    One row, read by every role: the renderer needs office_phone, agency_name, and the
--    bilingual separator, and the drawer needs to know whether automatic sending is on.
--    Row level security filters rows, not columns, so "select automatic_sending_enabled
--    only" in the design's agent column is a UI and route concern; nothing in this row is
--    a credential.
--    Update is Manager_Role and must name the acting profile as the changer, which is
--    Requirement 26.4's "accept a change to that setting only from a profile holding
--    Manager_Role" plus its "store the new setting value, the changing profile, and the
--    change time". Until this policy exists a non-manager can flip the kill switch.
--    No insert policy and no delete policy: the single row is seeded by v1.10.4 and the
--    single-row check plus the primary key make a second one impossible anyway.
drop policy if exists cancellation_settings_v1106_select on public.cancellation_settings;
create policy cancellation_settings_v1106_select on public.cancellation_settings
for select to authenticated
using (auth.uid() is not null);

drop policy if exists cancellation_settings_v1106_update_manager on public.cancellation_settings;
create policy cancellation_settings_v1106_update_manager on public.cancellation_settings
for update to authenticated
using (public.cancellation_is_manager())
with check (
  public.cancellation_is_manager()
  and updated_by = auth.uid()
);

-- ── 4.12 cancellation_notes ───────────────────────────────────────────────────
--    Append-only case activity. Read follows the case; insert requires the case be
--    assigned to the acting profile (or Manager_Role) and the note name that profile as
--    author. No update and no delete policy: v1.10.3's trigger refuses both.
drop policy if exists cancellation_notes_v1106_select on public.cancellation_notes;
create policy cancellation_notes_v1106_select on public.cancellation_notes
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_notes.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_notes_v1106_insert on public.cancellation_notes;
create policy cancellation_notes_v1106_insert on public.cancellation_notes
for insert to authenticated
with check (
  created_by = auth.uid()
  and (
    public.cancellation_is_manager()
    or exists (
      select 1 from public.cancellation_cases c
       where c.id = cancellation_notes.case_id
         and c.assigned_to = auth.uid()
    )
  )
);

-- ── 4.13 cancellation_customer_responses ──────────────────────────────────────
--    Same shape as notes. Requirement 22.2 lists recording customer responses as an
--    Agent_Role action on a case assigned to that profile.
drop policy if exists cancellation_customer_responses_v1106_select on public.cancellation_customer_responses;
create policy cancellation_customer_responses_v1106_select on public.cancellation_customer_responses
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_customer_responses.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_customer_responses_v1106_insert on public.cancellation_customer_responses;
create policy cancellation_customer_responses_v1106_insert on public.cancellation_customer_responses
for insert to authenticated
with check (
  created_by = auth.uid()
  and (
    public.cancellation_is_manager()
    or exists (
      select 1 from public.cancellation_cases c
       where c.id = cancellation_customer_responses.case_id
         and c.assigned_to = auth.uid()
    )
  )
);

-- ── 4.14 cancellation_payment_reports ─────────────────────────────────────────
--    Same shape. The reporter is the acting profile; verification of that report is a
--    separate, Manager_Role-only row in the next table.
drop policy if exists cancellation_payment_reports_v1106_select on public.cancellation_payment_reports;
create policy cancellation_payment_reports_v1106_select on public.cancellation_payment_reports
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_payment_reports.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_payment_reports_v1106_insert on public.cancellation_payment_reports;
create policy cancellation_payment_reports_v1106_insert on public.cancellation_payment_reports
for insert to authenticated
with check (
  reported_by = auth.uid()
  and (
    public.cancellation_is_manager()
    or exists (
      select 1 from public.cancellation_cases c
       where c.id = cancellation_payment_reports.case_id
         and c.assigned_to = auth.uid()
    )
  )
);

-- ── 4.15 cancellation_verification_outcomes ───────────────────────────────────
--    Requirement 19.11: a profile that does not hold Manager_Role cannot record a payment
--    verification outcome at all. Insert is cancellation_is_manager() and nothing else —
--    not "or own case" — and the row must name the acting manager as recorder. Read
--    follows the case, so the agent who reported the payment can see how it was
--    verified. No update and no delete policy: v1.10.3's trigger refuses both.
drop policy if exists cancellation_verification_outcomes_v1106_select on public.cancellation_verification_outcomes;
create policy cancellation_verification_outcomes_v1106_select on public.cancellation_verification_outcomes
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_verification_outcomes.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_verification_outcomes_v1106_insert on public.cancellation_verification_outcomes;
create policy cancellation_verification_outcomes_v1106_insert on public.cancellation_verification_outcomes
for insert to authenticated
with check (
  public.cancellation_is_manager()
  and recorded_by = auth.uid()
);

-- ── 4.16 cancellation_escalations ─────────────────────────────────────────────
--    The one table in the series that is legitimately updatable by a non-manager:
--    v1.10.3 kept the update privilege for authenticated precisely so this clear-only
--    policy has something to sit on.
--    Insert: Manager_Role or own case — see "deliberate deviations" in the header.
--    Update, own case: the row must currently be UNCLEARED, so a cleared escalation
--    cannot be un-cleared or re-attributed by a non-manager; and the resulting row must
--    either still be uncleared (the Requirement 20.8 notified_at stamp) or be cleared by
--    the acting profile (Requirement 20.12).
--    No delete policy: an escalation is cleared, never removed, so the reason stays
--    readable in history.
drop policy if exists cancellation_escalations_v1106_select on public.cancellation_escalations;
create policy cancellation_escalations_v1106_select on public.cancellation_escalations
for select to authenticated
using (
  exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_escalations.case_id
       and (
         public.cancellation_can_read_all()
         or (auth.uid() is not null and (c.assigned_to = auth.uid() or c.assigned_to is null))
       )
  )
);

drop policy if exists cancellation_escalations_v1106_insert on public.cancellation_escalations;
create policy cancellation_escalations_v1106_insert on public.cancellation_escalations
for insert to authenticated
with check (
  public.cancellation_is_manager()
  or exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_escalations.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
);

drop policy if exists cancellation_escalations_v1106_update_manager on public.cancellation_escalations;
create policy cancellation_escalations_v1106_update_manager on public.cancellation_escalations
for update to authenticated
using (public.cancellation_is_manager())
with check (public.cancellation_is_manager());

drop policy if exists cancellation_escalations_v1106_update_own on public.cancellation_escalations;
create policy cancellation_escalations_v1106_update_own on public.cancellation_escalations
for update to authenticated
using (
  cleared_at is null
  and exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_escalations.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
)
with check (
  (cleared_at is null or cleared_by = auth.uid())
  and exists (
    select 1 from public.cancellation_cases c
     where c.id = cancellation_escalations.case_id
       and auth.uid() is not null
       and c.assigned_to = auth.uid()
  )
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. POST-CONDITIONS
--
--    Any failure below raises, which rolls the whole file back rather than leaving a
--    partially protected schema deployed. Three parts:
--      5a. Catalog sweep — every cancellation_* table protected, no policy shape the
--          design forbids, no client TRUNCATE or DELETE grant left anywhere.
--      5b. Live enforcement proof — a simulated session per role actually attempting the
--          reads and writes. Presence of a policy proves nothing about what it permits.
--      5c. Requirements 26.1 / 26.2 guard, by difference against the section 0 baseline.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_expected       text[] := array[
    'cancellation_cases',
    'cancellation_communication_cases',
    'cancellation_communications',
    'cancellation_contacts',
    'cancellation_customer_responses',
    'cancellation_escalations',
    'cancellation_events',
    'cancellation_import_runs',
    'cancellation_notes',
    'cancellation_payment_reports',
    'cancellation_prohibited_phrases',
    'cancellation_settings',
    'cancellation_suppressions',
    'cancellation_template_versions',
    'cancellation_templates',
    'cancellation_verification_outcomes'
  ];
  v_no_update      text[] := array[
    'cancellation_import_runs',
    'cancellation_events',
    'cancellation_templates',
    'cancellation_template_versions',
    'cancellation_prohibited_phrases',
    'cancellation_communications',
    'cancellation_communication_cases',
    'cancellation_notes',
    'cancellation_customer_responses',
    'cancellation_payment_reports',
    'cancellation_verification_outcomes'
  ];
  v_bad            text;
  v_count          integer;
  v_tables         integer;
  v_policies       integer;

  -- enforcement proof
  v_fail           text := '';
  v_agent          uuid;
  v_other          uuid;
  v_manager        uuid;
  v_super          uuid;
  v_cs             uuid;
  v_case_mine      uuid;
  v_case_theirs    uuid;
  v_case_open      uuid;
  v_run_id         uuid;
  v_rc             integer;
  v_seen           integer;
  v_who            text;
  v_case_baseline  bigint;
  v_run_baseline   bigint;
  v_event_baseline bigint;
begin
  -- ══════════════════════════════════════════════════════════════════════════
  -- 5a. CATALOG SWEEP
  -- ══════════════════════════════════════════════════════════════════════════

  -- ── Every table whose name starts with `cancellation` has row level security on.
  --    Read from the catalog, not from the list above, so a table added later and missed
  --    by this file still fails here.
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cancellation%'
     and not c.relrowsecurity;
  if v_bad is not null then
    raise exception 'v1.10.6 left row level security disabled on: %', v_bad
      using detail = 'Requirement 22.9 requires every permission rule in database policies.',
            hint = 'Rolling back.';
  end if;

  -- ── Every one of them carries at least one policy. Row level security with no policy
  --    denies everything, which is safe but wrong: it would break the workspace instead
  --    of scoping it.
  select string_agg(c.relname, ', ' order by c.relname) into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cancellation%'
     and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if v_bad is not null then
    raise exception 'v1.10.6 enabled row level security without any policy on: %', v_bad
      using detail = 'A table silently missed is the failure mode of this task.',
            hint = 'Rolling back.';
  end if;

  -- ── Every expected table is actually there (a rename or a missing earlier stage).
  select string_agg(e.name, ', ' order by e.name) into v_bad
    from unnest(v_expected) as e(name)
   where not exists (
     select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relname = e.name);
  if v_bad is not null then
    raise exception 'v1.10.6 could not find the expected table(s): %', v_bad
      using hint = 'Rolling back.';
  end if;

  select count(*) into v_tables
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cancellation%';
  select count(*) into v_policies
    from pg_policies where schemaname = 'public' and tablename like 'cancellation%';
  raise notice 'v1.10.6 protected % cancellation_* tables with % policies', v_tables, v_policies;

  -- ── No delete policy and no FOR ALL policy anywhere: the design grants delete to no
  --    role on any table, and a FOR ALL policy would silently grant delete.
  select string_agg(tablename || ' (' || policyname || ' ' || cmd || ')', ', ' order by tablename, policyname)
    into v_bad
    from pg_policies
   where schemaname = 'public' and tablename like 'cancellation%'
     and cmd in ('DELETE', 'ALL');
  if v_bad is not null then
    raise exception 'v1.10.6 created a delete or FOR ALL policy: %', v_bad
      using detail = 'No cancellation_* table grants delete to any role.', hint = 'Rolling back.';
  end if;

  -- ── No update policy on any append-only table (Requirement 22.8), and in particular
  --    none on cancellation_communications, whose only update path is the security
  --    definer retry function.
  select string_agg(tablename || ' (' || policyname || ')', ', ' order by tablename, policyname)
    into v_bad
    from pg_policies
   where schemaname = 'public' and tablename = any (v_no_update) and cmd = 'UPDATE';
  if v_bad is not null then
    raise exception 'v1.10.6 created an update policy on an append-only table: %', v_bad
      using detail = 'Requirement 22.8. cancellation_communications updates only through cancellation_retry_communication.',
            hint = 'Rolling back.';
  end if;

  -- ── Exactly five tables carry an update policy: cases, contacts, suppressions,
  --    escalations, settings.
  select count(distinct tablename) into v_count
    from pg_policies
   where schemaname = 'public' and tablename like 'cancellation%' and cmd = 'UPDATE';
  if v_count <> 5 then
    raise exception 'v1.10.6 put update policies on % cancellation_* tables, expected exactly 5', v_count
      using detail = 'Expected: cases, contacts, suppressions, escalations, settings.',
            hint = 'Rolling back.';
  end if;

  -- ── Every policy is granted to `authenticated` and to nothing else. A policy with
  --    polroles = {0} applies to PUBLIC, which would hand `anon` everything.
  select string_agg(c.relname || ' (' || p.polname || ')', ', ' order by c.relname, p.polname)
    into v_bad
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname like 'cancellation%'
     and p.polroles <> array[(select oid from pg_roles where rolname = 'authenticated')];
  if v_bad is not null then
    raise exception 'v1.10.6 created a policy not scoped to authenticated only: %', v_bad
      using detail = 'A policy applying to PUBLIC would include anon.', hint = 'Rolling back.';
  end if;

  -- ── The TRUNCATE hole is closed on every table, for all three client roles. This is
  --    the check that would have caught v1.10.0's cancellation_events omission.
  select string_agg(table_name || ' -> ' || grantee, ', ' order by table_name, grantee)
    into v_bad
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name like 'cancellation%'
     and grantee in ('authenticated', 'anon', 'service_role')
     and privilege_type = 'TRUNCATE';
  if v_bad is not null then
    raise exception 'v1.10.6 left TRUNCATE granted: %', v_bad
      using detail = 'TRUNCATE is never checked against a policy and fires no row trigger, so it erases an append-only table in one statement.',
            hint = 'Rolling back.';
  end if;

  -- ── No client DELETE grant anywhere either.
  select string_agg(table_name || ' -> ' || grantee, ', ' order by table_name, grantee)
    into v_bad
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name like 'cancellation%'
     and grantee in ('authenticated', 'anon')
     and privilege_type = 'DELETE';
  if v_bad is not null then
    raise exception 'v1.10.6 left DELETE granted to a client role: %', v_bad
      using hint = 'Rolling back.';
  end if;

  -- ── And no client UPDATE grant on a table the design gives no update to.
  select string_agg(table_name || ' -> ' || grantee, ', ' order by table_name, grantee)
    into v_bad
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = any (v_no_update)
     and grantee in ('authenticated', 'anon')
     and privilege_type = 'UPDATE';
  if v_bad is not null then
    raise exception 'v1.10.6 left UPDATE granted on an append-only table: %', v_bad
      using hint = 'Rolling back.';
  end if;

  -- ── The status accessor is the shape the cases policy depends on.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancellation_case_stored_status'
       and p.prosecdef and p.provolatile = 's'
       and p.proconfig @> array['search_path=public']
  ) then
    raise exception 'v1.10.6 did not create public.cancellation_case_stored_status(uuid) as a stable security definer with a pinned search_path'
      using detail = 'Security invoker would recurse through cancellation_cases; volatile would read the post-update value.',
            hint = 'Rolling back.';
  end if;

  -- ── The two v1.10.8 storage policies are still exactly as task 7.9 left them.
  select count(*) into v_count
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname like 'cancellation_evidence_v1108%'
     and position('cancellation_can_access_evidence' in coalesce(qual, '') || ' ' || coalesce(with_check, '')) > 0;
  if v_count <> 2 then
    raise exception 'v1.10.6 changed the v1.10.8 evidence policies: % of 2 intact', v_count
      using detail = 'The storage.objects policies belong to task 7.9 and are not this file''s to touch.',
            hint = 'Rolling back.';
  end if;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 5b. LIVE ENFORCEMENT PROOF
  --
  --     current_user here is postgres, which holds rolbypassrls, so nothing above
  --     proves a policy actually decides anything. The block below inserts probe rows,
  --     switches to the `authenticated` role, simulates one session per role by setting
  --     request.jwt.claims (which is what auth.uid() reads), and attempts the reads and
  --     writes that matter. Every probe row is discarded by raising a sentinel at the
  --     end of the block: plpgsql variables are not transactional, so the recorded
  --     outcomes survive that rollback while the rows do not.
  --
  --     Two failure shapes to keep straight:
  --       * A USING clause that excludes the row -> the statement affects 0 rows and
  --         raises nothing.
  --       * A WITH CHECK clause the new row fails -> SQLSTATE 42501.
  -- ══════════════════════════════════════════════════════════════════════════
  select count(*) into v_case_baseline from public.cancellation_cases;
  select count(*) into v_run_baseline from public.cancellation_import_runs;
  select count(*) into v_event_baseline from public.cancellation_events;

  select id into v_agent   from public.profiles where role::text = 'agent' order by id limit 1;
  select id into v_other   from public.profiles where role::text = 'agent' and id <> v_agent order by id limit 1;
  select id into v_manager from public.profiles where role::text = 'manager' order by id limit 1;
  select id into v_super   from public.profiles where role::text = 'super_admin' order by id limit 1;
  select id into v_cs      from public.profiles where role::text = 'customer_service' order by id limit 1;

  if v_agent is null or v_other is null or v_manager is null then
    raise exception 'v1.10.6 could not find two agent profiles and one manager profile to prove enforcement with'
      using detail = 'The proof needs an owner, a second non-manager to own a case the first must not see, and a manager.',
            hint = 'Rolling back.';
  end if;

  begin
    -- ── Probe rows, inserted as the owner (policies not consulted).
    insert into public.cancellation_import_runs
      (file_name, column_set, imported_by, confirmed_mapping,
       rows_total, rows_created, rows_updated, rows_rejected, rows_duplicate)
    values ('v1106-enforcement-probe.csv', 'avisos', v_manager, '{}'::jsonb, 0, 0, 0, 0, 0)
    returning id into v_run_id;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header, assigned_to, case_status)
    values ('V1106-PROBE-MINE-' || gen_random_uuid()::text, current_date,
            '[]'::jsonb, array['v1106_probe'], v_agent, 'Imported')
    returning id into v_case_mine;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header, assigned_to, case_status)
    values ('V1106-PROBE-THEIRS-' || gen_random_uuid()::text, current_date,
            '[]'::jsonb, array['v1106_probe'], v_other, 'Open')
    returning id into v_case_theirs;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header, assigned_to, case_status)
    values ('V1106-PROBE-OPEN-' || gen_random_uuid()::text, current_date,
            '[]'::jsonb, array['v1106_probe'], null, 'Open')
    returning id into v_case_open;

    -- ── Become a client. Without this every probe below runs as a rolbypassrls role and
    --    proves nothing at all.
    execute 'set local role authenticated';
    select current_user into v_who;
    if v_who <> 'authenticated' then
      raise exception 'v1.10.6 could not switch to the authenticated role (current_user = %)', v_who;
    end if;

    -- ══════════════════════════════════════════════════════════════════════
    -- SESSION 1: the agent that owns v_case_mine
    -- ══════════════════════════════════════════════════════════════════════
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_agent::text, 'role', 'authenticated')::text, true);

    -- Cannot read a case assigned to somebody else (Requirement 22.1).
    select count(*) into v_seen from public.cancellation_cases where id = v_case_theirs;
    if v_seen <> 0 then
      v_fail := v_fail || format('[agent read another profile''s case: %s rows] ', v_seen);
    end if;

    -- Can read its own case and an unassigned one.
    select count(*) into v_seen from public.cancellation_cases where id in (v_case_mine, v_case_open);
    if v_seen <> 2 then
      v_fail := v_fail || format('[agent saw %s of its 2 readable cases] ', v_seen);
    end if;

    -- Cannot read import runs at all (design: no select for agent).
    select count(*) into v_seen from public.cancellation_import_runs;
    if v_seen <> 0 then
      v_fail := v_fail || format('[agent read %s import run rows] ', v_seen);
    end if;

    -- Cannot record a payment verification outcome (Requirement 19.11).
    begin
      insert into public.cancellation_verification_outcomes
        (case_id, recorded_by, outcome) values (v_case_mine, v_agent, 'Policy reinstated');
      v_fail := v_fail || '[agent inserted a verification outcome] ';
    exception when insufficient_privilege then null;
    end;

    -- Cannot flip the automatic-sending kill switch (Requirement 26.4).
    update public.cancellation_settings
       set automatic_sending_enabled = false, updated_by = v_agent, updated_at = now();
    get diagnostics v_rc = row_count;
    if v_rc <> 0 then
      v_fail := v_fail || format('[agent updated cancellation_settings: %s rows] ', v_rc);
    end if;

    -- Cannot create a case.
    begin
      insert into public.cancellation_cases
        (policy_number, cancellation_effective_date, raw_row, raw_header)
      values ('V1106-PROBE-AGENT-INSERT', current_date, '[]'::jsonb, array['v1106_probe']);
      v_fail := v_fail || '[agent inserted a cancellation case] ';
    exception when insufficient_privilege then null;
    end;

    -- CAN update a non-status column on its own case even though that case sits at a
    -- status outside the Requirement 22.10 four. This is the branch the status accessor
    -- exists for; without it this legitimate write would be refused.
    update public.cancellation_cases set assistance_requested = true where id = v_case_mine;
    get diagnostics v_rc = row_count;
    if v_rc <> 1 then
      v_fail := v_fail || format('[agent could not flag assistance on its own Imported case: %s rows] ', v_rc);
    end if;

    -- Cannot set a Case_Status reserved to Manager_Role (Requirement 22.10). The row is
    -- selected by the USING clause, so this is a WITH CHECK violation, not a no-op.
    begin
      update public.cancellation_cases set case_status = 'Cancelled' where id = v_case_mine;
      v_fail := v_fail || '[agent set case_status Cancelled] ';
    exception when insufficient_privilege then null;
    end;

    -- CAN set one of the four permitted values.
    update public.cancellation_cases set case_status = 'Payment Reported' where id = v_case_mine;
    get diagnostics v_rc = row_count;
    if v_rc <> 1 then
      v_fail := v_fail || format('[agent could not set a permitted case_status: %s rows] ', v_rc);
    end if;

    -- Cannot write another profile's case, or an unassigned one (Requirement 22.12).
    update public.cancellation_cases set assistance_requested = true where id = v_case_theirs;
    get diagnostics v_rc = row_count;
    if v_rc <> 0 then
      v_fail := v_fail || format('[agent wrote another profile''s case: %s rows] ', v_rc);
    end if;

    update public.cancellation_cases set assistance_requested = true where id = v_case_open;
    get diagnostics v_rc = row_count;
    if v_rc <> 0 then
      v_fail := v_fail || format('[agent wrote an unassigned case: %s rows] ', v_rc);
    end if;

    -- CAN add a note to its own case, naming itself as author.
    begin
      insert into public.cancellation_notes (case_id, note, created_by)
      values (v_case_mine, 'v1.10.6 enforcement probe', v_agent);
    exception when others then
      v_fail := v_fail || format('[agent could not note its own case: %s] ', sqlerrm);
    end;

    -- Cannot add a note to another profile's case, or attribute one to another profile.
    begin
      insert into public.cancellation_notes (case_id, note, created_by)
      values (v_case_theirs, 'v1.10.6 enforcement probe', v_agent);
      v_fail := v_fail || '[agent noted another profile''s case] ';
    exception when insufficient_privilege then null;
    end;

    begin
      insert into public.cancellation_notes (case_id, note, created_by)
      values (v_case_mine, 'v1.10.6 enforcement probe', v_other);
      v_fail := v_fail || '[agent attributed a note to another profile] ';
    exception when insufficient_privilege then null;
    end;

    -- CAN append an audit entry on a case it can read; cannot forge one onto a case it
    -- cannot read, and cannot attribute one to another profile.
    begin
      insert into public.cancellation_events (case_id, actor_id, event_type)
      values (v_case_open, v_agent, 'probe.v1106');
    exception when others then
      v_fail := v_fail || format('[agent could not append an audit entry to a readable case: %s] ', sqlerrm);
    end;

    begin
      insert into public.cancellation_events (case_id, actor_id, event_type)
      values (v_case_theirs, v_agent, 'probe.v1106');
      v_fail := v_fail || '[agent appended an audit entry to an unreadable case] ';
    exception when insufficient_privilege then null;
    end;

    begin
      insert into public.cancellation_events (case_id, actor_id, event_type)
      values (v_case_mine, v_other, 'probe.v1106');
      v_fail := v_fail || '[agent attributed an audit entry to another profile] ';
    exception when insufficient_privilege then null;
    end;

    -- ══════════════════════════════════════════════════════════════════════
    -- SESSION 2: customer_service — reads everything, writes only its own
    --            (Requirement 22.12)
    -- ══════════════════════════════════════════════════════════════════════
    if v_cs is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_cs::text, 'role', 'authenticated')::text, true);

      select count(*) into v_seen from public.cancellation_cases
       where id in (v_case_mine, v_case_theirs, v_case_open);
      if v_seen <> 3 then
        v_fail := v_fail || format('[customer_service saw %s of 3 cases] ', v_seen);
      end if;

      select count(*) into v_seen from public.cancellation_import_runs where id = v_run_id;
      if v_seen <> 1 then
        v_fail := v_fail || '[customer_service could not read an import run] ';
      end if;

      update public.cancellation_cases set assistance_requested = true where id = v_case_theirs;
      get diagnostics v_rc = row_count;
      if v_rc <> 0 then
        v_fail := v_fail || format('[customer_service wrote a case assigned elsewhere: %s rows] ', v_rc);
      end if;

      begin
        insert into public.cancellation_verification_outcomes
          (case_id, recorded_by, outcome) values (v_case_theirs, v_cs, 'Policy reinstated');
        v_fail := v_fail || '[customer_service inserted a verification outcome] ';
      exception when insufficient_privilege then null;
      end;

      update public.cancellation_settings
         set automatic_sending_enabled = false, updated_by = v_cs, updated_at = now();
      get diagnostics v_rc = row_count;
      if v_rc <> 0 then
        v_fail := v_fail || format('[customer_service updated cancellation_settings: %s rows] ', v_rc);
      end if;
    end if;

    -- ══════════════════════════════════════════════════════════════════════
    -- SESSION 3: manager — the same three attempts must all succeed
    -- ══════════════════════════════════════════════════════════════════════
    perform set_config('request.jwt.claims',
      json_build_object('sub', v_manager::text, 'role', 'authenticated')::text, true);

    select count(*) into v_seen from public.cancellation_cases
     where id in (v_case_mine, v_case_theirs, v_case_open);
    if v_seen <> 3 then
      v_fail := v_fail || format('[manager saw %s of 3 cases] ', v_seen);
    end if;

    select count(*) into v_seen from public.cancellation_import_runs where id = v_run_id;
    if v_seen <> 1 then
      v_fail := v_fail || '[manager could not read an import run] ';
    end if;

    begin
      insert into public.cancellation_verification_outcomes
        (case_id, recorded_by, outcome) values (v_case_theirs, v_manager, 'Policy reinstated');
    exception when others then
      v_fail := v_fail || format('[manager could not record a verification outcome: %s] ', sqlerrm);
    end;

    update public.cancellation_settings
       set automatic_sending_enabled = false, updated_by = v_manager, updated_at = now();
    get diagnostics v_rc = row_count;
    if v_rc <> 1 then
      v_fail := v_fail || format('[manager could not update cancellation_settings: %s rows] ', v_rc);
    end if;

    -- A manager without updated_by is still refused: Requirement 26.4 stores the
    -- changing profile, so the policy will not accept an anonymous change.
    begin
      update public.cancellation_settings
         set automatic_sending_enabled = false, updated_by = null;
      v_fail := v_fail || '[manager updated settings without naming itself] ';
    exception when insufficient_privilege then null;
    end;

    update public.cancellation_cases set case_status = 'Cancelled' where id = v_case_theirs;
    get diagnostics v_rc = row_count;
    if v_rc <> 1 then
      v_fail := v_fail || format('[manager could not set a reserved case_status: %s rows] ', v_rc);
    end if;

    -- ══════════════════════════════════════════════════════════════════════
    -- SESSION 4: super_admin holds every Manager_Role permission (Req 22.5)
    -- ══════════════════════════════════════════════════════════════════════
    if v_super is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', v_super::text, 'role', 'authenticated')::text, true);
      begin
        insert into public.cancellation_verification_outcomes
          (case_id, recorded_by, outcome) values (v_case_open, v_super, 'Policy reinstated');
      exception when others then
        v_fail := v_fail || format('[super_admin could not record a verification outcome: %s] ', sqlerrm);
      end;
    end if;

    -- ── Tear the simulated session down and hand the role back before the rollback.
    perform set_config('request.jwt.claims', '', true);
    execute 'reset role';

    raise exception 'v1106_probe_done' using errcode = 'RS001';
  exception
    when sqlstate 'RS001' then
      null;  -- probe rows discarded; the recorded outcomes are in v_fail
    when others then
      v_fail := v_fail || format('[probe raised unexpectedly: %s %s] ', sqlstate, sqlerrm);
  end;

  if v_fail <> '' then
    raise exception 'v1.10.6 enforcement proof failed: %', v_fail
      using detail = 'A policy was created but does not permit or deny what the requirements say it must.',
            hint = 'Rolling back.';
  end if;

  -- ── The probe left nothing behind.
  select count(*) into v_count from public.cancellation_cases;
  if v_count <> v_case_baseline then
    raise exception 'v1.10.6 left probe residue in cancellation_cases: % rows, expected %',
                    v_count, v_case_baseline using hint = 'Rolling back.';
  end if;
  select count(*) into v_count from public.cancellation_import_runs;
  if v_count <> v_run_baseline then
    raise exception 'v1.10.6 left probe residue in cancellation_import_runs: % rows, expected %',
                    v_count, v_run_baseline using hint = 'Rolling back.';
  end if;
  select count(*) into v_count from public.cancellation_events;
  if v_count <> v_event_baseline then
    raise exception 'v1.10.6 left probe residue in cancellation_events: % rows, expected %',
                    v_count, v_event_baseline using hint = 'Rolling back.';
  end if;

  -- ── The role really did come back.
  select current_user into v_who;
  if v_who = 'authenticated' then
    raise exception 'v1.10.6 finished the enforcement proof still running as authenticated'
      using hint = 'Rolling back.';
  end if;

  -- ══════════════════════════════════════════════════════════════════════════
  -- 5c. REQUIREMENTS 26.1 / 26.2 — nothing outside public.cancellation_* moved
  -- ══════════════════════════════════════════════════════════════════════════
  select count(*) into v_count
    from pg_policies p
   where not (p.schemaname = 'public' and p.tablename like 'cancellation%')
     and not exists (
       select 1 from _v1106_policy_baseline b
        where b.schemaname = p.schemaname and b.tablename = p.tablename
          and b.policyname = p.policyname);
  if v_count <> 0 then
    raise exception 'v1.10.6 added % policy(ies) outside public.cancellation_*', v_count
      using detail = 'Requirement 26.1: this file touches nothing created at v1.9.7 or earlier, and the v1.10.8 storage policies are not its to change.',
            hint = 'Rolling back.';
  end if;

  select count(*) into v_count
    from _v1106_policy_baseline b
   where not exists (
     select 1 from pg_policies p
      where p.schemaname = b.schemaname and p.tablename = b.tablename
        and p.policyname = b.policyname);
  if v_count <> 0 then
    raise exception 'v1.10.6 dropped % policy(ies) outside public.cancellation_*', v_count
      using detail = 'Requirement 26.1: only the 38 policies this file creates are ever dropped by it.',
            hint = 'Rolling back.';
  end if;

  select string_agg(b.schemaname || '.' || b.tablename, ', ' order by b.schemaname, b.tablename)
    into v_bad
    from _v1106_rls_baseline b
    join pg_class c on c.relname = b.tablename
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = b.schemaname
   where c.relkind = 'r' and c.relrowsecurity is distinct from b.relrowsecurity;
  if v_bad is not null then
    raise exception 'v1.10.6 changed the row-level-security flag of: %', v_bad
      using detail = 'Only cancellation_* tables are this file''s to enable.', hint = 'Rolling back.';
  end if;
end
$post$;

commit;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname like 'cancellation%') as cancellation_tables_expect_16,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname like 'cancellation%' and c.relrowsecurity) as rls_enabled_expect_16,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'cancellation%'
      and exists (select 1 from pg_policy p where p.polrelid = c.oid)) as tables_with_a_policy_expect_16,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%') as policies_total_expect_38,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%'
      and cmd = 'SELECT') as select_policies_expect_16,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%'
      and cmd = 'INSERT') as insert_policies_expect_15,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%'
      and cmd = 'UPDATE') as update_policies_expect_7,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%'
      and cmd in ('DELETE', 'ALL')) as delete_or_all_policies_expect_0,
  (select count(distinct tablename) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%'
      and cmd = 'UPDATE') as tables_with_update_policy_expect_5,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename like 'cancellation%'
      and roles::text <> '{authenticated}') as policies_not_authenticated_only_expect_0,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name like 'cancellation%'
      and grantee in ('authenticated', 'anon', 'service_role')
      and privilege_type = 'TRUNCATE') as client_truncate_grants_expect_0,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name like 'cancellation%'
      and grantee in ('authenticated', 'anon')
      and privilege_type = 'DELETE') as client_delete_grants_expect_0,
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cancellation_events'
      and grantee in ('authenticated', 'anon', 'service_role')
      and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')) as events_write_grants_expect_0,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('cancellation_is_manager', 'cancellation_can_read_all',
                        'cancellation_can_access_evidence', 'cancellation_case_stored_status')
      and p.prosecdef) as security_definer_helpers_expect_4,
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname like 'cancellation_evidence_v1108%') as v1108_storage_policies_untouched_expect_2;
