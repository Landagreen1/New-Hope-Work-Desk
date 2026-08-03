//
// Feature: policy-follow-up-renewals-cancellations, task 14.2 — smoke coverage for the
// reserve-then-send helper `src/features/cancellations/scheduler/send.ts`.
//
// **Validates: Requirements 12.4, 12.5, 12.6, 12.7, 13.4, 13.8, 13.9, 14.15, 14.18, 23.4, 23.8**
//
// The broader scheduler suites are tasks 14.3 (the idempotency property) and 14.4 (the scheduler
// unit cases). This file pins the helper's own contract: the order of the three steps, the `23505`
// abandonment, the email retry policy, and the combined-message row set.
//
// The store double enforces `unique (case_id, contact_id, touchpoint, channel)` by raising `23505`
// exactly as the live constraint does, and its `cancellation_retry_communication` writes only
// `send_time`, `provider_message_id`, `delivery_result`, `failure_reason`, and `attempt_count`, so a
// helper that tried to change a rendered subject or body would have no way to make it stick. It
// throws on any table other than the two this module is allowed to write, which is how the case
// status invariant of Requirements 13.9 and 15.4 is asserted: a write to `cancellation_cases` would
// fail the test rather than pass silently.
//
// Both providers are injected, so nothing here reaches RingCentral or Resend, and `sleep` is
// injected, so the three-attempt email case runs in milliseconds instead of 20 seconds.

import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmailSendInput, EmailSendResult } from '@/lib/email';
import type { SmsSendResult } from '@/lib/ringcentral-sms';

import type { RenderBlocked, RenderRendered } from '../../render/renderMessage';
import {
  DEFAULT_EMAIL_BACKOFF_MS,
  MAX_RETRY_BACKOFF_MS,
  MIN_RETRY_BACKOFF_MS,
  retryBackoffDelays,
  sendCommunication,
  type SendTarget,
} from '../send';

// ---------------------------------------------------------------------------
// The in-memory store
// ---------------------------------------------------------------------------

interface StoredCommunication {
  id: string;
  case_id: string;
  contact_id: string;
  touchpoint: number;
  channel: string;
  template_version_id: string;
  rendered_subject: string;
  rendered_body: string;
  send_time: string | null;
  provider_message_id: string | null;
  delivery_result: string;
  failure_reason: string | null;
  attempt_count: number;
  combined_group_id: string | null;
}

interface StoredLink {
  communication_id: string;
  combined_group_id: string;
  case_id: string;
}

interface PostgrestResult {
  data: unknown;
  error: { code?: string; message: string } | null;
}

const WRITABLE_TABLES = new Set(['cancellation_communications', 'cancellation_communication_cases']);

