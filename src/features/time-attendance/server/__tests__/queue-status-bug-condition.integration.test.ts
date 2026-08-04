// src/features/time-attendance/server/__tests__/queue-status-bug-condition.integration.test.ts
// Bug condition exploration test for the attendance / queue status separation bugfix.
//
// Feature: attendance-queue-status-separation, task 2
// Property 1: Bug Condition — attendance never silently decides queue participation
// **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11**
//
// ## THIS TEST IS EXPECTED TO FAIL ON UNFIXED CODE
//
// Every assertion below encodes the *fixed* behavior from `bugfix.md` § Expected
// Behavior. Run against today's code the failures are the deliverable: each one
// is a counterexample proving a clause of `isBugCondition(X)` holds in
// production. Task 9.1 re-runs this file unchanged, and the same assertions
// passing is what validates the fix. Do not weaken an assertion to make it
// green, and do not repair the routes from here.
//
// ## Why this is an integration test and not a unit test
//
// Nothing under test is a rule the domain layer holds. The defect lives in the
// seam between four HTTP route bodies and three `security definer` SQL
// functions, and every symptom is only observable where those two meet:
//
//   * `profiles.availability` after a route call — the entangled field itself.
//   * `rotation_state` and `turn_events` — whether a turn actually moved.
//   * the HTTP status and payload — whether a swallowed `{ error }` was
//     reported as success (1.5), and whether a retry answers with committed
//     state or a contradiction (1.11).
//   * the absence of any row, in any table, that names an availability
//     transition (1.8).
//
// So the routes are driven for real, with a real Supabase session, against the
// real database. The only stub is the cookie transport: `next/headers` is
// replaced by an in-memory jar that `@supabase/ssr` itself populated at
// sign-in, so the session, the JWT, the RLS posture and every SQL statement are
// genuine. No Supabase call, no SQL function and no response payload is mocked.
//
// ## What this test writes, and how it puts it all back
//
// It seeds its own employees — a queue-holding agent, a handoff target, a
// rotation-free agent, a customer service employee, a manager, and an agent to
// delete — and drives the unfixed routes as them. Cleanup, in `afterAll`, runs
// whether or not the probes succeeded:
//
//   * `rotation_state` is snapshotted before anything runs and restored
//     afterwards, but only for rotations that still point at, or were last
//     touched by, a seeded profile. If a real agent claimed in the meantime
//     their state is left alone and the run reports it. `version` is left
//     monotonically advanced rather than rewound, because rewinding a
//     concurrency counter is more dangerous than leaving it high.
//   * `availability_day_state` is snapshotted and restored.
//   * every active agent's `availability` is snapshotted and restored where it
//     differs, which covers the daily reset if it ever committed.
//   * `turn_events`, `audit_log`, `daily_rotation_starts`, `time_clock_breaks`
//     and `time_clock_entries` rows belonging to the seeded profiles are
//     deleted, then the profiles, then the auth users.
//   * `user_notifications` rows the restore itself provoked are deleted.
//
// The daily reset (C8) is the one probe that cannot be driven through a route,
// and it is also the most destructive thing in this file — it rewrites every
// active agent and nulls all three rotation pointers. It therefore runs inside
// a plpgsql block that raises at the end, so its writes are rolled back by the
// subtransaction and never commit. That is the same technique
// `audit-immutability.integration.test.ts` uses.
//
// The one piece of residue no design can avoid: `rotation_state.version` ends
// higher than it started, because any rotation write bumps it.
//
// ## How to run it
//
//   npm run test:integration
//
// which is `node --env-file=.env.local ./node_modules/vitest/vitest.mjs --run
// integration.test`. The file self-skips when the credentials are absent, so
// the default offline `npm test` run reports it as skipped.

import { createClient as createAdminClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ─── Credentials and gating ─────────────────────────────────────────────────

const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

const HAS_CREDENTIALS = Boolean(
  ACCESS_TOKEN && PROJECT_REF && SUPABASE_URL && PUBLISHABLE_KEY && SECRET_KEY,
);

/**
 * The eight availability sources requirement 2.12 defines. A row in any table
 * that does not name one of these does not attribute an availability change.
 */
const AVAILABILITY_SOURCES = [
  'manual_agent',
  'manual_manager',
  'attendance_clock_out',
  'attendance_break_start',
  'attendance_break_end',
  'daily_reset',
  'system_repair',
  'user_deactivated',
] as const;

/** Username prefix every seeded profile carries, so cleanup can find them all. */
const SEED_PREFIX = 'qsbug';

// ─── The cookie transport the routes read their session from ────────────────

interface CookieJar {
  getAll(): { name: string; value: string }[];
  get(name: string): { name: string; value: string } | undefined;
  has(name: string): boolean;
  set(name: string, value: string): void;
  delete(name: string): void;
}

/**
 * `next/headers` is the only thing replaced in this file. It hands the route
 * whichever jar the current probe bound, and each jar holds cookies written by
 * `@supabase/ssr` during a real password sign-in — so the route's own client
 * reads a real session out of a real cookie format.
 */
const harness = vi.hoisted(() => ({ jar: null as CookieJar | null }));

vi.mock('next/headers', () => ({
  cookies: async () => {
    if (!harness.jar) throw new Error('no cookie jar is bound to this request');
    return harness.jar;
  },
}));

const { POST: clockInRoute, PATCH: clockPatchRoute } = await import(
  '@/app/api/time-clock/route'
);
const { POST: breakStartRoute, PATCH: breakEndRoute } = await import(
  '@/app/api/time-clock/breaks/route'
);
const { DELETE: deleteUserRoute } = await import('@/app/api/admin/users/route');

function createJar(): CookieJar {
  const store = new Map<string, string>();
  return {
    getAll: () => [...store.entries()].map(([name, value]) => ({ name, value })),
    get: (name) => (store.has(name) ? { name, value: store.get(name)! } : undefined),
    has: (name) => store.has(name),
    set: (name, value) => void store.set(name, value),
    delete: (name) => void store.delete(name),
  };
}

// ─── Management API client, for reads and for the rolled-back probe ─────────

/**
 * One SQL request against the project, the same endpoint `scripts/run-sql.mjs`
 * and the existing audit immutability suite use. The gateway answers 502
 * intermittently, so a transient status is retried rather than failing the run
 * for a network blip.
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

const admin = HAS_CREDENTIALS
  ? createAdminClient(SUPABASE_URL!, SECRET_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// ─── Seeded employees ───────────────────────────────────────────────────────

type SeedRole = 'agent' | 'customer_service' | 'manager';

interface SeedSpec {
  key: string;
  role: SeedRole;
  /** Rotation enable flags. False everywhere keeps a probe out of live rotations. */
  rotations: boolean;
  availability: 'available' | 'break' | 'unavailable';
  positionOffset: number;
}

