-- New Hope Work Desk v1.10.3 — Cancellation case activity (migration stage 4 of 10)
--
-- Spec: .kiro/specs/policy-follow-up-renewals-cancellations (task 7.4)
-- Requirements: 17.8, 18.5, 18.6, 19.1, 20.10, 21.5, 26.1
-- Also narrowed by: 18.7, 19.2, 19.5, 19.9, 20.12, 21.5, 22.8, 24.x evidence paths
--
-- Forward-only, fourth file of the v1.10.x series. Creates five new tables, five
-- indexes, one trigger function, and four triggers. Touches no table, column, policy,
-- function, or row created at v1.9.7 or earlier: nothing outside the new cancellation_*
-- objects is written, altered, dropped, or truncated (Requirements 26.1, 26.2). The one
-- read outside them is a single `public.profiles` id in the post-condition block, used
-- as the author of the discarded probe rows; nothing is written there. The only drops in
-- this file are the four `drop trigger if exists` statements immediately before their
-- own `create trigger`, and the drops listed in the rollback path below, which name only
-- objects this file creates.
--
-- Contents:
--   1. cancellation_notes                     free-text notes plus evidence (Req 17.8)
--   2. cancellation_customer_responses        the six recorded response types (Req 21.5)
--   3. cancellation_payment_reports           customer payment reports (Req 18.5, 18.6)
--   4. cancellation_verification_outcomes     the seven verification outcomes (Req 19.1)
--   5. cancellation_escalations               one row per (case, escalation reason),
--                                             unique so at most one notification exists
--                                             for that pair (Req 20.10)
--   6. cancellation_case_activity_immutable() + its four before update or delete
--                                             triggers, and the update/delete/truncate
--                                             revokes
--   7. Post-conditions, including live proof that every check, the unique key, the
--      on delete restrict rules, and the immutability trigger fire
--
-- ROW LEVEL SECURITY IS DELIBERATELY NOT ENABLED HERE.
--   v1.10.6-cancellation-rls.sql (task 7.7) runs `enable row level security` on every
--   cancellation_* table and adds every policy, including the design's rows for these
--   five tables: cancellation_notes and cancellation_customer_responses are
--   select-for-readable-cases plus insert (own cases for agent and customer_service);
--   cancellation_payment_reports the same; cancellation_verification_outcomes is
--   select-for-readable-cases with insert for Manager_Role only (Requirement 19.11);
--   cancellation_escalations is select-for-readable-cases with a clear-only update for
--   agent and customer_service and insert/update for Manager_Role.
--   UNTIL TASK 7.7 LANDS ALL FIVE TABLES BELOW ARE UNPROTECTED: any `authenticated`
--   session can select and insert across every case, so this intermediate state must
--   not be left deployed. `case_id` is present and not null on all five so those
--   policies can join to the readable-case set, and every helper they need already
--   exists — public.cancellation_is_manager() and public.cancellation_can_read_all()
--   come from v1.10.0 and are deliberately NOT redefined here. Every manager check in
--   the series reuses cancellation_is_manager(), which admits `manager` and
--   `super_admin`; this file defines no new role test and no new helper.
--   The enforcement that DOES hold from this migration onward, for every role and on
--   every security definer path, is append-only immutability on the four record tables
--   (below) and the (case_id, reason) unique key on escalations.
--
-- WHICH TABLES ARE APPEND-ONLY, AND WHICH IS NOT
--   Append-only — no update, no delete, on any path including a security definer path:
--     cancellation_notes, cancellation_customer_responses,
--     cancellation_payment_reports, cancellation_verification_outcomes.
--   Each is a record of something a person did at a point in time and the design's RLS
--   rows give all four select and insert with no update policy and no delete policy.
--   Requirement 21.6 and 19.9 have a recorded response or outcome leave prior stored
--   rows untouched, and Requirement 22.8 forbids changing or removing stored history.
--   A correction is a new row, never an edit.
--
--   NOT append-only — cancellation_escalations.
--   Its cleared_at, cleared_by, and notified_at columns are written AFTER insert:
--   Requirement 20.12 clears every uncleared escalation reason when a manual contact
--   outcome is recorded, and Requirement 20.10 caps notifications at one per
--   (case, reason) pair, which is recorded by stamping notified_at on the existing row.
--   Because the pair is unique, a reason that is raised again after being cleared has to
--   reopen the SAME row rather than insert a second one, so raised_at is writable too.
--   It therefore gets NO immutability trigger and keeps its update privilege, so that
--   task 7.7's clear-only update policy has a privilege to sit on top of. Delete and
--   truncate are still revoked: the design grants delete to no role on any table.
--
-- WHY TRUNCATE IS REVOKED AND NOT JUST TRAPPED
--   `truncate` does not fire row triggers. A trigger alone therefore leaves any role
--   holding the truncate privilege — which Supabase's default grants hand to
--   `authenticated`, `anon`, and `service_role` on every new public table — able to
--   erase an entire table of case history in one statement while being unable to change
--   a single row of it. The same gap was closed on cancellation_template_versions at
--   task 7.2 and on both v1.10.2 tables at task 7.3; the revoke is applied here for the
--   same reason, on top of the trigger rather than instead of it. `service_role` is
--   included on purpose: none of these five tables has a documented update path the way
--   cancellation_communications has its retry function, so insert-only holds for the
--   scheduler and every server-side helper too. Revoking a privilege drops no object and
--   touches nothing created at v1.9.7 or earlier.
--
-- EVIDENCE COLUMNS
--   `evidence jsonb not null default '[]'` on notes, payment reports, and verification
--   outcomes, each guarded by `check (jsonb_typeof(evidence) = 'array')` — the same
--   shape guard v1.10.0 puts on cancellation_cases.raw_row, so a caller cannot store an
--   object or a scalar where the reader expects a list. The array holds storage paths
--   into the private `cancellation-evidence` bucket created at v1.10.8, laid out as
--   `<case_id>/<file>`; read and write access to those objects is governed by
--   public.cancellation_can_access_evidence(text) from that migration, not by anything
--   here. No check parses the array elements: the file-count and size limits of
--   Requirements 17.9 and 18.10 are enforced at upload time, before a row is written,
--   and duplicating them as a constraint would refuse a row whose upload already
--   succeeded.
--
-- DELIBERATE NARROWINGS BEYOND THE DESIGN'S COLUMN LIST
--   The design's Phase 2 data model is the authoritative column list and every column
--   below comes from it. These constraints go beyond it, each only refusing a write that
--   no acceptance criterion permits:
--     * cancellation_customer_responses.note — `<= 2000` characters (Requirement 21.5),
--       and non-blank for the response types `Assistance requested` and `Other`, which
--       is the one thing 21.5 makes conditional on the type.
--     * cancellation_verification_outcomes.note — `<= 2000` characters, and the
--       required-inputs check: the four outcomes that Requirements 19.2 and 19.5 make
--       conditional (`Other`, `Payment not found`, `Additional payment required`,
--       `Policy still scheduled for cancellation`) must carry non-blank note text, a
--       next_case_status drawn from Open / Verification Pending / Cancelled, and a
--       non-blank next_required_action. Every comparison is wrapped in coalesce, because
--       a check constraint passes when its expression evaluates to null and an absent
--       next_case_status is exactly the submission 19.2 and 19.5 tell us to reject.
--     * `on delete restrict` spelled out on all ten foreign keys, including the author
--       columns: a profile that recorded a note, a response, a payment report, a
--       verification outcome, or an escalation clearing cannot be deleted out from under
--       that evidence (Requirement 22.8).
--     * The five lookup indexes, all case-first, which is how the drawer reads every one
--       of these tables (Requirement 17.1).
--
-- DELIBERATELY NOT ENFORCED HERE
--   * No `(cleared_at is null) = (cleared_by is null)` pairing check on escalations.
--     Requirement 20.12 always has a user behind a clearing, so the pair should move
--     together, but nothing forbids a future automatic clear with no actor and refusing
--     it here would be inventing a rule.
--   * No constraint linking a verification outcome to the Case_Status it produces, and
--     none linking a payment report to Case_Status. Requirements 18.1, 18.8, 19.3, 19.4,
--     and 19.7 are transition rules over public.cancellation_cases, a v1.10.0 table this
--     file does not own; they belong to the mutation functions of tasks 18.x and 19.x.
--   * next_case_status and next_required_action are free text outside the four
--     conditional outcomes: 19.3, 19.4, and 19.7 set them from the outcome itself rather
--     than from user input, and the Case_Status vocabulary is already constrained on
--     cancellation_cases.
--   * response_channel is free text. No criterion enumerates it — Requirement 21.5 only
--     requires that it be stored — and the value legitimately records a channel the
--     module does not send on, such as an inbound phone call.
--
-- ROLLBACK PATH
--   begin;
--     drop trigger if exists cancellation_notes_no_update
--       on public.cancellation_notes;
--     drop trigger if exists cancellation_customer_responses_no_update
--       on public.cancellation_customer_responses;
--     drop trigger if exists cancellation_payment_reports_no_update
--       on public.cancellation_payment_reports;
--     drop trigger if exists cancellation_verification_outcomes_no_update
--       on public.cancellation_verification_outcomes;
--     drop function if exists public.cancellation_case_activity_immutable();
--     drop table if exists public.cancellation_escalations;
--     drop table if exists public.cancellation_verification_outcomes;
--     drop table if exists public.cancellation_payment_reports;
--     drop table if exists public.cancellation_customer_responses;
--     drop table if exists public.cancellation_notes;
--   commit;
--   Dropping the five tables drops their indexes, constraints, grants, and triggers with
--   them; all five must go before v1.10.0's cancellation_cases and public.profiles. No
--   pre-existing row is touched by the rollback, because none is touched by the
--   migration. This is the code-level rollback only; Requirement 26.3 keeps applied
--   v1.10.x migrations in place when application code is rolled back.

