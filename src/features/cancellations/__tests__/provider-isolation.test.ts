//
// Feature: policy-follow-up-renewals-cancellations, task 14.5 — provider isolation.
//
// **Validates: Requirements 23.1, 23.5, 25.3**
//
// Two halves, because provider isolation is two claims and one of them cannot be observed at
// runtime.
//
// ---------------------------------------------------------------------------------------------
// 1. THE RUNTIME HALF — zero live provider calls (Requirements 23.5, 25.3)
// ---------------------------------------------------------------------------------------------
// `src/lib/ringcentral-sms.ts` and `src/lib/email.ts` are the only two modules allowed to reach a
// provider. Both are replaced here by guards that record the call and refuse it, so:
//
//   * a send path that uses its injected mock leaves both guard counters at zero, which is what
//     "zero calls reach either live provider" means for that path;
//   * a send path that regressed to the real provider entry point is recorded by name and fails the
//     test, and is stopped before the RingCentral SDK or the email provider endpoint is reached.
//
// On top of the guards, `globalThis.fetch` is replaced by a spy that records the URL and throws.
// Two reasons it is worth having as well as the module guards: it catches a provider call made by
// any module the guards do not cover, and it proves the refusal is not merely reported — no request
// leaves the process. Both globals are restored in `afterEach`, so this file cannot leak into
// another suite.
//
// The three email environment variables are unset for the duration of this file and restored after,
// which is how the suite proves it needs no `RESEND_API_KEY`: every email path here runs on an
// injected `isEmailConfigured: () => true` seam instead (Requirement 23.3's seam, used in reverse).
//
// Paths driven:
//   * `deliverMessage` — the provider conversation itself, SMS and email, including the retry policy
//   * `sendCommunication` — reserve, send, record, both channels
//   * `runScheduler` — the whole Notification_Scheduler batch, over an in-memory store
//   * `resolveEmailConfigured` — the credential seam, asserted to read no environment variable
//
// `POST /api/cancellations/send` (task 15.1) does not exist in the repository yet. Rather than
// name a file that is still being written, the static half asserts the structural property that
// makes any route safe: no route under `src/app/api/cancellations/` imports either provider module
// directly. That assertion covers the manual send route automatically the moment it lands.
//
// ---------------------------------------------------------------------------------------------
// 2. THE STATIC HALF — one module owns each provider (Requirement 23.1)
// ---------------------------------------------------------------------------------------------
// Requirement 23.1 confines every email provider credential and provider-specific request detail to
// one module, which is a property of the source tree, not of a run: no test can observe a provider
// call that a second module would make only in production. So this half reads the source.
//
// Every TypeScript and JavaScript module under `src/`, `scripts/`, and the repository root is
// scanned for the provider endpoint host and the credential variable names. Comments are excluded
// from the scan and string literals are not: prose naming `RESEND_API_KEY` to explain a seam is not
// a provider call, while `fetch('https://api.resend.com/emails')` is exactly the thing being
// prohibited and lives in a string. `.env.example` is excluded because Requirement 23.6 requires the
// variable to be documented there, and `.kiro/` is excluded because a specification that names the
// variable is what put it in the design.
//
// A violation is reported with its file, line, and the matched text, so the fix is obvious.

import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { isEmailConfigured, type EmailSendInput, type EmailSendResult } from '@/lib/email';
import type { SmsSendResult } from '@/lib/ringcentral-sms';

import {
  TOKEN_NAMES,
  TOUCHPOINTS,
  tokenPlaceholder,
  type ProhibitedPhraseRow,
  type RenderRendered,
  type TemplateVersionRow,
  type Touchpoint,
} from '../render/renderMessage';
import {
  deliverMessage,
  sendCommunication,
  type SendTarget,
} from '../scheduler/send';
import {
  resolveEmailConfigured,
  runScheduler,
  type SchedulerCaseRow,
  type SchedulerContactRow,
  type SchedulerProfileRow,
  type SchedulerSettingsRow,
} from '../scheduler/run';

// ---------------------------------------------------------------------------
// The provider guards
// ---------------------------------------------------------------------------