interface SeededUser extends SeedSpec {
  id: string;
  email: string;
  password: string;
  username: string;
  jar: CookieJar;
  /** A real signed-in client, used for the My Status RPC the Work Desk calls. */
  session: ReturnType<typeof createServerClient>;
}

const SEEDS: SeedSpec[] = [
  // Holds the WhatsApp turn. The only seeded profile that is ever eligible for
  // a live rotation, and only for WhatsApp, for the seconds C2 and C7 need.
  { key: 'holder', role: 'agent', rotations: true, availability: 'unavailable', positionOffset: 1 },
  // The handoff target. Its WhatsApp position is one above the holder's, so
  // `next_eligible_profile` picks it and no live agent is handed the turn.
  { key: 'nextUp', role: 'agent', rotations: true, availability: 'unavailable', positionOffset: 2 },
  // Rotation-free agent: `is_agent()` is true so `set_my_availability` runs,
  // but no rotation flag is set, so nothing in live rotations can move.
  { key: 'agent', role: 'agent', rotations: false, availability: 'unavailable', positionOffset: 3 },
  // The deterministic C6 case: `is_agent()` is false for customer_service.
  { key: 'cs', role: 'customer_service', rotations: false, availability: 'unavailable', positionOffset: 4 },
  // The acting manager for the deletion path.
  { key: 'manager', role: 'manager', rotations: false, availability: 'unavailable', positionOffset: 5 },
  // Deleted through the DELETE handler while queue Available.
  { key: 'victim', role: 'agent', rotations: false, availability: 'available', positionOffset: 6 },
];

const users = new Map<string, SeededUser>();
const user = (key: string): SeededUser => {
  const found = users.get(key);
  if (!found) throw new Error(`the probe never seeded a user named ${key}`);
  return found;
};

// ─── Snapshots taken before anything is written ─────────────────────────────

interface RotationRow {
  kind: string;
  current_profile_id: string | null;
  version: number;
  updated_by: string | null;
  updated_at: string;
}

let rotationSnapshot: RotationRow[] = [];
let daySnapshot: { business_date: string } | null = null;
let availabilitySnapshot: { id: string; availability: string }[] = [];
let availabilityEventsExist = false;
let runStartedAt = '';

// ─── Route driving ──────────────────────────────────────────────────────────

type RouteHandler = (request: Request) => Promise<Response>;

interface RouteResult {
  status: number;
  body: Record<string, unknown>;
}

function bind(target: SeededUser): void {
  harness.jar = target.jar;
}

async function callRoute(
  handler: RouteHandler,
  method: string,
  url: string,
  body?: Record<string, unknown>,
): Promise<RouteResult> {
  const request = new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await handler(request);
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: payload };
}

const clockIn = (target: SeededUser) => {
  bind(target);
  return callRoute(clockInRoute as RouteHandler, 'POST', 'http://localhost/api/time-clock', {
    status: 'available',
  });
};

const clockOut = (target: SeededUser) => {
  bind(target);
  return callRoute(clockPatchRoute as RouteHandler, 'PATCH', 'http://localhost/api/time-clock', {
    action: 'clock_out',
  });
};

const startBreak = (target: SeededUser, breakType = 'lunch') => {
  bind(target);
  return callRoute(
    breakStartRoute as RouteHandler,
    'POST',
    'http://localhost/api/time-clock/breaks',
    { break_type: breakType },
  );
};

const endBreak = (target: SeededUser) => {
  bind(target);
  return callRoute(
    breakEndRoute as RouteHandler,
    'PATCH',
    'http://localhost/api/time-clock/breaks',
  );
};

const deleteAccount = (actor: SeededUser, targetId: string) => {
  bind(actor);
  return callRoute(deleteUserRoute as RouteHandler, 'DELETE', 'http://localhost/api/admin/users', {
    userId: targetId,
    reason: 'attendance / queue status separation exploration probe',
  });
};

// ─── Direct database reads ──────────────────────────────────────────────────

const nowIso = async (): Promise<string> =>
  (await runSql<{ at: string }>('select now()::text as at'))[0].at;

async function readAvailability(profileId: string): Promise<string> {
  const rows = await runSql<{ availability: string }>(
    `select availability::text as availability from public.profiles where id = '${profileId}'`,
  );
  return rows[0]?.availability ?? 'missing';
}

async function readRotation(kind: string): Promise<RotationRow> {
  const rows = await runSql<RotationRow>(`
    select kind::text as kind, current_profile_id, version, updated_by, updated_at::text as updated_at
    from public.rotation_state where kind::text = '${kind}'
  `);
  return rows[0];
}

/**
 * Everything that could conceivably attribute an availability change for one
 * profile in one window. `attributable` counts only records that satisfy 2.12 —
 * a previous status, a new status, a source drawn from the eight-member
 * vocabulary, and an actor. Today that can only ever be zero, because no table
 * has the columns; after the fix it is the `availability_events` count.
 */
