// src/features/time-attendance/server/__tests__/audit-immutability.integration.test.ts
// Integration tests for audit immutability and the migration stage 1 policies.
//
// Feature: time-attendance-ui-redesign, task 2.5
// Requirements: 16.5 (the audit log rejects updates and deletions),
//               21.10 (every access rule is enforced in row level security too)
//
// ## Why these are not unit tests
//
// Nothing here is a rule the domain layer could hold. `attendance_audit_log` is
// protected by three mechanisms that only exist in the database, and each one
// covers a path the other two do not:
//
//   1. Row level security grants select and insert, with no update policy and no
//      delete policy at all.
//   2. The `attendance_audit_immutable()` trigger raises on update or delete,
//      which is what stops a `security definer` function — the shape every
//      stage-5 mutation runs as — from editing history while bypassing RLS.
//   3. `update` and `delete` are revoked from `authenticated` and `anon`, so a
//      client attempt fails loudly at the privilege layer instead of quietly
//      matching zero rows under RLS.
//
// A test that only proved one of them would leave the other two free to be
// dropped by a later migration, so all three are exercised, and each attempt is
// made under the role that reaches that particular layer:
//
//   authenticated + super_admin claims  the grant layer, error 42501
//   security definer, invoked as authenticated  bypasses RLS, meets the trigger
//   service_role (bypassrls, keeps its grants)  bypasses RLS, meets the trigger
//   postgres (the table owner, bypassrls)       meets the trigger
//
// The last one records a live probe finding rather than a guess: `postgres` on a
// hosted Supabase project owns this table and carries `bypassrls`, so it is the
// strongest identity the application layer can reach, and the trigger refuses it
// too. If a future migration replaced the trigger with an RLS-only rule, this is
// the assertion that would fail.
//
// ## How the rows are cleaned up
//
// They are not deleted, because they cannot be: the table is append-only, which
// is the very thing under test. Every write the probe makes — the seeded audit
// row, an administrator's successful append, and the seeded note, day review,
// and closed date — happens inside one transaction that is rolled back by
// raising at the end of the block, carrying the collected results out through
// the exception detail. The test then re-counts the table and asserts it holds
// exactly as many rows as it did before, so a run leaves the project exactly as
// it found it. Nothing is committed, and no later test inherits a stray row.
//
// ## How to run it
//
// This file needs the live project, so it self-skips unless the Supabase
// Management API credentials are in the environment. `npx vitest --run` does not
// read `.env.local`, so the default suite reports these as skipped and stays
// offline. Run them against the project the same way the row-retention verifier
// is run:
//
//   npm run test:integration
//
// which is `node --env-file=.env.local ./node_modules/vitest/vitest.mjs --run
// integration.test`. Read-only apart from the rolled-back probe transaction.

import { beforeAll, describe, expect, it } from 'vitest';

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const HAS_CREDENTIALS = Boolean(ACCESS_TOKEN && PROJECT_REF);

/** The trigger's message, transcribed from `v1.9.0-attendance-foundations.sql`. */
const APPEND_ONLY_MESSAGE = 'attendance_audit_log is append-only';

/** `raise exception` in plpgsql without an explicit code. */
const RAISE_EXCEPTION = 'P0001';
/** Insufficient privilege, which is both a revoked grant and an RLS violation. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** A work date no real row uses, so the seeded policy rows are unambiguous. */
const PROBE_DATE = '2099-12-31';

// ─── Management API client ───────────────────────────────────────────────────

/**
 * Runs one SQL request against the project, the same endpoint
 * `scripts/run-sql.mjs` uses. Multi-statement requests return the last
 * statement's rows, which is why each probe ends in a single `select`.
 *
 * The gateway in front of the endpoint answers 502 intermittently, so a
 * transient status is retried rather than failing the suite for a network blip.
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

// ─── The probe ──────────────────────────────────────────────────────────────

/**
 * One attempt: the label, the role it ran as, and whether the database allowed
 * it. `rows` is the number of rows the statement touched or returned, which is
 * what makes a select under RLS legible — the statement succeeds either way and
 * the policy shows up as the row count.
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
  seededId: string;
  rowBefore: Record<string, unknown>;
  rowAfter: Record<string, unknown>;
  steps: ProbeStep[];
  error?: string;
}

interface Surface {
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
  anon_update: boolean;
  anon_delete: boolean;
  service_role_update: boolean;
  service_role_bypasses_rls: boolean;
}

/**
 * The catalogue view of the three protections, so a migration that dropped one
 * of them is caught even on a project where no attempt happens to be made.
 */
