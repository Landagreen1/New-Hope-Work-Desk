// src/features/cancellations/__tests__/audit-immutability.integration.test.ts
// Integration tests for the immutability of the two cancellation audit surfaces:
// `cancellation_communications` (the stored Communication_Record) and
// `cancellation_events` (the chronological audit timeline).
//
// Feature: policy-follow-up-renewals-cancellations, task 17.2
// Requirements: 14.16 (a change to a stored Communication_Record is rejected and every
//                      stored field is left unchanged),
//               17.7  (the audit timeline is ordered, and appended to, never edited),
//               22.8  (a profile of ANY role is refused deletion or modification of a
//                      stored Communication_Record or an audit timeline entry),
//               25.2  (permissions and audit history are covered by automated tests)
//
// ## Why these are not unit tests
//
// Nothing here is a rule the domain layer could hold. Both tables are protected by three
// mechanisms that only exist in the database, and each one covers a path the other two
// do not:
//
//   1. Row level security grants select and insert, with no update policy and no delete
//      policy at all (`v1.10.6-cancellation-rls.sql`, sections 4.5 and 4.9).
//   2. A `before update or delete` trigger raises — `cancellation_events_immutable()`
//      from v1.10.0 and `cancellation_communications_immutable()` from v1.10.2. This is
//      what stops a `security definer` function, the shape every server-side mutation
//      runs as, from rewriting history while bypassing RLS entirely.
//   3. `update`, `delete`, and `truncate` are revoked from `authenticated`, `anon`, AND
//      `service_role`, so a client attempt fails loudly at the privilege layer instead
//      of quietly matching zero rows under RLS. `truncate` has to be revoked rather
//      than trapped: it fires no row trigger, so the trigger above would not see it.
//
// A test that only proved one of them would leave the other two free to be dropped by a
// later migration, so all three are exercised, and every attempt is made under the role
// that reaches that particular layer:
//
//   authenticated + agent claims     the grant layer, error 42501
//   authenticated + manager claims   the grant layer too — Manager_Role buys no
//                                    exception here, which is Requirement 22.8's "of
//                                    any role"
//   service_role (bypassrls)         the grant layer, because v1.10.2 and the v1.10.6
//                                    sweep revoke update and delete from it as well
//   security definer, invoked as an  bypasses RLS and the revoked grants, meets the
//   authenticated agent              trigger
//   postgres (the table owner,       meets the trigger
//   bypassrls, RLS not forced)
//
// The last two are the point of the exercise: the service role bypasses RLS, so a
// service-role refusal alone would not tell us whether the policy or the privilege did
// the work, and neither would tell us what happens on a definer path. The definer and
// owner attempts are the ones that prove the TRIGGER is the real guarantee — if a future
// migration replaced it with an RLS-only rule, those are the assertions that would fail.
//
// The retry path is checked in the same probe because it is the one legitimate update in
// the design: `cancellation_retry_communication` may move exactly five columns
// (`send_time`, `provider_message_id`, `delivery_result`, `failure_reason`,
// `attempt_count`) and nothing else, so the record's rendered subject and rendered body
// stay frozen as evidence of what was sent (Requirements 14.16, 17.6). The subject and
// body refusals are made WITH the transaction-local retry marker set, which is the only
// window in which any update on this table is legal — so they prove the freeze holds
// even inside the permitted path, not merely outside it.
//
// ## What this run leaves behind
//
// Nothing, and that is deliberate rather than incidental. Both tables are append-only,
// so a probe row CANNOT be deleted once committed — that is the property under test.
// The probe therefore never commits: the throwaway `cancellation_cases` row, its one
// `cancellation_contacts` row, the one Communication_Record, and the one audit entry are
// all written inside a single plpgsql block that ends in `raise exception`, which rolls
// the block back to its implicit savepoint and carries the collected results out through
// the exception detail. The suite then re-counts both tables and asserts they hold
// exactly as many rows as before, so a run leaves the project exactly as it found it.
//
// Every probe write is confined to that one throwaway case: the Communication_Record and
// the audit entry both hang off it, no statement names a row this run did not create, no
// statement carries a broad predicate, and `truncate` is never issued — only the
// catalogue is read to confirm the privilege is absent. The two consequences that do
// survive a rollback are harmless and unavoidable: the `cancellation_events.sequence`
// bigserial advances (sequences are non-transactional), and the probe's `pg_temp`
// helpers live for the length of the connection.
//
// ## How to run it
//
// This file needs the live project, so it self-skips unless the Supabase Management API
// credentials are in the environment. `npx vitest --run` does not read `.env.local`, so
// the default suite reports these as skipped and stays offline. Run them against the
// project with:
//
//   npm run test:integration
//
// which is `node --env-file=.env.local ./node_modules/vitest/vitest.mjs --run
// integration.test`. Read-only apart from the rolled-back probe transaction.