interface WindowAudit {
  availabilityEvents: number;
  availabilityEventSources: string[];
  availabilityEventDetail: Record<string, unknown>[];
  turnEvents: number;
  attendanceAuditRows: number;
  auditRows: {
    action: string;
    entity_type: string | null;
    old_availability: string | null;
    new_availability: string | null;
    actor: string | null;
  }[];
  /** Records that actually satisfy requirement 2.12. */
  attributable: number;
}

async function auditWindow(profileId: string, sinceIso: string): Promise<WindowAudit> {
  const eventsSelect = availabilityEventsExist
    ? `coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at) from public.availability_events e
          where e.profile_id = '${profileId}' and e.created_at >= '${sinceIso}'::timestamptz), '[]'::jsonb)`
    : `'[]'::jsonb`;

  const rows = await runSql<{
    events: Record<string, unknown>[];
    turn_events: number;
    attendance_audit_rows: number;
    audit_rows: WindowAudit['auditRows'];
  }>(`
    select
      ${eventsSelect} as events,
      (select count(*)::int from public.turn_events t
        where t.created_at >= '${sinceIso}'::timestamptz
          and (t.actor_profile_id = '${profileId}'
            or t.previous_profile_id = '${profileId}'
            or t.next_profile_id = '${profileId}')) as turn_events,
      (select count(*)::int from public.attendance_audit_log a
        where a.created_at >= '${sinceIso}'::timestamptz
          and a.profile_id = '${profileId}') as attendance_audit_rows,
      coalesce((select jsonb_agg(jsonb_build_object(
                 'action', a.action,
                 'entity_type', a.entity_type,
                 'old_availability', a.old_value->>'availability',
                 'new_availability', a.new_value->>'availability',
                 'actor', a.actor_profile_id) order by a.created_at)
        from public.audit_log a
        where a.created_at >= '${sinceIso}'::timestamptz
          and (a.entity_id = '${profileId}' or a.actor_profile_id = '${profileId}')),
        '[]'::jsonb) as audit_rows
  `);

  const row = rows[0];
  const events = row.events ?? [];
  const sources = events.map((event) => String(event.source ?? ''));

  // An `audit_log` row qualifies only if it names one of the eight sources.
  // `user_deleted` does not, which is exactly the gap 2.20 closes.
  const qualifyingAuditRows = (row.audit_rows ?? []).filter(
    (candidate) =>
      (AVAILABILITY_SOURCES as readonly string[]).includes(candidate.action) &&
      candidate.old_availability !== null &&
      candidate.new_availability !== null &&
      candidate.actor !== null,
  );

  return {
    availabilityEvents: events.length,
    availabilityEventSources: sources,
    availabilityEventDetail: events,
    turnEvents: row.turn_events,
    attendanceAuditRows: row.attendance_audit_rows,
    auditRows: row.audit_rows ?? [],
    attributable: events.length + qualifyingAuditRows.length,
  };
}

/**
 * Whether the pre-break queue status is recoverable from anywhere after a break
 * start — the column `time_clock_breaks.pre_break_queue_status` the fix adds,
 * or any other stored trace of the value.
 */
async function readPreBreakStatus(breakId: string): Promise<{
  columnExists: boolean;
  value: string | null;
}> {
  const columns = await runSql<{ n: number }>(`
    select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and table_name = 'time_clock_breaks'
      and column_name = 'pre_break_queue_status'
  `);
  if (columns[0].n === 0) return { columnExists: false, value: null };

  const rows = await runSql<{ value: string | null }>(`
    select pre_break_queue_status::text as value
    from public.time_clock_breaks where id = '${breakId}'
  `);
  return { columnExists: true, value: rows[0]?.value ?? null };
}

// ─── Seeding and cleanup ────────────────────────────────────────────────────

async function seedUsers(): Promise<void> {
  const base = (
    await runSql<{ base: number }>(
      'select coalesce(max(rotation_position), 0) + 1000 as base from public.profiles',
    )
  )[0].base;

  const stamp = Date.now().toString(36).slice(-6);

  for (const spec of SEEDS) {
    const username = `${SEED_PREFIX}${stamp}${spec.key}`.toLowerCase().slice(0, 30);
    const email = `${username}@workdesk.newhope.local`;
    const password = `NH!probe-${stamp}-${spec.key}-26`;

    const created = await admin!.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { username, display_name: `Probe ${spec.key}`, role: spec.role },
    });
    if (created.error || !created.data.user) {
      throw new Error(`could not create the ${spec.key} auth user: ${created.error?.message}`);
    }

    const position = base + spec.positionOffset;
    const profile = await admin!.from('profiles').insert({
      id: created.data.user.id,
      username,
      display_name: `Probe ${spec.key}`,
      initials: 'QSB',
      role: spec.role,
      rotation_position: position,
      whatsapp_position: position,
      ringcentral_position: position,
      workload_position: position,
      // Seeded directly, exactly as `scripts/bootstrap-users.mjs` does, so
      // setting up a pre-state never runs the rotation logic under test.
      availability: spec.availability,
      // The mode dimension of `X`. Task 2 fixed it at `attendance_assisted` for
      // every probe, because that is how every agent behaved before the fix and
      // it is the half of the property this file exercises; the `manual` half is
      // task 9's. The column did not exist when this file was written, so on
      // unfixed code the key was simply absent and the behavior was assisted by
      // default. It now exists and defaults to `manual`, so the pre-state has to
      // say what it always meant. No assertion below changed with it.
      queue_status_mode: 'attendance_assisted',
      whatsapp_active: spec.rotations,
      ringcentral_active: spec.rotations,
      workload_active: spec.rotations,
      is_active: true,
      must_change_password: false,
    });
    if (profile.error) {
      await admin!.auth.admin.deleteUser(created.data.user.id);
      throw new Error(`could not create the ${spec.key} profile: ${profile.error.message}`);
    }

    const jar = createJar();
    const session = createServerClient(SUPABASE_URL!, PUBLISHABLE_KEY!, {
      cookies: {
        getAll: () => jar.getAll(),
        setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)),
      },
    });
    const signIn = await session.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`could not sign in as ${spec.key}: ${signIn.error.message}`);

    users.set(spec.key, { ...spec, id: created.data.user.id, email, password, username, jar, session });
  }
}