const SURFACE_SQL = `
select
  c.relrowsecurity                                     as rls_enabled,
  c.relforcerowsecurity                                as force_rls,
  pg_get_userbyid(c.relowner)                          as table_owner,
  (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'attendance_audit_log'
       and p.cmd in ('UPDATE', 'DELETE'))              as update_or_delete_policies,
  (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'attendance_audit_log'
       and p.cmd = 'SELECT')                           as select_policies,
  (select count(*) from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'attendance_audit_log'
       and p.cmd = 'INSERT')                           as insert_policies,
  (select count(*) from pg_trigger t
     where t.tgrelid = c.oid and not t.tgisinternal
       and t.tgfoid = 'public.attendance_audit_immutable()'::regprocedure)
                                                       as immutable_triggers,
  (select string_agg(distinct e.event, ',' order by e.event)
     from pg_trigger t
     cross join lateral (
       values ('update', (t.tgtype & 16) <> 0), ('delete', (t.tgtype & 8) <> 0),
              ('insert', (t.tgtype & 4) <> 0)
     ) as e(event, present)
     where t.tgrelid = c.oid and not t.tgisinternal and e.present
       and t.tgfoid = 'public.attendance_audit_immutable()'::regprocedure)
                                                       as trigger_events,
  has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
  has_table_privilege('authenticated', c.oid, 'INSERT') as authenticated_insert,
  has_table_privilege('authenticated', c.oid, 'UPDATE') as authenticated_update,
  has_table_privilege('authenticated', c.oid, 'DELETE') as authenticated_delete,
  has_table_privilege('anon', c.oid, 'UPDATE')          as anon_update,
  has_table_privilege('anon', c.oid, 'DELETE')          as anon_delete,
  has_table_privilege('service_role', c.oid, 'UPDATE')  as service_role_update,
  (select rolbypassrls from pg_roles where rolname = 'service_role')
                                                       as service_role_bypasses_rls
from pg_class c
where c.oid = 'public.attendance_audit_log'::regclass
`;

/**
 * Seeds one audit row, one note, one day review, and one closed date; attempts
 * every update and delete path against the audit row; runs the stage-1 read and
 * append probes as an administrator and as an ordinary employee; then raises so
 * the whole block is rolled back, carrying the results out in the exception
 * detail.
 *
 * The helper functions live in `pg_temp`, so they belong to this connection and
 * to no schema anyone else can see.
 */
