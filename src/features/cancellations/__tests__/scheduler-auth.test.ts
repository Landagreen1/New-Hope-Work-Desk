//
// Feature: policy-follow-up-renewals-cancellations, task 18.1 — scheduler authorization.
//
// **Validates: Requirements 12.9, 12.10, 22.6, 25.7**
//
// Requirement 12.9 names exactly two authorized callers of the Notification_Scheduler: a request
// whose `Authorization` header token equals the configured cron secret **in full**, and a session
// request from a profile holding Manager_Role (`manager` or `super_admin`). Requirement 12.10
// answers every other request HTTP 403, sends zero messages, and creates zero Communication_Record
// rows. Requirement 22.6 adds that such a refusal leaves every stored value unchanged, and
// Requirement 25.7 makes this file's existence part of the Phase 2 verification gate.
//
// ---------------------------------------------------------------------------------------------
// WHY EVERY REFUSAL IS ASSERTED SIX WAYS AND NOT ONE
// ---------------------------------------------------------------------------------------------
// `expect(response.status).toBe(403)` is the weakest half of Requirement 12.10. The other half —
// zero messages and zero rows — needs something that *could* have sent and written. So every
// refusal below runs through one harness that hands `handleSchedulerRequest` all three seams the
// batch would use:
//
//   * `runner` — a stand-in batch that records its input, inserts two `cancellation_communications`
//     rows plus one `cancellation_communication_cases` row through the injected client, and calls
//     both injected providers. If authorization ever leaked, this is what would run, and the row
//     counters and the provider counters would move.
//   * `run.client` — an in-memory store that records **every** call it receives, `from` included,
//     so a refusal that nevertheless touched the database is caught even if it wrote nothing.
//   * `run.providers` — recorders for the SMS sender and the email sender.
//
// A refusal therefore asserts: status 403, the refusal message, zero runner invocations, zero
// `cancellation_communications` rows, zero link rows, zero SMS calls, zero email calls, zero
// database calls of any kind, and a full-store snapshot identical to the seed (Requirement 22.6).
//
// The same harness proves the assertions are not vacuous: each authorized case asserts the runner
// ran once, two communication rows exist, one link row exists, and both providers were called. Every
// counter a refusal expects at zero is a counter an authorization moves.
//
// One refusal is driven with no seams at all, with the service-role variables removed from the
// environment. `handleSchedulerRequest` answers 503 when it reaches the client-construction step
// with no credentials, so a 403 there is positive evidence that the refusal happened before a
// database client existed.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE ROLE SWEEP IS FOR
// ---------------------------------------------------------------------------------------------
// The session cases enumerate `APP_ROLES` from `@/lib/permissions` rather than a list written here,
// so a role added to the application cannot silently skip this check: the sweep asserts that a role
// is authorized exactly where `isBroadManagerRole` holds, which is `manager` and `super_admin` and
// nothing else. `manager` and `super_admin` also get their own cases, because those two assert the
// actor the batch receives (`{ kind: 'session', profileId, role }`) and not merely the status.
//
// No test in this file touches a live provider or a live database: the SMS and email seams are
// injected recorders, the Supabase client is the in-memory store, and `process.env.CRON_SECRET` is
// saved and restored around every test so the file cannot leak into another suite. Most cases pass
// the secret through the options seam instead, so they read no environment variable at all.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmailSendInput, EmailSendResult } from '@/lib/email';
import { APP_ROLES, isBroadManagerRole } from '@/lib/permissions';
import type { SmsSendResult } from '@/lib/ringcentral-sms';
import type { AppRole } from '@/lib/types';

import {
  bearerTokenMatches,
  configuredCronSecret,
  readSchedulerRole,
  CRON_SECRET_ENV,
  SERVICE_ROLE_KEY_ENV_ORDER,
  SUPABASE_URL_ENV,
  UNAUTHORIZED_MESSAGE,
  type SchedulerActor,
  type SchedulerSessionResolver,
} from '../scheduler/authorize';
import {
  handleSchedulerRequest,
  SCHEDULER_SKIP_REASONS,
  type SchedulerRequestOptions,
  type SchedulerRunInput,
  type SchedulerRunSummary,
  type SchedulerSkipCounts,
} from '../scheduler/run';
import type { SendProviders } from '../scheduler/send';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SCHEDULER_URL = 'https://example.test/api/cancellations/scheduler';

