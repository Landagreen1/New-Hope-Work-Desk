//
// Feature: policy-follow-up-renewals-cancellations, task 14.4 — the Notification_Scheduler unit
// cases for `src/features/cancellations/scheduler/run.ts`.
//
// **Validates: Requirements 12.1, 12.2, 12.5, 12.8, 12.12, 12.13, 13.1, 13.4, 14.18, 23.3, 26.5, 25.2**
//
// One case per named item of task 14.4: each of the four Touchpoints firing on its due business
// date, a duplicate run on the same date, SMS success and SMS failure recorded on the reserved row,
// email success and email failure with the attempt count, a case with no eligible Contact_Recipient,
// an excluded Case_Status, a Touchpoint due date in the past, two cases of one customer reached at
// one contact value, the Requirement 26.4 kill switch off, and absent email credentials.
//
// ---------------------------------------------------------------------------------------------
// THE STORE DOUBLE
// ---------------------------------------------------------------------------------------------
// `run.ts` lists the reads and writes it performs in its own header, and the double below answers
// exactly those: `.select()`, `.in()`, `.is()`, `.insert()`, `.insert().select('id')`,
// `.insert().select('id').single()`, `.update().eq()`, `.update().in()`,
// `.update().not('cleared_at','is',null)`, and the two RPCs. It follows the smoke-test double of
// `./send.test.ts` — the same `23505` on a duplicate Idempotency_Key, the same
// `cancellation_retry_communication` that moves only the five permitted columns — and adds the
// tables a whole run touches. A table the batch is not supposed to read throws, so an unexpected
// query lands in `summary.failures` rather than passing silently.
//
// Two invariants are asserted on **every** run through `expectRunAccounting`:
//
//   1. `touchpointsEvaluated === sent + skipped + failed`, with all eight skip reasons present and
//      their counts summing to the skipped total (Requirement 12.13);
//   2. zero writes to `cancellation_cases.case_status`. The store refuses such a write and records
//      it, so a delivery result that tried to move Case_Status would fail the suite instead of
//      quietly succeeding (Requirements 13.9, 15.3, 15.4).
//
// Both providers are injected, so nothing here reaches RingCentral or Resend (Requirement 25.3),
// the business date is pinned, `sleep` is injected so the three-attempt email case runs in
// milliseconds, and `smsPacingMs` is 0.

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmailSendInput, EmailSendResult } from '@/lib/email';
import type { SmsSendResult } from '@/lib/ringcentral-sms';

import { addDays } from '../../../renewals/derive';
import type { CaseStatus } from '../../domain/communication-status';
import {
  TOKEN_NAMES,
  TOUCHPOINTS,
  tokenPlaceholder,
  type TemplateLanguage,
  type Touchpoint,
} from '../../render/renderMessage';
import { SCHEDULER_SKIP_REASONS, runScheduler, type SchedulerRunSummary } from '../run';

// ---------------------------------------------------------------------------
// The in-memory store
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface StoreError {
  code?: string;
  message: string;
}

interface PostgrestResult {
  data: unknown;
  error: StoreError | null;
}

interface Filter {
  kind: 'eq' | 'in' | 'is' | 'not_is';
  column: string;
  value: unknown;
}

interface StoreRequest {
  table: string;
  action: 'select' | 'insert' | 'update';
  rows: Row[];
  values: Row;
  filters: Filter[];
  /** The requested column list, recorded so a test can see what a stage selected. */
  columns: string | null;
  wantsSingle: boolean;
}

/** The tables one run reads or writes. Anything else is a defect and throws. */
const TABLE_NAMES = [
  'cancellation_settings',
  'cancellation_cases',
  'cancellation_contacts',
  'cancellation_suppressions',
  'cancellation_communications',
  'cancellation_escalations',
  'cancellation_customer_responses',
  'cancellation_templates',
  'cancellation_template_versions',
  'cancellation_prohibited_phrases',
  'cancellation_communication_cases',
  'cancellation_events',
  'user_notifications',
  'profiles',
] as const;

type TableName = (typeof TABLE_NAMES)[number];

/** The columns `cancellation_retry_communication` is allowed to move (Requirement 14.16). */
const RETRY_RPC = 'cancellation_retry_communication';
const RECOMPUTE_RPC = 'cancellation_recompute_communication_status';

/** PostgreSQL `unique_violation`, raised by both unique constraints the double enforces. */
const UNIQUE_VIOLATION: StoreError = {
  code: '23505',
  message: 'duplicate key value violates a unique constraint',
};

