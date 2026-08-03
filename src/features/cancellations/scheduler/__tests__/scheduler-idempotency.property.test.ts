// src/features/cancellations/scheduler/__tests__/scheduler-idempotency.property.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, Property 2: For any set of cancellation cases with contacts, and for any run count from 2 to 5, executing the Notification_Scheduler that many times over an unchanged input produces the same set of Communication_Record rows, compared by Idempotency_Key, as the first run alone produces, and issues exactly one provider call per key in that set.
//
// **Validates: Requirements 12.3, 12.4, 12.5, 12.6, 12.7, 25.5**
//
// The property is driven against the real `runScheduler` and the real `sendCommunication`, over an
// in-memory store that enforces the two unique constraints the idempotency contract rests on:
// `unique (case_id, contact_id, touchpoint, channel)` on `cancellation_communications`, which *is*
// the Idempotency_Key (Requirement 12.6), and `unique (case_id, reason)` on
// `cancellation_escalations`, which is how one escalation notification survives repeated runs.
// Both are raised as PostgreSQL `23505`, the code `send.ts` reads as "another run owns this key".
//
// ---------------------------------------------------------------------------------------------
// THE FOUR ASSERTIONS
// ---------------------------------------------------------------------------------------------
//  1. `keysAfter(n) === keysAfter(1)` as sets, for n drawn from 2 to 5. The stored Idempotency_Key
//     set after n runs equals the set one run produces on a fresh store (Requirements 12.3, 12.5).
//  2. One provider call per message, and none after the first run: the total call count across
//     every run equals the number of messages the first run assembled, and each later run adds
//     zero (Requirements 12.5, 12.7).
//  3. Every skipped key lands in the run summary's skipped total: `touchpointsEvaluated === sent +
//     skipped + failed` and `skipped === sum(skippedByReason)` for every run, and for every run
//     after the first, `skippedByReason.existing_record` equals the stored key count exactly —
//     every one of them was evaluated, skipped, and counted (Requirements 12.5, 12.7, 12.3).
//  4. Two schedulers driven alternately against one store reach the same key set with the same
//     total provider call count, and the second one — which never sees an unreserved key — calls
//     no provider at all.
//
// Plus the shape Requirement 12.6 actually names: the same two schedulers racing one store. Every
// key is stored exactly once however the two interleave, and whichever run loses a race catches the
// `23505`, abandons that send, and counts the key skipped (Requirement 12.7). The store counts the
// conflicts it issued, and the non-vacuity block asserts they happened — so the constraint is
// exercised inside the batch rather than only in the store's own test.
//
// ---------------------------------------------------------------------------------------------
// "ONE PROVIDER CALL PER KEY", STATED THE WAY REQUIREMENT 13.4 MEANS IT
// ---------------------------------------------------------------------------------------------
// A combined multi-policy message is one provider call covering up to 10 Idempotency_Keys
// (Requirement 13.4), so `providerCalls === keys.size` is not the invariant in a world that
// exercises grouping — and this world does, deliberately: match keys come from a pool of three and
// contact values from a pool of three, so cases share buckets. The general invariant asserted for
// every world is therefore the message form:
//
//     providerCalls === messages, where messages partitions the stored keys
//
// `messages` is counted from the store rather than from the summary: a combined message shares one
// injected `combined_group_id` across its rows and a single-case send stores none, so the message
// count is `rows with no group id` plus `distinct group ids`. It is then cross-checked against
// `summary.messagesAttempted`, so neither number can drift unnoticed.
//
// The literal per-key form is asserted too, for every world whose first run combined nothing
// (`combinedMessages === 0`), which is where one message covers exactly one key. The non-vacuity
// block at the bottom asserts both branches were reached often.
//
// ---------------------------------------------------------------------------------------------
// WHAT KEEPS THIS FROM PASSING VACUOUSLY
// ---------------------------------------------------------------------------------------------
// A store that never conflicts, a world that never sends, or a scheduler whose every run fails
// would all satisfy the equality. Five guards:
//   * the first `it` in this file inserts one key twice and asserts the store answers `23505`;
//   * `summary.failures` is asserted empty for every run, and the store records every table and
//     function it does not model, asserted empty — so a read the batch performs that this double
//     answers wrongly fails the test instead of silently emptying the world;
//   * the counters asserted after the run: worlds that sent at least one key, worlds that combined,
//     worlds whose provider refused a message, worlds where a later run skipped a stored key, and
//     the total number of keys written across the whole property;
//   * `sent + failed === keys.size` for the first run, so every stored key came from a real
//     reserve-then-send rather than from a store that invented rows;
//   * one `cancellation_communication_cases` link row per stored key after every run, so a repeated
//     run cannot quietly re-write the coverage links (Requirement 13.8).
//
// ---------------------------------------------------------------------------------------------
// GENERATION NOTES
// ---------------------------------------------------------------------------------------------
// * `businessDate` and `now` are pinned, `sleep` is a no-op, and `smsPacingMs` is 0, so a run costs
//   no wall-clock time. Effective dates are built from integer day offsets against the fixed
//   business date rather than from `fc.date`, which on fast-check v4 needs `noInvalidDate: true` to
//   avoid emitting `Invalid Date`; offsets 15, 10, 5, and 1 land a Touchpoint on the business date,
//   and 20, 12, 7, 3, 0, and -4 do not, so the run also sees cases it must leave alone.
// * Case_Status is drawn from all ten values of Requirement 15.1, weighted toward Imported and Open
//   so sends actually happen (Requirement 12.12 excludes the other eight).
// * Contacts are 0 to 4 per channel with independently drawn validation status, authorization
//   status, and per-contact suppression flag, plus a separate `cancellation_suppressions` list that
//   suppresses by value — the two halves of Requirement 21.3 that `eligibleContacts` checks.
// * Provider failures are non-retryable, so one message is one provider call. The Requirement 23.8
//   email retry policy is its own suite (`send.test.ts`) and a retried message would only blur the
//   call-count identity this property asserts.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmailSendInput, EmailSendResult } from '@/lib/email';
import type { SmsSendResult } from '@/lib/ringcentral-sms';