const PROBE_SQL = `
create or replace function pg_temp.audit_probe_step(
  p_label text, p_role text, p_actor uuid, p_sql text
) returns jsonb language plpgsql as $step$
declare
  v_rows bigint;
begin
  begin
    if p_actor is not null then
      perform set_config('request.jwt.claims',
        json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
    end if;
    perform set_config('role', coalesce(p_role, 'none'), true);

    execute p_sql;
    get diagnostics v_rows = row_count;

    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    return jsonb_build_object('step', p_label, 'role', coalesce(p_role, current_user),
                              'outcome', 'succeeded', 'rows', v_rows);
  exception when others then
    -- The failed statement is rolled back to this block's savepoint, so the
    -- seeded rows outside it survive and the next probe starts clean.
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    return jsonb_build_object('step', p_label, 'role', coalesce(p_role, current_user),
                              'outcome', 'rejected', 'sqlstate', sqlstate, 'message', sqlerrm);
  end;
end $step$;

create or replace function pg_temp.audit_definer_update(p_id uuid) returns void
language plpgsql security definer as $definer$
begin
  update public.attendance_audit_log
     set reason = 'tampered through a definer path'
   where id = p_id;
end $definer$;

create or replace function pg_temp.audit_definer_delete(p_id uuid) returns void
language plpgsql security definer as $definer$
begin
  delete from public.attendance_audit_log where id = p_id;
end $definer$;

create or replace function pg_temp.attendance_stage_one_probe() returns jsonb
language plpgsql as $probe$
declare
  v_admin uuid;
  v_employee uuid;
  v_id uuid;
  v_before jsonb;
  v_steps jsonb := '[]'::jsonb;
  v_detail text;
begin
  select id into v_admin from public.profiles where role = 'super_admin' order by id limit 1;
  select id into v_employee from public.profiles where role <> 'super_admin' order by id limit 1;
  if v_admin is null or v_employee is null then
    return jsonb_build_object('error',
      'the roster needs one super_admin profile and one other profile');
  end if;

  begin
    -- ── Seeded state, all of it undone by the raise at the end of this block.
    insert into public.attendance_audit_log (
      profile_id, work_date, entity_type, action, field,
      old_value, new_value, actor_profile_id, reason
    ) values (
      v_admin, date '${PROBE_DATE}', 'clock_entry', 'correct_punch', 'clock_in',
      to_jsonb('2026-02-02T13:00:00+00:00'::text),
      to_jsonb('2026-02-02T13:05:00+00:00'::text),
      v_admin, 'audit immutability integration probe'
    ) returning id into v_id;

    insert into public.attendance_closed_dates (closed_date, label, created_by)
    values (date '${PROBE_DATE}', 'audit immutability probe', v_admin)
    on conflict (closed_date) do nothing;

    insert into public.attendance_notes (profile_id, work_date, note, author_profile_id)
    values (v_admin, date '${PROBE_DATE}', 'audit immutability probe', v_admin);

    insert into public.attendance_day_reviews (profile_id, work_date, reviewed_by)
    values (v_admin, date '${PROBE_DATE}', v_admin)
    on conflict (profile_id, work_date) do nothing;

    select to_jsonb(t) into v_before from public.attendance_audit_log t where id = v_id;

    v_steps := v_steps
      -- ── Requirement 16.5: update and delete, on every path that could reach
      --    the row. The administrator attempts are the ones a route could make.
      || pg_temp.audit_probe_step('administrator_update', 'authenticated', v_admin,
           format('update public.attendance_audit_log set reason = %L where id = %L',
                  'tampered by an administrator', v_id))
      || pg_temp.audit_probe_step('administrator_delete', 'authenticated', v_admin,
           format('delete from public.attendance_audit_log where id = %L', v_id))
      || pg_temp.audit_probe_step('definer_update', 'authenticated', v_admin,
           format('select pg_temp.audit_definer_update(%L)', v_id))
      || pg_temp.audit_probe_step('definer_delete', 'authenticated', v_admin,
           format('select pg_temp.audit_definer_delete(%L)', v_id))
      || pg_temp.audit_probe_step('service_role_update', 'service_role', null,
           format('update public.attendance_audit_log set reason = %L where id = %L',
                  'tampered by service_role', v_id))
      || pg_temp.audit_probe_step('service_role_delete', 'service_role', null,
           format('delete from public.attendance_audit_log where id = %L', v_id))
      || pg_temp.audit_probe_step('owner_update', null, null,
           format('update public.attendance_audit_log set reason = %L where id = %L',
                  'tampered by the owner', v_id))
      || pg_temp.audit_probe_step('owner_delete', null, null,
           format('delete from public.attendance_audit_log where id = %L', v_id))

      -- ── Requirement 21.10: the same access rules, enforced by the policies.
      || pg_temp.audit_probe_step('administrator_reads_audit', 'authenticated', v_admin,
           format('select 1 from public.attendance_audit_log where id = %L', v_id))
      || pg_temp.audit_probe_step('employee_reads_audit', 'authenticated', v_employee,
           format('select 1 from public.attendance_audit_log where id = %L', v_id))
      || pg_temp.audit_probe_step('administrator_appends_audit', 'authenticated', v_admin,
           format($append$insert into public.attendance_audit_log
                    (profile_id, work_date, entity_type, action, actor_profile_id, reason)
                  values (%L, date '${PROBE_DATE}', 'review', 'mark_reviewed', %L,
                          'administrator append probe')$append$, v_admin, v_admin))
      || pg_temp.audit_probe_step('employee_appends_audit', 'authenticated', v_employee,
           format($append$insert into public.attendance_audit_log
                    (profile_id, work_date, entity_type, action, actor_profile_id, reason)
                  values (%L, date '${PROBE_DATE}', 'review', 'mark_reviewed', %L,
                          'employee append probe')$append$, v_employee, v_employee))
      || pg_temp.audit_probe_step('employee_reads_policy', 'authenticated', v_employee,
           'select 1 from public.attendance_policy')
      || pg_temp.audit_probe_step('employee_reads_closed_dates', 'authenticated', v_employee,
           format('select 1 from public.attendance_closed_dates where closed_date = date %L',
                  '${PROBE_DATE}'))
      || pg_temp.audit_probe_step('administrator_reads_notes', 'authenticated', v_admin,
           format('select 1 from public.attendance_notes where work_date = date %L',
                  '${PROBE_DATE}'))
      || pg_temp.audit_probe_step('employee_reads_notes', 'authenticated', v_employee,
           format('select 1 from public.attendance_notes where work_date = date %L',
                  '${PROBE_DATE}'))
      || pg_temp.audit_probe_step('administrator_reads_day_reviews', 'authenticated', v_admin,
           format('select 1 from public.attendance_day_reviews where work_date = date %L',
                  '${PROBE_DATE}'))
      || pg_temp.audit_probe_step('employee_reads_day_reviews', 'authenticated', v_employee,
           format('select 1 from public.attendance_day_reviews where work_date = date %L',
                  '${PROBE_DATE}'))
      || pg_temp.audit_probe_step('employee_appends_note', 'authenticated', v_employee,
           format($note$insert into public.attendance_notes
                    (profile_id, work_date, note, author_profile_id)
                  values (%L, date '${PROBE_DATE}', 'employee note probe', %L)$note$,
                  v_employee, v_employee));

    -- Raising here undoes every insert above and carries the results out.
    raise exception 'attendance_stage_one_probe_complete'
      using detail = jsonb_build_object(
        'seededId', v_id,
        'rowBefore', v_before,
        'rowAfter', (select to_jsonb(t) from public.attendance_audit_log t where id = v_id),
        'steps', v_steps
      )::text;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm = 'attendance_stage_one_probe_complete' then
      return v_detail::jsonb;
    end if;
    raise;
  end;
end $probe$;

select pg_temp.attendance_stage_one_probe() as probe;
`;