begin;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 1. NOTES — free-text case notes with optional evidence (Requirement 17.8).
--
--    The 1..4000 range is measured on btrim(note), because 17.8 states the range
--    "after leading and trailing whitespace is removed": a note of 4,000 characters
--    padded with spaces is accepted, a note of nothing but spaces is not.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_notes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  note text not null
    constraint cancellation_notes_note_length
      check (char_length(btrim(note)) between 1 and 4000),
  evidence jsonb not null default '[]'
    constraint cancellation_notes_evidence_is_array
      check (jsonb_typeof(evidence) = 'array'),
  created_by uuid not null
    references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table public.cancellation_notes is
  'Case notes recorded in the cancellation detail drawer (Requirement 17.8). Append-only for every role including a security definer path: a correction is a new note, never an edit (Requirement 22.8).';
comment on column public.cancellation_notes.note is
  'Note text, 1 to 4,000 characters measured after leading and trailing whitespace is removed (Requirement 17.8).';
comment on column public.cancellation_notes.evidence is
  'JSON array of storage paths into the private cancellation-evidence bucket, laid out as <case_id>/<file>. Access is governed by public.cancellation_can_access_evidence(text) from v1.10.8. The array shape is guarded here; the 10-file and 100-megabyte limits of Requirement 17.9 are enforced at upload time, before this row is written.';