/**
 * A chainable, awaitable query. Every builder method returns `this` and the work happens in `then`,
 * so the double does not care in which order a caller filters, selects, or narrows to one row.
 */
class StoreQuery implements PromiseLike<PostgrestResult> {
  constructor(
    private readonly request: StoreRequest,
    private readonly run: (request: StoreRequest) => PostgrestResult,
  ) {}

  select(columns?: string): this {
    this.request.columns = columns ?? null;
    return this;
  }

  single(): this {
    this.request.wantsSingle = true;
    return this;
  }

  eq(column: string, value: unknown): this {
    this.request.filters.push({ kind: 'eq', column, value });
    return this;
  }

  in(column: string, value: readonly unknown[]): this {
    this.request.filters.push({ kind: 'in', column, value });
    return this;
  }

  is(column: string, value: unknown): this {
    this.request.filters.push({ kind: 'is', column, value });
    return this;
  }

  /** Only `.not('cleared_at', 'is', null)` is used, which is the escalation reopen guard. */
  not(column: string, operator: string, value: unknown): this {
    if (operator !== 'is') throw new Error(`the store double does not implement .not(_, '${operator}', _)`);
    this.request.filters.push({ kind: 'not_is', column, value });
    return this;
  }

  then<TResult1 = PostgrestResult, TResult2 = never>(
    onfulfilled?: ((value: PostgrestResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve()
      .then(() => this.run(this.request))
      .then(onfulfilled, onrejected);
  }
}

interface StoreSeed {
  settings?: Row;
  cases?: Row[];
  contacts?: Row[];
  suppressions?: Row[];
  communications?: Row[];
  escalations?: Row[];
  responses?: Row[];
  profiles?: Row[];
}

function matchesFilters(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    const stored = row[filter.column] ?? null;
    if (filter.kind === 'eq') return stored === filter.value;
    if (filter.kind === 'in') return (filter.value as readonly unknown[]).includes(stored);
    if (filter.kind === 'is') return stored === (filter.value ?? null);
    return stored !== (filter.value ?? null);
  });
}