/**
 * Deletes the seeded profiles' `availability_events` rows.
 *
 * The table is append-only by design: a `before update or delete` trigger raises
 * even on a security definer path, and its `profile_id`, `clock_entry_id` and
 * `break_id` foreign keys carry no referential action, so a row referencing a
 * clock entry pins that entry and its profile in place. In production nothing
 * deletes either — corrections update clock entries and account deletion is a
 * soft deactivate — so the permanence is the point.
 *
 * A probe is the one caller that has to undo itself. The trigger is switched off
 * around the delete, which needs table ownership rather than merely the ability
 * to execute a definer function, so it does not weaken what the trigger proves
 * about the paths under test. Without this the probe cannot delete the clock
 * entries or the profiles it seeded, and the run leaves permanent residue.
 */
async function purgeAvailabilityEvents(): Promise<void> {
  const ids = [...users.values()].map((seeded) => `'${seeded.id}'`).join(', ');
  if (!ids || !availabilityEventsExist) return;
  await runSql(`
    alter table public.availability_events disable trigger availability_events_no_update;
    delete from public.availability_events where profile_id in (${ids}) or actor_profile_id in (${ids});
    alter table public.availability_events enable trigger availability_events_no_update;
    select 1 as done
  `);
}

/** Deletes every attendance row the probes created for the seeded profiles. */
async function resetAttendance(): Promise<void> {
  const ids = [...users.values()].map((seeded) => `'${seeded.id}'`).join(', ');
  if (!ids) return;
  // Availability events reference the clock entries and breaks, so they go first.
  // Every observation this file makes is read before the reset that follows it.
  await purgeAvailabilityEvents();
  await runSql(`
    delete from public.time_clock_breaks
     where clock_entry_id in (select id from public.time_clock_entries where profile_id in (${ids}));
    delete from public.time_clock_entries where profile_id in (${ids});
    select 1 as done
  `);
}

async function setAvailabilityDirectly(profileId: string, value: string): Promise<void> {
  await runSql(
    `update public.profiles set availability = '${value}'::availability_status where id = '${profileId}'`,
  );
}

async function cleanUp(): Promise<string[]> {
  const notes: string[] = [];
  const ids = [...users.values()].map((seeded) => `'${seeded.id}'`).join(', ');
  const restoreStartedAt = await nowIso();

  if (ids) {
    // Rotations first: a rotation still pointing at a seeded profile blocks the
    // profile delete, and a rotation a live claim has since moved is left alone.
    for (const snapshot of rotationSnapshot) {
      const current = await readRotation(snapshot.kind);
      const touchedByProbe =
        (current.current_profile_id !== null && ids.includes(`'${current.current_profile_id}'`)) ||
        (current.updated_by !== null && ids.includes(`'${current.updated_by}'`));

      if (!touchedByProbe) {
        if (current.version !== snapshot.version) {
          notes.push(
            `${snapshot.kind} moved to a live agent during the run (version ${snapshot.version} → ${current.version}); left as found`,
          );
        }
        continue;
      }

      await runSql(`
        update public.rotation_state
        set current_profile_id = ${snapshot.current_profile_id ? `'${snapshot.current_profile_id}'` : 'null'},
            updated_by = ${snapshot.updated_by ? `'${snapshot.updated_by}'` : 'null'},
            updated_at = '${snapshot.updated_at}'::timestamptz,
            version = version + 1
        where kind::text = '${snapshot.kind}'
      `);
      notes.push(
        `${snapshot.kind} restored to ${snapshot.current_profile_id ?? 'null'} (version left advanced, never rewound)`,
      );
    }

    // The append-only availability events reference the clock entries, the breaks
    // and the profiles about to be deleted, so they go first. See
    // `purgeAvailabilityEvents` for why a probe is allowed to do this.
    await purgeAvailabilityEvents();

    await runSql(`
      delete from public.time_clock_breaks
       where clock_entry_id in (select id from public.time_clock_entries where profile_id in (${ids}));
      delete from public.time_clock_entries where profile_id in (${ids});
      delete from public.turn_events
       where actor_profile_id in (${ids})
          or previous_profile_id in (${ids})
          or next_profile_id in (${ids});
      delete from public.audit_log
       where actor_profile_id in (${ids}) or entity_id in (${ids});
      delete from public.daily_rotation_starts where starter_profile_id in (${ids});
      select 1 as done
    `);
  }

  // The daily reset is the only thing in this file that can write a live
  // agent's availability, and it advances `business_date` in the same
  // transaction. So an unchanged business date is proof it never committed, and
  // therefore proof that no live agent's availability came from this run.
  //
  // That gate matters: without it the restore loop below reverts an agent who
  // legitimately changed their own status during the run, which is interference
  // rather than cleanup. An earlier run of this file did exactly that.
  const resetCommitted = daySnapshot
    ? (
        await runSql<{ moved: boolean }>(`
          select business_date <> '${daySnapshot.business_date}'::date as moved
          from public.availability_day_state where singleton_key
        `)
      )[0].moved
    : false;

  if (daySnapshot && resetCommitted) {
    await runSql(`
      update public.availability_day_state
      set business_date = '${daySnapshot.business_date}'::date
      where singleton_key = true
    `);
    notes.push('the daily reset committed unexpectedly; business date restored');

    for (const snapshot of availabilitySnapshot) {
      if (ids.includes(`'${snapshot.id}'`)) continue;
      const current = await readAvailability(snapshot.id);
      if (current === snapshot.availability || current === 'missing') continue;
      await setAvailabilityDirectly(snapshot.id, snapshot.availability);
      notes.push(`restored live agent ${snapshot.id} availability to ${snapshot.availability}`);
    }
  } else {
    notes.push('no live availability restore needed: the daily reset never committed');
  }

  if (ids) {
    await runSql(`
      delete from public.user_notifications
       where notification_type = 'turn' and created_at >= '${restoreStartedAt}'::timestamptz;
      delete from public.profiles where id in (${ids});
      select 1 as done
    `);
    for (const seeded of users.values()) {
      await admin!.auth.admin.deleteUser(seeded.id);
    }
  }

  const leftover = await runSql<{ n: number }>(
    `select count(*)::int as n from public.profiles where username like '${SEED_PREFIX}%'`,
  );
  if (leftover[0].n > 0) notes.push(`WARNING: ${leftover[0].n} seeded profiles survived cleanup`);

  return notes;
}