import { addDays } from '../../../renewals/derive';
import { CASE_STATUSES, type CaseStatus } from '../../domain/communication-status';
import type {
  ContactAuthorizationStatus,
  ContactChannel,
  ContactValidationStatus,
} from '../../import/contacts';
import { TOUCHPOINTS, type TemplateLanguage, type Touchpoint } from '../../render/renderMessage';
import { SCHEDULER_SKIP_REASONS, runScheduler, type SchedulerRunSummary } from '../run';
import { UNIQUE_VIOLATION_CODE, type SendProviders } from '../send';

/**
 * Runs of the property. Requirement 25.5 and task 14.3 set the floor at 100; each world drives up to
 * 11 scheduler runs and the whole file still finishes inside a second, so it runs 300.
 */
const NUM_RUNS = 300;

/** The pinned business date of every run, so the Touchpoint arithmetic is fixed. */
const BUSINESS_DATE = '2025-06-16';

/** The pinned clock. Send times, escalation times, and deadlines all cut from this. */
const FIXED_NOW = new Date('2025-06-16T13:45:00.000Z');

// ---------------------------------------------------------------------------
// The in-memory store
// ---------------------------------------------------------------------------

type StoredRow = Record<string, unknown>;

interface StoreError {
  code?: string;
  message: string;
}

interface PostgrestResult {
  data: unknown;
  error: StoreError | null;
}

/** Every table the batch reads or writes; see the read list in `run.ts`'s header. */
const MODELLED_TABLES = [
  'cancellation_settings',
  'cancellation_cases',
  'cancellation_contacts',
  'cancellation_suppressions',
  'cancellation_communications',
  'cancellation_communication_cases',
  'cancellation_escalations',
  'cancellation_customer_responses',
  'cancellation_templates',
  'cancellation_template_versions',
  'cancellation_prohibited_phrases',
  'cancellation_events',
  'user_notifications',
  'profiles',
] as const;

/** The two unique constraints this property rests on, both raised as `23505`. */
const UNIQUE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  cancellation_communications: ['case_id', 'contact_id', 'touchpoint', 'channel'],
  cancellation_escalations: ['case_id', 'reason'],
};

/** The only columns `cancellation_retry_communication` is permitted to move (Req 14.16, 22.8). */
const RETRY_COLUMNS = [
  'send_time',
  'provider_message_id',
  'delivery_result',
  'failure_reason',
  'attempt_count',
] as const;

type QueryOperation = 'select' | 'insert' | 'update';

interface QuerySpec {
  table: string;
  op: QueryOperation;
  rows: StoredRow[];
  values: StoredRow;
  filters: ((row: StoredRow) => boolean)[];
  single: boolean;
}

interface QueryChain extends PromiseLike<PostgrestResult> {
  select(columns?: string): QueryChain;
  insert(payload: StoredRow | readonly StoredRow[]): QueryChain;
  update(values: StoredRow): QueryChain;
  in(column: string, values: readonly unknown[]): QueryChain;
  is(column: string, value: unknown): QueryChain;
  eq(column: string, value: unknown): QueryChain;
  not(column: string, operator: string, value: unknown): QueryChain;
  single(): PromiseLike<PostgrestResult>;
}

const clone = (row: StoredRow): StoredRow => ({ ...row });

const isAbsent = (value: unknown): boolean => value === null || value === undefined;

interface Store {
  client: SupabaseClient;
  rows(table: string): StoredRow[];
  /** Every stored Idempotency_Key as `case|contact|touchpoint|channel`, sorted. */
  communicationKeys(): string[];
  /**
   * The messages the stored rows partition into: one per row with no `combined_group_id`, and one
   * per distinct group id (Requirement 13.8). This is the denominator of "one provider call per
   * message" that Requirement 13.4 fixes.
   */
  messageCount(): number;
  /** Every table or function the batch touched that this double does not model. */
  unmodelled: string[];
  rpcCalls: { name: string; args: Record<string, unknown> }[];
  /** `23505` answers issued, per table: the constraint actually firing rather than being assumed. */
  conflicts: { communications: number; escalations: number };
}

