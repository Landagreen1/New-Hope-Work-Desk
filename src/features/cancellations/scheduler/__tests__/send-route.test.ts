//
// Feature: policy-follow-up-renewals-cancellations, task 15.2 — the manual send route cases for
// `src/features/cancellations/scheduler/manual-send.ts`.
//
// **Validates: Requirements 17.5, 17.6, 17.11, 17.12, 22.6, 26.6, 25.2**
//
// One case per named item of task 15.2: the current Touchpoint selection including the pre-15-day
// fallback, a stored row that is not failed skipped with the already-sent indication, a retry that
// updates the stored row with a new send time, provider identifier, and delivery result while the
// template version, subject, and body stay byte-identical, zero eligible Contact_Recipient rows
// answered with the Requirement 17.12 error and zero rows written, both actions sending while the
// Requirement 26.4 kill switch is off, and a non-manager retry answered 403.
//
// ---------------------------------------------------------------------------------------------
// THE STORE DOUBLE
// ---------------------------------------------------------------------------------------------
// `manual-send.ts` lists the reads and writes it performs in its own header, and the double below
// answers exactly those: `.select()`, `.in()`, `.is()`, `.insert()`, `.insert().select('id')`,
// `.insert().select('id').single()`, `.update().in()`, and the two RPCs. It follows the doubles of
// `./scheduler.test.ts` and `./send.test.ts` — the same `23505` on a duplicate Idempotency_Key, the
// same `cancellation_retry_communication` that moves only the five permitted columns and refuses to
// lower `attempt_count` — and covers the eleven tables one manual send may touch. A table outside
// that list throws, so an unexpected query fails the suite rather than passing silently.
//
// Two invariants are asserted on **every** run through `manualSend`:
//
//   1. `keys.length === sent + skipped + failed`, so no recipient is reported twice and none is
//      lost (Requirement 17.5's sent, skipped, and failed counts);
//   2. zero writes to `cancellation_cases.case_status`. The double refuses such a write and records
//      it, so the Requirement 17.12 "leaves Case_Status unchanged" guarantee — and the wider rule
//      that a delivery result never moves Case_Status — fails the suite if it is ever broken.
//
// Both providers are injected, so nothing here reaches RingCentral or Resend (Requirement 25.3),
// `sleep` is injected so no case waits on the email backoff, the clock is pinned, and the business
// date is pinned.

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmailSendInput, EmailSendResult } from '@/lib/email';
import type { SmsSendResult } from '@/lib/ringcentral-sms';

import { addDays } from '../../../renewals/derive';
import type { CaseStatus, DeliveryResult } from '../../domain/communication-status';
import { SUPPRESSION_CHANNELS, type SuppressionChannel } from '../../domain/suppression';
import {
  TOKEN_NAMES,
  TOUCHPOINTS,
  tokenPlaceholder,
  type TemplateLanguage,
  type Touchpoint,
} from '../../render/renderMessage';
import {
  CASE_NOT_ASSIGNED_MESSAGE,
  COMMUNICATION_RETRIED_EVENT_TYPE,
  INVALID_REQUEST_MESSAGE,
  MANUAL_SEND_ACTIONS,
  NO_ELIGIBLE_CONTACT_MESSAGE,
  RETRY_FAILED_ACTION,
  RETRY_REQUIRES_MANAGER_MESSAGE,
  ROLE_NOT_PERMITTED_MESSAGE,
  SEND_NOW_ACTION,
  channelsFromBody,
  handleManualSendRequest,
  isManagerActor,
  parseManualSendBody,
  readManualSendBody,
  resolveCurrentTouchpoint,
  roleMayUseManualSend,
  runManualSend,
  type ManualSendAction,
  type ManualSendActor,
  type ManualSendInput,
  type ManualSendRejection,
  type ManualSendResult,
  type ManualSendSummary,
} from '../manual-send';

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
  kind: 'eq' | 'in' | 'is';
  column: string;
  value: unknown;
}

interface StoreRequest {
  table: string;
  action: 'select' | 'insert' | 'update';
  rows: Row[];
  values: Row;
  filters: Filter[];
  columns: string | null;
  wantsSingle: boolean;
}

/** The tables one manual send reads or writes. Anything else is a defect and throws. */
const TABLE_NAMES = [
  'cancellation_settings',
  'cancellation_cases',
  'cancellation_contacts',
  'cancellation_suppressions',
  'cancellation_communications',
  'cancellation_communication_cases',
  'cancellation_templates',
  'cancellation_template_versions',
  'cancellation_prohibited_phrases',
  'cancellation_events',
  'profiles',
] as const;

type TableName = (typeof TABLE_NAMES)[number];