import { beforeAll, describe, expect, it } from 'vitest';

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const HAS_CREDENTIALS = Boolean(ACCESS_TOKEN && PROJECT_REF);

/** Distinguishes this run's probe values from anything else in the project. */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** A cancellation date no real case uses, so the probe row is unambiguous. */
const PROBE_DATE = '2099-12-31';

// ─── The refusals, transcribed from the migrations ───────────────────────────

/** `errcode = 'restrict_violation'`, which both immutability triggers raise. */
const RESTRICT_VIOLATION = '23001';
/** Insufficient privilege: a revoked grant, and also an RLS violation. */
const INSUFFICIENT_PRIVILEGE = '42501';
/** `errcode = 'invalid_parameter_value'`, which the retry function raises. */
const INVALID_PARAMETER_VALUE = '22023';

/** `v1.10.2-cancellation-communications.sql`, the delete branch of the trigger. */
const COMM_DELETE_REFUSED =
  'cancellation_communications is append-only: a stored Communication_Record cannot be deleted';
/** The same trigger's frozen-column branch. */
const COMM_FROZEN_REFUSED =
  'is immutable: the case, recipient, touchpoint, channel, template version, rendered subject, rendered body, combined group, and created_at of a sent message cannot be changed';
/** The same trigger's missing-marker branch. */
const COMM_MARKER_REFUSED =
  'may be updated only through public.cancellation_retry_communication';
/** `v1.10.0-cancellation-core-tables.sql`, `cancellation_events_immutable()`. */
const EVENT_REFUSED =
  'cancellation_events is append-only: stored audit entries cannot be changed or deleted';
/** The retry function's authorization refusal. */
const RETRY_RESERVED =
  'cancellation_retry_communication is reserved to Manager_Role and the service role';

/** The only columns any path may move (Requirement 17.6), in sorted order. */
const PERMITTED_COLUMNS = [
  'attempt_count',
  'delivery_result',
  'failure_reason',
  'provider_message_id',
  'send_time',
];

// ─── Management API client ───────────────────────────────────────────────────

/**
 * Runs one SQL request against the project, the same endpoint
 * `scripts/run-sql.mjs` uses. Multi-statement requests return the last statement's
 * rows, which is why the probe request ends in a single `select`.
 *
 * The gateway in front of the endpoint answers 502 intermittently, so a transient
 * status is retried rather than failing the suite for a network blip. No credential
 * value is ever put in an error message.
 */