/**
 * Call records for the two real provider entry points. Hoisted so the `vi.mock` factories below,
 * which run before the module body, can write to them.
 */
const guard = vi.hoisted(() => ({
  /** Calls that reached the real `sendSms` export. Every assertion here expects zero. */
  sms: [] as { to: string; text: string }[],
  /** Calls that reached the real `sendEmail` export. Every assertion here expects zero. */
  email: [] as EmailSendInput[],
  /** Set from the actual modules, so a renamed export is a failure rather than a silent pass. */
  realExports: { sendSms: false, sendEmail: false, isEmailConfigured: false },
}));

vi.mock('@/lib/ringcentral-sms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ringcentral-sms')>();
  guard.realExports.sendSms = typeof actual.sendSms === 'function';
  return {
    ...actual,
    // Records and refuses. Refusing rather than delegating is deliberate: a regression is reported
    // by this file instead of dialing RingCentral from a test run.
    sendSms: async (to: string, text: string): Promise<SmsSendResult> => {
      guard.sms.push({ to, text });
      return { success: false, error: 'GUARD: the live RingCentral sendSms entry point was reached.' };
    },
  };
});

vi.mock('@/lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email')>();
  guard.realExports.sendEmail = typeof actual.sendEmail === 'function';
  guard.realExports.isEmailConfigured = typeof actual.isEmailConfigured === 'function';
  return {
    ...actual,
    // `isEmailConfigured` is left as the real credential check, so the environment assertions below
    // exercise the shipped function rather than a stand-in.
    sendEmail: async (input: EmailSendInput): Promise<EmailSendResult> => {
      guard.email.push(input);
      return {
        success: false,
        messageId: null,
        failureReason: 'GUARD: the live email sendEmail entry point was reached.',
        retryable: false,
      };
    },
  };
});

// ---------------------------------------------------------------------------
// The fetch guard and the environment
// ---------------------------------------------------------------------------

interface FetchAttempt {
  url: string;
  method: string;
}

let fetchAttempts: FetchAttempt[] = [];
let realFetch: typeof globalThis.fetch;