const RETRY_RPC = 'cancellation_retry_communication';
const RECOMPUTE_RPC = 'cancellation_recompute_communication_status';

/** PostgreSQL `unique_violation`, raised on a duplicate Idempotency_Key as the live index does. */
const UNIQUE_VIOLATION: StoreError = {
  code: '23505',
  message: 'duplicate key value violates constraint "cancellation_communications_idempotency_key"',
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
  profiles?: Row[];
}

function matchesFilters(row: Row, filters: readonly Filter[]): boolean {
  return filters.every((filter) => {
    const stored = row[filter.column] ?? null;
    if (filter.kind === 'eq') return stored === filter.value;
    if (filter.kind === 'in') return (filter.value as readonly unknown[]).includes(stored);
    return stored === (filter.value ?? null);
  });
}

function createStore(seed: StoreSeed = {}) {
  const tables: Record<TableName, Row[]> = {
    cancellation_settings: [seed.settings ?? settingsRow()],
    cancellation_cases: (seed.cases ?? [caseRow()]).map((row) => ({ ...row })),
    cancellation_contacts: (seed.contacts ?? []).map((row) => ({ ...row })),
    cancellation_suppressions: (seed.suppressions ?? []).map((row) => ({ ...row })),
    cancellation_communications: (seed.communications ?? []).map((row) => ({ ...row })),
    cancellation_communication_cases: [],
    cancellation_templates: templateRows(),
    cancellation_template_versions: templateVersionRows(),
    cancellation_prohibited_phrases: prohibitedPhraseRows(),
    cancellation_events: [],
    profiles: seed.profiles ?? profileRows(),
  };

  const requests: { table: string; action: StoreRequest['action'] }[] = [];
  const rpcCalls: { name: string; args: Row }[] = [];
  /** Any attempt to write `cancellation_cases.case_status`; must stay empty (Req 17.12). */
  const caseStatusWrites: Row[] = [];
  let sequence = 0;

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
      sequence += 1;
      const prefix = table === 'cancellation_communications' ? 'comm' : 'row';
      const withId: Row = { id: `${prefix}-${sequence}`, ...row };
      tables[table].push(withId);
      stored.push(withId);
    }
    return { data: stored.map((row) => ({ id: row.id })), error: null };
  };

  const run = (request: StoreRequest): PostgrestResult => {
    const table = request.table as TableName;
    requests.push({ table: request.table, action: request.action });

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

    // Requirement 17.12: nothing here may move Case_Status, so the double refuses the write and
    // records it rather than applying it.
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
        throw new Error(`the manual send queried ${table}, which it never touches`);
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
      if (attempts !== null && attempts < (row.attempt_count as number)) {
        return { data: null, error: { code: '22023', message: 'cannot lower attempt_count' } };
      }
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
    requests,
    rpcCalls,
    caseStatusWrites,
    client: client as unknown as SupabaseClient,
    communications: () => tables.cancellation_communications,
    links: () => tables.cancellation_communication_cases,
    events: () => tables.cancellation_events,
    caseById: (id: string) => tables.cancellation_cases.find((row) => row.id === id),
    selectCount: (table: TableName) =>
      requests.filter((entry) => entry.table === table && entry.action === 'select').length,
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

/** The assigned agent of `case-1`; Requirement 22.2 lets this profile use both actions on it. */
const AGENT_ACTOR: ManualSendActor = { profileId: 'emp-1', role: 'agent' };
/** A manager, which Requirement 17.10 requires for `Retry Failed Communication`. */
const MANAGER_ACTOR: ManualSendActor = { profileId: 'mgr-1', role: 'manager' };
/** An agent the case is not assigned to (Requirements 22.2, 22.6, 22.12). */
const OTHER_AGENT_ACTOR: ManualSendActor = { profileId: 'emp-2', role: 'agent' };
/** A role outside the Policy Follow-up workspace (Requirement 22.6). */
const OUTSIDE_ACTOR: ManualSendActor = { profileId: 'emp-9', role: 'commercial' };

/** A cancellation effective date the given number of days after the business date. */
function effectiveDateFor(daysRemaining: number, businessDate: string = BUSINESS_DATE): string {
  return addDays(businessDate, daysRemaining);
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
    { id: 'emp-2', display_name: 'Luis Ortega', role: 'agent', is_active: true },
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

/** The stored text of a seeded Communication_Record, which a resend must submit unchanged. */
const STORED_SUBJECT = 'Cancellation notice - tier 15 (as stored)';
const STORED_BODY = 'Stored body retained from the first attempt. Please call (704) 824-3130.';
const STORED_SEND_TIME = '2026-07-01T09:30:00.000Z';

function storedCommunication(overrides: Row = {}): Row {
  return {
    id: 'comm-seeded-1',
    case_id: 'case-1',
    contact_id: 'contact-sms-1',
    touchpoint: 15,
    channel: 'sms',
    template_version_id: 'tv-en-15',
    rendered_subject: STORED_SUBJECT,
    rendered_body: STORED_BODY,
    send_time: STORED_SEND_TIME,
    provider_message_id: 'rc-first-attempt',
    delivery_result: 'Sent' satisfies DeliveryResult,
    failure_reason: null,
    attempt_count: 1,
    combined_group_id: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Provider spies and the send driver
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

interface SendOptions {
  caseId?: string;
  action?: ManualSendAction;
  actor?: ManualSendActor;
  channels?: readonly SuppressionChannel[];
  businessDate?: string;
  sms?: readonly SmsSendResult[];
  email?: readonly EmailSendResult[];
  emailConfigured?: boolean;
}

/** One manual send over a store, with both providers, the clock, and the business date injected. */
async function manualSend(store: Store, options: SendOptions = {}) {
  const sms = smsSpy(options.sms ?? [SMS_ACCEPTED]);
  const email = emailSpy(options.email ?? [EMAIL_ACCEPTED]);
  const waits = sleepSpy();

  const input: ManualSendInput = {
    client: store.client,
    caseId: options.caseId ?? 'case-1',
    action: options.action ?? SEND_NOW_ACTION,
    actor: options.actor ?? AGENT_ACTOR,
    ...(options.channels === undefined ? {} : { channels: options.channels }),
    providers: {
      sendSms: sms.send,
      sendEmail: email.send,
      isEmailConfigured: () => options.emailConfigured ?? true,
    },
    now: () => FIXED_NOW,
    businessDate: options.businessDate ?? BUSINESS_DATE,
    sleep: waits.sleep,
    newGroupId: () => 'group-fixed',
  };

  const result = await runManualSend(input);

  // Requirement 17.12 and the wider rule that no send path moves Case_Status.
  expect(store.caseStatusWrites).toEqual([]);
  if (result.ok) {
    const { sent, skipped, failed } = result.summary.counts;
    expect(result.summary.keys).toHaveLength(sent + skipped + failed);
  }

  return { result, sms, email, waits };
}

function summaryOf(result: ManualSendResult): ManualSendSummary {
  if (!result.ok) throw new Error(`expected a summary, got the rejection ${result.rejection.code}`);
  return result.summary;
}

function rejectionOf(result: ManualSendResult): ManualSendRejection {
  if (result.ok) throw new Error('expected a rejection, got a summary');
  return result.rejection;
}

function retryRpcCalls(store: Store) {
  return store.rpcCalls.filter((call) => call.name === RETRY_RPC);
}

// ---------------------------------------------------------------------------
// Requirement 17.5 — the current Touchpoint, including the pre-15-day fallback
// ---------------------------------------------------------------------------

describe('resolveCurrentTouchpoint (Requirement 17.5)', () => {
  it.each([
    { label: '15 days remaining, the first due date arriving today', days: 15, expected: 15 },
    { label: '12 days remaining, between the 15-day and 10-day dates', days: 12, expected: 15 },
    { label: '10 days remaining, the 10-day date arriving today', days: 10, expected: 10 },
    { label: '6 days remaining, between the 10-day and 5-day dates', days: 6, expected: 10 },
    { label: '5 days remaining, the 5-day date arriving today', days: 5, expected: 5 },
    { label: '3 days remaining, between the 5-day and 1-day dates', days: 3, expected: 5 },
    { label: '1 day remaining, the last due date arriving today', days: 1, expected: 1 },
    { label: 'the effective date itself', days: 0, expected: 1 },
    { label: 'a date already passed', days: -4, expected: 1 },
    { label: 'no due date arrived yet, the 15-day fallback', days: 20, expected: 15 },
  ])('resolves $label to the $expected-day Touchpoint', ({ days, expected }) => {
    expect(resolveCurrentTouchpoint(effectiveDateFor(days), BUSINESS_DATE)).toBe(expected);
  });

  it('takes the 15-day fallback for an absent or unreadable effective date', () => {
    expect(resolveCurrentTouchpoint(null, BUSINESS_DATE)).toBe(15);
    expect(resolveCurrentTouchpoint(undefined, BUSINESS_DATE)).toBe(15);
    expect(resolveCurrentTouchpoint('', BUSINESS_DATE)).toBe(15);
    expect(resolveCurrentTouchpoint('not a calendar date', BUSINESS_DATE)).toBe(15);
  });
});

describe('runManualSend — Send Reminder Now sends the current Touchpoint (Requirement 17.5)', () => {
  it.each([
    { days: 12, touchpoint: 15 as Touchpoint },
    { days: 6, touchpoint: 10 as Touchpoint },
    { days: 3, touchpoint: 5 as Touchpoint },
    { days: 0, touchpoint: 1 as Touchpoint },
    { days: -2, touchpoint: 1 as Touchpoint },
  ])(
    'renders and stores the $touchpoint-day Touchpoint for a case $days days out',
    async ({ days, touchpoint }) => {
      const store = createStore({
        cases: [caseRow({ cancellation_effective_date: effectiveDateFor(days) })],
        contacts: [phoneContact()],
      });

      const { result, sms } = await manualSend(store, { channels: ['sms'] });
      const summary = summaryOf(result);

      expect(summary.touchpoint).toBe(touchpoint);
      expect(summary.businessDate).toBe(BUSINESS_DATE);
      expect(sms.calls).toHaveLength(1);
      expect(store.communications()).toHaveLength(1);
      expect(store.communications()[0]).toMatchObject({
        touchpoint,
        channel: 'sms',
        delivery_result: 'Sent',
        template_version_id: `tv-en-${touchpoint}`,
      });
      expect(summary.keys.map((key) => key.touchpoint)).toEqual([touchpoint]);
    },
  );

  it('sends the 15-day Touchpoint where no scheduled date has arrived yet', async () => {
    // 20 days out: no Touchpoint due date is on or before the business date, so Requirement 17.5's
    // own fallback applies and the 15-day Touchpoint is what the button sends.
    const store = createStore({
      cases: [caseRow({ cancellation_effective_date: effectiveDateFor(20) })],
      contacts: [phoneContact(), emailContact()],
    });

    const { result, sms, email } = await manualSend(store);
    const summary = summaryOf(result);

    expect(summary.touchpoint).toBe(15);
    expect(sms.calls).toHaveLength(1);
    expect(email.calls).toHaveLength(1);
    expect(store.communications().map((row) => row.touchpoint)).toEqual([15, 15]);
    expect(summary.counts).toEqual({ sent: 2, skipped: 0, failed: 0 });
  });

  it('sends one message per eligible recipient and channel and reports the three counts', async () => {
    const store = createStore({
      cases: [caseRow()],
      contacts: [
        phoneContact(),
        emailContact(),
        // Excluded by Requirement 17.5's own conditions, so neither is sent to nor counted eligible.
        phoneContact({ id: 'contact-sms-2', normalized_value: '+17045559999', validation_status: 'invalid' }),
        emailContact({ id: 'contact-email-2', normalized_value: 'no@example.com', authorization_status: 'Not Authorized' }),
      ],
    });

    const { result, sms, email } = await manualSend(store);
    const summary = summaryOf(result);

    expect(summary.action).toBe(SEND_NOW_ACTION);
    expect(summary.channels).toEqual([...SUPPRESSION_CHANNELS]);
    expect(summary.eligibleContacts).toEqual({ sms: 1, email: 1 });
    expect(summary.counts).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(summary.alreadySent).toBe(0);
    expect(summary.communicationRowsWritten).toBe(2);
    expect(summary.communicationRowsUpdated).toBe(0);
    expect(summary.linkRowsWritten).toBe(2);
    expect(summary.failures).toEqual([]);

    // One provider call per channel, to the eligible values only.
    expect(sms.calls.map((call) => call.to)).toEqual([PHONE_VALUE]);
    expect(email.calls.map((call) => call.to)).toEqual([EMAIL_VALUE]);
    expect(email.calls[0].senderDisplayName).toBe('Maria Lopez');

    // One row per Idempotency_Key, carrying the provider outcome (Requirement 17.5).
    expect(store.communications()).toHaveLength(2);
    expect(
      store.communications().map((row) => [row.contact_id, row.channel, row.delivery_result]),
    ).toEqual([
      ['contact-sms-1', 'sms', 'Sent'],
      ['contact-email-1', 'email', 'Sent'],
    ]);
    expect(store.communications()[0].rendered_subject).toBe('');
    expect(store.communications()[0].provider_message_id).toBe('rc-8801');
    expect(store.communications()[1].provider_message_id).toBe('resend-5501');
    expect(String(store.communications()[1].rendered_body)).toContain(AGENCY_NAME);
    expect(store.links()).toHaveLength(2);

    // Requirement 15.9: the stored rows recompute Communication_Status; Case_Status is untouched.
    expect(summary.statusRecomputed).toBe(true);
    expect(store.rpcCalls.filter((call) => call.name === RECOMPUTE_RPC)).toHaveLength(1);
    expect(store.rpcCalls.find((call) => call.name === RECOMPUTE_RPC)?.args.p_case_id).toBe('case-1');
    expect(store.caseById('case-1')?.case_status).toBe('Open');
  });
});

// ---------------------------------------------------------------------------
// Requirement 17.11 — a stored row that is not failed
// ---------------------------------------------------------------------------

describe('runManualSend — a stored row that is not failed (Requirement 17.11)', () => {
  it.each(['Sent', 'Delivered'] satisfies DeliveryResult[])(
    'skips the key of a stored %s row as already sent, storing no additional row',
    async (deliveryResult) => {
      const store = createStore({
        cases: [caseRow()],
        contacts: [phoneContact()],
        communications: [storedCommunication({ delivery_result: deliveryResult })],
      });
      const before = store.snapshot();

      const { result, sms } = await manualSend(store, { channels: ['sms'] });
      const summary = summaryOf(result);

      // No message went out and nothing was written.
      expect(sms.calls).toHaveLength(0);
      expect(summary.counts).toEqual({ sent: 0, skipped: 1, failed: 0 });
      expect(summary.alreadySent).toBe(1);
      expect(summary.keys).toEqual([
        {
          contactId: 'contact-sms-1',
          channel: 'sms',
          touchpoint: 15,
          recipient: PHONE_VALUE,
          status: 'skipped',
          reason: 'already_sent',
          communicationId: null,
          deliveryResult: null,
          providerMessageId: null,
          failureReason: null,
          attemptCount: null,
          updatedExistingRow: false,
        },
      ]);
      expect(summary.communicationRowsWritten).toBe(0);
      expect(summary.communicationRowsUpdated).toBe(0);
      expect(summary.retryEventsWritten).toBe(0);
      expect(summary.statusRecomputed).toBe(false);

      // One row still, byte for byte as it was stored.
      expect(store.communications()).toHaveLength(1);
      expect(store.snapshot()).toEqual(before);
      expect(store.rpcCalls).toEqual([]);
      expect(store.links()).toHaveLength(0);
      expect(store.events()).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Requirement 17.6 — Retry Failed Communication
// ---------------------------------------------------------------------------

describe('runManualSend — Retry Failed Communication (Requirement 17.6)', () => {
  it('updates the stored row in place and leaves the template version, subject, and body unchanged', async () => {
    const store = createStore({
      cases: [caseRow()],
      contacts: [phoneContact(), emailContact()],
      communications: [
        storedCommunication({
          id: 'comm-failed-1',
          contact_id: 'contact-email-1',
          channel: 'email',
          delivery_result: 'Failed' satisfies DeliveryResult,
          failure_reason: 'HTTP 500 provider error',
          provider_message_id: null,
          attempt_count: 3,
        }),
      ],
    });

    const { result, email } = await manualSend(store, {
      action: RETRY_FAILED_ACTION,
      actor: MANAGER_ACTOR,
      channels: ['email'],
      email: [{ success: true, messageId: 'resend-9001', failureReason: null, retryable: false }],
    });
    const summary = summaryOf(result);

    // The STORED text went to the provider, not a fresh render (Requirement 17.6).
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0]).toMatchObject({
      to: EMAIL_VALUE,
      subject: STORED_SUBJECT,
      body: STORED_BODY,
      senderDisplayName: 'Maria Lopez',
    });

    // No second row for the Idempotency_Key; the existing one carries the new outcome.
    expect(store.communications()).toHaveLength(1);
    const row = store.communications()[0];
    expect(row).toMatchObject({
      id: 'comm-failed-1',
      delivery_result: 'Sent',
      provider_message_id: 'resend-9001',
      failure_reason: null,
      // One attempt on top of the three already stored: a retry counts up.
      attempt_count: 4,
      send_time: FIXED_NOW.toISOString(),
    });
    expect(row.send_time).not.toBe(STORED_SEND_TIME);

    // Byte-identical: the three immutable values did not move.
    expect(row.template_version_id).toBe('tv-en-15');
    expect(row.rendered_subject).toBe(STORED_SUBJECT);
    expect(row.rendered_body).toBe(STORED_BODY);

    // The update went through the one permitted path, with the live parameter names.
    expect(retryRpcCalls(store)).toEqual([
      {
        name: RETRY_RPC,
        args: {
          p_communication_id: 'comm-failed-1',
          p_delivery_result: 'Sent',
          p_provider_message_id: 'resend-9001',
          p_failure_reason: null,
          p_attempt_count: 4,
          p_send_time: FIXED_NOW.toISOString(),
        },
      },
    ]);

    expect(summary.counts).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(summary.communicationRowsWritten).toBe(0);
    expect(summary.communicationRowsUpdated).toBe(1);
    expect(summary.linkRowsWritten).toBe(0);
    expect(summary.keys[0]).toMatchObject({
      contactId: 'contact-email-1',
      channel: 'email',
      touchpoint: 15,
      status: 'sent',
      communicationId: 'comm-failed-1',
      deliveryResult: 'Sent',
      providerMessageId: 'resend-9001',
      attemptCount: 4,
      updatedExistingRow: true,
    });

    // One retry entry per Contact_Recipient and channel on the audit timeline (Requirement 17.6).
    expect(summary.retryEventsWritten).toBe(1);
    expect(store.events()).toHaveLength(1);
    const event = store.events()[0];
    expect(event).toMatchObject({
      case_id: 'case-1',
      actor_id: 'mgr-1',
      event_type: COMMUNICATION_RETRIED_EVENT_TYPE,
      event_time: FIXED_NOW.toISOString(),
    });
    expect(event.detail).toMatchObject({
      communication_id: 'comm-failed-1',
      contact_id: 'contact-email-1',
      channel: 'email',
      touchpoint: 15,
      delivery_result: 'Sent',
      provider_message_id: 'resend-9001',
      attempt_count: 4,
      template_version_id: 'tv-en-15',
    });

    expect(summary.statusRecomputed).toBe(true);
    expect(store.caseById('case-1')?.case_status).toBe('Open');
  });

  it('sends nothing for a key whose current Touchpoint has no stored row', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [phoneContact()] });

    const { result, sms } = await manualSend(store, {
      action: RETRY_FAILED_ACTION,
      actor: MANAGER_ACTOR,
      channels: ['sms'],
    });
    const summary = summaryOf(result);

    expect(sms.calls).toHaveLength(0);
    expect(summary.counts).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(summary.keys[0]).toMatchObject({ status: 'skipped', reason: 'no_failed_record' });
    expect(store.communications()).toHaveLength(0);
    expect(store.events()).toHaveLength(0);
    expect(store.rpcCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Requirement 17.12 — zero eligible Contact_Recipient rows
// ---------------------------------------------------------------------------

describe('runManualSend — zero eligible contacts (Requirement 17.12)', () => {
  it.each([...MANUAL_SEND_ACTIONS])(
    '%s writes zero rows, leaves Case_Status unchanged, and returns the contact-information error',
    async (action) => {
      const store = createStore({
        cases: [caseRow()],
        // One invalid phone and one prohibited email: neither channel has a recipient.
        contacts: [
          phoneContact({ validation_status: 'invalid' }),
          emailContact({ authorization_status: 'Not Authorized' }),
        ],
      });

      const { result, sms, email } = await manualSend(store, { action, actor: MANAGER_ACTOR });
      const rejection = rejectionOf(result);

      expect(rejection.code).toBe('no_eligible_contact');
      expect(rejection.status).toBe(422);
      expect(rejection.message).toBe(NO_ELIGIBLE_CONTACT_MESSAGE);
      expect(rejection.message).toContain('Valid authorized contact information is required');

      // Zero messages, zero rows, Case_Status untouched.
      expect(sms.calls).toHaveLength(0);
      expect(email.calls).toHaveLength(0);
      expect(store.communications()).toHaveLength(0);
      expect(store.links()).toHaveLength(0);
      expect(store.events()).toHaveLength(0);
      expect(store.rpcCalls).toEqual([]);
      expect(store.caseById('case-1')?.case_status).toBe('Open');
      expect(store.caseStatusWrites).toEqual([]);

      // Returned before any Communication_Record read, any template read, and any render.
      expect(store.selectCount('cancellation_communications')).toBe(0);
      expect(store.selectCount('cancellation_templates')).toBe(0);
      expect(store.selectCount('cancellation_template_versions')).toBe(0);
      expect(store.selectCount('cancellation_prohibited_phrases')).toBe(0);
      expect(store.selectCount('profiles')).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Requirement 26.6 — both actions send while automatic sending is disabled
// ---------------------------------------------------------------------------

describe('runManualSend — the kill switch never gates a manual action (Requirement 26.6)', () => {
  it('Send Reminder Now stores one row per recipient and channel while sending is disabled', async () => {
    const store = createStore({
      settings: settingsRow({ automatic_sending_enabled: false }),
      cases: [caseRow()],
      contacts: [phoneContact(), emailContact()],
    });

    const { result, sms, email } = await manualSend(store);
    const summary = summaryOf(result);

    // Reported, never consulted.
    expect(summary.automaticSendingEnabled).toBe(false);
    expect(sms.calls).toHaveLength(1);
    expect(email.calls).toHaveLength(1);
    expect(summary.counts).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(summary.communicationRowsWritten).toBe(2);
    expect(store.communications()).toHaveLength(2);
    expect(store.communications().every((row) => row.delivery_result === 'Sent')).toBe(true);
  });

  it('Retry Failed Communication updates both stored rows while sending is disabled', async () => {
    const store = createStore({
      settings: settingsRow({ automatic_sending_enabled: false }),
      cases: [caseRow()],
      contacts: [phoneContact(), emailContact()],
      communications: [
        storedCommunication({
          id: 'comm-failed-sms',
          delivery_result: 'Failed' satisfies DeliveryResult,
          failure_reason: 'RingCentral rejected the recipient',
          provider_message_id: null,
          attempt_count: 1,
        }),
        storedCommunication({
          id: 'comm-failed-email',
          contact_id: 'contact-email-1',
          channel: 'email',
          delivery_result: 'Failed' satisfies DeliveryResult,
          failure_reason: 'HTTP 503',
          provider_message_id: null,
          attempt_count: 1,
        }),
      ],
    });

    const { result, sms, email } = await manualSend(store, {
      action: RETRY_FAILED_ACTION,
      actor: MANAGER_ACTOR,
    });
    const summary = summaryOf(result);

    expect(summary.automaticSendingEnabled).toBe(false);
    expect(sms.calls).toHaveLength(1);
    expect(email.calls).toHaveLength(1);
    expect(summary.counts).toEqual({ sent: 2, skipped: 0, failed: 0 });
    expect(summary.communicationRowsUpdated).toBe(2);
    expect(summary.communicationRowsWritten).toBe(0);
    expect(summary.retryEventsWritten).toBe(2);

    // Still two rows, both carrying the new outcome and the original rendered text.
    expect(store.communications()).toHaveLength(2);
    for (const row of store.communications()) {
      expect(row).toMatchObject({
        delivery_result: 'Sent',
        failure_reason: null,
        attempt_count: 2,
        send_time: FIXED_NOW.toISOString(),
        rendered_subject: STORED_SUBJECT,
        rendered_body: STORED_BODY,
        template_version_id: 'tv-en-15',
      });
    }
    expect(store.communications().map((row) => row.provider_message_id)).toEqual([
      'rc-8801',
      'resend-5501',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Requirements 17.10, 22.2, 22.6 — who may act
// ---------------------------------------------------------------------------

describe('manual send authorization (Requirements 17.10, 22.2, 22.6)', () => {
  it('answers a non-manager retry 403 without reaching the work function at all', async () => {
    let runnerCalls = 0;

    const response = await handleManualSendRequest(
      new Request('https://desk.test/api/cancellations/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId: 'case-1', action: RETRY_FAILED_ACTION }),
      }),
      {
        resolveSession: async () => ({ profileId: 'emp-1', role: 'agent' }),
        runner: async () => {
          runnerCalls += 1;
          throw new Error('the work function must not run for an unauthorized retry');
        },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: RETRY_REQUIRES_MANAGER_MESSAGE,
      code: 'forbidden_role',
    });
    expect(runnerCalls).toBe(0);
  });

  it('answers a role outside the Policy Follow-up workspace 403 before the body is read', async () => {
    let runnerCalls = 0;

    const response = await handleManualSendRequest(
      new Request('https://desk.test/api/cancellations/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseId: 'case-1', action: SEND_NOW_ACTION }),
      }),
      {
        resolveSession: async () => ({ profileId: 'emp-9', role: 'commercial' }),
        runner: async () => {
          runnerCalls += 1;
          throw new Error('the work function must not run for a role outside the workspace');
        },
      },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: ROLE_NOT_PERMITTED_MESSAGE,
      code: 'forbidden_role',
    });
    expect(runnerCalls).toBe(0);
  });

  it('refuses a non-manager retry in the work function before a single row is read', async () => {
    const store = createStore({
      cases: [caseRow()],
      contacts: [phoneContact()],
      communications: [
        storedCommunication({ delivery_result: 'Failed' satisfies DeliveryResult, provider_message_id: null }),
      ],
    });
    const before = store.snapshot();

    const { result, sms, email } = await manualSend(store, {
      action: RETRY_FAILED_ACTION,
      actor: AGENT_ACTOR,
    });
    const rejection = rejectionOf(result);

    expect(rejection).toEqual({
      code: 'forbidden_role',
      message: RETRY_REQUIRES_MANAGER_MESSAGE,
      status: 403,
    });
    expect(store.requests).toEqual([]);
    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(store.snapshot()).toEqual(before);
  });

  it('refuses a role outside the workspace in the work function', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [phoneContact()] });

    const { result } = await manualSend(store, { actor: OUTSIDE_ACTOR });

    expect(rejectionOf(result)).toEqual({
      code: 'forbidden_role',
      message: ROLE_NOT_PERMITTED_MESSAGE,
      status: 403,
    });
    expect(store.requests).toEqual([]);
  });

  it('refuses a non-manager acting on a case assigned to somebody else, writing nothing', async () => {
    const store = createStore({ cases: [caseRow()], contacts: [phoneContact(), emailContact()] });

    const { result, sms, email } = await manualSend(store, { actor: OTHER_AGENT_ACTOR });
    const rejection = rejectionOf(result);

    expect(rejection).toEqual({
      code: 'forbidden_case_scope',
      message: CASE_NOT_ASSIGNED_MESSAGE,
      status: 403,
    });
    // The case row was read for the scope decision; nothing beyond it was.
    expect(store.selectCount('cancellation_cases')).toBe(1);
    expect(store.selectCount('cancellation_contacts')).toBe(0);
    expect(sms.calls).toHaveLength(0);
    expect(email.calls).toHaveLength(0);
    expect(store.communications()).toHaveLength(0);
    expect(store.events()).toHaveLength(0);
    expect(store.caseById('case-1')?.case_status).toBe('Open');
  });

  it('lets the assigned agent use Send Reminder Now and a manager act on any case', async () => {
    const agentStore = createStore({ cases: [caseRow()], contacts: [phoneContact()] });
    const { result: agentResult } = await manualSend(agentStore, {
      actor: AGENT_ACTOR,
      channels: ['sms'],
    });
    expect(summaryOf(agentResult).counts.sent).toBe(1);

    // `case-1` is assigned to `emp-1`, and a manager is not limited to their own records.
    const managerStore = createStore({ cases: [caseRow()], contacts: [phoneContact()] });
    const { result: managerResult } = await manualSend(managerStore, {
      actor: MANAGER_ACTOR,
      channels: ['sms'],
    });
    expect(summaryOf(managerResult).counts.sent).toBe(1);
  });

  it('reads manager privilege and workspace access from the role alone', () => {
    expect(isManagerActor({ profileId: 'p', role: 'manager' })).toBe(true);
    expect(isManagerActor({ profileId: 'p', role: 'super_admin' })).toBe(true);
    expect(isManagerActor(AGENT_ACTOR)).toBe(false);
    expect(isManagerActor({ profileId: 'p', role: 'sales_supervisor' })).toBe(false);

    expect(roleMayUseManualSend('agent')).toBe(true);
    expect(roleMayUseManualSend('customer_service')).toBe(true);
    expect(roleMayUseManualSend('sales_supervisor')).toBe(true);
    expect(roleMayUseManualSend('manager')).toBe(true);
    expect(roleMayUseManualSend('super_admin')).toBe(true);
    expect(roleMayUseManualSend('commercial')).toBe(false);
    expect(roleMayUseManualSend('commercial_supervisor')).toBe(false);
    expect(roleMayUseManualSend('customer_service_supervisor')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The request body
// ---------------------------------------------------------------------------

describe('the manual send request body', () => {
  it('accepts a case identifier, one of the two actions, and an optional channel', () => {
    expect(parseManualSendBody({ caseId: ' case-1 ', action: SEND_NOW_ACTION })).toEqual({
      ok: true,
      body: { caseId: 'case-1', action: SEND_NOW_ACTION },
    });
    expect(parseManualSendBody({ caseId: 'case-1', action: RETRY_FAILED_ACTION, channel: 'sms' })).toEqual({
      ok: true,
      body: { caseId: 'case-1', action: RETRY_FAILED_ACTION, channel: 'sms' },
    });
  });

  it('refuses a body that names no case, an unknown action, or an unknown channel', () => {
    const refused: unknown[] = [
      null,
      'send_now',
      [],
      {},
      { action: SEND_NOW_ACTION },
      { caseId: '   ', action: SEND_NOW_ACTION },
      { caseId: 'case-1' },
      { caseId: 'case-1', action: 'delete_everything' },
      { caseId: 'case-1', action: SEND_NOW_ACTION, channel: 'fax' },
    ];

    for (const payload of refused) {
      const result = parseManualSendBody(payload);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.rejection).toEqual({
          code: 'invalid_request',
          message: INVALID_REQUEST_MESSAGE,
          status: 400,
        });
      }
    }
  });

  it('refuses a request whose body is not readable JSON', async () => {
    const result = await readManualSendBody(
      new Request('https://desk.test/api/cancellations/send', { method: 'POST', body: 'not json' }),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe('invalid_request');
  });

  it('targets both channels unless the body names one', () => {
    expect(channelsFromBody(undefined)).toEqual([...SUPPRESSION_CHANNELS]);
    expect(channelsFromBody('both')).toEqual([...SUPPRESSION_CHANNELS]);
    expect(channelsFromBody('sms')).toEqual(['sms']);
    expect(channelsFromBody('email')).toEqual(['email']);
  });
});