function createStore(seed: StoreSeed = {}) {
  const tables: Record<TableName, Row[]> = {
    cancellation_settings: [seed.settings ?? settingsRow()],
    cancellation_cases: (seed.cases ?? [caseRow()]).map((row) => ({ ...row })),
    cancellation_contacts: (seed.contacts ?? []).map((row) => ({ ...row })),
    cancellation_suppressions: (seed.suppressions ?? []).map((row) => ({ ...row })),
    cancellation_communications: (seed.communications ?? []).map((row) => ({ ...row })),
    cancellation_escalations: (seed.escalations ?? []).map((row) => ({ ...row })),
    cancellation_customer_responses: (seed.responses ?? []).map((row) => ({ ...row })),
    cancellation_templates: templateRows(),
    cancellation_template_versions: templateVersionRows(),
    cancellation_prohibited_phrases: prohibitedPhraseRows(),
    cancellation_communication_cases: [],
    cancellation_events: [],
    user_notifications: [],
    profiles: seed.profiles ?? profileRows(),
  };

  const rpcCalls: { name: string; args: Row }[] = [];
  /** Any attempt to write `cancellation_cases.case_status`; must stay empty (Req 15.3, 15.4). */
  const caseStatusWrites: Row[] = [];
  let sequence = 0;

  const nextId = (prefix: string): string => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };

  const insert = (table: TableName, rows: Row[]): PostgrestResult => {
    const stored: Row[] = [];
    for (const row of rows) {
      if (table === 'cancellation_communications') {
        const clash = tables.cancellation_communications.some(
          (existing) =>
            existing.case_id === row.case_id
            && existing.contact_id === row.contact_id
            && existing.touchpoint === row.touchpoint
            && existing.channel === row.channel,
        );
        if (clash) return { data: null, error: UNIQUE_VIOLATION };
      }
      if (table === 'cancellation_escalations') {
        const clash = tables.cancellation_escalations.some(
          (existing) => existing.case_id === row.case_id && existing.reason === row.reason,
        );
        if (clash) return { data: null, error: UNIQUE_VIOLATION };
      }
      const withId: Row = { id: nextId(table === 'cancellation_communications' ? 'comm' : 'row'), ...row };
      tables[table].push(withId);
      stored.push(withId);
    }
    return { data: stored.map((row) => ({ id: row.id })), error: null };
  };

  const run = (request: StoreRequest): PostgrestResult => {
    const table = request.table as TableName;

    if (request.action === 'select') {
      return { data: tables[table].filter((row) => matchesFilters(row, request.filters)), error: null };
    }

    if (request.action === 'insert') {
      const result = insert(table, request.rows);
      if (result.error !== null) return result;
      const rows = result.data as Row[];
      if (request.wantsSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    // Requirements 13.9, 15.3, 15.4: a delivery result never moves Case_Status, so the double
    // refuses the write and records it rather than applying it.
    if (table === 'cancellation_cases' && Object.hasOwn(request.values, 'case_status')) {
      caseStatusWrites.push({ ...request.values });
      return {
        data: null,
        error: { code: '42501', message: 'cancellation_cases.case_status is not writable from a send path' },
      };
    }

    const matched = tables[table].filter((row) => matchesFilters(row, request.filters));
    for (const row of matched) Object.assign(row, request.values);
    return { data: matched, error: null };
  };

  const client = {
    from(table: string) {
      if (!(TABLE_NAMES as readonly string[]).includes(table)) {
        throw new Error(`the scheduler queried ${table}, which one run never touches`);
      }
      const base = (action: StoreRequest['action'], rows: Row[], values: Row): StoreQuery =>
        new StoreQuery(
          { table, action, rows, values, filters: [], columns: null, wantsSingle: false },
          run,
        );
      return {
        select: (columns?: string) => base('select', [], {}).select(columns),
        insert: (payload: Row | Row[]) => base('insert', Array.isArray(payload) ? payload : [payload], {}),
        update: (values: Row) => base('update', [], values),
      };
    },

    async rpc(name: string, args: Row): Promise<PostgrestResult> {
      rpcCalls.push({ name, args });

      if (name === RECOMPUTE_RPC) return { data: null, error: null };

      if (name !== RETRY_RPC) {
        return { data: null, error: { message: `unknown function ${name}` } };
      }

      const row = tables.cancellation_communications.find(
        (stored) => stored.id === args.p_communication_id,
      );
      if (row === undefined) {
        return { data: null, error: { code: 'P0002', message: 'no such Communication_Record' } };
      }
      const attempts = args.p_attempt_count as number | null;
      // Only the five permitted columns move; the template version, subject, and body cannot.
      row.send_time = (args.p_send_time as string | null) ?? row.send_time;
      row.provider_message_id = args.p_provider_message_id as string | null;
      row.delivery_result = args.p_delivery_result as string;
      row.failure_reason = args.p_failure_reason as string | null;
      row.attempt_count = attempts ?? row.attempt_count;
      return { data: row, error: null };
    },
  };

  return {
    tables,
    rpcCalls,
    caseStatusWrites,
    client: client as unknown as SupabaseClient,
    communications: () => tables.cancellation_communications,
    links: () => tables.cancellation_communication_cases,
    events: () => tables.cancellation_events,
    notifications: () => tables.user_notifications,
    escalations: () => tables.cancellation_escalations,
    caseById: (id: string) => tables.cancellation_cases.find((row) => row.id === id),
    snapshot: () => JSON.parse(JSON.stringify(tables.cancellation_communications)) as Row[],
  };
}

type Store = ReturnType<typeof createStore>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BUSINESS_DATE = '2026-07-16';
const FIXED_NOW = new Date('2026-07-16T13:45:00.000Z');
const OFFICE_PHONE = '(704) 824-3130';
const AGENCY_NAME = 'New Hope Insurance Agency';
const PHONE_VALUE = '+17045551234';
const EMAIL_VALUE = 'rosa@example.com';

/** The cancellation effective date whose `touchpoint` due date is the business date (Req 12.1). */
function effectiveDateFor(touchpoint: Touchpoint, businessDate: string = BUSINESS_DATE): string {
  return addDays(businessDate, touchpoint);
}

function settingsRow(overrides: Row = {}): Row {
  return {
    automatic_sending_enabled: true,
    office_phone: OFFICE_PHONE,
    agency_name: AGENCY_NAME,
    bilingual_separator: '\n---\n',
    holidays: [],
    ...overrides,
  };
}

function templateRows(): Row[] {
  return TOUCHPOINTS.map((touchpoint) => ({ id: `tpl-${touchpoint}`, touchpoint }));
}

const STATEMENTS: Record<TemplateLanguage, string> = {
  English: 'According to our records, this policy is scheduled for cancellation.',
  Spanish: 'Según nuestros registros, esta póliza está programada para cancelación.',
};

const REQUESTS: Record<TemplateLanguage, string> = {
  English: `Please contact us on or before ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)} to review your options.`,
  Spanish: `Comuníquese con nosotros a más tardar el ${tokenPlaceholder(TOKEN_NAMES.contactDeadline)} para revisar sus opciones.`,
};

/** A compact stored body carrying every required element as a token, in both channels' shape. */
function templateBody(language: TemplateLanguage): string {
  const policyLabel = language === 'English' ? 'Policy' : 'Póliza';
  const dateLabel = language === 'English' ? 'Cancellation effective date' : 'Fecha efectiva de cancelación';
  return [
    tokenPlaceholder(TOKEN_NAMES.cancellationStatement),
    `${policyLabel}: ${tokenPlaceholder(TOKEN_NAMES.policyNumber)}`,
    `${dateLabel}: ${tokenPlaceholder(TOKEN_NAMES.cancellationDate)}`,
    tokenPlaceholder(TOKEN_NAMES.contactRequest),
    `${tokenPlaceholder(TOKEN_NAMES.senderName)} - ${tokenPlaceholder(TOKEN_NAMES.agencyName)} - ${tokenPlaceholder(TOKEN_NAMES.officePhone)}`,
  ].join('\n');
}

/** One English and one Spanish version row per Touchpoint, as migration v1.10.9 seeds them. */
function templateVersionRows(): Row[] {
  const languages: TemplateLanguage[] = ['English', 'Spanish'];
  return TOUCHPOINTS.flatMap((touchpoint) =>
    languages.map((language) => ({
      id: `tv-${language === 'English' ? 'en' : 'es'}-${touchpoint}`,
      template_id: `tpl-${touchpoint}`,
      version: 2,
      language,
      subject:
        language === 'English'
          ? `Cancellation notice - tier ${touchpoint}`
          : `Aviso de cancelación - nivel ${touchpoint}`,
      body: templateBody(language),
      cancellation_statement: STATEMENTS[language],
      contact_request: REQUESTS[language],
      fallback_text: {
        [TOKEN_NAMES.carrier]: language === 'English' ? 'your carrier' : 'su aseguradora',
        [TOKEN_NAMES.amountDue]: '',
      },
    })),
  );
}

/** A seeded list that matches nothing rendered here, so every send proves the gate ran and passed. */
function prohibitedPhraseRows(): Row[] {
  return [
    { id: 'pp-1', phrase: 'your policy will be reinstated', language: 'English', is_active: true },
    { id: 'pp-2', phrase: 'payment guarantees continued coverage', language: 'English', is_active: true },
    { id: 'pp-3', phrase: 'su póliza será reactivada', language: 'Spanish', is_active: true },
  ];
}

function profileRows(): Row[] {
  return [
    { id: 'emp-1', display_name: 'Maria Lopez', role: 'agent', is_active: true },
    { id: 'mgr-1', display_name: 'Dana Ruiz', role: 'manager', is_active: true },
  ];
}

function caseRow(overrides: Row = {}): Row {
  return {
    id: 'case-1',
    policy_number: 'POL-10001',
    cancellation_effective_date: effectiveDateFor(15),
    customer_name: 'Rosa Martinez',
    customer_match_key: 'rosa-martinez',
    carrier: 'Progressive',
    cancellation_reason: 'Non-payment',
    amount_due: '1234.50',
    case_status: 'Open' satisfies CaseStatus,
    communication_status: 'Scheduled',
    next_required_action: null,
    assigned_to: 'emp-1',
    producer_label: 'Maria Lopez',
    follow_up_deadline: null,
    assistance_requested: false,
    ...overrides,
  };
}

function phoneContact(overrides: Row = {}): Row {
  return {
    id: 'contact-sms-1',
    case_id: 'case-1',
    channel: 'phone',
    normalized_value: PHONE_VALUE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    is_primary: true,
    preferred_language: 'English',
    contact_name: 'Rosa Martinez',
    segment_index: 0,
    ...overrides,
  };
}

function emailContact(overrides: Row = {}): Row {
  return {
    id: 'contact-email-1',
    case_id: 'case-1',
    channel: 'email',
    normalized_value: EMAIL_VALUE,
    validation_status: 'valid',
    authorization_status: 'Authorized',
    sms_suppressed: false,
    email_suppressed: false,
    is_primary: true,
    preferred_language: 'English',
    contact_name: 'Rosa Martinez',
    segment_index: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider spies and the run driver
// ---------------------------------------------------------------------------

function smsSpy(results: readonly SmsSendResult[]) {
  const calls: { to: string; text: string }[] = [];
  let index = 0;
  const send = async (to: string, text: string): Promise<SmsSendResult> => {
    calls.push({ to, text });
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  };
  return { calls, send };
}

function emailSpy(results: readonly EmailSendResult[]) {
  const calls: EmailSendInput[] = [];
  let index = 0;
  const send = async (input: EmailSendInput): Promise<EmailSendResult> => {
    calls.push(input);
    const result = results[Math.min(index, results.length - 1)];
    index += 1;
    return result;
  };
  return { calls, send };
}

function sleepSpy() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

const SMS_ACCEPTED: SmsSendResult = { success: true, messageId: 'rc-8801' };
const EMAIL_ACCEPTED: EmailSendResult = {
  success: true,
  messageId: 'resend-5501',
  failureReason: null,
  retryable: false,
};

interface RunOptions {
  businessDate?: string;
  sms?: readonly SmsSendResult[];
  email?: readonly EmailSendResult[];
  emailConfigured?: boolean;
}

/** One run over a store, with both providers, the clock, the business date, and backoff injected. */
async function runOnce(store: Store, options: RunOptions = {}) {
  const sms = smsSpy(options.sms ?? [SMS_ACCEPTED]);
  const email = emailSpy(options.email ?? [EMAIL_ACCEPTED]);
  const waits = sleepSpy();

  const summary = await runScheduler({
    client: store.client,
    providers: {
      sendSms: sms.send,
      sendEmail: email.send,
      isEmailConfigured: () => options.emailConfigured ?? true,
    },
    now: () => FIXED_NOW,
    businessDate: options.businessDate ?? BUSINESS_DATE,
    sleep: waits.sleep,
    smsPacingMs: 0,
    newGroupId: () => 'group-fixed',
    actor: null,
  });

  expectRunAccounting(summary, store);
  return { summary, sms, email, waits };
}

/**
 * The two invariants every run has to satisfy: the Requirement 12.13 unit accounting, and the
 * absence of any `cancellation_cases.case_status` write (Requirements 13.9, 15.3, 15.4).
 */
function expectRunAccounting(summary: SchedulerRunSummary, store: Store): void {
  expect(summary.touchpointsEvaluated).toBe(summary.sent + summary.skipped + summary.failed);
  expect(Object.keys(summary.skippedByReason).sort()).toEqual([...SCHEDULER_SKIP_REASONS].sort());
  const byReason = SCHEDULER_SKIP_REASONS.reduce(
    (total, reason) => total + summary.skippedByReason[reason],
    0,
  );
  expect(byReason).toBe(summary.skipped);
  expect(summary.failures).toEqual([]);
  expect(store.caseStatusWrites).toEqual([]);
}

/** The stored Communication_Record rows, ordered so an assertion does not depend on write order. */
function storedRows(store: Store): Row[] {
  return [...store.communications()].sort((left, right) =>
    `${left.case_id}|${left.channel}|${left.touchpoint}`.localeCompare(
      `${right.case_id}|${right.channel}|${right.touchpoint}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Requirements 12.1, 12.2, 12.13 — the four Touchpoints
// ---------------------------------------------------------------------------

describe('runScheduler — the four Touchpoints (Requirements 12.1, 12.2)', () => {
  it.each([...TOUCHPOINTS])(
    'sends the %s-day Touchpoint on its due business date, one message per channel',
    async (touchpoint) => {
      const store = createStore({
        cases: [caseRow({ cancellation_effective_date: effectiveDateFor(touchpoint) })],
        contacts: [phoneContact(), emailContact()],
      });

      const { summary, sms, email } = await runOnce(store);

      // Every Touchpoint with more days remaining than this one came due before the business date,
      // so it is counted skipped on both channels rather than sent (Requirement 12.8).
      const passedUnits = TOUCHPOINTS.filter((earlier) => earlier > touchpoint).length * 2;

      expect(summary.businessDate).toBe(BUSINESS_DATE);
      expect(summary.casesEvaluated).toBe(1);
      expect(summary.sent).toBe(2);
      expect(summary.skipped).toBe(passedUnits);
      expect(summary.skippedByReason.due_date_passed).toBe(passedUnits);
      expect(summary.failed).toBe(0);
      expect(summary.touchpointsEvaluated).toBe(2 + passedUnits);
      expect(summary.messagesAttempted).toBe(2);
      expect(summary.combinedMessages).toBe(0);

      // One provider call per channel, and one row per Idempotency_Key carrying this Touchpoint.
      expect(sms.calls).toHaveLength(1);
      expect(sms.calls[0].to).toBe(PHONE_VALUE);
      expect(email.calls).toHaveLength(1);
      expect(email.calls[0].to).toBe(EMAIL_VALUE);

      expect(summary.communicationRowsWritten).toBe(2);
      expect(storedRows(store).map((row) => [row.channel, row.touchpoint, row.delivery_result])).toEqual([
        ['email', touchpoint, 'Sent'],
        ['sms', touchpoint, 'Sent'],
      ]);
      expect(summary.linkRowsWritten).toBe(2);
      expect(summary.statusRecomputed).toBe(1);
    },
  );

  it('evaluates a Touchpoint whose due date is later than the business date as nothing at all', async () => {
    // 20 days out: the 15-day due date falls 5 days from now, so no unit exists yet and the case is
    // not even selected (Requirement 12.1 selects by the four due dates).
    const store = createStore({
      cases: [caseRow({ cancellation_effective_date: addDays(BUSINESS_DATE, 20) })],
      contacts: [phoneContact(), emailContact()],
    });

    const { summary, sms, email } = await runOnce(store);

    expect(summary.casesEvaluated).toBe(0);
    expect(summary.touchpointsEvaluated).toBe(0);
    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(store.communications()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Requirements 12.3, 12.5 — a duplicate run on the same business date
// ---------------------------------------------------------------------------

describe('runScheduler — a duplicate run on the same business date (Requirement 12.5)', () => {
  it('sends nothing on the second run and counts every key as an existing record', async () => {
    const store = createStore({
      cases: [caseRow()],
      contacts: [phoneContact(), emailContact()],
    });

    const first = await runOnce(store);
    expect(first.summary.sent).toBe(2);
    const afterFirst = store.snapshot();

    const second = await runOnce(store);

    expect(second.sms.calls).toHaveLength(0);
    expect(second.email.calls).toHaveLength(0);
    expect(second.summary.messagesAttempted).toBe(0);
    expect(second.summary.sent).toBe(0);
    expect(second.summary.failed).toBe(0);
    expect(second.summary.skipped).toBe(2);
    expect(second.summary.skippedByReason.existing_record).toBe(2);
    expect(second.summary.communicationRowsWritten).toBe(0);
    expect(second.summary.linkRowsWritten).toBe(0);

    // Two rows in all, every stored value exactly as the first run left it (Requirement 12.7).
    expect(store.communications()).toHaveLength(2);
    expect(store.snapshot()).toEqual(afterFirst);
    expect(store.links()).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Requirements 12.11, 12.13, 14.18 — SMS success and SMS failure
// ---------------------------------------------------------------------------

describe('runScheduler — SMS outcomes recorded on the reserved row (Requirements 12.11, 14.18)', () => {
  it('records an accepted SMS on the row it reserved, with zero characters as the subject', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [phoneContact()] });

    const { summary, sms } = await runOnce(store);

    expect(summary.sent).toBe(1);
    expect(sms.calls).toHaveLength(1);
    expect(store.communications()).toHaveLength(1);

    const row = store.communications()[0];
    expect(row).toMatchObject({
      case_id: 'case-1',
      contact_id: 'contact-sms-1',
      touchpoint: 15,
      channel: 'sms',
      delivery_result: 'Sent',
      provider_message_id: 'rc-8801',
      attempt_count: 1,
      failure_reason: null,
      rendered_subject: '',
      combined_group_id: null,
      template_version_id: 'tv-en-15',
    });
    // The body reached the provider byte for byte as it is stored (Requirement 14.15).
    expect(sms.calls[0].text).toBe(row.rendered_body);
    expect(sms.calls[0].text).toContain(AGENCY_NAME);

    // The outcome went through the one permitted update path.
    expect(store.rpcCalls.filter((call) => call.name === RETRY_RPC)).toEqual([
      {
        name: RETRY_RPC,
        args: {
          p_communication_id: row.id,
          p_delivery_result: 'Sent',
          p_provider_message_id: 'rc-8801',
          p_failure_reason: null,
          p_attempt_count: 1,
          p_send_time: FIXED_NOW.toISOString(),
        },
      },
    ]);
  });

  it('records a refused SMS as one failed row and leaves Case_Status untouched', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [phoneContact()] });

    const { summary, sms } = await runOnce(store, {
      sms: [{ success: false, error: 'RingCentral rejected the recipient' }],
    });

    // One attempt only: an SMS is never retried (Requirement 12.11).
    expect(sms.calls).toHaveLength(1);
    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(summary.messagesAttempted).toBe(1);

    expect(store.communications()).toHaveLength(1);
    expect(store.communications()[0]).toMatchObject({
      delivery_result: 'Failed',
      failure_reason: 'RingCentral rejected the recipient',
      attempt_count: 1,
      provider_message_id: null,
    });
    // The rendered body is retained through the failure (Requirement 14.18).
    expect(String(store.communications()[0].rendered_body)).toContain(AGENCY_NAME);

    // The delivery result changed no Case_Status (Requirements 13.9, 15.3, 15.4).
    expect(store.caseById('case-1')?.case_status).toBe('Open');
    expect(store.caseStatusWrites).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirements 23.4, 23.8, 14.18 — email success and email failure
// ---------------------------------------------------------------------------

describe('runScheduler — email outcomes and the attempt count (Requirements 23.4, 23.8)', () => {
  it('records an accepted email with the provider identifier and the rendered subject', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [emailContact()] });

    const { summary, email } = await runOnce(store);

    expect(summary.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].senderDisplayName).toBe('Maria Lopez');

    const row = store.communications()[0];
    expect(row).toMatchObject({
      channel: 'email',
      contact_id: 'contact-email-1',
      delivery_result: 'Sent',
      provider_message_id: 'resend-5501',
      attempt_count: 1,
    });
    expect(row.rendered_subject).toBe('Cancellation notice - tier 15');
    expect(email.calls[0].subject).toBe(row.rendered_subject);
    expect(email.calls[0].body).toBe(row.rendered_body);
  });

  it('stores the final failure of three attempts as the attempt count on one row', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [emailContact()] });

    const { summary, email, waits } = await runOnce(store, {
      email: [
        { success: false, messageId: null, failureReason: 'HTTP 500 first', retryable: true },
        { success: false, messageId: null, failureReason: 'HTTP 500 second', retryable: true },
        { success: false, messageId: null, failureReason: 'HTTP 503 final', retryable: true },
      ],
    });

    // Three attempts in all, two waits between them, one row (Requirement 23.8).
    expect(email.calls).toHaveLength(3);
    expect(waits.delays).toHaveLength(2);
    expect(summary.failed).toBe(1);
    expect(summary.messagesAttempted).toBe(1);
    expect(store.communications()).toHaveLength(1);
    expect(store.communications()[0]).toMatchObject({
      delivery_result: 'Failed',
      failure_reason: 'HTTP 503 final',
      attempt_count: 3,
      provider_message_id: null,
    });
    expect(store.caseById('case-1')?.case_status).toBe('Open');
  });
});

// ---------------------------------------------------------------------------
// Requirements 12.2, 12.12, 12.8, 12.13 — the skip reasons
// ---------------------------------------------------------------------------

describe('runScheduler — the Requirement 12.13 skip reasons', () => {
  it('skips a case with no eligible Contact_Recipient, per channel, with zero rows', async () => {
    const store = createStore({
      cases: [caseRow()],
      // The one stored contact is invalid, so neither channel has a recipient (Requirement 12.2).
      contacts: [phoneContact({ validation_status: 'invalid' })],
    });

    const { summary, sms, email } = await runOnce(store);

    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(summary.sent).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.skippedByReason.no_eligible_contact).toBe(2);
    expect(summary.communicationRowsWritten).toBe(0);
    expect(store.communications()).toHaveLength(0);
  });

  it('skips a case whose Case_Status is outside Imported and Open (Requirement 12.12)', async () => {
    const store = createStore({
      cases: [caseRow({ case_status: 'Payment Reported' satisfies CaseStatus })],
      contacts: [phoneContact(), emailContact()],
    });

    const { summary, sms, email } = await runOnce(store);

    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(summary.skipped).toBe(2);
    expect(summary.skippedByReason.excluded_case_status).toBe(2);
    expect(store.communications()).toHaveLength(0);
    // The scheduler read the status; it did not write it.
    expect(store.caseById('case-1')?.case_status).toBe('Payment Reported');
  });

  it('skips a Touchpoint whose due date is earlier than the business date, writing zero rows', async () => {
    // Five days out: the 15-day and 10-day due dates have passed, the 5-day due date is today.
    const store = createStore({
      cases: [caseRow({ cancellation_effective_date: effectiveDateFor(5) })],
      contacts: [phoneContact(), emailContact()],
    });

    const { summary, sms, email } = await runOnce(store);

    expect(summary.touchpointsEvaluated).toBe(6);
    expect(summary.sent).toBe(2);
    expect(summary.skipped).toBe(4);
    expect(summary.skippedByReason.due_date_passed).toBe(4);
    expect(summary.skippedByReason.existing_record).toBe(0);

    // Only the due Touchpoint reached a provider, and only it stored rows (Requirement 12.8).
    expect(sms.calls).toHaveLength(1);
    expect(email.calls).toHaveLength(1);
    expect(store.communications()).toHaveLength(2);
    expect(storedRows(store).map((row) => row.touchpoint)).toEqual([5, 5]);
  });
});

// ---------------------------------------------------------------------------
// Requirements 13.1, 13.4 — one combined message for one customer
// ---------------------------------------------------------------------------

describe('runScheduler — a combined multi-policy message (Requirements 13.1, 13.4)', () => {
  it('renders one message for two cases of one customer on one contact value, one row per key', async () => {
    const store = createStore({
      cases: [
        caseRow({ id: 'case-1', policy_number: 'POL-10001' }),
        caseRow({ id: 'case-2', policy_number: 'POL-20002' }),
      ],
      contacts: [
        emailContact({ id: 'contact-email-1', case_id: 'case-1' }),
        emailContact({ id: 'contact-email-2', case_id: 'case-2' }),
      ],
    });

    const { summary, email } = await runOnce(store);

    // One provider call covering both cases (Requirement 13.4), one row per Idempotency_Key.
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].to).toBe(EMAIL_VALUE);
    expect(email.calls[0].body).toContain('POL-10001');
    expect(email.calls[0].body).toContain('POL-20002');

    expect(summary.casesEvaluated).toBe(2);
    expect(summary.combinedMessages).toBe(1);
    expect(summary.messagesAttempted).toBe(1);
    expect(summary.sent).toBe(2);
    // The SMS channel has no recipient for either case, which is its own reason.
    expect(summary.skipped).toBe(2);
    expect(summary.skippedByReason.no_eligible_contact).toBe(2);

    const rows = storedRows(store);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.case_id)).toEqual(['case-1', 'case-2']);
    for (const row of rows) {
      expect(row.combined_group_id).toBe('group-fixed');
      expect(row.channel).toBe('email');
      expect(row.touchpoint).toBe(15);
      expect(row.delivery_result).toBe('Sent');
      expect(row.provider_message_id).toBe('resend-5501');
      // Every row of the group carries the same template version, subject, and body (Req 13.8).
      expect(row.template_version_id).toBe(rows[0].template_version_id);
      expect(row.rendered_subject).toBe(rows[0].rendered_subject);
      expect(row.rendered_body).toBe(rows[0].rendered_body);
    }
    expect(summary.linkRowsWritten).toBe(2);
    expect(store.links().map((link) => link.case_id)).toEqual(['case-1', 'case-2']);
  });
});

// ---------------------------------------------------------------------------
// Requirement 26.5 — the kill switch
// ---------------------------------------------------------------------------

describe('runScheduler — automatic sending disabled (Requirement 26.5)', () => {
  it('counts every candidate Touchpoint skipped and writes zero rows', async () => {
    const store = createStore({
      settings: settingsRow({ automatic_sending_enabled: false }),
      cases: [caseRow()],
      contacts: [phoneContact(), emailContact()],
    });

    const { summary, sms, email } = await runOnce(store);

    expect(summary.automaticSendingEnabled).toBe(false);
    expect(summary.touchpointsEvaluated).toBe(2);
    expect(summary.skipped).toBe(2);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.skippedByReason.automatic_sending_disabled).toBe(2);
    expect(summary.messagesAttempted).toBe(0);

    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(store.communications()).toHaveLength(0);
    expect(store.links()).toHaveLength(0);
    expect(store.events()).toHaveLength(0);
    expect(store.escalations()).toHaveLength(0);
    expect(store.notifications()).toHaveLength(0);
    expect(summary.statusRecomputed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Requirement 23.3 — absent email credentials
// ---------------------------------------------------------------------------

describe('runScheduler — absent email credentials (Requirement 23.3)', () => {
  it('writes zero email rows, continues SMS, and reports the skipped email keys', async () => {
    const store = createStore({
      cases: [caseRow()],
      contacts: [phoneContact(), emailContact()],
    });

    const { summary, sms, email } = await runOnce(store, { emailConfigured: false });

    expect(summary.emailConfigured).toBe(false);
    expect(email.calls).toHaveLength(0);
    expect(summary.skippedByReason.email_not_configured).toBe(1);

    // SMS continued for the due Touchpoint.
    expect(sms.calls).toHaveLength(1);
    expect(summary.sent).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.touchpointsEvaluated).toBe(2);

    // Zero rows for the skipped email key, so a later run may still send it.
    expect(store.communications()).toHaveLength(1);
    expect(store.communications()[0].channel).toBe('sms');
    expect(store.communications().some((row) => row.channel === 'email')).toBe(false);
  });
});