function createStore() {
  const communications: StoredCommunication[] = [];
  const links: StoredLink[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  let sequence = 0;

  const insertCommunication = (row: Record<string, unknown>): PostgrestResult => {
    const clash = communications.some(
      (stored) =>
        stored.case_id === row.case_id &&
        stored.contact_id === row.contact_id &&
        stored.touchpoint === row.touchpoint &&
        stored.channel === row.channel,
    );
    if (clash) {
      return {
        data: null,
        error: {
          code: '23505',
          message:
            'duplicate key value violates unique constraint "cancellation_communications_idempotency_key"',
        },
      };
    }
    sequence += 1;
    const stored = { id: `comm-${sequence}`, ...row } as unknown as StoredCommunication;
    communications.push(stored);
    return { data: { id: stored.id }, error: null };
  };

  const client = {
    from(table: string) {
      if (!WRITABLE_TABLES.has(table)) {
        throw new Error(`send.ts wrote to ${table}, which it must never touch`);
      }
      return {
        insert(payload: Record<string, unknown> | Record<string, unknown>[]) {
          const rows = Array.isArray(payload) ? payload : [payload];
          let outcome: PostgrestResult = { data: null, error: null };

          if (table === 'cancellation_communications') {
            outcome = insertCommunication(rows[0]);
          } else {
            for (const row of rows) links.push(row as unknown as StoredLink);
            outcome = { data: rows, error: null };
          }

          return {
            select() {
              return {
                single: async (): Promise<PostgrestResult> => outcome,
                then: (resolve: (value: PostgrestResult) => unknown) => resolve(outcome),
              };
            },
            then: (resolve: (value: PostgrestResult) => unknown) => resolve(outcome),
          };
        },
      };
    },

    async rpc(name: string, args: Record<string, unknown>): Promise<PostgrestResult> {
      rpcCalls.push({ name, args });
      if (name !== 'cancellation_retry_communication') {
        return { data: null, error: { message: `unknown function ${name}` } };
      }

      const row = communications.find((stored) => stored.id === args.p_communication_id);
      if (row === undefined) {
        return { data: null, error: { code: 'P0002', message: 'no such Communication_Record' } };
      }
      const nextAttempts = args.p_attempt_count as number | null;
      if (nextAttempts !== null && nextAttempts < row.attempt_count) {
        return { data: null, error: { code: '22023', message: 'cannot lower attempt_count' } };
      }

      // Only the five permitted columns move; every other stored value is left alone.
      row.send_time = (args.p_send_time as string | null) ?? row.send_time;
      row.provider_message_id = args.p_provider_message_id as string | null;
      row.delivery_result = args.p_delivery_result as string;
      row.failure_reason = args.p_failure_reason as string | null;
      row.attempt_count = nextAttempts ?? row.attempt_count;

      return { data: row, error: null };
    },
  };

  return {
    communications,
    links,
    rpcCalls,
    client: client as unknown as SupabaseClient,
    seed(row: Partial<StoredCommunication> & Pick<StoredCommunication, 'case_id' | 'contact_id' | 'touchpoint' | 'channel'>) {
      sequence += 1;
      communications.push({
        id: `seeded-${sequence}`,
        template_version_id: 'tv-seeded',
        rendered_subject: 'seeded subject',
        rendered_body: 'seeded body',
        send_time: '2025-01-01T00:00:00.000Z',
        provider_message_id: 'seeded-provider-id',
        delivery_result: 'Sent',
        failure_reason: null,
        attempt_count: 1,
        combined_group_id: null,
        ...row,
      } as StoredCommunication);
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rendered(overrides: Partial<RenderRendered> = {}): RenderRendered {
  return {
    ok: true,
    subject: 'Your policy is scheduled for cancellation',
    body: 'New Hope Insurance Agency. Please call (704) 824-3130.',
    templateVersionId: 'tv-15-en',
    templateVersionIds: ['tv-15-en'],
    language: 'English',
    touchpoint: 15,
    senderName: 'Maria Lopez',
    truncated: false,
    ...overrides,
  };
}

const blocked: RenderBlocked = {
  ok: false,
  blockedBy: 'prohibited_phrase',
  match: 'your policy will be reinstated',
  field: 'body',
};

function target(caseId: string, touchpoint: SendTarget['touchpoint'] = 15): SendTarget {
  return { caseId, contactId: 'contact-1', touchpoint };
}

const FIXED_NOW = new Date('2025-03-10T15:04:05.000Z');

function smsSpy(results: SmsSendResult[]) {
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

function emailSpy(results: EmailSendResult[]) {
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

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('sendCommunication — reserve, send, record', () => {
  it('reserves before sending, then records the provider outcome on the reserved row', async () => {
    const store = createStore();
    const sms = smsSpy([{ success: true, messageId: 'rc-8801' }]);

    const outcome = await sendCommunication({
      channel: 'sms',
      recipient: '+17045551234',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendSms: sms.send },
      now: () => FIXED_NOW,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.counts).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(sms.calls).toEqual([
      { to: '+17045551234', text: 'New Hope Insurance Agency. Please call (704) 824-3130.' },
    ]);

    // One row, carrying the provider outcome and zero characters as the subject (Req 14.15).
    expect(store.communications).toHaveLength(1);
    const row = store.communications[0];
    expect(row.rendered_subject).toBe('');
    expect(row.rendered_body).toBe('New Hope Insurance Agency. Please call (704) 824-3130.');
    expect(row.delivery_result).toBe('Sent');
    expect(row.provider_message_id).toBe('rc-8801');
    expect(row.attempt_count).toBe(1);
    expect(row.combined_group_id).toBeNull();

    // The outcome went through the one permitted update path, with the live parameter names.
    expect(store.rpcCalls).toHaveLength(1);
    expect(store.rpcCalls[0]).toEqual({
      name: 'cancellation_retry_communication',
      args: {
        p_communication_id: row.id,
        p_delivery_result: 'Sent',
        p_provider_message_id: 'rc-8801',
        p_failure_reason: null,
        p_attempt_count: 1,
        p_send_time: FIXED_NOW.toISOString(),
      },
    });

    // Coverage link (Requirement 13.8); a single-case send groups under its own record.
    expect(store.links).toEqual([
      { communication_id: row.id, combined_group_id: row.id, case_id: 'case-1' },
    ]);
    expect(outcome.linkRowsWritten).toBe(1);
  });

  it('stores a success carrying no provider identifier as an absent value (Req 23.4)', async () => {
    const store = createStore();
    const email = emailSpy([{ success: true, messageId: null, failureReason: null, retryable: false }]);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendEmail: email.send },
      now: () => FIXED_NOW,
    });

    expect(outcome.counts.sent).toBe(1);
    expect(email.calls).toHaveLength(1);
    expect(email.calls[0].senderDisplayName).toBe('Maria Lopez');
    expect(store.communications[0].provider_message_id).toBeNull();
    expect(store.communications[0].delivery_result).toBe('Sent');
    expect(store.communications[0].rendered_subject).toBe(
      'Your policy is scheduled for cancellation',
    );
  });

  it('abandons the send on a 23505, calling no provider and leaving the stored row untouched', async () => {
    const store = createStore();
    store.seed({ case_id: 'case-1', contact_id: 'contact-1', touchpoint: 15, channel: 'sms' });
    const sms = smsSpy([{ success: true, messageId: 'must-not-happen' }]);

    const outcome = await sendCommunication({
      channel: 'sms',
      recipient: '+17045551234',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendSms: sms.send },
      now: () => FIXED_NOW,
    });

    expect(sms.calls).toHaveLength(0);
    expect(outcome.provider).toBeNull();
    expect(outcome.skipped).toEqual([
      {
        key: { caseId: 'case-1', contactId: 'contact-1', touchpoint: 15, channel: 'sms' },
        reason: 'existing_record',
      },
    ]);
    expect(outcome.counts).toEqual({ sent: 0, skipped: 1, failed: 0 });

    // No second row, and every stored value of the existing one is exactly as it was.
    expect(store.communications).toHaveLength(1);
    expect(store.communications[0]).toMatchObject({
      provider_message_id: 'seeded-provider-id',
      delivery_result: 'Sent',
      attempt_count: 1,
      rendered_subject: 'seeded subject',
      rendered_body: 'seeded body',
      send_time: '2025-01-01T00:00:00.000Z',
    });
    expect(store.rpcCalls).toHaveLength(0);
    expect(store.links).toHaveLength(0);
  });

  it('writes zero rows and calls no provider for a blocked render', async () => {
    const store = createStore();
    const email = emailSpy([{ success: true, messageId: 'must-not-happen', failureReason: null, retryable: false }]);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: blocked,
      targets: [target('case-1'), target('case-2')],
      client: store.client,
      providers: { sendEmail: email.send },
    });

    expect(email.calls).toHaveLength(0);
    expect(store.communications).toHaveLength(0);
    expect(outcome.blocked).toEqual({
      blockedBy: 'prohibited_phrase',
      match: 'your policy will be reinstated',
      field: 'body',
    });
    expect(outcome.skipped.map((entry) => entry.reason)).toEqual([
      'render_blocked',
      'render_blocked',
    ]);
  });

  it('writes zero rows for an email key when the email service is not configured (Req 23.3)', async () => {
    const store = createStore();
    const email = emailSpy([{ success: true, messageId: 'must-not-happen', failureReason: null, retryable: false }]);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendEmail: email.send, isEmailConfigured: () => false },
    });

    expect(email.calls).toHaveLength(0);
    expect(store.communications).toHaveLength(0);
    expect(outcome.skipped[0].reason).toBe('email_not_configured');
    expect(outcome.counts).toEqual({ sent: 0, skipped: 1, failed: 0 });
  });
});