const EMAIL_ENV_KEYS = [
  'RESEND_API_KEY',
  'CANCELLATION_EMAIL_FROM',
  'CANCELLATION_EMAIL_REPLY_TO',
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeAll(() => {
  // No test in this file may depend on an email credential (Requirement 23.3's seam is what the
  // email paths use instead), so the three variables are unset for the file and restored after.
  for (const key of EMAIL_ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of EMAIL_ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

beforeEach(() => {
  guard.sms.length = 0;
  guard.email.length = 0;
  fetchAttempts = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET');
    fetchAttempts.push({ url, method });
    throw new Error(`GUARD: a network request to ${url} was attempted during the test run.`);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every live-provider counter, asserted together so a failure names which one moved. */
function expectZeroLiveProviderCalls(): void {
  expect(guard.sms, 'the real sendSms was reached').toEqual([]);
  expect(guard.email, 'the real sendEmail was reached').toEqual([]);
  expect(fetchAttempts, 'a network request was attempted').toEqual([]);
}

// ---------------------------------------------------------------------------
// Provider mocks
// ---------------------------------------------------------------------------

function smsMock(results: readonly SmsSendResult[]) {
  const calls: { to: string; text: string }[] = [];
  let index = 0;
  return {
    calls,
    send: async (to: string, text: string): Promise<SmsSendResult> => {
      calls.push({ to, text });
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result;
    },
  };
}

function emailMock(results: readonly EmailSendResult[]) {
  const calls: EmailSendInput[] = [];
  let index = 0;
  return {
    calls,
    send: async (input: EmailSendInput): Promise<EmailSendResult> => {
      calls.push(input);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result;
    },
  };
}

const SMS_ACCEPTED: SmsSendResult = { success: true, messageId: 'mock-sms-1' };
const EMAIL_ACCEPTED: EmailSendResult = {
  success: true,
  messageId: 'mock-email-1',
  failureReason: null,
  retryable: false,
};
const EMAIL_RETRYABLE: EmailSendResult = {
  success: false,
  messageId: null,
  failureReason: 'mock 503',
  retryable: true,
};

/** Backoff seam, so a three-attempt email case runs in milliseconds. */
function sleepMock() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number): Promise<void> => void delays.push(ms) };
}

// ---------------------------------------------------------------------------
// The in-memory store
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface QueryResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

/** The chainable, awaitable shape of the query builder the scheduler uses. */
interface FakeBuilder {
  select: (columns?: string) => FakeBuilder;
  in: (column?: string, values?: unknown) => FakeBuilder;
  is: (column?: string, value?: unknown) => FakeBuilder;
  eq: (column?: string, value?: unknown) => FakeBuilder;
  not: (column?: string, operator?: string, value?: unknown) => FakeBuilder;
  order: (column?: string) => FakeBuilder;
  single: () => Promise<QueryResult>;
  maybeSingle: () => Promise<QueryResult>;
  then: <TResult>(
    onFulfilled: (value: QueryResult) => TResult,
    onRejected?: (reason: unknown) => TResult,
  ) => Promise<TResult>;
}

/**
 * A Supabase double covering the calls the scheduler makes: `from(table).select(...)` with the
 * filter methods, `insert`, `update`, and `rpc`. Filters are not evaluated — every fixture row in
 * this file is one the real filters would return — and the `unique (case_id, contact_id, touchpoint,
 * channel)` constraint of `cancellation_communications` is enforced, because the reserve step reads
 * its `23505` as the Idempotency_Key already being taken.
 */
function createStore(seed: Readonly<Record<string, readonly unknown[]>> = {}) {
  const tables = new Map<string, Row[]>();
  for (const [name, rows] of Object.entries(seed)) {
    tables.set(name, rows.map((row) => ({ ...(row as Row) })));
  }

  const rpcCalls: { name: string; args: Row }[] = [];
  let sequence = 0;

  const rowsOf = (table: string): Row[] => {
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
    order: () => thenable(resolve),
    single: async () => resolve(),
    maybeSingle: async () => resolve(),
    then: (onFulfilled, onRejected) => Promise.resolve(resolve()).then(onFulfilled, onRejected),
  });

  const insertRows = (table: string, payload: Row | readonly Row[]): QueryResult => {
    const incoming = Array.isArray(payload) ? payload : [payload as Row];
    const stored: Row[] = [];

    for (const row of incoming) {
      if (table === 'cancellation_communications') {
        const clash = rowsOf(table).some(
          (existing) =>
            existing.case_id === row.case_id &&
            existing.contact_id === row.contact_id &&
            existing.touchpoint === row.touchpoint &&
            existing.channel === row.channel,
        );
        if (clash) {
          return {
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
          };
        }
      }
      sequence += 1;
      const withId: Row = { id: `${table}-${sequence}`, ...row };
      rowsOf(table).push(withId);
      stored.push(withId);
    }

    return { data: stored.length === 1 ? stored[0] : stored, error: null };
  };

  const client = {
    from(table: string) {
      return {
        select: () => thenable(() => ({ data: rowsOf(table).map((row) => ({ ...row })), error: null })),
        insert: (payload: Row | readonly Row[]) => {
          const outcome = insertRows(table, payload);
          return thenable(() => outcome);
        },
        update: (patch: Row) =>
          thenable(() => {
            for (const row of rowsOf(table)) Object.assign(row, patch);
            return { data: null, error: null };
          }),
      };
    },

    async rpc(name: string, args: Row): Promise<QueryResult> {
      rpcCalls.push({ name, args });

      if (name === 'cancellation_retry_communication') {
        const row = rowsOf('cancellation_communications').find(
          (stored) => stored.id === args.p_communication_id,
        );
        if (row === undefined) {
          return { data: null, error: { code: 'P0002', message: 'no such Communication_Record' } };
        }
        // Only the five columns the live function is allowed to touch.
        row.send_time = args.p_send_time ?? row.send_time;
        row.provider_message_id = args.p_provider_message_id ?? null;
        row.delivery_result = args.p_delivery_result;
        row.failure_reason = args.p_failure_reason ?? null;
        row.attempt_count = args.p_attempt_count ?? row.attempt_count;
        return { data: row, error: null };
      }

      return { data: null, error: null };
    },
  };

  return {
    rpcCalls,
    client: client as unknown as SupabaseClient,
    rows: (table: string): Row[] => rowsOf(table),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS_DATE = '2026-07-16';
/** 15 days after the business date, so the 15-day Touchpoint is the one due. */
const EFFECTIVE_DATE = '2026-07-31';
const PHONE = '+17045551234';
const EMAIL_ADDRESS = 'rosa@example.com';
const FIXED_NOW = new Date('2026-07-16T14:00:00.000Z');

const SETTINGS_ROW: SchedulerSettingsRow = {
  automatic_sending_enabled: true,
  office_phone: '(704) 824-3130',
  agency_name: 'New Hope Insurance Agency',
  bilingual_separator: '\n---\n',
  holidays: [],
};

const PHRASE_ROWS: readonly ProhibitedPhraseRow[] = [
  { id: 'pp-1', phrase: 'your policy will be reinstated', language: 'English', is_active: true },
];

/** The template body shape task 7.10 seeds: one optional value per line, tokens delimited. */
function templateBody(touchpoint: Touchpoint): string {
  return [
    `Hello ${tokenPlaceholder(TOKEN_NAMES.customerName)},`,
    '',
    tokenPlaceholder(TOKEN_NAMES.cancellationStatement),
    '',
    `Reminder tier ${touchpoint}.`,
    `Policy: ${tokenPlaceholder(TOKEN_NAMES.policyNumber)}`,
    `Cancellation effective date: ${tokenPlaceholder(TOKEN_NAMES.cancellationDate)}`,
    `Carrier: ${tokenPlaceholder(TOKEN_NAMES.carrier)}`,
    `Reason: ${tokenPlaceholder(TOKEN_NAMES.cancellationReason)}`,
    `Amount due: ${tokenPlaceholder(TOKEN_NAMES.amountDue)}`,
    `Your agent: ${tokenPlaceholder(TOKEN_NAMES.producerName)}`,
    '',
    tokenPlaceholder(TOKEN_NAMES.contactRequest),
    '',
    tokenPlaceholder(TOKEN_NAMES.senderName),
    `${tokenPlaceholder(TOKEN_NAMES.agencyName)} - ${tokenPlaceholder(TOKEN_NAMES.officePhone)}`,
  ].join('\n');
}

const TEMPLATE_ROWS: readonly { id: string; touchpoint: Touchpoint }[] = TOUCHPOINTS.map(
  (touchpoint) => ({ id: `tpl-${touchpoint}`, touchpoint }),
);

const TEMPLATE_VERSION_ROWS: readonly TemplateVersionRow[] = TOUCHPOINTS.map((touchpoint) => ({
  id: `tv-en-${touchpoint}`,
  template_id: `tpl-${touchpoint}`,
  version: 2,
  language: 'English',
  subject: `Cancellation notice - tier ${touchpoint}`,
  body: templateBody(touchpoint),
  cancellation_statement:
    'According to our records, this policy is scheduled for cancellation.',
  contact_request: `Please contact us on or before ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)} to review your options.`,
  fallback_text: {
    [TOKEN_NAMES.carrier]: 'your carrier',
    [TOKEN_NAMES.cancellationReason]: 'a change on the policy',
    [TOKEN_NAMES.producerName]: 'our team',
    [TOKEN_NAMES.amountDue]: '',
  },
}));

const CASE_ROW: SchedulerCaseRow = {
  id: 'case-1',
  policy_number: 'POL-10001',
  cancellation_effective_date: EFFECTIVE_DATE,
  customer_name: 'Rosa Martinez',
  customer_match_key: 'client-9001',
  carrier: 'Progressive',
  cancellation_reason: 'Non-payment',
  amount_due: '1234.50',
  case_status: 'Open',
  communication_status: 'Not Scheduled',
  next_required_action: null,
  assigned_to: 'profile-agent',
  producer_label: 'MG - Maria Gomez',
  follow_up_deadline: null,
  assistance_requested: false,
};

const CONTACT_ROWS: readonly SchedulerContactRow[] = [
  {
    id: 'contact-phone',
    case_id: 'case-1',
    channel: 'phone',
    normalized_value: PHONE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    preferred_language: 'English',
    contact_name: 'Rosa Martinez',
    segment_index: 0,
  },
  {
    id: 'contact-email',
    case_id: 'case-1',
    channel: 'email',
    normalized_value: EMAIL_ADDRESS,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    preferred_language: 'English',
    contact_name: 'Rosa Martinez',
    segment_index: 0,
  },
];

const PROFILE_ROWS: readonly SchedulerProfileRow[] = [
  { id: 'profile-agent', display_name: 'Maria Gomez', role: 'agent', is_active: true },
];

function schedulerStore() {
  return createStore({
    cancellation_settings: [SETTINGS_ROW],
    cancellation_cases: [CASE_ROW],
    cancellation_contacts: CONTACT_ROWS,
    cancellation_templates: TEMPLATE_ROWS,
    cancellation_template_versions: TEMPLATE_VERSION_ROWS,
    cancellation_prohibited_phrases: PHRASE_ROWS,
    profiles: PROFILE_ROWS,
  });
}

/** A rendered message for the `sendCommunication` cases, which do not exercise the renderer. */
function rendered(): RenderRendered {
  return {
    ok: true,
    subject: 'Your policy is scheduled for cancellation',
    body: 'New Hope Insurance Agency. Please call (704) 824-3130.',
    templateVersionId: 'tv-en-15',
    templateVersionIds: ['tv-en-15'],
    language: 'English',
    touchpoint: 15,
    senderName: 'Maria Gomez',
    truncated: false,
  };
}

const SMS_TARGET: SendTarget = { caseId: 'case-1', contactId: 'contact-phone', touchpoint: 15 };
const EMAIL_TARGET: SendTarget = { caseId: 'case-1', contactId: 'contact-email', touchpoint: 15 };

// ---------------------------------------------------------------------------
// The guards themselves (a zero-call assertion is worthless if nothing can move it)
// ---------------------------------------------------------------------------

describe('the provider guards', () => {
  it('wrap the real exports of both provider modules', () => {
    expect(guard.realExports).toEqual({ sendSms: true, sendEmail: true, isEmailConfigured: true });
  });

  it('records an SMS send that resolves to the real module instead of an injected mock', async () => {
    // No `providers`, so `resolveProviders` falls back to `src/lib/ringcentral-sms.ts` — which is
    // the guard. One recorded call proves the counter the other cases assert as zero can move, and
    // zero fetch attempts prove the refusal happened before any network call.
    const outcome = await deliverMessage({
      channel: 'sms',
      recipient: PHONE,
      subject: '',
      body: 'guard check',
      senderDisplayName: 'Maria Gomez',
    });

    expect(guard.sms).toEqual([{ to: PHONE, text: 'guard check' }]);
    expect(outcome.success).toBe(false);
    expect(fetchAttempts).toEqual([]);
  });

  it('records an email send that resolves to the real module instead of an injected mock', async () => {
    const outcome = await deliverMessage({
      channel: 'email',
      recipient: EMAIL_ADDRESS,
      subject: 'guard check',
      body: 'guard check',
      senderDisplayName: 'Maria Gomez',
    });

    expect(guard.email).toHaveLength(1);
    expect(guard.email[0].to).toBe(EMAIL_ADDRESS);
    expect(outcome.success).toBe(false);
    expect(fetchAttempts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deliverMessage — the provider conversation
// ---------------------------------------------------------------------------

describe('deliverMessage resolves both channels to the injected mocks', () => {
  it('sends SMS through the injected mock and reaches no live provider', async () => {
    const sms = smsMock([SMS_ACCEPTED]);

    const outcome = await deliverMessage({
      channel: 'sms',
      recipient: PHONE,
      subject: '',
      body: 'Your policy is scheduled for cancellation.',
      senderDisplayName: 'Maria Gomez',
      providers: { sendSms: sms.send },
    });

    expect(sms.calls).toEqual([
      { to: PHONE, text: 'Your policy is scheduled for cancellation.' },
    ]);
    expect(outcome.messageId).toBe('mock-sms-1');
    expectZeroLiveProviderCalls();
  });

  it('sends email through the injected mock, retries included, and reaches no live provider', async () => {
    const email = emailMock([EMAIL_RETRYABLE, EMAIL_RETRYABLE, EMAIL_ACCEPTED]);
    const sleep = sleepMock();

    const outcome = await deliverMessage({
      channel: 'email',
      recipient: EMAIL_ADDRESS,
      subject: 'Your policy is scheduled for cancellation',
      body: 'Please call (704) 824-3130.',
      senderDisplayName: 'Maria Gomez',
      providers: { sendEmail: email.send },
      sleep: sleep.sleep,
    });

    // Three attempts, all three on the mock: the retry policy cannot leak to the real provider.
    expect(email.calls).toHaveLength(3);
    expect(outcome.attempts).toBe(3);
    expect(outcome.messageId).toBe('mock-email-1');
    expectZeroLiveProviderCalls();
  });
});

// ---------------------------------------------------------------------------
// sendCommunication — reserve, send, record
// ---------------------------------------------------------------------------

describe('sendCommunication resolves both channels to the injected mocks', () => {
  it('reserves, sends SMS through the mock, and records the mock outcome', async () => {
    const store = createStore();
    const sms = smsMock([SMS_ACCEPTED]);

    const outcome = await sendCommunication({
      channel: 'sms',
      recipient: PHONE,
      rendered: rendered(),
      targets: [SMS_TARGET],
      client: store.client,
      providers: { sendSms: sms.send },
      now: () => FIXED_NOW,
    });

    expect(outcome.counts).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sms.calls).toHaveLength(1);
    expect(store.rows('cancellation_communications')[0].provider_message_id).toBe('mock-sms-1');
    expectZeroLiveProviderCalls();
  });

  it('sends email on an injected credential seam, so no test needs RESEND_API_KEY', async () => {
    const store = createStore();
    const email = emailMock([EMAIL_ACCEPTED]);

    // The real credential check is false here — the variables are unset for this file — and the send
    // still happens, because the seam decides (Requirement 23.3 read in reverse).
    expect(isEmailConfigured()).toBe(false);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: EMAIL_ADDRESS,
      rendered: rendered(),
      targets: [EMAIL_TARGET],
      client: store.client,
      providers: { sendEmail: email.send, isEmailConfigured: () => true },
      now: () => FIXED_NOW,
    });

    expect(outcome.counts).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].to).toBe(EMAIL_ADDRESS);
    expect(store.rows('cancellation_communications')[0].provider_message_id).toBe('mock-email-1');
    expectZeroLiveProviderCalls();
  });
});

// ---------------------------------------------------------------------------
// runScheduler — the whole batch
// ---------------------------------------------------------------------------

describe('runScheduler resolves both channels to the injected mocks', () => {
  it('sends the due SMS and the due email through the mocks and reaches no live provider', async () => {
    const store = schedulerStore();
    const sms = smsMock([SMS_ACCEPTED]);
    const email = emailMock([EMAIL_ACCEPTED]);

    const summary = await runScheduler({
      client: store.client,
      businessDate: BUSINESS_DATE,
      now: () => FIXED_NOW,
      providers: { sendSms: sms.send, sendEmail: email.send, isEmailConfigured: () => true },
    });

    // One SMS key and one email key, each sent once, by the mocks.
    expect(summary.sent).toBe(2);
    expect(summary.messagesAttempted).toBe(2);
    expect(sms.calls).toHaveLength(1);
    expect(sms.calls[0].to).toBe(PHONE);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].to).toBe(EMAIL_ADDRESS);
    expect(store.rows('cancellation_communications')).toHaveLength(2);
    expectZeroLiveProviderCalls();
  });

  it('reads no environment variable to decide whether email may be sent', () => {
    // Both seams answer without the credential check, which is what keeps a scheduler test off the
    // provider and out of the environment (Requirement 23.3).
    expect(resolveEmailConfigured({ isEmailConfigured: () => true })).toBe(true);
    expect(resolveEmailConfigured({ sendEmail: emailMock([EMAIL_ACCEPTED]).send })).toBe(true);
    expectZeroLiveProviderCalls();
  });
});

// ---------------------------------------------------------------------------
// The static half: one module owns each provider
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.git',
  '.kiro',
  '.vercel',
  'coverage',
  'dist',
  'build',
  'out',
]);