function createStore(world: World): Store {
  const tables = new Map<string, StoredRow[]>();
  for (const table of MODELLED_TABLES) tables.set(table, []);
  const uniqueIndexes = new Map<string, Set<string>>();
  const unmodelled: string[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const conflicts = { communications: 0, escalations: 0 };
  let sequence = 0;

  const uniqueIndexOf = (table: string): Set<string> => {
    const existing = uniqueIndexes.get(table);
    if (existing !== undefined) return existing;
    const created = new Set<string>();
    uniqueIndexes.set(table, created);
    return created;
  };

  const uniqueKeyOf = (table: string, row: StoredRow): string | null => {
    const columns = UNIQUE_COLUMNS[table];
    if (columns === undefined) return null;
    return columns.map((column) => String(row[column])).join('|');
  };

  const seed = (table: string, rows: readonly StoredRow[]): void => {
    const target = tables.get(table);
    if (target === undefined) throw new Error(`cannot seed unmodelled table ${table}`);
    for (const row of rows) {
      const key = uniqueKeyOf(table, row);
      if (key !== null) uniqueIndexOf(table).add(key);
      target.push({ ...row });
    }
  };

  function insertRows(spec: QuerySpec, rows: StoredRow[]): PostgrestResult {
    // Validated before anything is stored, so a conflicting row of a multi-row insert leaves the
    // table exactly as the live statement would: nothing written.
    const index = UNIQUE_COLUMNS[spec.table] === undefined ? null : uniqueIndexOf(spec.table);
    if (index !== null) {
      const pending = new Set<string>();
      for (const payload of spec.rows) {
        const key = uniqueKeyOf(spec.table, payload) ?? '';
        if (index.has(key) || pending.has(key)) {
          if (spec.table === 'cancellation_communications') conflicts.communications += 1;
          if (spec.table === 'cancellation_escalations') conflicts.escalations += 1;
          return {
            data: null,
            error: {
              code: UNIQUE_VIOLATION_CODE,
              message: `duplicate key value violates unique constraint "${spec.table}_idempotency_key"`,
            },
          };
        }
        pending.add(key);
      }
    }

    const inserted: StoredRow[] = [];
    for (const payload of spec.rows) {
      sequence += 1;
      const stored: StoredRow = { id: `${spec.table}-${sequence}`, ...payload };
      if (index !== null) index.add(uniqueKeyOf(spec.table, stored) ?? '');
      rows.push(stored);
      inserted.push(stored);
    }

    if (spec.single) {
      return { data: inserted.length === 0 ? null : clone(inserted[0]), error: null };
    }
    return { data: inserted.map(clone), error: null };
  }

  function execute(spec: QuerySpec): PostgrestResult {
    const rows = tables.get(spec.table);
    if (rows === undefined) {
      unmodelled.push(`${spec.op} ${spec.table}`);
      return {
        data: null,
        error: { message: `the batch touched ${spec.table}, which this store does not model` },
      };
    }

    if (spec.op === 'insert') return insertRows(spec, rows);

    const matched = rows.filter((row) => spec.filters.every((filter) => filter(row)));
    if (spec.op === 'update') {
      for (const row of matched) Object.assign(row, spec.values);
    }
    return { data: matched.map(clone), error: null };
  }

  function chain(table: string): QueryChain {
    const spec: QuerySpec = { table, op: 'select', rows: [], values: {}, filters: [], single: false };
    const api: QueryChain = {
      select() {
        return api;
      },
      insert(payload) {
        spec.op = 'insert';
        spec.rows = Array.isArray(payload) ? [...(payload as readonly StoredRow[])] : [payload as StoredRow];
        return api;
      },
      update(values) {
        spec.op = 'update';
        spec.values = values;
        return api;
      },
      in(column, values) {
        spec.filters.push((row) => values.includes(row[column]));
        return api;
      },
      is(column, value) {
        spec.filters.push((row) => (isAbsent(value) ? isAbsent(row[column]) : row[column] === value));
        return api;
      },
      eq(column, value) {
        spec.filters.push((row) => row[column] === value);
        return api;
      },
      not(column, operator, value) {
        // The one form the batch uses: `.not('cleared_at', 'is', null)`.
        spec.filters.push((row) => (operator === 'is' && isAbsent(value) ? !isAbsent(row[column]) : row[column] !== value));
        return api;
      },
      single() {
        spec.single = true;
        return {
          then: <TResult1 = PostgrestResult, TResult2 = never>(
            onfulfilled?: ((value: PostgrestResult) => TResult1 | PromiseLike<TResult1>) | null,
            onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
          ) => Promise.resolve(execute(spec)).then(onfulfilled, onrejected),
        };
      },
      then<TResult1 = PostgrestResult, TResult2 = never>(
        onfulfilled?: ((value: PostgrestResult) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute(spec)).then(onfulfilled, onrejected);
      },
    };
    return api;
  }

  async function rpc(name: string, args: Record<string, unknown>): Promise<PostgrestResult> {
    rpcCalls.push({ name, args });

    if (name === 'cancellation_recompute_communication_status') {
      // The live function derives Communication_Status under a row lock. It never writes
      // Case_Status, so nothing it does can change which Touchpoints a later run may send.
      return { data: null, error: null };
    }

    if (name === 'cancellation_retry_communication') {
      const row = tables
        .get('cancellation_communications')!
        .find((stored) => stored.id === args.p_communication_id);
      if (row === undefined) {
        return { data: null, error: { code: 'P0002', message: 'no such Communication_Record' } };
      }
      const nextAttempts = args.p_attempt_count as number | null;
      if (nextAttempts !== null && nextAttempts < (row.attempt_count as number)) {
        return { data: null, error: { code: '22023', message: 'cannot lower attempt_count' } };
      }
      // Only the five permitted columns move, and the write is driven by that list rather than by
      // hand, so a helper that tried to change a template version, subject, or body could not.
      const patch: StoredRow = {
        send_time: (args.p_send_time as string | null) ?? row.send_time,
        provider_message_id: args.p_provider_message_id as string | null,
        delivery_result: args.p_delivery_result as string,
        failure_reason: args.p_failure_reason as string | null,
        attempt_count: nextAttempts ?? row.attempt_count,
      };
      for (const column of RETRY_COLUMNS) row[column] = patch[column];
      return { data: clone(row), error: null };
    }

    unmodelled.push(`rpc ${name}`);
    return { data: null, error: { message: `unknown function ${name}` } };
  }

  const client = { from: chain, rpc } as unknown as SupabaseClient;

  seed('cancellation_settings', [
    {
      automatic_sending_enabled: world.automaticSendingEnabled,
      office_phone: '(704) 824-3130',
      agency_name: 'New Hope Insurance Agency',
      bilingual_separator: '\n---\n',
      holidays: [],
    },
  ]);
  seed('cancellation_cases', caseRowsOf(world));
  seed('cancellation_contacts', contactRowsOf(world));
  seed('cancellation_suppressions', suppressionRowsOf(world));
  seed('cancellation_templates', TEMPLATE_ROWS);
  seed('cancellation_template_versions', TEMPLATE_VERSION_ROWS);
  seed('profiles', PROFILE_ROWS);

  return {
    client,
    rows: (table) => tables.get(table) ?? [],
    communicationKeys() {
      return (tables.get('cancellation_communications') ?? [])
        .map((row) => `${row.case_id}|${row.contact_id}|${row.touchpoint}|${row.channel}`)
        .sort();
    },
    messageCount() {
      const rows = tables.get('cancellation_communications') ?? [];
      const singles = rows.filter((row) => isAbsent(row.combined_group_id)).length;
      const groups = new Set(
        rows.filter((row) => !isAbsent(row.combined_group_id)).map((row) => String(row.combined_group_id)),
      );
      return singles + groups.size;
    },
    unmodelled,
    rpcCalls,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Fixed reference data
// ---------------------------------------------------------------------------

const MANAGER_PROFILE_ID = 'profile-manager';
const AGENT_PROFILE_ID = 'profile-agent';

const PROFILE_ROWS: readonly StoredRow[] = [
  { id: MANAGER_PROFILE_ID, display_name: 'Dana Whitfield', role: 'manager', is_active: true },
  { id: AGENT_PROFILE_ID, display_name: 'Maria Lopez', role: 'agent', is_active: true },
];

const TEMPLATE_ROWS: readonly StoredRow[] = TOUCHPOINTS.map((touchpoint) => ({
  id: `template-${touchpoint}`,
  touchpoint,
}));

const STATEMENTS: Readonly<Record<TemplateLanguage, string>> = {
  English: 'According to our records, your policy is scheduled for cancellation.',
  Spanish: 'Según nuestros registros, su póliza está programada para cancelación.',
};

const CONTACT_REQUESTS: Readonly<Record<TemplateLanguage, string>> = {
  English: 'Please call our office before {{Contact_Deadline}} so we can review your options.',
  Spanish: 'Comuníquese con nuestra oficina antes del {{Contact_Deadline}} para revisar sus opciones.',
};

const TEMPLATE_BODIES: Readonly<Record<TemplateLanguage, string>> = {
  English: [
    '{{Cancellation_Statement}}',
    'Customer: {{Customer_Name}}',
    'Policy: {{Policy_Number}}',
    'Cancellation effective date: {{Cancellation_Date}}',
    'Amount due: {{Amount_Due}}',
    '{{Contact_Request}}',
    '{{Sender_Name}} - {{Agency_Name}} - {{Office_Phone}}',
  ].join('\n'),
  Spanish: [
    '{{Cancellation_Statement}}',
    'Cliente: {{Customer_Name}}',
    'Póliza: {{Policy_Number}}',
    'Fecha efectiva de cancelación: {{Cancellation_Date}}',
    'Monto debido: {{Amount_Due}}',
    '{{Contact_Request}}',
    '{{Sender_Name}} - {{Agency_Name}} - {{Office_Phone}}',
  ].join('\n'),
};

const TEMPLATE_SUBJECTS: Readonly<Record<TemplateLanguage, string>> = {
  English: 'Cancellation notice for {{Customer_Name}} - policy {{Policy_Number}}',
  Spanish: 'Aviso de cancelación para {{Customer_Name}} - póliza {{Policy_Number}}',
};

/** One English and one Spanish version for each of the four Touchpoints, as `v1.10.9` seeds. */
const TEMPLATE_VERSION_ROWS: readonly StoredRow[] = TOUCHPOINTS.flatMap((touchpoint) =>
  (['English', 'Spanish'] as const).map((language) => ({
    id: `version-${touchpoint}-${language}`,
    template_id: `template-${touchpoint}`,
    version: 1,
    language,
    subject: TEMPLATE_SUBJECTS[language],
    body: TEMPLATE_BODIES[language],
    cancellation_statement: STATEMENTS[language],
    contact_request: CONTACT_REQUESTS[language],
    fallback_text: null,
  })),
);

// ---------------------------------------------------------------------------
// The generated world
// ---------------------------------------------------------------------------

/** Contact values from small pools, so cases share buckets and grouping is exercised. */
const PHONE_VALUES = ['+17045550101', '+17045550102', '+17045550103'] as const;
const EMAIL_VALUES = ['ana.reyes@example.com', 'luis.gomez@example.com', 'office@example.com'] as const;

/** Match keys from a small pool, plus the absent forms that must never join a bucket (Req 13.6). */
const MATCH_KEYS = ['reyes|704', 'gomez|305', 'lopez|786'] as const;

const CUSTOMER_NAMES = ['Ana Reyes', 'Luis Gómez', 'Marta López', 'Carlos Duarte'] as const;
const POLICY_NUMBERS = ['BWG63424074', '007-ABC-991', 'AAA1234567', 'PLP0000123'] as const;
const CARRIERS = ['Progressive', 'Infinity Insurance', 'United Automobile'] as const;
const REASONS = ['Non-payment of premium', 'Insufficient funds'] as const;

/**
 * Day offsets from the fixed business date. 15, 10, 5, and 1 land a Touchpoint on the business date;
 * the rest do not, and a case at offset 1 also carries three Touchpoints whose due date has passed.
 */
const EFFECTIVE_DATE_OFFSETS = [15, 10, 5, 1, 20, 12, 7, 3, 0, -4] as const;

interface GeneratedContact {
  readonly channel: ContactChannel;
  readonly value: string;
  readonly validation: ContactValidationStatus;
  readonly authorization: ContactAuthorizationStatus;
  readonly flagSuppressed: boolean;
  readonly preferredLanguage: string | null;
  readonly contactName: string | null;
}

interface GeneratedCase {
  readonly offsetDays: number;
  readonly caseStatus: CaseStatus;
  readonly matchKey: string | null;
  readonly customerName: string;
  readonly policyNumber: string;
  readonly carrier: string | null;
  readonly reason: string | null;
  readonly amountDue: number | null;
  readonly assignedTo: string | null;
  readonly phoneContacts: readonly GeneratedContact[];
  readonly emailContacts: readonly GeneratedContact[];
}

interface World {
  readonly cases: readonly GeneratedCase[];
  readonly suppressions: readonly { readonly channel: 'sms' | 'email'; readonly value: string }[];
  readonly automaticSendingEnabled: boolean;
  readonly emailConfigured: boolean;
  /** Recipient values the provider refuses, non-retryably, so one message is one call. */
  readonly failingRecipients: readonly string[];
  /** How many consecutive runs execute: Requirement 12.3's "however many runs execute". */
  readonly runCount: number;
}

const validationArb: fc.Arbitrary<ContactValidationStatus> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<ContactValidationStatus>('valid') },
  { weight: 1, arbitrary: fc.constant<ContactValidationStatus>('invalid') },
);

const authorizationArb: fc.Arbitrary<ContactAuthorizationStatus> = fc.oneof(
  { weight: 4, arbitrary: fc.constant<ContactAuthorizationStatus>('Authorized') },
  { weight: 2, arbitrary: fc.constant<ContactAuthorizationStatus>('Unknown') },
  { weight: 1, arbitrary: fc.constant<ContactAuthorizationStatus>('Not Authorized') },
);

const suppressedFlagArb: fc.Arbitrary<boolean> = fc.oneof(
  { weight: 5, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);

const preferredLanguageArb: fc.Arbitrary<string | null> = fc.constantFrom<string | null>(
  'English',
  'Spanish',
  'Bilingual',
  null,
);

function contactArb(channel: ContactChannel): fc.Arbitrary<GeneratedContact> {
  return fc.record({
    channel: fc.constant(channel),
    value: fc.constantFrom(...(channel === 'phone' ? PHONE_VALUES : EMAIL_VALUES)),
    validation: validationArb,
    authorization: authorizationArb,
    flagSuppressed: suppressedFlagArb,
    preferredLanguage: preferredLanguageArb,
    contactName: fc.constantFrom<string | null>('Ana Reyes', 'Luis Gómez', null),
  });
}

const caseStatusArb: fc.Arbitrary<CaseStatus> = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom<CaseStatus>('Imported', 'Open') },
  { weight: 4, arbitrary: fc.constantFrom(...CASE_STATUSES) },
);