async function runSql<T>(query: string): Promise<T[]> {
  const transient = new Set([502, 503, 504]);
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ACCESS_TOKEN}`,
        },
        body: JSON.stringify({ query }),
      },
    );

    lastStatus = response.status;
    lastBody = await response.text();

    if (response.ok) return JSON.parse(lastBody) as T[];
    if (!transient.has(response.status)) break;

    await new Promise((resolve) => setTimeout(resolve, 1_500 * attempt));
  }

  const detail = lastBody.trimStart().startsWith('<')
    ? 'gateway error page'
    : lastBody.slice(0, 400);
  throw new Error(`Management API query failed (${lastStatus}): ${detail}`);
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

/**
 * One attempt: the label, the role it ran as, and whether the database allowed it.
 * `rows` is the number of rows the statement touched or returned, which is what makes
 * a select under RLS legible — the statement succeeds either way and the policy shows
 * up as the row count.
 */
interface ProbeStep {
  step: string;
  role: string;
  outcome: 'succeeded' | 'rejected';
  rows?: number;
  sqlstate?: string;
  message?: string;
}

interface ProbeResult {
  communicationId: string;
  eventId: string;
  commBefore: Record<string, unknown>;
  commAfter: Record<string, unknown>;
  eventBefore: Record<string, unknown>;
  eventAfter: Record<string, unknown>;
  retryAfter: Record<string, unknown>;
  retryChangedColumns: string[];
  steps: ProbeStep[];
  error?: string;
}

interface Surface {
  table_name: string;
  rls_enabled: boolean;
  force_rls: boolean;
  table_owner: string;
  update_or_delete_policies: number;
  select_policies: number;
  insert_policies: number;
  immutable_triggers: number;
  trigger_events: string;
  authenticated_select: boolean;
  authenticated_insert: boolean;
  authenticated_update: boolean;
  authenticated_delete: boolean;
  authenticated_truncate: boolean;
  anon_update: boolean;
  anon_delete: boolean;
  anon_truncate: boolean;
  service_role_select: boolean;
  service_role_update: boolean;
  service_role_delete: boolean;
  service_role_truncate: boolean;
  service_role_bypasses_rls: boolean;
}

interface RowCounts {
  communications: number;
  events: number;
}

// ─── The catalogue view ─────────────────────────────────────────────────────

/**
 * The three protections as the catalogue sees them, one row per table, so a migration
 * that dropped one of them is caught even on a project where no attempt happens to be
 * made. The trigger is matched by its function name — `<table>_immutable()` — rather
 * than by trigger name, so renaming the trigger cannot hide its removal.
 */
const SURFACE_SQL = `
select
  c.relname::text                                        as table_name,
  c.relrowsecurity                                       as rls_enabled,
  c.relforcerowsecurity                                  as force_rls,
  pg_get_userbyid(c.relowner)::text                      as table_owner,
  (select count(*)::int from pg_policies p
     where p.schemaname = 'public' and p.tablename = c.relname
       and p.cmd in ('UPDATE', 'DELETE'))                as update_or_delete_policies,
  (select count(*)::int from pg_policies p
     where p.schemaname = 'public' and p.tablename = c.relname
       and p.cmd = 'SELECT')                             as select_policies,
  (select count(*)::int from pg_policies p
     where p.schemaname = 'public' and p.tablename = c.relname
       and p.cmd = 'INSERT')                             as insert_policies,
  (select count(*)::int from pg_trigger t
     join pg_proc pr on pr.oid = t.tgfoid
    where t.tgrelid = c.oid and not t.tgisinternal
      and pr.pronamespace = 'public'::regnamespace
      and pr.proname = c.relname || '_immutable')        as immutable_triggers,
  (select string_agg(distinct e.event, ',' order by e.event)
     from pg_trigger t
     join pg_proc pr on pr.oid = t.tgfoid
     cross join lateral (
       values ('update', (t.tgtype & 16) <> 0),
              ('delete', (t.tgtype & 8) <> 0),
              ('insert', (t.tgtype & 4) <> 0)
     ) as e(event, present)
    where t.tgrelid = c.oid and not t.tgisinternal and e.present
      and pr.pronamespace = 'public'::regnamespace
      and pr.proname = c.relname || '_immutable')        as trigger_events,
  has_table_privilege('authenticated', c.oid, 'SELECT')   as authenticated_select,
  has_table_privilege('authenticated', c.oid, 'INSERT')   as authenticated_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE')   as authenticated_update,
  has_table_privilege('authenticated', c.oid, 'DELETE')   as authenticated_delete,
  has_table_privilege('authenticated', c.oid, 'TRUNCATE') as authenticated_truncate,
  has_table_privilege('anon', c.oid, 'UPDATE')            as anon_update,
  has_table_privilege('anon', c.oid, 'DELETE')            as anon_delete,
  has_table_privilege('anon', c.oid, 'TRUNCATE')          as anon_truncate,
  has_table_privilege('service_role', c.oid, 'SELECT')    as service_role_select,
  has_table_privilege('service_role', c.oid, 'UPDATE')    as service_role_update,
  has_table_privilege('service_role', c.oid, 'DELETE')    as service_role_delete,
  has_table_privilege('service_role', c.oid, 'TRUNCATE')  as service_role_truncate,
  (select rolbypassrls from pg_roles where rolname = 'service_role')
                                                          as service_role_bypasses_rls
from pg_class c
where c.oid in ('public.cancellation_communications'::regclass,
                'public.cancellation_events'::regclass)
order by c.relname
`;

const COUNTS_SQL = `
select
  (select count(*)::int from public.cancellation_communications) as communications,
  (select count(*)::int from public.cancellation_events)         as events
`;

// ─── The probe ──────────────────────────────────────────────────────────────

/**
 * Seeds one throwaway case with one recipient, one Communication_Record, and one audit
 * entry; attempts every update and delete path against both audit rows under every role
 * that can reach a different protection layer; exercises the one permitted update path;
 * then raises so the whole block is rolled back, carrying the results out in the
 * exception detail.
 *
 * The helper functions live in `pg_temp`, so they belong to this connection and to no
 * schema anyone else can see. `cx_step` sets the request role, the JWT claims, and — for
 * the two retry-window attempts — the transaction-local marker the trigger recognizes,
 * runs one statement, and clears all three again whether the statement succeeded or not.
 */
const PROBE_SQL = `
create or replace function pg_temp.cx_step(
  p_label text, p_role text, p_actor uuid, p_sql text, p_marker uuid default null
) returns jsonb language plpgsql as $step$
declare
  v_rows bigint;
begin
  begin
    if p_actor is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
    end if;
    if p_marker is not null then
      perform set_config('cancellation.retry_communication_id', p_marker::text, true);
    end if;
    perform set_config('role', coalesce(p_role, 'none'), true);

    execute p_sql;
    get diagnostics v_rows = row_count;

    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('cancellation.retry_communication_id', '', true);
    return jsonb_build_object('step', p_label, 'role', coalesce(p_role, current_user),
                              'outcome', 'succeeded', 'rows', v_rows);
  exception when others then
    -- The failed statement is rolled back to this block's savepoint, so the seeded rows
    -- outside it survive and the next attempt starts from the same state.
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    perform set_config('cancellation.retry_communication_id', '', true);
    return jsonb_build_object('step', p_label, 'role', coalesce(p_role, current_user),
                              'outcome', 'rejected', 'sqlstate', sqlstate, 'message', sqlerrm);
  end;