/** The repository root: the nearest ancestor of the working directory holding a `package.json`. */
function repositoryRoot(): string {
  let current = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error('No package.json found above the working directory.');
    current = parent;
  }
}

const ROOT = repositoryRoot();

/** Repository-relative, forward-slashed, so an allowance reads the same on every platform. */
function relative(absolute: string): string {
  return path.relative(ROOT, absolute).split(path.sep).join('/');
}

/** Every scannable module under `src/`, `scripts/`, and the repository root itself. */
function sourceFiles(): string[] {
  const found: string[] = [];

  const walk = (directory: string, recurse: boolean): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (recurse && !SKIPPED_DIRECTORIES.has(entry.name)) walk(absolute, true);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) found.push(absolute);
    }
  };

  walk(ROOT, false);
  for (const directory of ['src', 'scripts']) {
    const absolute = path.join(ROOT, directory);
    if (fs.existsSync(absolute)) walk(absolute, true);
  }

  return found.sort();
}

/**
 * The file with every comment blanked and every other character, string literals included, left
 * where it was, so a match's line number is the line number in the file.
 *
 * Written as a scanner rather than a regular expression on purpose: a URL contains `//`, so any
 * expression that strips from `//` to the end of a line would hide `https://api.resend.com` — the
 * exact string this scan exists to find — inside its own comment stripper.
 */