describe('sendCommunication — email retry policy (Requirement 23.8)', () => {
  it('retries a retryable failure and records the attempt count of the successful attempt', async () => {
    const store = createStore();
    const email = emailSpy([
      { success: false, messageId: null, failureReason: 'HTTP 429', retryable: true },
      { success: true, messageId: 'resend-77', failureReason: null, retryable: false },
    ]);
    const waits = sleepSpy();

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendEmail: email.send },
      sleep: waits.sleep,
      now: () => FIXED_NOW,
    });

    expect(email.calls).toHaveLength(2);
    expect(waits.delays).toEqual([DEFAULT_EMAIL_BACKOFF_MS[0]]);
    expect(outcome.provider?.attempts).toBe(2);
    expect(store.communications).toHaveLength(1);
    expect(store.communications[0]).toMatchObject({
      delivery_result: 'Sent',
      provider_message_id: 'resend-77',
      failure_reason: null,
      attempt_count: 2,
    });
  });

  it('stops after two additional attempts and stores the final failure on one row', async () => {
    const store = createStore();
    const email = emailSpy([
      { success: false, messageId: null, failureReason: 'HTTP 500 first', retryable: true },
      { success: false, messageId: null, failureReason: 'HTTP 500 second', retryable: true },
      { success: false, messageId: null, failureReason: 'HTTP 503 final', retryable: true },
    ]);
    const waits = sleepSpy();

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendEmail: email.send },
      sleep: waits.sleep,
      now: () => FIXED_NOW,
    });

    expect(email.calls).toHaveLength(3);
    expect(waits.delays).toEqual([...DEFAULT_EMAIL_BACKOFF_MS]);
    for (const delay of waits.delays) {
      expect(delay).toBeGreaterThanOrEqual(MIN_RETRY_BACKOFF_MS);
      expect(delay).toBeLessThanOrEqual(MAX_RETRY_BACKOFF_MS);
    }

    expect(store.communications).toHaveLength(1);
    expect(store.communications[0]).toMatchObject({
      delivery_result: 'Failed',
      failure_reason: 'HTTP 503 final',
      attempt_count: 3,
      // Retained unchanged through the failure (Requirement 14.18).
      rendered_subject: 'Your policy is scheduled for cancellation',
      rendered_body: 'New Hope Insurance Agency. Please call (704) 824-3130.',
    });
    expect(outcome.counts).toEqual({ sent: 0, skipped: 0, failed: 1 });
    expect(outcome.keys[0].status).toBe('failed');
  });

  it('makes zero additional attempts after a non-retryable failure', async () => {
    const store = createStore();
    const email = emailSpy([
      { success: false, messageId: null, failureReason: 'HTTP 422 invalid address', retryable: false },
    ]);
    const waits = sleepSpy();

    await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1')],
      client: store.client,
      providers: { sendEmail: email.send },
      sleep: waits.sleep,
    });

    expect(email.calls).toHaveLength(1);
    expect(waits.delays).toEqual([]);
    expect(store.communications[0]).toMatchObject({
      delivery_result: 'Failed',
      failure_reason: 'HTTP 422 invalid address',
      attempt_count: 1,
    });
  });

  it('clamps any caller-supplied backoff into the permitted window', () => {
    expect(retryBackoffDelays(2, [1, 100_000])).toEqual([
      MIN_RETRY_BACKOFF_MS,
      MAX_RETRY_BACKOFF_MS,
    ]);
    expect(retryBackoffDelays(0)).toEqual([]);
    expect(retryBackoffDelays(2)).toEqual([...DEFAULT_EMAIL_BACKOFF_MS]);
  });
});