/** The configured cron secret. Long enough that a prefix and a suffix are distinct strings. */
const SECRET = 'cancellation-scheduler-secret-4f7c91';

const SESSION_PROFILE_ID = 'profile-under-test';
const CASE_ID = 'case-1';
const SMS_CONTACT_ID = 'contact-phone';
const EMAIL_CONTACT_ID = 'contact-email';
const PHONE = '+17045551234';
const EMAIL_ADDRESS = 'rosa@example.com';
const BUSINESS_DATE = '2026-07-16';
const FIXED_NOW = new Date('2026-07-16T14:00:00.000Z');

const COMMUNICATIONS_TABLE = 'cancellation_communications';
const LINKS_TABLE = 'cancellation_communication_cases';

type Row = Record<string, unknown>;

/**
 * The seed. Two tables with one row each, so "left every stored value unchanged" has something to
 * protect (Requirement 22.6) and `cancellation_communications` starts empty, which is what makes
 * "created zero Communication_Record rows" an emptiness assertion.
 */
const SEED: Readonly<Record<string, readonly Row[]>> = {
  cancellation_settings: [{ id: 'settings-1', automatic_sending_enabled: true }],
  cancellation_cases: [
    {
      id: CASE_ID,
      policy_number: 'POL-10001',
      cancellation_effective_date: '2026-07-31',
      case_status: 'Open',
      communication_status: 'Not Scheduled',
    },
  ],
};

// ---------------------------------------------------------------------------
// The recording store
// ---------------------------------------------------------------------------

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** Every call the client received, so a refusal that read one row is a failure like any other. */
interface DatabaseCall {
  /** The table, or the function name for an `rpc` call. */
  target: string;
  operation: 'from' | 'select' | 'insert' | 'update' | 'rpc';
}

interface FakeBuilder {
  select: (columns?: string) => FakeBuilder;
  in: (column?: string, values?: unknown) => FakeBuilder;
  is: (column?: string, value?: unknown) => FakeBuilder;
  eq: (column?: string, value?: unknown) => FakeBuilder;
  not: (column?: string, operator?: string, value?: unknown) => FakeBuilder;
  single: () => Promise<QueryResult>;
  maybeSingle: () => Promise<QueryResult>;
  then: <TResult>(
    onFulfilled: (value: QueryResult) => TResult,
    onRejected?: (reason: unknown) => TResult,
  ) => Promise<TResult>;
}

/**
 * A Supabase double that records every call and stores what it is asked to store.
 *
 * Filters are not evaluated — no test here depends on one — and nothing is rejected, so the only
 * reason a row is absent afterwards is that nothing tried to write it.
 */