function codeWithoutComments(source: string): string {
  const out: string[] = [];
  let index = 0;
  const blank = (character: string): string => (character === '\n' ? '\n' : ' ');

  while (index < source.length) {
    const character = source[index];

    // A string or template literal, kept verbatim: an endpoint URL lives in one.
    if (character === '"' || character === "'" || character === '`') {
      const quote = character;
      out.push(character);
      index += 1;
      while (index < source.length) {
        const inner = source[index];
        out.push(inner);
        index += 1;
        if (inner === '\\' && index < source.length) {
          out.push(source[index]);
          index += 1;
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }

    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') {
        out.push(blank(source[index]));
        index += 1;
      }
      continue;
    }

    if (character === '/' && source[index + 1] === '*') {
      out.push(' ', ' ');
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        out.push(blank(source[index]));
        index += 1;
      }
      if (index < source.length) {
        out.push(' ', ' ');
        index += 2;
      }
      continue;
    }

    out.push(character);
    index += 1;
  }

  return out.join('');
}

interface Violation {
  file: string;
  line: number;
  needle: string;
  text: string;
}

function scan(needles: readonly string[], allowed: (file: string) => boolean): Violation[] {
  const violations: Violation[] = [];

  for (const absolute of sourceFiles()) {
    const file = relative(absolute);
    if (allowed(file)) continue;

    const source = fs.readFileSync(absolute, 'utf8');
    if (!needles.some((needle) => source.includes(needle))) continue;

    const code = codeWithoutComments(source);
    const lines = code.split('\n');
    const rawLines = source.split('\n');

    lines.forEach((line, position) => {
      for (const needle of needles) {
        if (line.includes(needle)) {
          violations.push({
            file,
            line: position + 1,
            needle,
            text: rawLines[position].trim(),
          });
        }
      }
    });
  }

  return violations;
}