-- The drawer reads notes for one case, most recent first (Requirement 17.1).
create index if not exists idx_cancellation_notes_case_time
  on public.cancellation_notes (case_id, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 2. CUSTOMER RESPONSES — exactly one of the six response types (Requirement 21.5).
--
--    response_time defaults to now() but is writable on insert: 21.5 stores "the
--    response time", which for a response relayed after the fact is earlier than the
--    moment it was recorded.
--    Requirement 21.7 turns `Assistance requested` and `Callback requested` into the
--    assistance-requested flag on the case and into Requirement 20.4's escalation
--    reason `Customer Assistance Requested`; that flag lives on cancellation_cases and
--    the escalation row lives in table 5, so nothing here writes either one.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_customer_responses (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  response_type text not null
    constraint cancellation_customer_responses_response_type_values
      check (response_type in ('Assistance requested',
                               'Callback requested',
                               'Opted out of SMS',
                               'Opted out of email',
                               'No assistance needed',
                               'Other')),
  response_channel text,
  response_time timestamptz not null default now(),
  note text
    constraint cancellation_customer_responses_note_length
      check (note is null or char_length(note) <= 2000),
  constraint cancellation_customer_responses_note_required
    check (response_type not in ('Assistance requested', 'Other')
           or char_length(btrim(coalesce(note, ''))) >= 1),
  created_by uuid not null
    references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

comment on table public.cancellation_customer_responses is
  'Recorded customer responses (Requirement 21.5). Exactly one of six response types per row, note text at most 2,000 characters and non-blank for Assistance requested and Other. Append-only for every role including a security definer path (Requirements 21.6, 22.8).';
comment on column public.cancellation_customer_responses.response_channel is
  'How the response arrived. Deliberately free text: no criterion enumerates it, and the value legitimately records a channel the module does not send on, such as an inbound phone call.';
comment on column public.cancellation_customer_responses.response_time is
  'When the customer responded, not when the row was written. Defaults to now() but is writable on insert, because a response relayed after the fact happened earlier than its recording (Requirement 21.5).';

-- Drawer read, and the Customer Responded saved filter (Requirement 16.8).
create index if not exists idx_cancellation_customer_responses_case_time
  on public.cancellation_customer_responses (case_id, response_time desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 3. PAYMENT REPORTS — a customer said they paid (Requirements 18.5, 18.6).
--
--    note is required and 1..2000 on btrim (18.5, 18.7). reported_amount and
--    confirmation_reference are both optional (18.6) and each is range-checked only
--    when supplied, because a check constraint passes on null: an absent amount is
--    accepted, an amount of 0 or 1,000,000,000 is not.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_payment_reports (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  reported_by uuid not null
    references public.profiles(id) on delete restrict,
  reported_at timestamptz not null default now(),
  reported_amount numeric(12,2)
    constraint cancellation_payment_reports_amount_range
      check (reported_amount between 0.01 and 999999999.99),
  confirmation_reference text
    constraint cancellation_payment_reports_reference_length
      check (char_length(confirmation_reference) <= 100),
  note text not null
    constraint cancellation_payment_reports_note_length
      check (char_length(btrim(note)) between 1 and 2000),
  evidence jsonb not null default '[]'
    constraint cancellation_payment_reports_evidence_is_array
      check (jsonb_typeof(evidence) = 'array')
);

comment on table public.cancellation_payment_reports is
  'Customer payment reports (Requirements 18.5, 18.6). Note text is required at 1 to 2,000 characters after trimming; reported amount and confirmation reference are optional and range-checked only when supplied. Append-only for every role including a security definer path (Requirement 22.8). The Case_Status, next-required-action, and follow-up-deadline changes of Requirements 18.1 through 18.4 belong to the mutation function, not to this table.';
comment on column public.cancellation_payment_reports.reported_amount is
  'Optional (Requirement 18.6). 0.01 to 999,999,999.99 when supplied; the check passes on null, which is how an absent amount is stored.';
comment on column public.cancellation_payment_reports.evidence is
  'JSON array of storage paths into the private cancellation-evidence bucket, laid out as <case_id>/<file>, access governed by public.cancellation_can_access_evidence(text) from v1.10.8. Zero attached files is valid (Requirement 18.6); the 100-megabyte limit of Requirement 18.10 is enforced at upload time.';

create index if not exists idx_cancellation_payment_reports_case_time
  on public.cancellation_payment_reports (case_id, reported_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 4. VERIFICATION OUTCOMES — exactly the seven values of Requirement 19.1.
--
--    The first value carries an em dash, character for character as Requirement 19.1
--    and the design's data model spell it: 'Payment verified — reinstatement pending'.
--
--    The required-inputs check encodes Requirements 19.2 and 19.5 and nothing more: the
--    four conditional outcomes need non-blank note text, a next_case_status from
--    Open / Verification Pending / Cancelled, and a non-blank next_required_action.
--    The other three outcomes (19.3, 19.4, 19.7) derive their own Case_Status and clear
--    or set the next required action themselves, so their columns stay free.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_verification_outcomes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  recorded_by uuid not null
    references public.profiles(id) on delete restrict,
  verified_at timestamptz not null default now(),
  outcome text not null
    constraint cancellation_verification_outcomes_outcome_values
      check (outcome in ('Payment verified — reinstatement pending',
                         'Policy reinstated',
                         'Payment not found',
                         'Additional payment required',
                         'Policy still scheduled for cancellation',
                         'Policy cancelled',
                         'Other')),
  note text
    constraint cancellation_verification_outcomes_note_length
      check (note is null or char_length(note) <= 2000),
  next_case_status text,
  next_required_action text,
  evidence jsonb not null default '[]'
    constraint cancellation_verification_outcomes_evidence_is_array
      check (jsonb_typeof(evidence) = 'array'),

  constraint cancellation_verification_outcomes_required_inputs
    check (outcome not in ('Other',
                           'Payment not found',
                           'Additional payment required',
                           'Policy still scheduled for cancellation')
           or (char_length(btrim(coalesce(note, ''))) >= 1
               and coalesce(next_case_status, '') in ('Open', 'Verification Pending', 'Cancelled')
               and char_length(btrim(coalesce(next_required_action, ''))) >= 1))
);

comment on table public.cancellation_verification_outcomes is
  'Recorded payment verification outcomes, restricted to exactly the seven values of Requirement 19.1. Append-only for every role including a security definer path (Requirements 19.9, 22.8). Manager_Role-only insertion is a policy matter and belongs to task 7.7 (Requirement 19.11).';
comment on column public.cancellation_verification_outcomes.outcome is
  'One of the seven values of Requirement 19.1. The first is spelled with an em dash, character for character: Payment verified — reinstatement pending.';
comment on constraint cancellation_verification_outcomes_required_inputs
  on public.cancellation_verification_outcomes is
  'Requirements 19.2 and 19.5: the outcomes Other, Payment not found, Additional payment required, and Policy still scheduled for cancellation each require non-blank note text, a next Case_Status from Open / Verification Pending / Cancelled, and a next required action. Every comparison is wrapped in coalesce because a check constraint passes when its expression is null, and an absent next Case_Status is precisely the submission those criteria reject.';

create index if not exists idx_cancellation_verification_outcomes_case_time
  on public.cancellation_verification_outcomes (case_id, verified_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- 5. ESCALATIONS — one row per (case, escalation reason) (Requirement 20.10).
--
--    `unique (case_id, reason)` is what caps notifications at one per pair "across
--    every escalation evaluation and every Notification_Scheduler run": the evaluator
--    inserts on conflict do nothing, and only an insert that actually created a row goes
--    on to write the public.user_notifications row of Requirement 20.8 or 20.9 and stamp
--    notified_at here. Two concurrent evaluations therefore produce one notification,
--    not two, without either of them having to read first.
--
--    NOT append-only, and deliberately without an immutability trigger: cleared_at,
--    cleared_by, and notified_at are all written after insert (Requirements 20.10,
--    20.12), and because the pair is unique, a reason raised again after being cleared
--    reopens this same row rather than inserting a second one, so raised_at is writable
--    too. Delete and truncate are revoked below all the same.
-- ═══════════════════════════════════════════════════════════════════════════════
create table if not exists public.cancellation_escalations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null
    references public.cancellation_cases(id) on delete restrict,
  reason text not null
    constraint cancellation_escalations_reason_values
      check (reason in ('No Valid Contact',
                        'All Channels Failed',
                        'SMS Suppressed Without Email',
                        'Customer Assistance Requested',
                        'No Delivered Contact',
                        'Payment Reported',
                        'Authorization Unknown')),
  raised_at timestamptz not null default now(),
  cleared_at timestamptz,
  cleared_by uuid
    references public.profiles(id) on delete restrict,
  notified_at timestamptz,

  constraint cancellation_escalations_key unique (case_id, reason)
);

comment on table public.cancellation_escalations is
  'One row per (Cancellation_Case, escalation reason) pair, restricted to the seven reasons of Requirement 20 criteria 1 through 7. The unique key enforces Requirement 20.10: at most one public.user_notifications row exists for a pair across every escalation evaluation and every Notification_Scheduler run. Not append-only — cleared_at, cleared_by, and notified_at are written after insert (Requirements 20.10, 20.12) — but delete and truncate are revoked from every client role.';
comment on column public.cancellation_escalations.notified_at is
  'When the public.user_notifications row for this pair was created (Requirements 20.8, 20.9). Null means the notification has not been sent yet; the unique key on (case_id, reason) is what keeps a second one from ever being sent (Requirement 20.10).';
comment on column public.cancellation_escalations.cleared_at is
  'When a manual contact outcome cleared this escalation reason (Requirement 20.12). Null means uncleared, which is what holds Communication_Status at Manual Follow-up Required in preference to every derived value (Requirement 20.11).';

-- "Does this case have an uncleared escalation reason?" — Requirement 20.11's override
-- and the Needs Action saved filter. Partial: cleared rows are history, not workload.
-- The unique key already serves every (case_id, reason) and case-first lookup.
create index if not exists idx_cancellation_escalations_case_uncleared
  on public.cancellation_escalations (case_id)
  where cleared_at is null;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 6. IMMUTABILITY — one trigger function, four triggers.
--
--    Modelled on public.cancellation_events_immutable() from v1.10.0: it raises on
--    every update and every delete without inspecting the row, so it holds on a
--    security definer path and against the table owner, not just against a client
--    session whose privileges were revoked. One function serves all four tables by
--    reading tg_table_name; every one of them has an `id`, so the detail message
--    resolves for each.
--
--    cancellation_escalations deliberately gets no trigger — see section 5.
-- ═══════════════════════════════════════════════════════════════════════════════
create or replace function public.cancellation_case_activity_immutable()
returns trigger
language plpgsql
as $fn$
begin
  raise exception '% is append-only: a stored case-activity record cannot be changed or deleted', tg_table_name
    using errcode = 'restrict_violation',
          detail  = format('attempted %s on %s.%s row %s',
                           lower(tg_op), tg_table_schema, tg_table_name,
                           coalesce(old.id::text, '(unknown)')),
          hint    = 'Requirements 19.9, 21.6, 22.8. Record a new row instead.';
end;
$fn$;

comment on function public.cancellation_case_activity_immutable() is
  'Trigger function refusing every update and delete on the append-only cancellation case-activity tables (notes, customer responses, payment reports, verification outcomes), including on a security definer path and against the table owner. Requirement 22.8. Deliberately not applied to public.cancellation_escalations, whose cleared_at, cleared_by, and notified_at are written after insert.';

drop trigger if exists cancellation_notes_no_update
  on public.cancellation_notes;
create trigger cancellation_notes_no_update
  before update or delete on public.cancellation_notes
  for each row execute function public.cancellation_case_activity_immutable();

drop trigger if exists cancellation_customer_responses_no_update
  on public.cancellation_customer_responses;
create trigger cancellation_customer_responses_no_update
  before update or delete on public.cancellation_customer_responses
  for each row execute function public.cancellation_case_activity_immutable();

drop trigger if exists cancellation_payment_reports_no_update
  on public.cancellation_payment_reports;
create trigger cancellation_payment_reports_no_update
  before update or delete on public.cancellation_payment_reports
  for each row execute function public.cancellation_case_activity_immutable();

drop trigger if exists cancellation_verification_outcomes_no_update
  on public.cancellation_verification_outcomes;
create trigger cancellation_verification_outcomes_no_update
  before update or delete on public.cancellation_verification_outcomes
  for each row execute function public.cancellation_case_activity_immutable();

--    Privileges. `truncate` goes with update and delete on the four append-only tables
--    because truncate does not fire the triggers above. service_role is included: none
--    of these tables has a documented update path.
revoke update, delete, truncate on public.cancellation_notes from authenticated;
revoke update, delete, truncate on public.cancellation_notes from anon;
revoke update, delete, truncate on public.cancellation_notes from service_role;

revoke update, delete, truncate on public.cancellation_customer_responses from authenticated;
revoke update, delete, truncate on public.cancellation_customer_responses from anon;
revoke update, delete, truncate on public.cancellation_customer_responses from service_role;

revoke update, delete, truncate on public.cancellation_payment_reports from authenticated;
revoke update, delete, truncate on public.cancellation_payment_reports from anon;
revoke update, delete, truncate on public.cancellation_payment_reports from service_role;

revoke update, delete, truncate on public.cancellation_verification_outcomes from authenticated;
revoke update, delete, truncate on public.cancellation_verification_outcomes from anon;
revoke update, delete, truncate on public.cancellation_verification_outcomes from service_role;

--    Escalations: delete and truncate only. The update privilege is deliberately LEFT IN
--    PLACE so task 7.7's clear-only update policy has a privilege to sit on top of
--    (Requirements 20.10, 20.12).
revoke delete, truncate on public.cancellation_escalations from authenticated;
revoke delete, truncate on public.cancellation_escalations from anon;
revoke delete, truncate on public.cancellation_escalations from service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- 7. POST-CONDITIONS
--    Any failure below raises, which rolls the whole migration back rather than leaving
--    stages 5-10 to apply on top of a half-built schema. Every probe write is discarded:
--    the probe block ends in a raise carrying a custom sqlstate, which rolls back to the
--    block's implicit savepoint, and plpgsql variables are not transactional, so the
--    recorded outcomes survive that rollback.
-- ═══════════════════════════════════════════════════════════════════════════════
do $post$
declare
  v_missing              text;
  v_append_only          text[] := array['cancellation_notes',
                                         'cancellation_customer_responses',
                                         'cancellation_payment_reports',
                                         'cancellation_verification_outcomes'];
  v_all_tables           text[] := array['cancellation_notes',
                                         'cancellation_customer_responses',
                                         'cancellation_payment_reports',
                                         'cancellation_verification_outcomes',
                                         'cancellation_escalations'];
  v_i                    integer;
  v_probe_ran            boolean := false;
  v_profile_id           uuid;
  v_case                 uuid;
  v_note_id              uuid;
  v_response_id          uuid;
  v_payment_id           uuid;
  v_outcome_id           uuid;
  v_escalation_id        uuid;
  v_probe_ids            uuid[];
  v_evidence             jsonb;
  v_created_at           timestamptz;
  v_response_time        timestamptz;
  v_reported_at          timestamptz;
  v_amount               numeric(12,2);
  v_cleared              timestamptz;
  v_notified             timestamptz;
  v_update_allowed       text[] := '{}';
  v_delete_allowed       text[] := '{}';
  v_note_blank_blocked   boolean := false;
  v_note_long_blocked    boolean := false;
  v_note_evidence_block  boolean := false;
  v_resp_type_blocked    boolean := false;
  v_resp_note_blocked    boolean := false;
  v_resp_long_blocked    boolean := false;
  v_pay_amount_low       boolean := false;
  v_pay_amount_high      boolean := false;
  v_pay_ref_blocked      boolean := false;
  v_pay_note_blocked     boolean := false;
  v_outcome_val_blocked  boolean := false;
  v_outcome_req_blocked  boolean := false;
  v_outcome_status_block boolean := false;
  v_esc_reason_blocked   boolean := false;
  v_esc_dup_blocked      boolean := false;
  v_esc_update_ok        boolean := false;
  v_case_restrict_block  boolean := false;
begin
  -- ── All five tables exist.
  select string_agg(t.name, ', ' order by t.name) into v_missing
    from unnest(v_all_tables) as t(name)
   where not exists (select 1 from pg_tables
                      where schemaname = 'public' and tablename = t.name);
  if v_missing is not null then
    raise exception 'v1.10.3 did not create: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── Every column of the design's data model exists, with the stated type.
  select string_agg(format('%s.%s %s', c.tbl, c.col, c.typ), ', ' order by c.tbl, c.col)
    into v_missing
    from (values
      ('cancellation_notes',                  'id',                   'uuid'),
      ('cancellation_notes',                  'case_id',              'uuid'),
      ('cancellation_notes',                  'note',                 'text'),
      ('cancellation_notes',                  'evidence',             'jsonb'),
      ('cancellation_notes',                  'created_by',           'uuid'),
      ('cancellation_notes',                  'created_at',           'timestamp with time zone'),
      ('cancellation_customer_responses',     'id',                   'uuid'),
      ('cancellation_customer_responses',     'case_id',              'uuid'),
      ('cancellation_customer_responses',     'response_type',        'text'),
      ('cancellation_customer_responses',     'response_channel',     'text'),
      ('cancellation_customer_responses',     'response_time',        'timestamp with time zone'),
      ('cancellation_customer_responses',     'note',                 'text'),
      ('cancellation_customer_responses',     'created_by',           'uuid'),
      ('cancellation_customer_responses',     'created_at',           'timestamp with time zone'),
      ('cancellation_payment_reports',        'id',                   'uuid'),
      ('cancellation_payment_reports',        'case_id',              'uuid'),
      ('cancellation_payment_reports',        'reported_by',          'uuid'),
      ('cancellation_payment_reports',        'reported_at',          'timestamp with time zone'),
      ('cancellation_payment_reports',        'reported_amount',      'numeric'),
      ('cancellation_payment_reports',        'confirmation_reference','text'),
      ('cancellation_payment_reports',        'note',                 'text'),
      ('cancellation_payment_reports',        'evidence',             'jsonb'),
      ('cancellation_verification_outcomes',  'id',                   'uuid'),
      ('cancellation_verification_outcomes',  'case_id',              'uuid'),
      ('cancellation_verification_outcomes',  'recorded_by',          'uuid'),
      ('cancellation_verification_outcomes',  'verified_at',          'timestamp with time zone'),
      ('cancellation_verification_outcomes',  'outcome',              'text'),
      ('cancellation_verification_outcomes',  'note',                 'text'),
      ('cancellation_verification_outcomes',  'next_case_status',     'text'),
      ('cancellation_verification_outcomes',  'next_required_action', 'text'),
      ('cancellation_verification_outcomes',  'evidence',             'jsonb'),
      ('cancellation_escalations',            'id',                   'uuid'),
      ('cancellation_escalations',            'case_id',              'uuid'),
      ('cancellation_escalations',            'reason',               'text'),
      ('cancellation_escalations',            'raised_at',            'timestamp with time zone'),
      ('cancellation_escalations',            'cleared_at',           'timestamp with time zone'),
      ('cancellation_escalations',            'cleared_by',           'uuid'),
      ('cancellation_escalations',            'notified_at',          'timestamp with time zone')
    ) as c(tbl, col, typ)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = c.tbl
        and ic.column_name = c.col
        and ic.data_type = c.typ);
  if v_missing is not null then
    raise exception 'v1.10.3 left these columns absent or of the wrong type: %', v_missing
      using detail = 'Column list is the design Phase 2 data model.', hint = 'Rolling back.';
  end if;

  -- ── Every not-null column of the design's data model is actually not null.
  select string_agg(format('%s.%s', c.tbl, c.col), ', ' order by c.tbl, c.col) into v_missing
    from (values
      ('cancellation_notes',                 'case_id'),
      ('cancellation_notes',                 'note'),
      ('cancellation_notes',                 'evidence'),
      ('cancellation_notes',                 'created_by'),
      ('cancellation_notes',                 'created_at'),
      ('cancellation_customer_responses',    'case_id'),
      ('cancellation_customer_responses',    'response_type'),
      ('cancellation_customer_responses',    'response_time'),
      ('cancellation_customer_responses',    'created_by'),
      ('cancellation_customer_responses',    'created_at'),
      ('cancellation_payment_reports',       'case_id'),
      ('cancellation_payment_reports',       'reported_by'),
      ('cancellation_payment_reports',       'reported_at'),
      ('cancellation_payment_reports',       'note'),
      ('cancellation_payment_reports',       'evidence'),
      ('cancellation_verification_outcomes', 'case_id'),
      ('cancellation_verification_outcomes', 'recorded_by'),
      ('cancellation_verification_outcomes', 'verified_at'),
      ('cancellation_verification_outcomes', 'outcome'),
      ('cancellation_verification_outcomes', 'evidence'),
      ('cancellation_escalations',           'case_id'),
      ('cancellation_escalations',           'reason'),
      ('cancellation_escalations',           'raised_at')
    ) as c(tbl, col)
   where not exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = c.tbl
        and ic.column_name = c.col
        and ic.is_nullable = 'NO');
  if v_missing is not null then
    raise exception 'v1.10.3 left these columns nullable: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── Every named constraint of this migration exists.
  select string_agg(k.name, ', ' order by k.name) into v_missing
    from (values
      ('cancellation_notes_note_length'),
      ('cancellation_notes_evidence_is_array'),
      ('cancellation_customer_responses_response_type_values'),
      ('cancellation_customer_responses_note_length'),
      ('cancellation_customer_responses_note_required'),
      ('cancellation_payment_reports_amount_range'),
      ('cancellation_payment_reports_reference_length'),
      ('cancellation_payment_reports_note_length'),
      ('cancellation_payment_reports_evidence_is_array'),
      ('cancellation_verification_outcomes_outcome_values'),
      ('cancellation_verification_outcomes_note_length'),
      ('cancellation_verification_outcomes_required_inputs'),
      ('cancellation_verification_outcomes_evidence_is_array'),
      ('cancellation_escalations_reason_values'),
      ('cancellation_escalations_key')
    ) as k(name)
   where not exists (select 1 from pg_constraint where conname = k.name);
  if v_missing is not null then
    raise exception 'v1.10.3 did not create these constraints: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── The escalation unique key is on exactly (case_id, reason) (Requirement 20.10).
  select pg_get_constraintdef(c.oid) into v_missing
    from pg_constraint c where c.conname = 'cancellation_escalations_key';
  if v_missing is null or v_missing not like 'UNIQUE (case_id, reason)%' then
    raise exception 'cancellation_escalations_key is % , expected UNIQUE (case_id, reason)', v_missing
      using detail = 'Requirement 20.10 caps notifications at one per case and reason.',
            hint = 'Rolling back.';
  end if;

  -- ── Ten foreign keys, every one of them restricting (Requirement 22.8).
  select string_agg(format('%s.%s', c.conrelid::regclass::text, c.conname), ', ')
    into v_missing
    from pg_constraint c
   where c.conrelid = any (
           select format('public.%I', t)::regclass from unnest(v_all_tables) as u(t))
     and c.contype = 'f'
     and c.confdeltype <> 'r';
  if v_missing is not null then
    raise exception 'v1.10.3 left these foreign keys without on delete restrict: %', v_missing
      using hint = 'Rolling back.';
  end if;
  if (select count(*) from pg_constraint c
       where c.conrelid = any (
               select format('public.%I', t)::regclass from unnest(v_all_tables) as u(t))
         and c.contype = 'f') <> 10 then
    raise exception 'v1.10.3 created % foreign keys, expected 10 (five case_id, five author)',
                    (select count(*) from pg_constraint c
                      where c.conrelid = any (
                              select format('public.%I', t)::regclass from unnest(v_all_tables) as u(t))
                        and c.contype = 'f')
      using hint = 'Rolling back.';
  end if;

  -- ── Every index of this migration exists.
  select string_agg(k.name, ', ' order by k.name) into v_missing
    from (values
      ('idx_cancellation_notes_case_time'),
      ('idx_cancellation_customer_responses_case_time'),
      ('idx_cancellation_payment_reports_case_time'),
      ('idx_cancellation_verification_outcomes_case_time'),
      ('idx_cancellation_escalations_case_uncleared')
    ) as k(name)
   where not exists (select 1 from pg_indexes
                      where schemaname = 'public' and indexname = k.name);
  if v_missing is not null then
    raise exception 'v1.10.3 did not create these indexes: %', v_missing using hint = 'Rolling back.';
  end if;

  -- ── The trigger function and its four triggers exist; escalations has none.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname = 'cancellation_case_activity_immutable') then
    raise exception 'v1.10.3 did not create public.cancellation_case_activity_immutable()'
      using hint = 'Rolling back.';
  end if;

  select string_agg(k.name, ', ' order by k.name) into v_missing
    from (values
      ('cancellation_notes_no_update'),
      ('cancellation_customer_responses_no_update'),
      ('cancellation_payment_reports_no_update'),
      ('cancellation_verification_outcomes_no_update')
    ) as k(name)
   where not exists (
     select 1 from pg_trigger t
      where t.tgname = k.name and not t.tgisinternal);
  if v_missing is not null then
    raise exception 'v1.10.3 did not create these triggers: %', v_missing using hint = 'Rolling back.';
  end if;

  if exists (select 1 from pg_trigger t
              where t.tgrelid = 'public.cancellation_escalations'::regclass
                and not t.tgisinternal) then
    raise exception 'v1.10.3 put a trigger on cancellation_escalations'
      using detail = 'cleared_at, cleared_by, and notified_at are written after insert (Requirements 20.10, 20.12).',
            hint = 'Rolling back.';
  end if;

  -- ── Task 7.7 owns row level security for every cancellation_* table.
  select string_agg(c.relname, ', ' order by c.relname) into v_missing
    from pg_class c
   where c.relname = any (v_all_tables) and c.relrowsecurity;
  if v_missing is not null then
    raise exception 'v1.10.3 enabled row level security on %; v1.10.6 owns that', v_missing
      using hint = 'Rolling back.';
  end if;
  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = any (v_all_tables)) then
    raise exception 'v1.10.3 added a policy; v1.10.6 owns every cancellation_* policy'
      using hint = 'Rolling back.';
  end if;

  -- ── Privileges: append-only by privilege as well as by trigger, and escalations
  --    keeping the update privilege task 7.7's clear-only policy needs.
  select string_agg(format('%s holds %s on %s', g.role, g.priv, g.tbl), ', '
                    order by g.tbl, g.role, g.priv) into v_missing
    from (select r.role, t.tbl, p.priv
            from (values ('authenticated'), ('anon'), ('service_role')) as r(role),
                 unnest(v_append_only) as t(tbl),
                 (values ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)) g
   where has_table_privilege(g.role, format('public.%I', g.tbl), g.priv);
  if v_missing is not null then
    raise exception 'v1.10.3 left write privileges on an append-only table: %', v_missing
      using detail = 'Requirement 22.8; truncate does not fire the trigger, so the privilege has to be revoked.',
            hint = 'Rolling back.';
  end if;

  select string_agg(format('%s holds %s on cancellation_escalations', g.role, g.priv), ', '
                    order by g.role, g.priv) into v_missing
    from (select r.role, p.priv
            from (values ('authenticated'), ('anon'), ('service_role')) as r(role),
                 (values ('DELETE'), ('TRUNCATE')) as p(priv)) g
   where has_table_privilege(g.role, 'public.cancellation_escalations', g.priv);
  if v_missing is not null then
    raise exception 'v1.10.3 left destructive privileges on cancellation_escalations: %', v_missing
      using hint = 'Rolling back.';
  end if;

  if not has_table_privilege('authenticated', 'public.cancellation_escalations', 'UPDATE') then
    raise exception 'v1.10.3 revoked update on cancellation_escalations from authenticated'
      using detail = 'Requirements 20.10, 20.12: task 7.7 adds a clear-only update policy, which needs the privilege underneath it.',
            hint = 'Rolling back.';
  end if;

  -- ── Prerequisites from earlier files in the series.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'cancellation_is_manager' and p.prosecdef) then
    raise exception 'public.cancellation_is_manager() is absent: v1.10.0 must be applied before v1.10.3'
      using detail = 'Every manager check in the series reuses that helper; this file defines no new role test.',
            hint = 'Rolling back.';
  end if;
  if not exists (select 1 from pg_tables
                  where schemaname = 'public' and tablename = 'cancellation_cases') then
    raise exception 'public.cancellation_cases is absent: v1.10.0 must be applied before v1.10.3'
      using detail = 'case_id on all five tables references it.', hint = 'Rolling back.';
  end if;

  -- ═════════════════════════════════════════════════════════════════════════════
  -- LIVE PROOF. Every write below is discarded by the raise at the end of the block.
  -- Each expected failure runs in its own nested block, so catching it rolls that one
  -- statement back to its own savepoint and the probe continues.
  -- ═════════════════════════════════════════════════════════════════════════════
  select id into v_profile_id from public.profiles order by id limit 1;
  if v_profile_id is null then
    raise notice 'v1.10.3: no profile row exists, so the live proof was skipped; structural post-conditions above still hold';
  else
  begin
    v_probe_ran := true;

    insert into public.cancellation_cases
      (policy_number, cancellation_effective_date, raw_row, raw_header)
    values ('V1103-PROBE-A', current_date + 5, '[]'::jsonb, array['probe'])
    returning id into v_case;

    -- ── Notes: defaults, then the trimmed length range and the array guard.
    insert into public.cancellation_notes (case_id, note, created_by)
    values (v_case, '   v1.10.3 probe note   ', v_profile_id)
    returning id, evidence, created_at into v_note_id, v_evidence, v_created_at;

    begin
      insert into public.cancellation_notes (case_id, note, created_by)
      values (v_case, '     ', v_profile_id);
    exception when check_violation then
      v_note_blank_blocked := true;
    end;

    begin
      insert into public.cancellation_notes (case_id, note, created_by)
      values (v_case, repeat('x', 4001), v_profile_id);
    exception when check_violation then
      v_note_long_blocked := true;
    end;

    begin
      insert into public.cancellation_notes (case_id, note, evidence, created_by)
      values (v_case, 'v1.10.3 probe note', '{"path":"x"}'::jsonb, v_profile_id);
    exception when check_violation then
      v_note_evidence_block := true;
    end;

    -- ── Customer responses: an accepted type needing no note, then the enumeration,
    --    the conditional non-blank note, and the 2,000-character cap.
    insert into public.cancellation_customer_responses
      (case_id, response_type, response_channel, created_by)
    values (v_case, 'Callback requested', 'phone', v_profile_id)
    returning id, response_time into v_response_id, v_response_time;

    begin
      insert into public.cancellation_customer_responses (case_id, response_type, created_by)
      values (v_case, 'Called back later', v_profile_id);
    exception when check_violation then
      v_resp_type_blocked := true;
    end;

    begin
      insert into public.cancellation_customer_responses
        (case_id, response_type, note, created_by)
      values (v_case, 'Assistance requested', '   ', v_profile_id);
    exception when check_violation then
      v_resp_note_blocked := true;
    end;

    begin
      insert into public.cancellation_customer_responses
        (case_id, response_type, note, created_by)
      values (v_case, 'No assistance needed', repeat('y', 2001), v_profile_id);
    exception when check_violation then
      v_resp_long_blocked := true;
    end;

    -- ── Payment reports: an absent amount and reference are accepted (Req 18.6), the
    --    supplied ranges are enforced, and the note is required (Req 18.5, 18.7).
    insert into public.cancellation_payment_reports (case_id, reported_by, note)
    values (v_case, v_profile_id, '  v1.10.3 probe payment report  ')
    returning id, reported_at, reported_amount into v_payment_id, v_reported_at, v_amount;

    begin
      insert into public.cancellation_payment_reports
        (case_id, reported_by, reported_amount, note)
      values (v_case, v_profile_id, 0.00, 'v1.10.3 probe');
    exception when check_violation then
      v_pay_amount_low := true;
    end;

    begin
      insert into public.cancellation_payment_reports
        (case_id, reported_by, reported_amount, note)
      values (v_case, v_profile_id, 1000000000.00, 'v1.10.3 probe');
    exception when others then
      v_pay_amount_high := true;
    end;

    begin
      insert into public.cancellation_payment_reports
        (case_id, reported_by, confirmation_reference, note)
      values (v_case, v_profile_id, repeat('r', 101), 'v1.10.3 probe');
    exception when check_violation then
      v_pay_ref_blocked := true;
    end;

    begin
      insert into public.cancellation_payment_reports (case_id, reported_by, note)
      values (v_case, v_profile_id, '   ');
    exception when check_violation then
      v_pay_note_blocked := true;
    end;

    -- ── Verification outcomes: an unconditional outcome stores with no note, the
    --    enumeration holds (em dash included), and the four conditional outcomes need
    --    note, next Case_Status, and next required action (Req 19.1, 19.2, 19.5).
    insert into public.cancellation_verification_outcomes (case_id, recorded_by, outcome)
    values (v_case, v_profile_id, 'Payment verified — reinstatement pending')
    returning id into v_outcome_id;

    begin
      insert into public.cancellation_verification_outcomes (case_id, recorded_by, outcome)
      values (v_case, v_profile_id, 'Payment verified - reinstatement pending');
    exception when check_violation then
      v_outcome_val_blocked := true;
    end;

    begin
      insert into public.cancellation_verification_outcomes
        (case_id, recorded_by, outcome, note, next_case_status, next_required_action)
      values (v_case, v_profile_id, 'Other', '   ', 'Open', 'Call customer');
    exception when check_violation then
      v_outcome_req_blocked := true;
    end;

    begin
      insert into public.cancellation_verification_outcomes
        (case_id, recorded_by, outcome, note, next_required_action)
      values (v_case, v_profile_id, 'Payment not found', 'v1.10.3 probe', 'Call customer');
    exception when check_violation then
      v_outcome_status_block := true;
    end;

    -- ── Escalations: the seven reasons, one row per pair, and a writable clearing.
    insert into public.cancellation_escalations (case_id, reason)
    values (v_case, 'No Valid Contact')
    returning id into v_escalation_id;

    begin
      insert into public.cancellation_escalations (case_id, reason)
      values (v_case, 'Manager said so');
    exception when check_violation then
      v_esc_reason_blocked := true;
    end;

    begin
      insert into public.cancellation_escalations (case_id, reason)
      values (v_case, 'No Valid Contact');
    exception when unique_violation then
      v_esc_dup_blocked := true;
    end;

    update public.cancellation_escalations
       set cleared_at = now(), cleared_by = v_profile_id, notified_at = now()
     where id = v_escalation_id
    returning cleared_at, notified_at into v_cleared, v_notified;
    v_esc_update_ok := v_cleared is not null and v_notified is not null;

    -- ── The immutability trigger: no update and no delete on any of the four
    --    append-only tables, even for the table owner running this migration.
    v_probe_ids := array[v_note_id, v_response_id, v_payment_id, v_outcome_id];
    for v_i in 1 .. array_length(v_append_only, 1) loop
      begin
        execute format('update public.%I set case_id = case_id where id = $1', v_append_only[v_i])
          using v_probe_ids[v_i];
        v_update_allowed := array_append(v_update_allowed, v_append_only[v_i]);
      exception when others then
        null;
      end;
      begin
        execute format('delete from public.%I where id = $1', v_append_only[v_i])
          using v_probe_ids[v_i];
        v_delete_allowed := array_append(v_delete_allowed, v_append_only[v_i]);
      exception when others then
        null;
      end;
    end loop;

    -- ── on delete restrict: a case carrying any of this activity cannot be deleted.
    begin
      delete from public.cancellation_cases where id = v_case;
    exception when foreign_key_violation then
      v_case_restrict_block := true;
    end;

    raise exception 'v1103_probe_done' using errcode = 'RS001';
  exception when sqlstate 'RS001' then
    null;  -- probe rows discarded; outcomes retained in the variables below
  end;
  end if;

  if v_probe_ran then
    if v_evidence is distinct from '[]'::jsonb then
      raise exception 'v1.10.3 note evidence defaulted to % , expected an empty array', v_evidence
        using hint = 'Rolling back.';
    end if;
    if v_created_at is null or v_response_time is null or v_reported_at is null then
      raise exception 'v1.10.3 left a time column without its default (created_at %, response_time %, reported_at %)',
                      v_created_at, v_response_time, v_reported_at
        using hint = 'Rolling back.';
    end if;
    if v_amount is not null then
      raise exception 'v1.10.3 invented a reported amount where none was supplied: %', v_amount
        using detail = 'Requirement 18.6 accepts an absent reported amount.', hint = 'Rolling back.';
    end if;
    if not v_note_blank_blocked or not v_note_long_blocked then
      raise exception 'v1.10.3 accepted note text outside 1..4000 after trimming (blank blocked %, over-long blocked %)',
                      v_note_blank_blocked, v_note_long_blocked
        using detail = 'Requirement 17.8.', hint = 'Rolling back.';
    end if;
    if not v_note_evidence_block then
      raise exception 'v1.10.3 accepted a non-array evidence value on cancellation_notes'
        using detail = 'Matches the raw_row array guard of v1.10.0.', hint = 'Rolling back.';
    end if;
    if not v_resp_type_blocked then
      raise exception 'v1.10.3 accepted a response type outside the six of Requirement 21.5'
        using hint = 'Rolling back.';
    end if;
    if not v_resp_note_blocked then
      raise exception 'v1.10.3 accepted blank note text on an Assistance requested response'
        using detail = 'Requirement 21.5 requires a non-whitespace character for Assistance requested and Other.',
              hint = 'Rolling back.';
    end if;
    if not v_resp_long_blocked then
      raise exception 'v1.10.3 accepted response note text longer than 2,000 characters'
        using detail = 'Requirement 21.5.', hint = 'Rolling back.';
    end if;
    if not v_pay_amount_low or not v_pay_amount_high then
      raise exception 'v1.10.3 accepted a reported amount outside 0.01..999999999.99 (low blocked %, high blocked %)',
                      v_pay_amount_low, v_pay_amount_high
        using detail = 'Requirements 18.6, 18.7.', hint = 'Rolling back.';
    end if;
    if not v_pay_ref_blocked then
      raise exception 'v1.10.3 accepted a confirmation reference longer than 100 characters'
        using detail = 'Requirements 18.6, 18.7.', hint = 'Rolling back.';
    end if;
    if not v_pay_note_blocked then
      raise exception 'v1.10.3 accepted a payment report with blank note text'
        using detail = 'Requirements 18.5, 18.7.', hint = 'Rolling back.';
    end if;
    if not v_outcome_val_blocked then
      raise exception 'v1.10.3 accepted a verification outcome outside the seven of Requirement 19.1'
        using detail = 'The hyphen spelling of the first value was accepted; it is an em dash.',
              hint = 'Rolling back.';
    end if;
    if not v_outcome_req_blocked or not v_outcome_status_block then
      raise exception 'v1.10.3 accepted a conditional verification outcome missing a required input (blank note blocked %, absent next Case_Status blocked %)',
                      v_outcome_req_blocked, v_outcome_status_block
        using detail = 'Requirements 19.2, 19.5.', hint = 'Rolling back.';
    end if;
    if not v_esc_reason_blocked then
      raise exception 'v1.10.3 accepted an escalation reason outside the seven of Requirement 20'
        using hint = 'Rolling back.';
    end if;
    if not v_esc_dup_blocked then
      raise exception 'v1.10.3 accepted the same (case_id, reason) pair twice'
        using detail = 'Requirement 20.10: at most one notification exists per case and reason.',
              hint = 'Rolling back.';
    end if;
    if not v_esc_update_ok then
      raise exception 'v1.10.3 could not stamp cleared_at, cleared_by, and notified_at on an escalation'
        using detail = 'Requirements 20.10, 20.12: cancellation_escalations is not insert-only.',
              hint = 'Rolling back.';
    end if;
    if v_update_allowed <> '{}' then
      raise exception 'v1.10.3 allowed an update on these append-only tables: %',
                      array_to_string(v_update_allowed, ', ')
        using detail = 'Requirement 22.8; the trigger must hold against the table owner too.',
              hint = 'Rolling back.';
    end if;
    if v_delete_allowed <> '{}' then
      raise exception 'v1.10.3 allowed a delete on these append-only tables: %',
                      array_to_string(v_delete_allowed, ', ')
        using detail = 'Requirement 22.8.', hint = 'Rolling back.';
    end if;
    if not v_case_restrict_block then
      raise exception 'v1.10.3 allowed a Cancellation_Case carrying case activity to be deleted'
        using detail = 'on delete restrict on all five case_id foreign keys.', hint = 'Rolling back.';
    end if;
  end if;

  -- ── No probe residue is committed, in the five new tables or in the v1.10.0 table
  --    the fixture borrowed.
  if exists (select 1 from public.cancellation_cases where policy_number like 'V1103-PROBE-%')
     or exists (select 1 from public.cancellation_notes where note like '%v1.10.3 probe%')
     or exists (select 1 from public.cancellation_payment_reports where note like '%v1.10.3 probe%')
     or exists (select 1 from public.cancellation_customer_responses
                 where response_channel = 'phone' and response_type = 'Callback requested') then
    raise exception 'v1.10.3 left probe residue behind' using hint = 'Rolling back.';
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
       and tablename in ('cancellation_notes',
                         'cancellation_customer_responses',
                         'cancellation_payment_reports',
                         'cancellation_verification_outcomes',
                         'cancellation_escalations')) as tables_created_expect_5,
  (select count(*) from information_schema.columns
     where table_schema = 'public'
       and table_name in ('cancellation_notes',
                          'cancellation_customer_responses',
                          'cancellation_payment_reports',
                          'cancellation_verification_outcomes',
                          'cancellation_escalations')) as columns_created_expect_38,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_notes'::regclass,
                        'public.cancellation_customer_responses'::regclass,
                        'public.cancellation_payment_reports'::regclass,
                        'public.cancellation_verification_outcomes'::regclass,
                        'public.cancellation_escalations'::regclass)
       and contype = 'c'
       and conname like 'cancellation%') as named_check_constraints_expect_14,
  (select count(*) from pg_constraint
     where conrelid = 'public.cancellation_escalations'::regclass
       and contype = 'u') as escalation_unique_keys_expect_1,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_notes'::regclass,
                        'public.cancellation_customer_responses'::regclass,
                        'public.cancellation_payment_reports'::regclass,
                        'public.cancellation_verification_outcomes'::regclass,
                        'public.cancellation_escalations'::regclass)
       and contype = 'f') as foreign_keys_expect_10,
  (select count(*) from pg_constraint
     where conrelid in ('public.cancellation_notes'::regclass,
                        'public.cancellation_customer_responses'::regclass,
                        'public.cancellation_payment_reports'::regclass,
                        'public.cancellation_verification_outcomes'::regclass,
                        'public.cancellation_escalations'::regclass)
       and contype = 'f' and confdeltype = 'r') as restricting_foreign_keys_expect_10,
  (select count(*) from pg_indexes
     where schemaname = 'public'
       and indexname in ('idx_cancellation_notes_case_time',
                         'idx_cancellation_customer_responses_case_time',
                         'idx_cancellation_payment_reports_case_time',
                         'idx_cancellation_verification_outcomes_case_time',
                         'idx_cancellation_escalations_case_uncleared')) as indexes_expect_5,
  (select count(*) from pg_trigger t
     where not t.tgisinternal
       and t.tgrelid in ('public.cancellation_notes'::regclass,
                         'public.cancellation_customer_responses'::regclass,
                         'public.cancellation_payment_reports'::regclass,
                         'public.cancellation_verification_outcomes'::regclass,
                         'public.cancellation_escalations'::regclass)) as immutability_triggers_expect_4,
  (select count(*) from pg_class
     where relname in ('cancellation_notes',
                       'cancellation_customer_responses',
                       'cancellation_payment_reports',
                       'cancellation_verification_outcomes',
                       'cancellation_escalations')
       and relrowsecurity) as rls_enabled_expect_0_until_task_7_7,
  (select count(*) from pg_policies
     where schemaname = 'public'
       and tablename in ('cancellation_notes',
                         'cancellation_customer_responses',
                         'cancellation_payment_reports',
                         'cancellation_verification_outcomes',
                         'cancellation_escalations')) as policies_expect_0_until_task_7_7,
  (select count(*) from (
     select 1 from (values ('authenticated'), ('anon'), ('service_role')) as r(role),
                   (values ('cancellation_notes'),
                           ('cancellation_customer_responses'),
                           ('cancellation_payment_reports'),
                           ('cancellation_verification_outcomes')) as t(tbl),
                   (values ('UPDATE'), ('DELETE'), ('TRUNCATE')) as p(priv)
      where has_table_privilege(r.role, format('public.%I', t.tbl), p.priv)
   ) held) as append_only_write_privileges_expect_0,
  (select count(*) from (
     select 1 from (values ('authenticated'), ('anon'), ('service_role')) as r(role),
                   (values ('DELETE'), ('TRUNCATE')) as p(priv)
      where has_table_privilege(r.role, 'public.cancellation_escalations', p.priv)
   ) held) as escalation_destructive_privileges_expect_0,
  (select has_table_privilege('authenticated', 'public.cancellation_escalations', 'UPDATE'))
    as escalation_update_retained_expect_true;