function createRecordingStore(seed: Readonly<Record<string, readonly Row[]>>) {
  const tables = new Map<string, Row[]>();
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((row) => ({ ...row })));
  }

  const calls: DatabaseCall[] = [];
  let sequence = 0;

  /** Reads without creating, so inspecting an untouched table cannot alter the snapshot. */
  const peek = (table: string): Row[] => (tables.get(table) ?? []).map((row) => ({ ...row }));

  const rowsFor = (table: string): Row[] => {
    const existing = tables.get(table);
    if (existing !== undefined) return existing;
    const created: Row[] = [];
    tables.set(table, created);
    return created;
  };

  const thenable = (resolve: () => QueryResult): FakeBuilder => ({
    select: () => thenable(resolve),
    in: () => thenable(resolve),
    is: () => thenable(resolve),
    eq: () => thenable(resolve),
    not: () => thenable(resolve),
    single: async () => resolve(),
    maybeSingle: async () => resolve(),
    then: (onFulfilled, onRejected) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  });

  const client = {
    from(table: string) {
      calls.push({ target: table, operation: 'from' });
      return {
        select: (columns?: string) => {
          calls.push({ target: table, operation: 'select' });
          void columns;
          return thenable(() => ({ data: peek(table), error: null }));
        },
        insert: (payload: Row | readonly Row[]) => {
          calls.push({ target: table, operation: 'insert' });
          const incoming = Array.isArray(payload) ? payload : [payload as Row];
          const stored: Row[] = [];
          for (const row of incoming) {
            sequence += 1;
            const withId: Row = { id: `${table}-${sequence}`, ...row };
            rowsFor(table).push(withId);
            stored.push(withId);
          }
          return thenable(() => ({ data: stored.length === 1 ? stored[0] : stored, error: null }));
        },
        update: (patch: Row) => {
          calls.push({ target: table, operation: 'update' });
          return thenable(() => {
            for (const row of rowsFor(table)) Object.assign(row, patch);
            return { data: null, error: null };
          });
        },
      };
    },

    async rpc(name: string, args: Row): Promise<QueryResult> {
      calls.push({ target: name, operation: 'rpc' });
      void args;
      return { data: null, error: null };
    },
  };

  /** Every table and every row, so "unchanged" is asserted over the whole store, not one table. */
  const snapshot = (): string =>
    JSON.stringify(
      [...tables.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );

  return {
    calls,
    snapshot,
    rows: peek,
    client: client as unknown as SupabaseClient,
  };
}

// ---------------------------------------------------------------------------
// The recording providers
// ---------------------------------------------------------------------------

const SMS_ACCEPTED: SmsSendResult = { success: true, messageId: 'stub-sms-1' };
const EMAIL_ACCEPTED: EmailSendResult = {
  success: true,
  messageId: 'stub-email-1',
  failureReason: null,
  retryable: false,
};

function createRecordingProviders() {
  const sms: { to: string; text: string }[] = [];
  const email: EmailSendInput[] = [];

  const providers: SendProviders = {
    sendSms: async (to, text) => {
      sms.push({ to, text });
      return SMS_ACCEPTED;
    },
    sendEmail: async (input) => {
      email.push(input);
      return EMAIL_ACCEPTED;
    },
    isEmailConfigured: () => true,
  };

  return { sms, email, providers };
}

// ---------------------------------------------------------------------------
// The stand-in batch
// ---------------------------------------------------------------------------

function stubSummary(businessDate: string): SchedulerRunSummary {
  const skippedByReason = {} as SchedulerSkipCounts;
  for (const reason of SCHEDULER_SKIP_REASONS) skippedByReason[reason] = 0;

  return {
    businessDate,
    automaticSendingEnabled: true,
    emailConfigured: true,
    casesEvaluated: 1,
    touchpointsEvaluated: 2,
    sent: 2,
    skipped: 0,
    failed: 0,
    skippedByReason,
    messagesAttempted: 2,
    combinedMessages: 0,
    blockedMessages: 0,
    communicationRowsWritten: 2,
    linkRowsWritten: 1,
    escalationsRaised: 0,
    notificationsWritten: 0,
    statusRecomputed: 1,
    caseIds: [CASE_ID],
    failures: [],
  };
}

/**
 * The batch seam, replaced by something that writes and sends.
 *
 * It writes through `input.client` and calls `input.providers` rather than closures of its own, so
 * the seam chain the route actually uses is what moves the counters. An authorization failure that
 * still reached the batch would leave two communication rows, one link row, and two provider calls
 * behind — which is exactly what every refusal below asserts is absent.
 */