function report(violations: readonly Violation[]): string {
  return violations
    .map((violation) => `${violation.file}:${violation.line} references ${violation.needle} — ${violation.text}`)
    .join('\n');
}

const THIS_FILE = 'src/features/cancellations/__tests__/provider-isolation.test.ts';

describe('the email provider is confined to src/lib/email.ts', () => {
  // The endpoint host and the credential name. A module holding either one is talking to the
  // provider or holding its key, and Requirement 23.1 allows exactly one module to do that.
  const EMAIL_PROVIDER_NEEDLES = ['api.resend.com', 'RESEND_API_KEY'] as const;

  /**
   * `src/lib/email.ts` is the one email delivery module (Requirement 23.1). Its own suite is allowed
   * with it: a test of the module has to set the credential it reads and assert the endpoint it
   * posts to, and that suite is where Requirement 23.6's behaviour is verified. This file is allowed
   * because it names the strings it prohibits.
   */
  const ALLOWED = new Set([
    'src/lib/email.ts',
    'src/lib/__tests__/email.test.ts',
    // The readiness regression suite, for the same reason `email.test.ts` is allowed: the defect it
    // pins was the readiness route reading the *wrong* variable names, so a test that proves the
    // right ones are read has to name them. Mocking the provider module instead would assert only
    // that the mock was called and would have passed against the bug.
    'src/features/cancellations/__tests__/email-readiness.test.ts',
    THIS_FILE,
  ]);

  it('finds the endpoint and the credential in no other module', () => {
    const violations = scan([...EMAIL_PROVIDER_NEEDLES], (file) => ALLOWED.has(file));
    expect(violations, `email provider references outside src/lib/email.ts:\n${report(violations)}`).toEqual([]);
  });

  it('scans the modules it claims to scan', () => {
    // A scan that walked nothing would pass the assertion above without proving anything.
    const files = sourceFiles().map(relative);
    expect(files).toContain('src/lib/email.ts');
    expect(files).toContain('src/features/cancellations/scheduler/send.ts');
    expect(files).toContain('src/features/cancellations/scheduler/run.ts');
    expect(files.length).toBeGreaterThan(100);
  });
});