// ─── The rolled-back daily reset probe ──────────────────────────────────────

interface DailyResetProbe {
  fired: boolean;
  changed_profiles: number;
  availability_events_exist: boolean;
  availability_events_added: number;
  audit_log_added: number;
  attendance_audit_added: number;
  turn_events_added: number;
  rotation_before: { kind: string; current_profile_id: string | null; version: number }[];
  rotation_after: { kind: string; current_profile_id: string | null; version: number }[];
  unread_turn_notifications_before: number;
  unread_turn_notifications_after: number;
}

const DAILY_RESET_PROBE_SQL = `
create or replace function pg_temp.qs_daily_reset_probe() returns jsonb
language plpgsql as $probe$
declare
  v_detail             text;
  v_before             jsonb;
  v_rot_before         jsonb;
  v_rot_after          jsonb;
  v_changed            int;
  v_events             int := 0;
  v_events_exist       boolean := to_regclass('public.availability_events') is not null;
  v_audit_before       bigint;
  v_attendance_before  bigint;
  v_turn_before        bigint;
  v_audit_added        int;
  v_attendance_added   int;
  v_turn_added         int;
  v_unread_before      int;
  v_unread_after       int;
  v_fired              boolean;
  v_started            timestamptz := clock_timestamp();
begin
  begin
    select count(*) into v_audit_before from public.audit_log;
    select count(*) into v_attendance_before from public.attendance_audit_log;
    select count(*) into v_turn_before from public.turn_events;
    select count(*) into v_unread_before from public.user_notifications
      where notification_type = 'turn' and read_at is null;

    select jsonb_agg(jsonb_build_object('id', id, 'availability', availability::text) order by id)
      into v_before
      from public.profiles where is_active and role::text = 'agent';

    select jsonb_agg(jsonb_build_object('kind', kind::text,
                                        'current_profile_id', current_profile_id,
                                        'version', version) order by kind)
      into v_rot_before from public.rotation_state;

    -- Roll the business date back so the rollover branch fires. Undone by the
    -- raise below, along with everything the reset writes.
    update public.availability_day_state
       set business_date = public.current_business_date() - 1
     where singleton_key = true;

    v_fired := public.ensure_daily_availability_reset();

    select count(*) into v_changed
      from jsonb_to_recordset(v_before) as b(id uuid, availability text)
      join public.profiles p on p.id = b.id
     where p.availability::text <> b.availability;

    select jsonb_agg(jsonb_build_object('kind', kind::text,
                                        'current_profile_id', current_profile_id,
                                        'version', version) order by kind)
      into v_rot_after from public.rotation_state;

    if v_events_exist then
      execute format(
        'select count(*)::int from public.availability_events where created_at >= %L', v_started
      ) into v_events;
    end if;

    select count(*) - v_audit_before into v_audit_added from public.audit_log;
    select count(*) - v_attendance_before into v_attendance_added from public.attendance_audit_log;
    select count(*) - v_turn_before into v_turn_added from public.turn_events;
    select count(*) into v_unread_after from public.user_notifications
      where notification_type = 'turn' and read_at is null;

    raise exception 'qs_daily_reset_probe_complete'
      using detail = jsonb_build_object(
        'fired', v_fired,
        'changed_profiles', v_changed,
        'availability_events_exist', v_events_exist,
        'availability_events_added', v_events,
        'audit_log_added', v_audit_added,
        'attendance_audit_added', v_attendance_added,
        'turn_events_added', v_turn_added,
        'rotation_before', v_rot_before,
        'rotation_after', v_rot_after,
        'unread_turn_notifications_before', v_unread_before,
        'unread_turn_notifications_after', v_unread_after
      )::text;
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    if sqlerrm = 'qs_daily_reset_probe_complete' then
      return v_detail::jsonb;
    end if;
    raise;
  end;
end $probe$;

select pg_temp.qs_daily_reset_probe() as probe;
`;

// ─── Observations ───────────────────────────────────────────────────────────

interface Observations {
  c2: {
    response: RouteResult;
    availabilityBefore: string;
    availabilityAfter: string;
    whatsappBefore: RotationRow;
    whatsappAfter: RotationRow;
    audit: WindowAudit;
  };
  c3: {
    response: RouteResult;
    availabilityBeforeBreak: string;
    availabilityAfterBreakStart: string;
    preBreak: { columnExists: boolean; value: string | null };
    audit: WindowAudit;
  };
  c4: {
    response: RouteResult;
    availabilityAfterBreakEnd: string;
    audit: WindowAudit;
  };
  myStatus: { audit: WindowAudit; availabilityAfter: string };
  c6: {
    response: RouteResult;
    availabilityBefore: string;
    availabilityAfter: string;
    rpcError: string | null;
  };
  c7: {
    responses: RouteResult[];
    availabilityAfter: string;
    audit: WindowAudit;
    whatsappTurnEvents: number;
  };
  c8Deletion: {
    response: RouteResult;
    availabilityBefore: string;
    availabilityAfter: string;
    audit: WindowAudit;
    rotationsMoved: string[];
  };
  c8Reset: DailyResetProbe;
  c1: { response: RouteResult; availabilityBefore: string };
  retry: {
    clockIn: RouteResult;
    clockInRepeat: RouteResult;
    clockOut: RouteResult;
    clockOutRepeat: RouteResult;
    breakEnd: RouteResult;
    breakEndRepeat: RouteResult;
  };
}