const caseArb: fc.Arbitrary<GeneratedCase> = fc.record({
  offsetDays: fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom(15, 10, 5, 1) },
    { weight: 2, arbitrary: fc.constantFrom(...EFFECTIVE_DATE_OFFSETS) },
  ),
  caseStatus: caseStatusArb,
  matchKey: fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom<string | null>(...MATCH_KEYS) },
    { weight: 1, arbitrary: fc.constantFrom<string | null>(null, '') },
  ),
  customerName: fc.constantFrom(...CUSTOMER_NAMES),
  policyNumber: fc.constantFrom(...POLICY_NUMBERS),
  carrier: fc.constantFrom<string | null>(...CARRIERS, null),
  reason: fc.constantFrom<string | null>(...REASONS, null),
  amountDue: fc.constantFrom<number | null>(148.5, 1250, 0.01, null),
  assignedTo: fc.constantFrom<string | null>(MANAGER_PROFILE_ID, AGENT_PROFILE_ID, null),
  phoneContacts: fc.array(contactArb('phone'), { minLength: 0, maxLength: 4 }),
  emailContacts: fc.array(contactArb('email'), { minLength: 0, maxLength: 4 }),
});

const worldArb: fc.Arbitrary<World> = fc.record({
  cases: fc.array(caseArb, { minLength: 1, maxLength: 12 }),
  suppressions: fc.array(
    fc.record({
      channel: fc.constantFrom<'sms' | 'email'>('sms', 'email'),
      value: fc.constantFrom<string>(...PHONE_VALUES, ...EMAIL_VALUES),
    }),
    { maxLength: 2 },
  ),
  automaticSendingEnabled: fc.oneof(
    { weight: 9, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  emailConfigured: fc.oneof(
    { weight: 4, arbitrary: fc.constant(true) },
    { weight: 1, arbitrary: fc.constant(false) },
  ),
  failingRecipients: fc.subarray([...PHONE_VALUES, ...EMAIL_VALUES], { maxLength: 2 }),
  runCount: fc.integer({ min: 2, max: 5 }),
});

// ---------------------------------------------------------------------------
// World -> stored rows
// ---------------------------------------------------------------------------

const caseIdOf = (index: number): string => `case-${index + 1}`;

function caseRowsOf(world: World): StoredRow[] {
  return world.cases.map((row, index) => ({
    id: caseIdOf(index),
    policy_number: row.policyNumber,
    cancellation_effective_date: addDays(BUSINESS_DATE, row.offsetDays),
    customer_name: row.customerName,
    customer_match_key: row.matchKey,
    carrier: row.carrier,
    cancellation_reason: row.reason,
    amount_due: row.amountDue,
    case_status: row.caseStatus,
    communication_status: 'Scheduled',
    next_required_action: null,
    assigned_to: row.assignedTo,
    producer_label: null,
    follow_up_deadline: null,
    assistance_requested: false,
  }));
}

function contactRowsOf(world: World): StoredRow[] {
  const rows: StoredRow[] = [];
  world.cases.forEach((generated, index) => {
    const caseId = caseIdOf(index);
    [...generated.phoneContacts, ...generated.emailContacts].forEach((contact, position) => {
      rows.push({
        id: `${caseId}-contact-${position + 1}`,
        case_id: caseId,
        channel: contact.channel,
        normalized_value: contact.value,
        validation_status: contact.validation,
        authorization_status: contact.authorization,
        sms_suppressed: contact.channel === 'phone' ? contact.flagSuppressed : false,
        email_suppressed: contact.channel === 'email' ? contact.flagSuppressed : false,
        is_primary: position === 0,
        preferred_language: contact.preferredLanguage,
        contact_name: contact.contactName,
        segment_index: position,
      });
    });
  });
  return rows;
}

function suppressionRowsOf(world: World): StoredRow[] {
  // `unique (channel, normalized_value) where cleared_at is null`: one active row per pair.
  const seen = new Set<string>();
  const rows: StoredRow[] = [];
  world.suppressions.forEach((entry) => {
    const key = `${entry.channel}|${entry.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({
      id: `suppression-${rows.length + 1}`,
      channel: entry.channel,
      normalized_value: entry.value,
      cleared_at: null,
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// One scheduler instance: its own providers, its own call counters
// ---------------------------------------------------------------------------

interface SchedulerInstance {
  run(client: SupabaseClient): Promise<SchedulerRunSummary>;
  readonly providerCalls: number;
}

function createScheduler(world: World, label: string): SchedulerInstance {
  const smsCalls: { to: string; text: string }[] = [];
  const emailCalls: EmailSendInput[] = [];
  let groupSequence = 0;

  const providers: SendProviders = {
    sendSms: async (to, text): Promise<SmsSendResult> => {
      smsCalls.push({ to, text });
      if (world.failingRecipients.includes(to)) {
        return { success: false, error: 'RingCentral refused the message.' };
      }
      return { success: true, messageId: `${label}-sms-${smsCalls.length}` };
    },
    sendEmail: async (input): Promise<EmailSendResult> => {
      emailCalls.push(input);
      if (world.failingRecipients.includes(input.to)) {
        // Non-retryable: one message, one provider call. Req 23.8's retry policy is send.test.ts.
        return { success: false, messageId: null, failureReason: 'HTTP 422 rejected', retryable: false };
      }
      return { success: true, messageId: `${label}-email-${emailCalls.length}`, failureReason: null, retryable: false };
    },
    isEmailConfigured: () => world.emailConfigured,
  };

  return {
    run: (client) =>
      runScheduler({
        client,
        providers,
        now: () => FIXED_NOW,
        businessDate: BUSINESS_DATE,
        sleep: async () => undefined,
        smsPacingMs: 0,
        newGroupId: () => {
          groupSequence += 1;
          return `${label}-group-${groupSequence}`;
        },
        actor: null,
      }),
    get providerCalls() {
      return smsCalls.length + emailCalls.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Summary invariants asserted for every run of every world
// ---------------------------------------------------------------------------

function assertSummaryAccounting(summary: SchedulerRunSummary): void {
  expect(summary.businessDate).toBe(BUSINESS_DATE);
  // Every evaluated unit lands in exactly one bucket, which is what makes "every skipped key is in
  // the skipped total" a checkable statement rather than a wish.
  expect(summary.touchpointsEvaluated).toBe(summary.sent + summary.skipped + summary.failed);
  expect(Object.keys(summary.skippedByReason).sort()).toEqual([...SCHEDULER_SKIP_REASONS].sort());
  const byReason = SCHEDULER_SKIP_REASONS.reduce(
    (total, reason) => total + summary.skippedByReason[reason],
    0,
  );
  expect(byReason).toBe(summary.skipped);
}

// ---------------------------------------------------------------------------
// The store double is the constraint, so prove it conflicts
// ---------------------------------------------------------------------------

const SINGLE_CASE_WORLD: World = {
  cases: [
    {
      offsetDays: 15,
      caseStatus: 'Open',
      matchKey: MATCH_KEYS[0],
      customerName: CUSTOMER_NAMES[0],
      policyNumber: POLICY_NUMBERS[0],
      carrier: CARRIERS[0],
      reason: REASONS[0],
      amountDue: 1250,
      assignedTo: AGENT_PROFILE_ID,
      phoneContacts: [
        {
          channel: 'phone',
          value: PHONE_VALUES[0],
          validation: 'valid',
          authorization: 'Authorized',
          flagSuppressed: false,
          preferredLanguage: 'English',
          contactName: 'Ana Reyes',
        },
      ],
      emailContacts: [],
    },
  ],
  suppressions: [],
  automaticSendingEnabled: true,
  emailConfigured: true,
  failingRecipients: [],
  runCount: 2,
};

describe('Property 2 — the store double enforces the Idempotency_Key', () => {
  it('answers 23505 for a second Communication_Record on one Idempotency_Key', async () => {
    const store = createStore(SINGLE_CASE_WORLD);
    const row = {
      case_id: 'case-1',
      contact_id: 'case-1-contact-1',
      touchpoint: 15 as Touchpoint,
      channel: 'sms',
      template_version_id: 'version-15-English',
      rendered_subject: '',
      rendered_body: 'body',
      send_time: FIXED_NOW.toISOString(),
      provider_message_id: null,
      delivery_result: 'Sent',
      failure_reason: null,
      attempt_count: 1,
      combined_group_id: null,
    };

    const first = await store.client.from('cancellation_communications').insert(row).select('id').single();
    expect(first.error).toBeNull();

    const second = await store.client.from('cancellation_communications').insert(row).select('id').single();
    expect(second.error?.code).toBe(UNIQUE_VIOLATION_CODE);
    expect(store.rows('cancellation_communications')).toHaveLength(1);

    // The same conflict on the escalation pair, which is how one notification survives n runs.
    const raise = { case_id: 'case-1', reason: 'no_delivered_contact', raised_at: FIXED_NOW.toISOString() };
    expect((await store.client.from('cancellation_escalations').insert(raise).select('id')).error).toBeNull();
    expect(
      (await store.client.from('cancellation_escalations').insert(raise).select('id')).error?.code,
    ).toBe(UNIQUE_VIOLATION_CODE);
  });
});

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe('Property 2 — scheduler idempotency across repeated runs', () => {
  it('produces the first run key set and one provider call per message, however many runs execute', async () => {
    const observed = {
      worlds: 0,
      worldsThatSent: 0,
      worldsThatCombined: 0,
      worldsWithoutCombining: 0,
      worldsWithProviderFailure: 0,
      worldsWithRepeatSkips: 0,
      worldsWithRaceConflicts: 0,
      worldsWithPassedTouchpoints: 0,
      worldsWithExcludedStatus: 0,
      worldsWithKillSwitchOff: 0,
      worldsWithoutEmailCredentials: 0,
      keysWritten: 0,
      providerCalls: 0,
    };

    await fc.assert(
      fc.asyncProperty(worldArb, async (world) => {
        // ── The reference: exactly one run, over a fresh store.
        const reference = createStore(world);
        const referenceScheduler = createScheduler(world, 'ref');
        const firstSummary = await referenceScheduler.run(reference.client);
        const firstKeys = reference.communicationKeys();
        const firstMessages = reference.messageCount();

        expect(reference.unmodelled).toEqual([]);
        expect(firstSummary.failures).toEqual([]);
        assertSummaryAccounting(firstSummary);

        // Every stored key came from a reserve-then-send, and every message made one provider call.
        expect(firstSummary.sent + firstSummary.failed).toBe(firstKeys.length);
        expect(firstSummary.communicationRowsWritten).toBe(firstKeys.length);
        expect(firstMessages).toBe(firstSummary.messagesAttempted);
        expect(referenceScheduler.providerCalls).toBe(firstMessages);
        expect(reference.rows('cancellation_communication_cases')).toHaveLength(firstKeys.length);

        // The literal per-key form, where one message covers exactly one key (Requirement 13.4).
        if (firstSummary.combinedMessages === 0) {
          expect(referenceScheduler.providerCalls).toBe(firstKeys.length);
        }

        // ── n consecutive runs over one store, n from 2 to 5 (Requirement 12.3).
        const repeated = createStore(world);
        const repeatedScheduler = createScheduler(world, 'repeat');
        const summaries: SchedulerRunSummary[] = [];
        const callsPerRun: number[] = [];
        for (let index = 0; index < world.runCount; index += 1) {
          const before = repeatedScheduler.providerCalls;
          summaries.push(await repeatedScheduler.run(repeated.client));
          callsPerRun.push(repeatedScheduler.providerCalls - before);
        }

        expect(repeated.unmodelled).toEqual([]);

        // (1) The stored Idempotency_Key set after n runs is the set the first run alone produces.
        expect(repeated.communicationKeys()).toEqual(firstKeys);

        // (2) One provider call per message of the first run, and not one more afterwards.
        expect(repeatedScheduler.providerCalls).toBe(firstMessages);
        expect(callsPerRun[0]).toBe(firstMessages);
        expect(callsPerRun.slice(1)).toEqual(callsPerRun.slice(1).map(() => 0));
        expect(repeated.messageCount()).toBe(firstMessages);
        expect(repeated.rows('cancellation_communication_cases')).toHaveLength(firstKeys.length);

        // (3) Every run accounts for every unit, and every stored key is counted skipped in every
        //     run after the first (Requirements 12.5, 12.7).
        summaries.forEach((summary, index) => {
          expect(summary.failures).toEqual([]);
          assertSummaryAccounting(summary);
          if (index === 0) {
            expect(summary.sent).toBe(firstSummary.sent);
            expect(summary.failed).toBe(firstSummary.failed);
            expect(summary.skipped).toBe(firstSummary.skipped);
            expect(summary.skippedByReason).toEqual(firstSummary.skippedByReason);
            return;
          }
          expect(summary.sent).toBe(0);
          expect(summary.failed).toBe(0);
          expect(summary.messagesAttempted).toBe(0);
          expect(summary.communicationRowsWritten).toBe(0);
          expect(summary.skippedByReason.existing_record).toBe(firstKeys.length);
        });

        // A sequential later run never even offers a stored key to the constraint: the
        // `cancellation_communications` pre-read filters it first, so the batch is idempotent
        // before the unique index is reached rather than because of it.
        expect(repeated.conflicts.communications).toBe(0);

        // (4) Two schedulers driven alternately against one store reach the same set, and the one
        //     that never sees an unreserved key calls no provider at all (Requirement 12.6).
        const shared = createStore(world);
        const alpha = createScheduler(world, 'alpha');
        const beta = createScheduler(world, 'beta');
        for (let index = 0; index < world.runCount; index += 1) {
          await (index % 2 === 0 ? alpha : beta).run(shared.client);
        }
        expect(shared.unmodelled).toEqual([]);
        expect(shared.communicationKeys()).toEqual(firstKeys);
        expect(alpha.providerCalls + beta.providerCalls).toBe(firstMessages);
        expect(beta.providerCalls).toBe(0);
        expect(shared.messageCount()).toBe(firstMessages);
        expect(shared.conflicts.communications).toBe(0);

        // (5) The same two schedulers racing one store, which is the shape Requirement 12.6 names:
        //     whichever run loses the race for a key catches the `23505`, abandons that send
        //     without touching a provider, and counts the key skipped (Requirement 12.7). At most
        //     one Communication_Record exists for one Idempotency_Key however the two interleave.
        const raced = createStore(world);
        const racerA = createScheduler(world, 'racer-a');
        const racerB = createScheduler(world, 'racer-b');
        const [racedA, racedB] = await Promise.all([racerA.run(raced.client), racerB.run(raced.client)]);

        expect(raced.unmodelled).toEqual([]);
        expect(racedA.failures).toEqual([]);
        expect(racedB.failures).toEqual([]);
        assertSummaryAccounting(racedA);
        assertSummaryAccounting(racedB);
        expect(raced.communicationKeys()).toEqual(firstKeys);
        expect(raced.rows('cancellation_communication_cases')).toHaveLength(firstKeys.length);
        // Every stored key was reserved and recorded by exactly one of the two runs.
        expect(racedA.sent + racedA.failed + racedB.sent + racedB.failed).toBe(firstKeys.length);
        // Neither run sends a message it reserved nothing for, and neither sends one twice.
        expect(racerA.providerCalls + racerB.providerCalls).toBeGreaterThanOrEqual(
          firstKeys.length === 0 ? 0 : 1,
        );
        expect(racerA.providerCalls + racerB.providerCalls).toBeLessThanOrEqual(2 * firstMessages);

        // ── Bookkeeping for the non-vacuity assertions below.
        observed.worlds += 1;
        observed.keysWritten += firstKeys.length;
        observed.providerCalls += referenceScheduler.providerCalls;
        if (firstKeys.length > 0) observed.worldsThatSent += 1;
        if (firstSummary.combinedMessages > 0) observed.worldsThatCombined += 1;
        else if (firstKeys.length > 0) observed.worldsWithoutCombining += 1;
        if (firstSummary.failed > 0) observed.worldsWithProviderFailure += 1;
        if (summaries.slice(1).some((summary) => summary.skippedByReason.existing_record > 0)) {
          observed.worldsWithRepeatSkips += 1;
        }
        if (raced.conflicts.communications > 0) observed.worldsWithRaceConflicts += 1;
        if (firstSummary.skippedByReason.due_date_passed > 0) observed.worldsWithPassedTouchpoints += 1;
        if (firstSummary.skippedByReason.excluded_case_status > 0) observed.worldsWithExcludedStatus += 1;
        if (!firstSummary.automaticSendingEnabled) observed.worldsWithKillSwitchOff += 1;
        if (!firstSummary.emailConfigured) observed.worldsWithoutEmailCredentials += 1;
      }),
      { numRuns: NUM_RUNS },
    );

    // ── Non-vacuity. Every one of these would be zero for a property that never sent anything, a
    //    store that never conflicted, or a generator that never reached the interesting shapes.
    //    Each floor sits near half of the observed mean, so the assertions hold across seeds while
    //    still failing loudly if a generator edit hollows the world out.
    expect(observed.worlds).toBe(NUM_RUNS);
    expect(observed.keysWritten).toBeGreaterThan(600);
    expect(observed.providerCalls).toBeGreaterThan(400);
    expect(observed.worldsThatSent).toBeGreaterThan(NUM_RUNS / 3);
    expect(observed.worldsThatCombined).toBeGreaterThan(40);
    expect(observed.worldsWithoutCombining).toBeGreaterThan(15);
    expect(observed.worldsWithProviderFailure).toBeGreaterThan(20);
    expect(observed.worldsWithRepeatSkips).toBeGreaterThan(NUM_RUNS / 3);
    // The constraint firing inside the batch, not just in the store's own test above.
    expect(observed.worldsWithRaceConflicts).toBeGreaterThan(NUM_RUNS / 4);
    expect(observed.worldsWithPassedTouchpoints).toBeGreaterThan(50);
    expect(observed.worldsWithExcludedStatus).toBeGreaterThan(50);
    expect(observed.worldsWithKillSwitchOff).toBeGreaterThan(3);
    expect(observed.worldsWithoutEmailCredentials).toBeGreaterThan(5);
  });
});