describe('sendCommunication — combined multi-policy message', () => {
  it('writes one row per included key sharing the rendered message and the group id', async () => {
    const store = createStore();
    const email = emailSpy([{ success: true, messageId: 'resend-combined', failureReason: null, retryable: false }]);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered({ touchpoint: 5 }),
      targets: [target('case-1', 15), target('case-2', 10), target('case-3', 5)],
      client: store.client,
      providers: { sendEmail: email.send },
      newGroupId: () => 'group-abc',
      now: () => FIXED_NOW,
    });

    expect(email.calls).toHaveLength(1);
    expect(outcome.combined).toBe(true);
    expect(outcome.combinedGroupId).toBe('group-abc');
    expect(outcome.counts).toEqual({ sent: 3, skipped: 0, failed: 0 });

    expect(store.communications).toHaveLength(3);
    for (const row of store.communications) {
      expect(row.template_version_id).toBe('tv-15-en');
      expect(row.rendered_subject).toBe('Your policy is scheduled for cancellation');
      expect(row.rendered_body).toBe('New Hope Insurance Agency. Please call (704) 824-3130.');
      expect(row.provider_message_id).toBe('resend-combined');
      expect(row.delivery_result).toBe('Sent');
      expect(row.combined_group_id).toBe('group-abc');
    }
    // Each case keeps its own due touchpoint (Requirement 13.4).
    expect(store.communications.map((row) => row.touchpoint)).toEqual([15, 10, 5]);

    expect(store.links).toEqual([
      { communication_id: store.communications[0].id, combined_group_id: 'group-abc', case_id: 'case-1' },
      { communication_id: store.communications[1].id, combined_group_id: 'group-abc', case_id: 'case-2' },
      { communication_id: store.communications[2].id, combined_group_id: 'group-abc', case_id: 'case-3' },
    ]);
  });

  it('marks every row of the group failed with the provider reason', async () => {
    const store = createStore();
    const email = emailSpy([
      { success: false, messageId: null, failureReason: 'HTTP 400 rejected', retryable: false },
    ]);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1', 10), target('case-2', 10)],
      client: store.client,
      providers: { sendEmail: email.send },
      newGroupId: () => 'group-xyz',
      now: () => FIXED_NOW,
    });

    expect(email.calls).toHaveLength(1);
    expect(outcome.counts).toEqual({ sent: 0, skipped: 0, failed: 2 });
    expect(store.communications).toHaveLength(2);
    for (const row of store.communications) {
      expect(row.delivery_result).toBe('Failed');
      expect(row.failure_reason).toBe('HTTP 400 rejected');
      expect(row.combined_group_id).toBe('group-xyz');
    }
    // The links still record what the message covered.
    expect(store.links).toHaveLength(2);
  });

  it('skips only the conflicting key of a group and still sends for the reserved ones', async () => {
    const store = createStore();
    store.seed({ case_id: 'case-2', contact_id: 'contact-1', touchpoint: 10, channel: 'email' });
    const email = emailSpy([{ success: true, messageId: 'resend-partial', failureReason: null, retryable: false }]);

    const outcome = await sendCommunication({
      channel: 'email',
      recipient: 'customer@example.com',
      rendered: rendered(),
      targets: [target('case-1', 10), target('case-2', 10)],
      client: store.client,
      providers: { sendEmail: email.send },
      newGroupId: () => 'group-partial',
      now: () => FIXED_NOW,
    });

    expect(email.calls).toHaveLength(1);
    expect(outcome.counts).toEqual({ sent: 1, skipped: 1, failed: 0 });
    expect(outcome.skipped[0].key.caseId).toBe('case-2');
    expect(store.communications).toHaveLength(2);
    // The pre-existing row for case-2 is byte-identical.
    expect(store.communications.find((row) => row.case_id === 'case-2')).toMatchObject({
      provider_message_id: 'seeded-provider-id',
      rendered_body: 'seeded body',
      attempt_count: 1,
    });
    expect(store.links).toEqual([
      {
        communication_id: store.communications.find((row) => row.case_id === 'case-1')!.id,
        combined_group_id: 'group-partial',
        case_id: 'case-1',
      },
    ]);
  });
});