// ─── The suite ──────────────────────────────────────────────────────────────

const describeAgainstProject = HAS_CREDENTIALS ? describe : describe.skip;

describeAgainstProject('attendance_audit_log immutability and the stage-1 policies', () => {
  let surface: Surface;
  let probe: ProbeResult;
  let rowsBefore: number;
  let rowsAfter: number;

  const countRows = async (): Promise<number> => {
    const rows = await runSql<{ rows: number }>(
      'select count(*)::int as rows from public.attendance_audit_log',
    );
    return rows[0].rows;
  };

  beforeAll(async () => {
    rowsBefore = await countRows();
    surface = (await runSql<Surface>(SURFACE_SQL))[0];
    probe = (await runSql<{ probe: ProbeResult }>(PROBE_SQL))[0].probe;
    rowsAfter = await countRows();

    // A probe that could not seed says nothing about the policies, so fail
    // loudly here rather than letting every assertion below pass vacuously.
    expect(probe.error).toBeUndefined();
    expect(probe.steps.length).toBe(19);
  }, 120_000);

  /** One attempt by name, so a renamed or dropped probe fails clearly. */
  function step(name: string): ProbeStep {
    const found = probe.steps.find((candidate) => candidate.step === name);
    if (!found) throw new Error(`the probe recorded no step named ${name}`);
    return found;
  }

  function expectAppendOnlyRefusal(name: string): void {
    const attempt = step(name);
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.sqlstate).toBe(RAISE_EXCEPTION);
    expect(attempt.message).toContain(APPEND_ONLY_MESSAGE);
  }

  function expectPrivilegeRefusal(name: string): void {
    const attempt = step(name);
    expect(attempt.outcome).toBe('rejected');
    expect(attempt.sqlstate).toBe(INSUFFICIENT_PRIVILEGE);
  }

  describe('the three protections are in place', () => {
    it('has row level security on, with select and insert policies and no update or delete policy', () => {
      // Requirement 16, criterion 5, at the policy layer.
      expect(surface.rls_enabled).toBe(true);
      expect(surface.update_or_delete_policies).toBe(0);
      expect(surface.select_policies).toBeGreaterThanOrEqual(1);
      expect(surface.insert_policies).toBeGreaterThanOrEqual(1);
    });

    it('carries the immutability trigger on update and delete', () => {
      expect(surface.immutable_triggers).toBe(1);
      expect(surface.trigger_events).toBe('delete,update');
    });

    it('has update and delete revoked from the client roles, keeping select and insert', () => {
      expect(surface.authenticated_update).toBe(false);
      expect(surface.authenticated_delete).toBe(false);
      expect(surface.anon_update).toBe(false);
      expect(surface.anon_delete).toBe(false);
      // The append path has to keep working, or the audit trail cannot be
      // written at all (Requirement 16, criterion 1).
      expect(surface.authenticated_select).toBe(true);
      expect(surface.authenticated_insert).toBe(true);
    });
  });

  describe('update and delete are refused on every path (Requirement 16.5)', () => {
    it('refuses an administrator update and delete at the privilege layer', () => {
      expectPrivilegeRefusal('administrator_update');
      expectPrivilegeRefusal('administrator_delete');
    });

    it('refuses a security definer update and delete at the trigger', () => {
      // The definer function runs as the table owner, so RLS and the revoked
      // grants are both out of the way. This is the path every stage-5
      // mutation function will run on.
      expectAppendOnlyRefusal('definer_update');
      expectAppendOnlyRefusal('definer_delete');
    });

    it('refuses an RLS-bypassing service role update and delete at the trigger', () => {
      expect(surface.service_role_bypasses_rls).toBe(true);
      expect(surface.service_role_update).toBe(true);
      expectAppendOnlyRefusal('service_role_update');
      expectAppendOnlyRefusal('service_role_delete');
    });

    it('refuses the table owner itself', () => {
      // Recorded from a live probe: on a hosted project `postgres` owns this
      // table and carries bypassrls, and RLS is not forced. The trigger is the
      // only thing standing between that identity and rewritten history.
      expect(surface.table_owner).toBe('postgres');
      expect(surface.force_rls).toBe(false);
      expectAppendOnlyRefusal('owner_update');
      expectAppendOnlyRefusal('owner_delete');
    });

    it('leaves the row exactly as it was after all eight attempts', () => {
      expect(probe.rowAfter).not.toBeNull();
      expect(probe.rowAfter).toEqual(probe.rowBefore);
      expect(probe.rowAfter.id).toBe(probe.seededId);
      expect(probe.rowAfter.reason).toBe('audit immutability integration probe');
    });
  });

  describe('the stage-1 policies decide the same way the module does (Requirement 21.10)', () => {
    it('lets an administrator read and append audit entries', () => {
      expect(step('administrator_reads_audit')).toMatchObject({ outcome: 'succeeded', rows: 1 });
      expect(step('administrator_appends_audit')).toMatchObject({ outcome: 'succeeded', rows: 1 });
    });

    it('hides audit entries from an employee and refuses their append', () => {
      // The select policy leaves the statement legal and the row invisible,
      // which is why this reads as a row count rather than an error.
      expect(step('employee_reads_audit')).toMatchObject({ outcome: 'succeeded', rows: 0 });
      expectPrivilegeRefusal('employee_appends_audit');
      expect(step('employee_appends_audit').message).toContain('row-level security policy');
    });

    it('lets every signed-in user read the configuration tables', () => {
      // My Day, the working-day count, and the Health Ribbon all need these,
      // so both tables are readable by any authenticated user.
      expect(step('employee_reads_policy').outcome).toBe('succeeded');
      expect(step('employee_reads_policy').rows).toBeGreaterThanOrEqual(1);
      expect(step('employee_reads_closed_dates')).toMatchObject({
        outcome: 'succeeded',
        rows: 1,
      });
    });

    it('keeps notes and day reviews administrator-only', () => {
      expect(step('administrator_reads_notes')).toMatchObject({ outcome: 'succeeded', rows: 1 });
      expect(step('employee_reads_notes')).toMatchObject({ outcome: 'succeeded', rows: 0 });
      expect(step('administrator_reads_day_reviews')).toMatchObject({
        outcome: 'succeeded',
        rows: 1,
      });
      expect(step('employee_reads_day_reviews')).toMatchObject({ outcome: 'succeeded', rows: 0 });
      expectPrivilegeRefusal('employee_appends_note');
    });
  });

  it('leaves the audit log with exactly the rows it started with', () => {
    // The seeded row and the administrator's append were both rolled back, so
    // this run added nothing to an append-only table.
    expect(rowsAfter).toBe(rowsBefore);
  });
});