end $step$;

create or replace function pg_temp.cx_definer_comm_update(p_id uuid) returns void
language plpgsql security definer as $definer$
begin
  update public.cancellation_communications
     set delivery_result = 'Delivered' where id = p_id;
end $definer$;

create or replace function pg_temp.cx_definer_comm_delete(p_id uuid) returns void
language plpgsql security definer as $definer$
begin
  delete from public.cancellation_communications where id = p_id;
end $definer$;

create or replace function pg_temp.cx_definer_event_update(p_id uuid) returns void
language plpgsql security definer as $definer$
begin
  update public.cancellation_events
     set event_type = 'tampered through a definer path' where id = p_id;
end $definer$;

create or replace function pg_temp.cx_definer_event_delete(p_id uuid) returns void
language plpgsql security definer as $definer$
begin
  delete from public.cancellation_events where id = p_id;
end $definer$;

create or replace function pg_temp.cx_immutability_probe() returns jsonb
language plpgsql as $probe$
declare
  v_agent        uuid;
  v_manager      uuid;
  v_version      uuid;
  v_case         uuid;
  v_contact      uuid;
  v_comm         uuid;
  v_event        uuid;
  v_comm_before  jsonb;
  v_comm_after   jsonb;
  v_event_before jsonb;
  v_event_after  jsonb;
  v_retry_after  jsonb;
  v_changed      jsonb;
  v_send_time    timestamptz := date_trunc('second', now()) - interval '1 hour';
  v_steps        jsonb := '[]'::jsonb;
  v_detail       text;