function createStandInBatch() {
  const inputs: SchedulerRunInput[] = [];

  const run = async (input: SchedulerRunInput): Promise<SchedulerRunSummary> => {
    inputs.push(input);

    await input.client.from(COMMUNICATIONS_TABLE).insert([
      { case_id: CASE_ID, contact_id: SMS_CONTACT_ID, touchpoint: 15, channel: 'sms', delivery_result: 'Sent' },
      { case_id: CASE_ID, contact_id: EMAIL_CONTACT_ID, touchpoint: 15, channel: 'email', delivery_result: 'Sent' },
    ]);
    await input.client.from(LINKS_TABLE).insert({
      communication_id: `${COMMUNICATIONS_TABLE}-1`,
      case_id: CASE_ID,
    });

    await input.providers?.sendSms?.(PHONE, 'Your policy is scheduled for cancellation.');
    await input.providers?.sendEmail?.({
      to: EMAIL_ADDRESS,
      subject: 'Your policy is scheduled for cancellation',
      body: 'Please call the office.',
      senderDisplayName: 'Maria Gomez',
      replyTo: 'agency@example.test',
    });

    return stubSummary(input.businessDate ?? BUSINESS_DATE);
  };

  return { inputs, run };
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

interface AttemptOptions {
  /** The `Authorization` header value. Absent sends no header at all. */
  authorization?: string;
  /** Passed through the options seam. Absent reads `process.env.CRON_SECRET`. */
  cronSecret?: string | null;
  /** The session seam. Absent uses the real cookie-bound resolver. */
  resolveSession?: SchedulerSessionResolver;
}

interface Attempt {
  status: number;
  body: Record<string, unknown>;
  runnerInputs: SchedulerRunInput[];
  databaseCalls: DatabaseCall[];
  communicationRows: Row[];
  linkRows: Row[];
  smsCalls: { to: string; text: string }[];
  emailCalls: EmailSendInput[];
  storeBefore: string;
  storeAfter: string;
}

async function attemptScheduler(options: AttemptOptions = {}): Promise<Attempt> {
  const store = createRecordingStore(SEED);
  const providers = createRecordingProviders();
  const batch = createStandInBatch();
  const storeBefore = store.snapshot();

  const headers: Record<string, string> = {};
  if (options.authorization !== undefined) headers.authorization = options.authorization;

  const requestOptions: SchedulerRequestOptions = {};
  if (options.cronSecret !== undefined) requestOptions.cronSecret = options.cronSecret;
  if (options.resolveSession !== undefined) requestOptions.resolveSession = options.resolveSession;
  requestOptions.run = {
    client: store.client,
    providers: providers.providers,
    businessDate: BUSINESS_DATE,
    now: () => FIXED_NOW,
  };
  requestOptions.runner = batch.run;

  const response = await handleSchedulerRequest(
    new Request(SCHEDULER_URL, { method: 'POST', headers }),
    requestOptions,
  );
  const body = (await response.json()) as Record<string, unknown>;

  return {
    status: response.status,
    body,
    runnerInputs: batch.inputs,
    databaseCalls: store.calls,
    communicationRows: store.rows(COMMUNICATIONS_TABLE),
    linkRows: store.rows(LINKS_TABLE),
    smsCalls: providers.sms,
    emailCalls: providers.email,
    storeBefore,
    storeAfter: store.snapshot(),
  };
}

/** Requirement 12.10 in full, plus Requirement 22.6's unchanged store. */
function expectRefused(attempt: Attempt): void {
  expect(attempt.status, 'an unauthorized request must be answered 403').toBe(403);
  expect(attempt.body).toEqual({ error: UNAUTHORIZED_MESSAGE });
  expect(attempt.runnerInputs, 'the batch was reached by an unauthorized request').toEqual([]);
  expect(attempt.communicationRows, 'a Communication_Record row was created').toEqual([]);
  expect(attempt.linkRows, 'a communication link row was created').toEqual([]);
  expect(attempt.smsCalls, 'an SMS provider call was made').toEqual([]);
  expect(attempt.emailCalls, 'an email provider call was made').toEqual([]);
  expect(attempt.databaseCalls, 'the database was contacted at all').toEqual([]);
  expect(attempt.storeAfter, 'a stored value changed').toBe(attempt.storeBefore);
}

/** Requirement 12.9, and the proof that every counter above can move. */
function expectAuthorized(attempt: Attempt, actor: SchedulerActor): void {
  expect(attempt.status, 'an authorized request must reach the batch').toBe(200);
  expect(attempt.body.success).toBe(true);
  expect(attempt.runnerInputs).toHaveLength(1);
  expect(attempt.runnerInputs[0].actor).toEqual(actor);
  expect(attempt.communicationRows).toHaveLength(2);
  expect(attempt.linkRows).toHaveLength(1);
  expect(attempt.smsCalls).toHaveLength(1);
  expect(attempt.emailCalls).toHaveLength(1);
}

function sessionResolver(role: AppRole | null, profileId = SESSION_PROFILE_ID) {
  const calls: number[] = [];
  const resolve: SchedulerSessionResolver = async () => {
    calls.push(1);
    return { profileId, role };
  };
  return { calls, resolve };
}

const absentSession: SchedulerSessionResolver = async () => null;

// ---------------------------------------------------------------------------
// The environment, saved and restored around every test
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  CRON_SECRET_ENV,
  SUPABASE_URL_ENV,
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  ...SERVICE_ROLE_KEY_ENV_ORDER,
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env[CRON_SECRET_ENV] = SECRET;
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// The full-string bearer rule (Requirement 12.9)
// ---------------------------------------------------------------------------

describe('the bearer token comparison', () => {
  it('accepts only the entire `Bearer ${secret}` header value', () => {
    expect(bearerTokenMatches(`Bearer ${SECRET}`, SECRET)).toBe(true);

    // A prefix and a suffix of the secret are the two matches a `startsWith` or a `split(' ')[1]`
    // comparison would let through, and either one hands the scheduler to a guesser.
    expect(bearerTokenMatches(`Bearer ${SECRET.slice(0, -1)}`, SECRET)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${SECRET.slice(1)}`, SECRET)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${SECRET}0`, SECRET)).toBe(false);
    expect(bearerTokenMatches(`Bearer ${SECRET} `, SECRET)).toBe(false);
    expect(bearerTokenMatches(`Bearer  ${SECRET}`, SECRET)).toBe(false);
    expect(bearerTokenMatches(`bearer ${SECRET}`, SECRET)).toBe(false);
    expect(bearerTokenMatches(SECRET, SECRET)).toBe(false);
    expect(bearerTokenMatches('Bearer wrong-secret', SECRET)).toBe(false);
    expect(bearerTokenMatches('', SECRET)).toBe(false);
    expect(bearerTokenMatches(null, SECRET)).toBe(false);
    expect(bearerTokenMatches(undefined, SECRET)).toBe(false);
  });

  it('authorizes nobody when the configured secret is absent or empty', () => {
    for (const secret of [null, undefined, ''] as const) {
      // `Bearer ` is the first request an attacker sends against a deployment that forgot to set
      // the variable, so it has to be refused rather than compared against an empty secret.
      expect(bearerTokenMatches('Bearer ', secret)).toBe(false);
      expect(bearerTokenMatches('Bearer undefined', secret)).toBe(false);
      expect(bearerTokenMatches('Bearer null', secret)).toBe(false);
      expect(bearerTokenMatches('', secret)).toBe(false);
      expect(bearerTokenMatches(`Bearer ${SECRET}`, secret)).toBe(false);
    }
  });

  it('reads the configured secret from the environment, treating a blank value as absent', () => {
    process.env[CRON_SECRET_ENV] = SECRET;
    expect(configuredCronSecret()).toBe(SECRET);

    process.env[CRON_SECRET_ENV] = '';
    expect(configuredCronSecret()).toBeNull();

    delete process.env[CRON_SECRET_ENV];
    expect(configuredCronSecret()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The refused requests (Requirements 12.10, 22.6, 25.7)
// ---------------------------------------------------------------------------

describe('a request presenting no valid cron secret', () => {
  it('is refused when it carries no Authorization header', async () => {
    expectRefused(await attemptScheduler({ cronSecret: SECRET, resolveSession: absentSession }));
  });

  it('is refused when it carries a wrong bearer token', async () => {
    expectRefused(
      await attemptScheduler({
        authorization: 'Bearer not-the-configured-secret',
        cronSecret: SECRET,
        resolveSession: absentSession,
      }),
    );
  });

  it('is refused when the token is a prefix of the configured secret', async () => {
    expectRefused(
      await attemptScheduler({
        authorization: `Bearer ${SECRET.slice(0, -1)}`,
        cronSecret: SECRET,
        resolveSession: absentSession,
      }),
    );
  });

  it('is refused when the token is a suffix of the configured secret', async () => {
    expectRefused(
      await attemptScheduler({
        authorization: `Bearer ${SECRET.slice(1)}`,
        cronSecret: SECRET,
        resolveSession: absentSession,
      }),
    );
  });

  // The near misses that a lenient comparison would accept. Each is a different whole string from
  // `Bearer ${SECRET}`, which is the only string Requirement 12.9 authorizes.
  //
  // Leading and trailing whitespace is deliberately not in this list, and the omission is a fact
  // about the transport rather than a gap: `Headers` normalizes a header value by stripping
  // surrounding whitespace, so `Authorization: Bearer ${SECRET} ` arrives at the route as
  // `Bearer ${SECRET}` — it *is* the exact token by the time anything can compare it, and the
  // request is authorized. `bearerTokenMatches` still refuses the untrimmed string, which is what
  // the comparison test above asserts, so the rule is enforced wherever a caller can present it.
  const NEAR_MISSES: { label: string; header: string }[] = [
    { label: 'a doubled space after the scheme', header: `Bearer  ${SECRET}` },
    { label: 'a space before the scheme and none after the secret', header: ` Bearer${SECRET}` },
    { label: 'the secret with one character appended', header: `Bearer ${SECRET}0` },
    { label: 'the raw secret with no scheme', header: SECRET },
    { label: 'a lowercase scheme', header: `bearer ${SECRET}` },
  ];

  it.each(NEAR_MISSES)('is refused when it carries $label', async ({ header }) => {
    expectRefused(
      await attemptScheduler({
        authorization: header,
        cronSecret: SECRET,
        resolveSession: absentSession,
      }),
    );
  });

  it('is refused when no cron secret is configured, including the empty token', async () => {
    delete process.env[CRON_SECRET_ENV];

    for (const authorization of ['Bearer ', 'Bearer undefined', `Bearer ${SECRET}`]) {
      expectRefused(
        await attemptScheduler({ authorization, cronSecret: null, resolveSession: absentSession }),
      );
    }
  });

  it('is refused before a database client exists', async () => {
    // No seams and no service-role credentials. `handleSchedulerRequest` answers 503 the moment it
    // tries to build a client without them, so a 403 here is evidence that authorization ended the
    // request first — the structural half of "zero messages and zero rows" (Requirement 12.10).
    delete process.env[SUPABASE_URL_ENV];
    for (const key of SERVICE_ROLE_KEY_ENV_ORDER) delete process.env[key];

    // No client, no providers, and no batch seam: if authorization did not end the request, the
    // next step is `createSchedulerServiceClient()`, which has nothing to build a client from.
    const response = await handleSchedulerRequest(new Request(SCHEDULER_URL, { method: 'POST' }), {
      cronSecret: SECRET,
      resolveSession: absentSession,
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: UNAUTHORIZED_MESSAGE });
  });
});

// ---------------------------------------------------------------------------
// The session path (Requirements 12.9, 12.10, 22.6)
// ---------------------------------------------------------------------------

describe('a session request', () => {
  // Enumerated from the application's own role list, so a new role cannot skip this check.
  it.each([...APP_ROLES])('is authorized only where Manager_Role holds: %s', async (role) => {
    const session = sessionResolver(role);
    const attempt = await attemptScheduler({ cronSecret: SECRET, resolveSession: session.resolve });

    expect(session.calls).toHaveLength(1);

    if (isBroadManagerRole(role)) {
      expectAuthorized(attempt, { kind: 'session', profileId: SESSION_PROFILE_ID, role });
    } else {
      expectRefused(attempt);
    }
  });

  it('is refused when there is no session', async () => {
    expectRefused(await attemptScheduler({ cronSecret: SECRET, resolveSession: absentSession }));
  });

  it('is refused when the stored role is not a role the application defines', async () => {
    // `readSchedulerRole` is what reduces an unreadable `profiles.role` to `null`, and a null role
    // is refused rather than treated as an unknown that might be a manager.
    expect(readSchedulerRole('district_manager')).toBeNull();
    expect(readSchedulerRole(null)).toBeNull();
    expect(readSchedulerRole(42)).toBeNull();

    expectRefused(
      await attemptScheduler({ cronSecret: SECRET, resolveSession: sessionResolver(null).resolve }),
    );
  });

  it('authorizes a manager session and hands the batch that actor', async () => {
    const attempt = await attemptScheduler({
      cronSecret: SECRET,
      resolveSession: sessionResolver('manager', 'profile-manager').resolve,
    });

    expectAuthorized(attempt, { kind: 'session', profileId: 'profile-manager', role: 'manager' });
  });

  it('authorizes a super_admin session wherever it authorizes a manager', async () => {
    const attempt = await attemptScheduler({
      cronSecret: SECRET,
      resolveSession: sessionResolver('super_admin', 'profile-super-admin').resolve,
    });

    expectAuthorized(attempt, {
      kind: 'session',
      profileId: 'profile-super-admin',
      role: 'super_admin',
    });
    expect(isBroadManagerRole('super_admin')).toBe(isBroadManagerRole('manager'));
  });

  it('is refused when the default resolver finds no configured Supabase', async () => {
    // Requirement 12.10 answers a request that presents neither authorized credential with 403, so
    // an unconfigured Supabase is a refusal here and not the 503 the renewals scheduler returns.
    delete process.env[SUPABASE_URL_ENV];
    delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

    expectRefused(await attemptScheduler({ authorization: 'Bearer wrong', cronSecret: SECRET }));
  });

  it('is refused when the default resolver runs outside a request scope', async () => {
    // The session read is reached through a dynamic import and every failure inside it — including
    // `cookies()` called with no request in flight — resolves to "no session", which is 403. The
    // fetch guard makes sure no live call can happen on the way to that answer.
    process.env[SUPABASE_URL_ENV] = 'https://project.supabase.test';
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'publishable-test-key';

    const realFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      attempts.push(url);
      throw new Error(`GUARD: a network request to ${url} was attempted during the test run.`);
    }) as typeof globalThis.fetch;

    try {
      expectRefused(await attemptScheduler({ authorization: 'Bearer wrong', cronSecret: SECRET }));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// The cron path (Requirement 12.9)
// ---------------------------------------------------------------------------

describe('a request carrying the exact bearer token', () => {
  it('is authorized and reaches the batch', async () => {
    const attempt = await attemptScheduler({
      authorization: `Bearer ${SECRET}`,
      cronSecret: SECRET,
      resolveSession: absentSession,
    });

    expectAuthorized(attempt, { kind: 'cron', profileId: null, role: null });
    expect(attempt.body.summary).toMatchObject({ businessDate: BUSINESS_DATE, sent: 2 });
  });

  it('reads no session, because the secret short-circuits the database', async () => {
    // A resolver that would have authorized the request anyway, so the assertion is about ordering
    // rather than outcome: a valid cron request performs no session read at all.
    const session = sessionResolver('manager');

    const attempt = await attemptScheduler({
      authorization: `Bearer ${SECRET}`,
      cronSecret: SECRET,
      resolveSession: session.resolve,
    });

    expect(session.calls).toEqual([]);
    expectAuthorized(attempt, { kind: 'cron', profileId: null, role: null });
  });

  it('honors the secret configured in the environment when none is passed', async () => {
    process.env[CRON_SECRET_ENV] = SECRET;

    const authorized = await attemptScheduler({
      authorization: `Bearer ${SECRET}`,
      resolveSession: absentSession,
    });
    expectAuthorized(authorized, { kind: 'cron', profileId: null, role: null });

    const refused = await attemptScheduler({
      authorization: `Bearer ${SECRET.slice(0, -1)}`,
      resolveSession: absentSession,
    });
    expectRefused(refused);
  });
});