describe('the SMS provider is confined to src/lib/ringcentral-sms.ts', () => {
  // Requirement 23.5: SMS goes only through the existing RingCentral service, so its credentials,
  // its endpoint host, and its SDK import belong to that one module.
  const SMS_PROVIDER_NEEDLES = [
    'RC_CLIENT_ID',
    'RC_CLIENT_SECRET',
    'RC_JWT_TOKEN',
    'RC_SMS_FROM_NUMBER',
    'platform.ringcentral.com',
    '@ringcentral/sdk',
  ] as const;

  const ALLOWED = new Set([
    'src/lib/ringcentral-sms.ts',
    'src/lib/__tests__/ringcentral-sms.test.ts',
    // Same reason as the email allowlist above. The readiness route read `RINGCENTRAL_*` instead of
    // `RC_*`, so its SMS check was false on every deployment that has ever existed; the regression
    // test has to name both spellings to prove which one is honoured.
    'src/features/cancellations/__tests__/email-readiness.test.ts',
    THIS_FILE,
  ]);

  it('finds the credentials, the endpoint, and the SDK in no other module', () => {
    const violations = scan([...SMS_PROVIDER_NEEDLES], (file) => ALLOWED.has(file));
    expect(
      violations,
      `SMS provider references outside src/lib/ringcentral-sms.ts:\n${report(violations)}`,
    ).toEqual([]);
  });
});

describe('cancellation routes reach a provider only through the send helper', () => {
  // `POST /api/cancellations/send` (task 15.1) is not in the repository yet. This assertion is
  // written over the directory rather than the file, so it covers that route the moment it lands:
  // a route that imported `@/lib/email` or `@/lib/ringcentral-sms` directly would be a second
  // caller of a provider, which is what Requirements 23.1 and 23.5 prohibit.
  const PROVIDER_IMPORTS = ['@/lib/email', '@/lib/ringcentral-sms'] as const;

  it('imports neither provider module in any route under src/app/api/cancellations', () => {
    const routes = sourceFiles()
      .map(relative)
      .filter((file) => file.startsWith('src/app/api/cancellations/'));

    // The scheduler route exists today; the assertion is meaningless if the list is empty.
    expect(routes).toContain('src/app/api/cancellations/scheduler/route.ts');

    const violations: string[] = [];
    for (const file of routes) {
      const code = codeWithoutComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
      for (const specifier of PROVIDER_IMPORTS) {
        if (code.includes(`'${specifier}'`) || code.includes(`"${specifier}"`)) {
          violations.push(`${file} imports ${specifier} directly`);
        }
      }
    }

    expect(violations, violations.join('\n')).toEqual([]);
  });
});