begin
  select id into v_agent from public.profiles
   where role = 'agent' order by id limit 1;
  select id into v_manager from public.profiles
   where role in ('manager', 'super_admin') order by id limit 1;
  -- Any stored template version will do: the record only has to reference one, and
  -- v1.10.9 seeds eight. Nothing in the template tables is written by this probe.
  select id into v_version from public.cancellation_template_versions
   order by created_at, id limit 1;

  if v_agent is null or v_manager is null or v_version is null then
    return jsonb_build_object('error',
      'the probe needs one agent profile, one manager or super_admin profile, and one stored template version');
  end if;

  begin
    -- ── Seeded state, all of it undone by the raise at the end of this block. The case
    --    is assigned to the agent so that agent can READ both audit rows under the
    --    v1.10.6 policies, which is what makes each refusal below a refusal of the
    --    write rather than an artefact of an invisible row.
    insert into public.cancellation_cases (
      policy_number, cancellation_effective_date, customer_name, carrier,
      assigned_to, assignment_source, raw_row, raw_header
    ) values (
      'CX-IMMUT-${RUN_ID}', date '${PROBE_DATE}', 'Audit Immutability Probe',
      'Probe Carrier', v_agent, 'import',
      '["audit immutability integration probe"]'::jsonb, array['probe']::text[]
    ) returning id into v_case;

    insert into public.cancellation_contacts (
      case_id, channel, normalized_value, raw_segment, validation_status, segment_index
    ) values (
      v_case, 'email', 'cx-immut-${RUN_ID}@example.invalid',
      'cx-immut-${RUN_ID}@example.invalid', 'valid', 0
    ) returning id into v_contact;

    -- The email channel, so the record carries a non-empty rendered subject and the
    -- frozen-subject attempt has something real to try to change (the SMS channel
    -- stores zero characters there by Requirement 14.15).
    insert into public.cancellation_communications (
      case_id, contact_id, touchpoint, channel, template_version_id,
      rendered_subject, rendered_body, send_time, delivery_result, attempt_count
    ) values (
      v_case, v_contact, 15, 'email', v_version,
      'audit immutability probe subject', 'audit immutability probe body',
      v_send_time, 'Sent', 1
    ) returning id into v_comm;

    insert into public.cancellation_events (
      case_id, actor_id, event_type, detail, event_time
    ) values (
      v_case, v_manager, 'note_added',
      jsonb_build_object('run', '${RUN_ID}'), v_send_time
    ) returning id into v_event;

    select to_jsonb(t) into v_comm_before
      from public.cancellation_communications t where t.id = v_comm;
    select to_jsonb(t) into v_event_before
      from public.cancellation_events t where t.id = v_event;

    v_steps := v_steps
      -- ── Requirements 14.16, 22.8: the Communication_Record, on every path that could
      --    reach it. The agent and manager attempts are the ones a route could make.
      || pg_temp.cx_step('comm_agent_reads', 'authenticated', v_agent,
           format('select 1 from public.cancellation_communications where id = %L', v_comm))
      || pg_temp.cx_step('comm_agent_update', 'authenticated', v_agent,
           format('update public.cancellation_communications set delivery_result = %L where id = %L',
                  'Delivered', v_comm))
      || pg_temp.cx_step('comm_agent_delete', 'authenticated', v_agent,
           format('delete from public.cancellation_communications where id = %L', v_comm))
      || pg_temp.cx_step('comm_manager_update', 'authenticated', v_manager,
           format('update public.cancellation_communications set delivery_result = %L where id = %L',
                  'Delivered', v_comm))
      || pg_temp.cx_step('comm_manager_delete', 'authenticated', v_manager,
           format('delete from public.cancellation_communications where id = %L', v_comm))
      || pg_temp.cx_step('comm_service_role_update', 'service_role', null,
           format('update public.cancellation_communications set delivery_result = %L where id = %L',
                  'Delivered', v_comm))
      || pg_temp.cx_step('comm_service_role_delete', 'service_role', null,
           format('delete from public.cancellation_communications where id = %L', v_comm))
      || pg_temp.cx_step('comm_definer_update', 'authenticated', v_agent,
           format('select pg_temp.cx_definer_comm_update(%L)', v_comm))
      || pg_temp.cx_step('comm_definer_delete', 'authenticated', v_agent,
           format('select pg_temp.cx_definer_comm_delete(%L)', v_comm))
      || pg_temp.cx_step('comm_owner_update', null, null,
           format('update public.cancellation_communications set delivery_result = %L where id = %L',
                  'Delivered', v_comm))
      || pg_temp.cx_step('comm_owner_delete', null, null,
           format('delete from public.cancellation_communications where id = %L', v_comm))
      -- ── Requirement 14.16 inside the retry window: the marker naming this row is set,
      --    so an update is legal here and only the frozen columns can refuse it.
      || pg_temp.cx_step('comm_retry_window_subject_change', null, null,
           format('update public.cancellation_communications set rendered_subject = %L where id = %L',
                  'tampered subject', v_comm), v_comm)
      || pg_temp.cx_step('comm_retry_window_body_change', null, null,
           format('update public.cancellation_communications set rendered_body = %L where id = %L',
                  'tampered body', v_comm), v_comm)
      || pg_temp.cx_step('comm_retry_window_delete', null, null,
           format('delete from public.cancellation_communications where id = %L', v_comm), v_comm)

      -- ── Requirements 17.7, 22.8: the audit timeline entry, on the same five paths.
      || pg_temp.cx_step('event_agent_reads', 'authenticated', v_agent,
           format('select 1 from public.cancellation_events where id = %L', v_event))
      || pg_temp.cx_step('event_agent_update', 'authenticated', v_agent,
           format('update public.cancellation_events set event_type = %L where id = %L',
                  'tampered by an agent', v_event))
      || pg_temp.cx_step('event_agent_delete', 'authenticated', v_agent,
           format('delete from public.cancellation_events where id = %L', v_event))
      || pg_temp.cx_step('event_manager_update', 'authenticated', v_manager,
           format('update public.cancellation_events set event_type = %L where id = %L',
                  'tampered by a manager', v_event))
      || pg_temp.cx_step('event_manager_delete', 'authenticated', v_manager,
           format('delete from public.cancellation_events where id = %L', v_event))
      || pg_temp.cx_step('event_service_role_update', 'service_role', null,
           format('update public.cancellation_events set event_type = %L where id = %L',
                  'tampered by service_role', v_event))
      || pg_temp.cx_step('event_service_role_delete', 'service_role', null,
           format('delete from public.cancellation_events where id = %L', v_event))
      || pg_temp.cx_step('event_definer_update', 'authenticated', v_agent,
           format('select pg_temp.cx_definer_event_update(%L)', v_event))
      || pg_temp.cx_step('event_definer_delete', 'authenticated', v_agent,
           format('select pg_temp.cx_definer_event_delete(%L)', v_event))
      || pg_temp.cx_step('event_owner_update', null, null,
           format('update public.cancellation_events set event_type = %L where id = %L',
                  'tampered by the owner', v_event))
      || pg_temp.cx_step('event_owner_delete', null, null,
           format('delete from public.cancellation_events where id = %L', v_event));

    -- Read back after every refusal and before the one permitted update, so the
    -- byte-identical comparison covers exactly the refused attempts.
    select to_jsonb(t) into v_comm_after
      from public.cancellation_communications t where t.id = v_comm;
    select to_jsonb(t) into v_event_after
      from public.cancellation_events t where t.id = v_event;

    -- ── Requirement 17.6: the one permitted update path, refused for Agent_Role and
    --    admitted for Manager_Role.
    v_steps := v_steps
      || pg_temp.cx_step('retry_agent', 'authenticated', v_agent,
           format('select public.cancellation_retry_communication(%L, %L, %L, %L, %L, %L)',
                  v_comm, 'Failed', 'cx-immut-${RUN_ID}-agent', 'agent retry probe', 2,
                  v_send_time))
      || pg_temp.cx_step('retry_manager', 'authenticated', v_manager,
           format('select public.cancellation_retry_communication(%L, %L, %L, %L, %L, %L)',
                  v_comm, 'Failed', 'cx-immut-${RUN_ID}-provider', 'probe failure reason', 2,
                  v_send_time + interval '1 minute'));

    select to_jsonb(t) into v_retry_after
      from public.cancellation_communications t where t.id = v_comm;

    select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_changed
      from (select key as k from jsonb_each(v_comm_after)
             where value is distinct from v_retry_after -> key) t;

    v_steps := v_steps
      -- The function clears its marker, so a bare update straight afterwards, in the
      -- same transaction, is refused again.
      || pg_temp.cx_step('retry_marker_cleared', null, null,
           format('update public.cancellation_communications set delivery_result = %L where id = %L',
                  'Delivered', v_comm))
      || pg_temp.cx_step('retry_lowers_attempt_count', 'authenticated', v_manager,
           format('select public.cancellation_retry_communication(%L, %L, %L, %L, %L, %L)',
                  v_comm, 'Sent', null, null, 1, v_send_time))
      || pg_temp.cx_step('retry_unknown_delivery_result', 'authenticated', v_manager,
           format('select public.cancellation_retry_communication(%L, %L)', v_comm, 'Queued'));

    -- Raising here undoes every insert above and carries the results out.
    raise exception 'cx_immutability_probe_complete'
      using detail = jsonb_build_object(
        'communicationId', v_comm,
        'eventId', v_event,
        'commBefore', v_comm_before,
        'commAfter', v_comm_after,
        'eventBefore', v_event_before,
        'eventAfter', v_event_after,
        'retryAfter', v_retry_after,
        'retryChangedColumns', v_changed,
        'steps', v_steps
      )::text;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm = 'cx_immutability_probe_complete' then
      return v_detail::jsonb;
    end if;
    raise;
  end;