let seen: Observations;
let cleanupNotes: string[] = [];
let setupError: unknown = null;

// ─── The suite ──────────────────────────────────────────────────────────────

const describeAgainstProject = HAS_CREDENTIALS ? describe : describe.skip;

describeAgainstProject('Bug condition: attendance silently decides queue participation', () => {
  beforeAll(async () => {
    try {
      runStartedAt = await nowIso();

      rotationSnapshot = await runSql<RotationRow>(`
        select kind::text as kind, current_profile_id, version, updated_by,
               updated_at::text as updated_at
        from public.rotation_state order by kind
      `);
      daySnapshot = (
        await runSql<{ business_date: string }>(
          `select business_date::text as business_date from public.availability_day_state where singleton_key`,
        )
      )[0];
      availabilitySnapshot = await runSql<{ id: string; availability: string }>(`
        select id, availability::text as availability
        from public.profiles where is_active and role::text = 'agent'
      `);
      availabilityEventsExist =
        (
          await runSql<{ n: number }>(
            `select count(*)::int as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public' and c.relname = 'availability_events'`,
          )
        )[0].n > 0;

      await seedUsers();

      // ── C2. Clock-out with no open break, holding the WhatsApp turn.
      const holder = user('holder');
      const nextUp = user('nextUp');
      await setAvailabilityDirectly(nextUp.id, 'available');
      await setAvailabilityDirectly(holder.id, 'available');
      await runSql(`
        update public.rotation_state
        set current_profile_id = '${holder.id}', version = version + 1, updated_at = now(),
            updated_by = '${holder.id}'
        where kind::text = 'whatsapp'
      `);
      const c2WhatsappBefore = await readRotation('whatsapp');
      const c2Since = await nowIso();
      await clockIn(holder);
      const c2AvailabilityBefore = await readAvailability(holder.id);
      const c2Response = await clockOut(holder);
      const c2Observed = {
        response: c2Response,
        availabilityBefore: c2AvailabilityBefore,
        availabilityAfter: await readAvailability(holder.id),
        whatsappBefore: c2WhatsappBefore,
        whatsappAfter: await readRotation('whatsapp'),
        audit: await auditWindow(holder.id, c2Since),
      };

      // ── C7. Two clock-outs at one open entry, with a break open, still
      //        holding the WhatsApp turn.
      await resetAttendance();
      await setAvailabilityDirectly(holder.id, 'available');
      await runSql(`
        update public.rotation_state
        set current_profile_id = '${holder.id}', version = version + 1, updated_at = now(),
            updated_by = '${holder.id}'
        where kind::text = 'whatsapp'
      `);
      await clockIn(holder);
      await startBreak(holder);
      const c7Since = await nowIso();
      const c7Responses = await Promise.all([clockOut(holder), clockOut(holder)]);
      const c7Audit = await auditWindow(holder.id, c7Since);
      const c7Observed = {
        responses: c7Responses,
        availabilityAfter: await readAvailability(holder.id),
        audit: c7Audit,
        whatsappTurnEvents: (
          await runSql<{ n: number }>(`
            select count(*)::int as n from public.turn_events
            where created_at >= '${c7Since}'::timestamptz
              and rotation::text = 'whatsapp'
              and previous_profile_id = '${holder.id}'
          `)
        )[0].n,
      };

      // The holder is finished with live rotations. Take it back out of the
      // eligible set immediately rather than at cleanup.
      await setAvailabilityDirectly(holder.id, 'unavailable');
      await setAvailabilityDirectly(nextUp.id, 'unavailable');

      // ── My Status, then C3 and C4, on the rotation-free agent.
      const agent = user('agent');
      await resetAttendance();
      await setAvailabilityDirectly(agent.id, 'available');
      const myStatusSince = await nowIso();
      // The RPC the **My status** control sends. Before the fix that was
      // `set_my_availability`; after task 7.3 the Work Desk sends
      // `set_my_queue_status`, which wraps it and adds the `manual_agent`
      // availability event. The probe drives whichever RPC the control actually
      // uses — the assertions on the result are untouched.
      const myStatusResult = await agent.session.rpc('set_my_queue_status', {
        p_status: 'unavailable',
      });
      if (myStatusResult.error) {
        throw new Error(`the My Status RPC failed for the probe agent: ${myStatusResult.error.message}`);
      }
      const myStatusObserved = {
        audit: await auditWindow(agent.id, myStatusSince),
        availabilityAfter: await readAvailability(agent.id),
      };

      // ── C3. Break start from a deliberate Unavailable.
      await clockIn(agent);
      const c3Since = await nowIso();
      const c3AvailabilityBefore = await readAvailability(agent.id);
      const c3Response = await startBreak(agent);
      const startedBreakId = String(
        (c3Response.body.break as Record<string, unknown> | undefined)?.id ?? '',
      );
      const c3Observed = {
        response: c3Response,
        availabilityBeforeBreak: c3AvailabilityBefore,
        availabilityAfterBreakStart: await readAvailability(agent.id),
        preBreak: startedBreakId
          ? await readPreBreakStatus(startedBreakId)
          : { columnExists: false, value: null },
        audit: await auditWindow(agent.id, c3Since),
      };

      // ── C4. Ending that break must not force Available.
      const c4Since = await nowIso();
      const c4Response = await endBreak(agent);
      const c4Observed = {
        response: c4Response,
        availabilityAfterBreakEnd: await readAvailability(agent.id),
        audit: await auditWindow(agent.id, c4Since),
      };

      // ── Edge case 1.11. Retry each action after it has committed.
      const retryClockOut = await clockOut(agent);
      const retryClockOutRepeat = await clockOut(agent);
      const retryClockIn = await clockIn(agent);
      const retryClockInRepeat = await clockIn(agent);
      await startBreak(agent);
      const retryBreakEnd = await endBreak(agent);
      const retryBreakEndRepeat = await endBreak(agent);
      const retryObserved = {
        clockIn: retryClockIn,
        clockInRepeat: retryClockInRepeat,
        clockOut: retryClockOut,
        clockOutRepeat: retryClockOutRepeat,
        breakEnd: retryBreakEnd,
        breakEndRepeat: retryBreakEndRepeat,
      };

      // ── C1. Clock in while Unavailable.
      await resetAttendance();
      await setAvailabilityDirectly(agent.id, 'unavailable');
      const c1AvailabilityBefore = await readAvailability(agent.id);
      const c1Response = await clockIn(agent);
      const c1Observed = { response: c1Response, availabilityBefore: c1AvailabilityBefore };

      // ── C6. A non-agent starts a break. `is_agent()` is agent-only, so
      //        `set_my_availability` raises inside Postgres every single time.
      const cs = user('cs');
      await clockIn(cs);
      const c6AvailabilityBefore = await readAvailability(cs.id);
      const c6Response = await startBreak(cs);
      const c6Rpc = await cs.session.rpc('set_my_availability', { p_status: 'break' });
      const c6Observed = {
        response: c6Response,
        availabilityBefore: c6AvailabilityBefore,
        availabilityAfter: await readAvailability(cs.id),
        rpcError: c6Rpc.error?.message ?? null,
      };

      // ── C8, sixth writer. Delete an Available agent through the real handler.
      const victim = user('victim');
      const manager = user('manager');
      await setAvailabilityDirectly(victim.id, 'available');
      const deletionSince = await nowIso();
      const deletionAvailabilityBefore = await readAvailability(victim.id);
      const deletionResponse = await deleteAccount(manager, victim.id);
      const rotationsAfterDeletion = await runSql<{ kind: string }>(`
        select kind::text as kind from public.rotation_state
        where updated_by = '${manager.id}' or current_profile_id = '${victim.id}'
      `);
      const c8DeletionObserved = {
        response: deletionResponse,
        availabilityBefore: deletionAvailabilityBefore,
        availabilityAfter: await readAvailability(victim.id),
        audit: await auditWindow(victim.id, deletionSince),
        rotationsMoved: rotationsAfterDeletion.map((row) => row.kind),
      };

      // ── C8, fifth writer. The daily reset, rolled back so nothing commits.
      const resetProbe = (
        await runSql<{ probe: DailyResetProbe }>(DAILY_RESET_PROBE_SQL)
      )[0].probe;

      seen = {
        c2: c2Observed,
        c3: c3Observed,
        c4: c4Observed,
        myStatus: myStatusObserved,
        c6: c6Observed,
        c7: c7Observed,
        c8Deletion: c8DeletionObserved,
        c8Reset: resetProbe,
        c1: c1Observed,
        retry: retryObserved,
      };
    } catch (error) {
      setupError = error;
      throw error;
    }
  }, 600_000);

  afterAll(async () => {
    if (!HAS_CREDENTIALS) return;
    cleanupNotes = await cleanUp();
    if (cleanupNotes.length) {
      console.log(`queue-status probe cleanup:\n  ${cleanupNotes.join('\n  ')}`);
    }
    if (setupError) console.log(`queue-status probe setup failed: ${String(setupError)}`);
  }, 300_000);

  // ── C2 ───────────────────────────────────────────────────────────────────
  describe('C2: clock-out with no open break', () => {
    it('removes the agent from the sales queues', () => {
      // 2.2. Today `set_my_availability('unavailable')` sits inside
      // `if (onBreak)`, so a break-less clock-out writes nothing at all.
      expect(seen.c2.availabilityBefore).toBe('available');
      expect(seen.c2.availabilityAfter).toBe('unavailable');
    });

    it('hands off the WhatsApp turn the agent was holding', () => {
      // 2.2, 3.6. The agent has left for the day; live WhatsApp work must not
      // keep routing to them.
      expect(seen.c2.whatsappBefore.current_profile_id).toBe(user('holder').id);
      expect(seen.c2.whatsappAfter.current_profile_id).not.toBe(user('holder').id);
    });

    it('reports the queue status back to the caller', () => {
      // 2.7, 2.18. The response is the only thing the client sees.
      expect(seen.c2.response.status).toBe(200);
      expect(seen.c2.response.body.queue_status).toBe('unavailable');
    });
  });

  // ── C4 ───────────────────────────────────────────────────────────────────
  describe('C4: ending a break that started from Unavailable', () => {
    it('restores the stored pre-break status instead of forcing Available', () => {
      // 2.5. `set_my_availability('available')` is called unconditionally on
      // break end, which launders a deliberate Unavailable into queue-eligible.
      expect(seen.c4.availabilityAfterBreakEnd).toBe('unavailable');
    });

    it('does not hand the agent a turn they never asked for', () => {
      // 1.4, 3.6. The available branch of `set_my_availability` can start or
      // repair a rotation onto this agent.
      expect(seen.c4.audit.turnEvents).toBe(0);
    });
  });

  // ── C3 ───────────────────────────────────────────────────────────────────
  describe('C3: starting a break while Unavailable', () => {
    it('leaves an ineligible agent ineligible', () => {
      // 2.4. Break must never be written over Unavailable.
      expect(seen.c3.availabilityBeforeBreak).toBe('unavailable');
      expect(seen.c3.availabilityAfterBreakStart).toBe('unavailable');
    });

    it('records the pre-break queue status somewhere recoverable', () => {
      // 2.3. There is nowhere to put it today: `time_clock_breaks` has no
      // column for it, so break end has nothing to restore.
      expect(seen.c3.preBreak.columnExists).toBe(true);
      expect(seen.c3.preBreak.value).toBe('unavailable');
    });
  });

  // ── C6 ───────────────────────────────────────────────────────────────────
  describe('C6: a non-agent starts a break', () => {
    it('confirms Postgres refuses the availability write for a non-agent', () => {
      // Recorded, not asserted as a defect: `is_agent()` is `role = 'agent'`
      // only, so this raise is guaranteed for every non-agent, every break.
      expect(seen.c6.rpcError).toContain('Agent permission required');
    });

    it('does not report an unqualified success', () => {
      // 2.7, 2.8. The route discards the `{ error }` and answers 201. After the
      // fix no queue call is made for a non-agent, and the response says so.
      expect(seen.c6.response.body.changed_queue).toBe(false);
      expect(seen.c6.response.body.queue_status).toBeDefined();
    });

    it('leaves the queue status untouched', () => {
      expect(seen.c6.availabilityAfter).toBe(seen.c6.availabilityBefore);
    });
  });

  // ── C7 ───────────────────────────────────────────────────────────────────
  describe('C7: two concurrent clock-outs for one open entry', () => {
    it('answers the losing request with the committed state', () => {
      // 2.10, 1.11. Today one caller gets HTTP 400 "Not clocked in." for an
      // action that did in fact happen.
      for (const response of seen.c7.responses) {
        expect(response.status).toBe(200);
        expect(response.body.error).toBeUndefined();
      }
    });

    it('applies exactly one availability transition and one handoff', () => {
      // 2.10. One logical action, one transition, one event, one turn move.
      expect(seen.c7.availabilityAfter).toBe('unavailable');
      expect(seen.c7.audit.attributable).toBe(1);
      expect(seen.c7.whatsappTurnEvents).toBeLessThanOrEqual(1);
    });
  });

  // ── C8 ───────────────────────────────────────────────────────────────────
  describe('C8: every availability change is attributable', () => {
    it('attributes an explicit My Status change', () => {
      // 2.12, source `manual_agent`.
      expect(seen.myStatus.availabilityAfter).toBe('unavailable');
      expect(seen.myStatus.audit.attributable).toBe(1);
      expect(seen.myStatus.audit.availabilityEventSources).toContain('manual_agent');
    });

    it('attributes a break start', () => {
      // 2.12, source `attendance_break_start`.
      expect(seen.c3.audit.attributable).toBe(1);
    });

    it('attributes a break end', () => {
      // 2.12, source `attendance_break_end`.
      expect(seen.c4.audit.attributable).toBe(1);
    });

    it('attributes a clock-out', () => {
      // 2.12, source `attendance_clock_out`.
      expect(seen.c2.audit.attributable).toBe(1);
    });

    it('attributes the daily reset, once per genuinely changed profile', () => {
      // 2.12, source `daily_reset`. The reset rewrites every active agent and
      // records nothing anywhere, so no table names the cause.
      expect(seen.c8Reset.fired).toBe(true);
      expect(seen.c8Reset.changed_profiles).toBeGreaterThan(0);
      expect(seen.c8Reset.availability_events_added).toBe(seen.c8Reset.changed_profiles);
    });

    it('attributes a user deletion as an availability change, not only as a deletion', () => {
      // 2.20. `admin_deactivate_profile` is the third writer of the field. Its
      // only trace is one `audit_log` row whose action is `user_deleted`, which
      // is not a member of the eight-source vocabulary, so the 2.19 diagnostic
      // would flag every deleted user forever.
      expect(seen.c8Deletion.response.status).toBe(200);
      expect(seen.c8Deletion.availabilityBefore).toBe('available');
      expect(seen.c8Deletion.availabilityAfter).toBe('unavailable');
      expect(
        seen.c8Deletion.audit.auditRows.some((row) => row.action === 'user_deleted'),
      ).toBe(true);
      expect(seen.c8Deletion.audit.attributable).toBe(1);
      expect(seen.c8Deletion.audit.availabilityEventSources).toContain('user_deactivated');
    });

    it('has a table that can carry an availability transition at all', () => {
      // 2.13. Recorded as its own assertion because it is the root of the
      // whole of C8: no existing table has the columns.
      expect(availabilityEventsExist).toBe(true);
    });
  });

  // ── C1 ───────────────────────────────────────────────────────────────────
  describe('C1: clocking in while not queue-Available', () => {
    it('says so, and offers the explicit way in', () => {
      // 2.1, 2.15. Clock-in correctly does not change the queue status; the
      // defect is that it says nothing about it.
      expect(seen.c1.availabilityBefore).toBe('unavailable');
      expect(seen.c1.response.body.queue_status).toBe('unavailable');
      expect(seen.c1.response.body.offers_join_sales_queues).toBe(true);
    });
  });

  // ── Edge case 1.11 ───────────────────────────────────────────────────────
  describe('Edge case 1.11: retry semantics are the same for every action', () => {
    it('answers a repeated clock-in with the committed state', () => {
      // The one action that already behaves. Kept as the reference point.
      expect(seen.retry.clockInRepeat.status).toBe(200);
      expect(seen.retry.clockInRepeat.body.already_open).toBe(true);
    });

    it('answers a repeated clock-out with the committed state', () => {
      // 2.10. Today: HTTP 400 "Not clocked in.".
      expect(seen.retry.clockOut.status).toBe(200);
      expect(seen.retry.clockOutRepeat.status).toBe(200);
      expect(seen.retry.clockOutRepeat.body.already_applied).toBe(true);
    });

    it('answers a repeated break-end with the committed state', () => {
      // 2.10. Today: HTTP 400 "No active break to end.".
      expect(seen.retry.breakEnd.status).toBe(200);
      expect(seen.retry.breakEndRepeat.status).toBe(200);
      expect(seen.retry.breakEndRepeat.body.already_applied).toBe(true);
    });
  });
});