end $probe$;

select pg_temp.cx_immutability_probe() as probe;
`;

// ─── The suite ──────────────────────────────────────────────────────────────

const describeAgainstProject = HAS_CREDENTIALS ? describe : describe.skip;

describeAgainstProject('cancellation audit immutability', () => {
  let communications: Surface;
  let events: Surface;
  let probe: ProbeResult;
  let before: RowCounts;
  let after: RowCounts;

  const countRows = async (): Promise<RowCounts> => (await runSql<RowCounts>(COUNTS_SQL))[0];

  beforeAll(async () => {
    before = await countRows();

    const surfaces = await runSql<Surface>(SURFACE_SQL);
    communications = surfaces.find((s) => s.table_name === 'cancellation_communications')!;
    events = surfaces.find((s) => s.table_name === 'cancellation_events')!;

    probe = (await runSql<{ probe: ProbeResult }>(PROBE_SQL))[0].probe;
    after = await countRows();

    // A probe that could not seed says nothing about the protections, so fail loudly
    // here rather than letting every assertion below pass vacuously.
    expect(probe.error).toBeUndefined();
    expect(probe.steps.length).toBe(30);
    expect(communications).toBeDefined();
    expect(events).toBeDefined();
  }, 120_000);

  /** One attempt by name, so a renamed or dropped probe step fails clearly. */
  function step(name: string): ProbeStep {
    const found = probe.steps.find((candidate) => candidate.step === name);
    if (!found) throw new Error(`the probe recorded no step named ${name}`);
    return found;
  }

  /** Refused before the statement ran, by a revoked grant. */
  function expectPrivilegeRefusal(name: string, table: string): void {
    const attempt = step(name);
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
    expect(attempt.message).toContain(`permission denied for table ${table}`);
  }

  /** Refused by the table's immutability trigger, whatever the caller's privileges. */
  function expectTriggerRefusal(name: string, message: string): void {
    const attempt = step(name);
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.sqlstate).toBe(RESTRICT_VIOLATION);
    expect(attempt.message).toContain(message);
  }

  describe('the three protections are in place on both audit tables', () => {
    it('has row level security on, with select and insert policies and no update or delete policy', () => {
      for (const surface of [communications, events]) {
        expect(surface.rls_enabled).toBe(true);
        expect(surface.update_or_delete_policies).toBe(0);
        expect(surface.select_policies).toBeGreaterThanOrEqual(1);
        expect(surface.insert_policies).toBeGreaterThanOrEqual(1);
      }
    });

    it('carries its immutability trigger on update and delete', () => {
      for (const surface of [communications, events]) {
        expect(surface.immutable_triggers).toBe(1);
        expect(surface.trigger_events).toBe('delete,update');
      }
    });

    it('has update, delete, and truncate revoked from every client role, keeping select and insert', () => {
      for (const surface of [communications, events]) {
        expect(surface.authenticated_update).toBe(false);
        expect(surface.authenticated_delete).toBe(false);
        expect(surface.anon_update).toBe(false);
        expect(surface.anon_delete).toBe(false);
        // Requirement 22.8 is "a profile of any role", and the service role is the one
        // that bypasses RLS, so insert-only has to hold for it at the privilege layer.
        expect(surface.service_role_update).toBe(false);
        expect(surface.service_role_delete).toBe(false);
        // truncate fires no row trigger, so it can only be revoked, never trapped.
        expect(surface.authenticated_truncate).toBe(false);
        expect(surface.anon_truncate).toBe(false);
        expect(surface.service_role_truncate).toBe(false);
        // The append and read paths have to keep working, or history cannot be written
        // or shown at all (Requirements 14.15, 17.1).
        expect(surface.authenticated_select).toBe(true);
        expect(surface.authenticated_insert).toBe(true);
        expect(surface.service_role_select).toBe(true);
      }
    });
  });

  describe('a stored Communication_Record refuses update and delete on every path (Requirements 14.16, 22.8)', () => {
    it('is readable by the assigned agent, so every refusal below is about the write', () => {
      expect(step('comm_agent_reads')).toMatchObject({ outcome: 'succeeded', rows: 1 });
    });

    it('refuses an agent update and delete at the privilege layer', () => {
      expectPrivilegeRefusal('comm_agent_update', 'cancellation_communications');
      expectPrivilegeRefusal('comm_agent_delete', 'cancellation_communications');
    });

    it('refuses a manager update and delete at the privilege layer', () => {
      // Manager_Role buys no exception here: Requirement 22.8 is "of any role", and the
      // only manager path to this row is cancellation_retry_communication.
      expectPrivilegeRefusal('comm_manager_update', 'cancellation_communications');
      expectPrivilegeRefusal('comm_manager_delete', 'cancellation_communications');
    });

    it('refuses an RLS-bypassing service-role update and delete at the privilege layer', () => {
      expect(communications.service_role_bypasses_rls).toBe(true);
      expectPrivilegeRefusal('comm_service_role_update', 'cancellation_communications');
      expectPrivilegeRefusal('comm_service_role_delete', 'cancellation_communications');
    });

    it('refuses a security definer update and delete at the trigger', () => {
      // A definer function runs as the table owner, so RLS and the revoked grants are
      // both out of the way. This is the path every server-side mutation runs on, and
      // the only thing standing in front of the row is the trigger.
      expectTriggerRefusal('comm_definer_update', COMM_MARKER_REFUSED);
      expectTriggerRefusal('comm_definer_delete', COMM_DELETE_REFUSED);
    });

    it('refuses the table owner itself at the trigger', () => {
      // Recorded from a live probe: on a hosted project `postgres` owns this table and
      // carries bypassrls, and RLS is not forced, so this is the strongest identity the
      // application layer can reach.
      expect(communications.table_owner).toBe('postgres');
      expect(communications.force_rls).toBe(false);
      expectTriggerRefusal('comm_owner_update', COMM_MARKER_REFUSED);
      expectTriggerRefusal('comm_owner_delete', COMM_DELETE_REFUSED);
    });

    it('refuses a delete even inside the retry window', () => {
      // The retry marker unlocks five columns, never a delete.
      expectTriggerRefusal('comm_retry_window_delete', COMM_DELETE_REFUSED);
    });

    it('leaves the record byte-identical after all thirteen write attempts', () => {
      expect(probe.commAfter).not.toBeNull();
      expect(probe.commAfter).toEqual(probe.commBefore);
      expect(probe.commAfter.id).toBe(probe.communicationId);
      expect(probe.commAfter.delivery_result).toBe('Sent');
      expect(probe.commAfter.rendered_subject).toBe('audit immutability probe subject');
      expect(probe.commAfter.rendered_body).toBe('audit immutability probe body');
    });
  });

  describe('a stored audit timeline entry refuses update and delete on every path (Requirements 17.7, 22.8)', () => {
    it('is readable by the assigned agent, so every refusal below is about the write', () => {
      expect(step('event_agent_reads')).toMatchObject({ outcome: 'succeeded', rows: 1 });
    });

    it('refuses an agent update and delete at the privilege layer', () => {
      expectPrivilegeRefusal('event_agent_update', 'cancellation_events');
      expectPrivilegeRefusal('event_agent_delete', 'cancellation_events');
    });

    it('refuses a manager update and delete at the privilege layer', () => {
      expectPrivilegeRefusal('event_manager_update', 'cancellation_events');
      expectPrivilegeRefusal('event_manager_delete', 'cancellation_events');
    });

    it('refuses an RLS-bypassing service-role update and delete at the privilege layer', () => {
      expect(events.service_role_bypasses_rls).toBe(true);
      expectPrivilegeRefusal('event_service_role_update', 'cancellation_events');
      expectPrivilegeRefusal('event_service_role_delete', 'cancellation_events');
    });

    it('refuses a security definer update and delete at the trigger', () => {
      expectTriggerRefusal('event_definer_update', EVENT_REFUSED);
      expectTriggerRefusal('event_definer_delete', EVENT_REFUSED);
    });

    it('refuses the table owner itself at the trigger', () => {
      expect(events.table_owner).toBe('postgres');
      expect(events.force_rls).toBe(false);
      expectTriggerRefusal('event_owner_update', EVENT_REFUSED);
      expectTriggerRefusal('event_owner_delete', EVENT_REFUSED);
    });

    it('leaves the entry byte-identical after all ten write attempts', () => {
      expect(probe.eventAfter).not.toBeNull();
      expect(probe.eventAfter).toEqual(probe.eventBefore);
      expect(probe.eventAfter.id).toBe(probe.eventId);
      expect(probe.eventAfter.event_type).toBe('note_added');
    });
  });

  describe('cancellation_retry_communication is the one permitted update path (Requirements 14.16, 17.6)', () => {
    it('moves exactly the five permitted columns', () => {
      expect(step('retry_manager')).toMatchObject({ outcome: 'succeeded', rows: 1 });
      expect([...probe.retryChangedColumns].sort()).toEqual(PERMITTED_COLUMNS);
      expect(probe.retryAfter.delivery_result).toBe('Failed');
      expect(probe.retryAfter.failure_reason).toBe('probe failure reason');
      expect(probe.retryAfter.attempt_count).toBe(2);
      expect(probe.retryAfter.provider_message_id).toBe(`cx-immut-${RUN_ID}-provider`);
      expect(probe.retryAfter.send_time).not.toBe(probe.commAfter.send_time);
    });

    it('leaves every other stored column of the record unchanged', () => {
      // Stated as the whole row minus the five, so a column added by a later migration
      // is covered by this assertion the day it exists.
      for (const [column, value] of Object.entries(probe.commAfter)) {
        if (PERMITTED_COLUMNS.includes(column)) continue;
        expect(probe.retryAfter[column]).toEqual(value);
      }
      // Named individually too, because these three are the evidence of what was sent.
      expect(probe.retryAfter.template_version_id).toBe(probe.commAfter.template_version_id);
      expect(probe.retryAfter.rendered_subject).toBe('audit immutability probe subject');
      expect(probe.retryAfter.rendered_body).toBe('audit immutability probe body');
    });

    it('refuses a rendered subject change and a rendered body change inside the retry window', () => {
      // Both attempts carry the transaction-local marker naming this row, so an update
      // is otherwise legal at that moment: the refusal is the frozen-column rule alone.
      expectTriggerRefusal('comm_retry_window_subject_change', COMM_FROZEN_REFUSED);
      expectTriggerRefusal('comm_retry_window_body_change', COMM_FROZEN_REFUSED);
    });

    it('refuses a retry that lowers attempt_count or names an unknown delivery result', () => {
      const lowered = step('retry_lowers_attempt_count');
      expect(lowered.outcome).toBe('rejected');
      expect(lowered.sqlstate).toBe(INVALID_PARAMETER_VALUE);
      expect(lowered.message).toContain('cannot lower attempt_count');

      const unknown = step('retry_unknown_delivery_result');
      expect(unknown.outcome).toBe('rejected');
      expect(unknown.sqlstate).toBe(INVALID_PARAMETER_VALUE);
      expect(unknown.message).toContain(
        'needs a delivery result of Sent, Delivered, or Failed',
      );
    });

    it('is reserved to Manager_Role and the service role', () => {
      const attempt = step('retry_agent');
      expect(attempt.outcome).toBe('rejected');
      expect(attempt.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
      expect(attempt.message).toContain(RETRY_RESERVED);
    });

    it('clears its marker, so a bare update straight afterwards is refused again', () => {
      // One retry must not become a licence to rewrite the row later in the same
      // transaction.
      expectTriggerRefusal('retry_marker_cleared', COMM_MARKER_REFUSED);
    });
  });

  it('leaves both append-only tables with exactly the rows they started with', () => {
    // The seeded case, recipient, Communication_Record, and audit entry were all rolled
    // back, so this run added nothing to two tables from which nothing can be removed.
    expect(after.communications).toBe(before.communications);
    expect(after.events).toBe(before.events);
  });
});
