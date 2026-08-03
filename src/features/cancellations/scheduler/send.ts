//
// Reserve-then-send: the one path from a rendered message to a provider.
//
// Both callers go through this file — the Notification_Scheduler
// (`POST /api/cancellations/scheduler`) and the drawer's Send Reminder Now / Retry Failed
// Communication route (`POST /api/cancellations/send`). Neither one calls `sendSms` or `sendEmail`
// itself, so the ordering below holds for every outbound cancellation message in the product.
//
// ---------------------------------------------------------------------------------------------
// THE ORDER, AND WHY IT IS THIS ORDER
// ---------------------------------------------------------------------------------------------
// 1. **Reserve.** Insert the `cancellation_communications` row first, with
//    `delivery_result = 'Sent'` and `provider_message_id = null` (Requirement 12.4). The
//    `unique (case_id, contact_id, touchpoint, channel)` constraint of
//    `v1.10.2-cancellation-communications.sql` is the Idempotency_Key, so the insert *is* the
//    reservation: two concurrent runs racing one touchpoint both attempt the same key, exactly one
//    wins, and the loser catches `23505`, abandons the send without touching a provider, leaves the
//    stored row exactly as it was, and counts the key as skipped (Requirements 12.5, 12.6, 12.7).
// 2. **Send.** One provider call per message, never per key: a combined multi-policy message is one
//    SMS or one email covering up to 10 cases (Requirement 13.4).
// 3. **Record.** Write the outcome back through `public.cancellation_retry_communication`, the only
//    update path the immutability trigger admits, which touches only `send_time`,
//    `provider_message_id`, `delivery_result`, `failure_reason`, and `attempt_count`. The template
//    version, rendered subject, and rendered body stay byte-identical to what went to the provider
//    (Requirements 14.15, 14.16).
//
// Reserving before sending is deliberately the lossy-in-the-safe-direction choice: a crash between
// steps 1 and 2 leaves a reserved row that never reached a provider, which the drawer surfaces as a
// send to retry. The opposite order would risk sending the same customer the same notice twice, and
// no requirement lets that happen.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS MODULE DOES NOT DO
// ---------------------------------------------------------------------------------------------
// * It never writes `cancellation_cases.case_status`. Delivery results never change case status and
//   case status is never derived from delivery results (Requirements 15.3, 15.4, 13.9), so the
//   guarantee is structural here: the table is not written from this file at all.
// * It never renders. A blocked render (`ok: false`) is reported straight back with zero rows and
//   zero provider calls; writing the `cancellation_events` block entry and setting
//   `communication_status = 'Manual Follow-up Required'` belongs to the caller (Requirements 14.9,
//   14.10).
// * It never decides which touchpoints are due, which contacts are eligible, or how cases group.
//   The caller hands over a rendered message plus the exact Idempotency_Keys it covers.
// * It never recomputes Communication_Status or evaluates escalations. Both run over the touched
//   cases after the batch, in the caller.
//
// ---------------------------------------------------------------------------------------------
// RETRY POLICY (Requirement 23.8) — email only
// ---------------------------------------------------------------------------------------------
// A retryable email failure, timeout included (`src/lib/email.ts` converts its own 30-second
// timeout into `retryable: true`), is retried at most twice more: three attempts in all, 5 to 60
// seconds apart, and zero further attempts after a non-retryable result. One row carries the final
// delivery result, the final failure reason, and the number of attempts made. SMS gets exactly one
// attempt: Requirement 12.11 asks only that the provider outcome be recorded, and a blind SMS retry
// would risk a second delivery of a notice RingCentral may already have accepted.
//
// Backoff is served through an injectable `sleep`, and the clock through an injectable `now`, so a
// test exercises three attempts in milliseconds. Any caller-supplied delay is clamped into
// [5 s, 60 s] so the requirement cannot be broken from the outside.
//
// ---------------------------------------------------------------------------------------------
// THE CLIENT THE CALLER HAS TO PASS
// ---------------------------------------------------------------------------------------------
// `public.cancellation_retry_communication` is `security definer` and admits Manager_Role
// (`manager` or `super_admin`), the service role, and a direct database connection; every other
// caller gets `42501` with nothing changed. So step 3 needs either the service-role client the
// scheduler builds or a manager session. Under any other session the reserve and the provider call
// still happen and the recording step is reported as a failure with `outcomeRecorded: false`,
// leaving a row that says `Sent`/attempt 1/no provider id — recoverable, but not what a caller
// wants. Pass a service-role client from a route handler.
//
// Providers are injected the same way, which is what keeps every test off the real RingCentral and
// Resend endpoints.
//

import type { SupabaseClient } from '@supabase/supabase-js';

import { isEmailConfigured, sendEmail, type EmailSendInput, type EmailSendResult } from '@/lib/email';
import { sendSms, type SmsSendResult } from '@/lib/ringcentral-sms';

import { getSupabase } from '../../nhwd-shared/client';
import type { DeliveryResult } from '../domain/communication-status';
import type {
  GateBlockedBy,
  RenderChannel,
  RenderResult,
  Touchpoint,
} from '../render/renderMessage';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMUNICATIONS_TABLE = 'cancellation_communications';
const COMMUNICATION_CASES_TABLE = 'cancellation_communication_cases';
const RETRY_COMMUNICATION_RPC = 'cancellation_retry_communication';

/** PostgreSQL `unique_violation`: the Idempotency_Key is already reserved (Requirement 12.7). */
export const UNIQUE_VIOLATION_CODE = '23505';

/** The reserving insert's delivery result, before any provider has been asked (Req 12.4). */
export const RESERVED_DELIVERY_RESULT: DeliveryResult = 'Sent';

/** One attempt plus at most 2 additional attempts on a retryable email failure (Req 23.8). */
export const MAX_EMAIL_ATTEMPTS = 3;

/** SMS is attempted once; a resend risks a second delivery of an accepted message (Req 12.11). */
export const MAX_SMS_ATTEMPTS = 1;

/** Requirement 23.8: at least 5 seconds and at most 60 seconds between consecutive attempts. */
export const MIN_RETRY_BACKOFF_MS = 5_000;
export const MAX_RETRY_BACKOFF_MS = 60_000;

/** The two waits a three-attempt email send uses, both inside the permitted window. */
export const DEFAULT_EMAIL_BACKOFF_MS: readonly number[] = [5_000, 15_000];

/** Combined messages cover at most 10 cases; the caller chunks, this only refuses more. */
export const MAX_COMBINED_TARGETS = 10;

// ---------------------------------------------------------------------------
// Keys and targets
// ---------------------------------------------------------------------------

/** The Idempotency_Key tuple: `unique (case_id, contact_id, touchpoint, channel)` (Req 12.6). */
export interface IdempotencyKey {
  caseId: string;
  contactId: string;
  touchpoint: Touchpoint;
  channel: RenderChannel;
}

/**
 * One Idempotency_Key this message covers, without the channel, which belongs to the message.
 * A single-case send passes one; a combined message passes one per included case, each carrying
 * that case's own due touchpoint — Requirement 13.7 renders the group from the fewest-days
 * template, and Requirement 13.4 still stores each case's own touchpoint.
 */
export interface SendTarget {
  caseId: string;
  contactId: string;
  touchpoint: Touchpoint;
}

/** `case_id:contact_id:touchpoint:channel`, for set comparison and log lines. */
export function idempotencyKeyString(key: IdempotencyKey): string {
  return `${key.caseId}:${key.contactId}:${key.touchpoint}:${key.channel}`;
}

// ---------------------------------------------------------------------------
// Provider seams
// ---------------------------------------------------------------------------

export type SmsSender = (to: string, text: string) => Promise<SmsSendResult>;
export type EmailSender = (input: EmailSendInput) => Promise<EmailSendResult>;

/**
 * The provider surface, injectable so no test can reach a real endpoint. Left absent, the real
 * `src/lib/ringcentral-sms.ts` and `src/lib/email.ts` functions apply — the only two modules in
 * the repository allowed to call a provider (Requirements 23.1, 23.5).
 *
 * `isEmailConfigured` guards Requirement 23.3: with no credentials, an email send writes zero rows
 * so a later run can still send the same key. An injected `sendEmail` without an injected
 * `isEmailConfigured` counts as configured, because a caller that supplied its own sender is not
 * asking about `RESEND_API_KEY`.
 */
export interface SendProviders {
  sendSms?: SmsSender;
  sendEmail?: EmailSender;
  isEmailConfigured?: () => boolean;
}

interface ResolvedProviders {
  sendSms: SmsSender;
  sendEmail: EmailSender;
  isEmailConfigured: () => boolean;
}

function resolveProviders(providers: SendProviders | undefined): ResolvedProviders {
  const emailSender = providers?.sendEmail;
  return {
    sendSms: providers?.sendSms ?? sendSms,
    sendEmail: emailSender ?? sendEmail,
    isEmailConfigured:
      providers?.isEmailConfigured ?? (emailSender !== undefined ? () => true : isEmailConfigured),
  };
}

// ---------------------------------------------------------------------------
// One provider attempt, normalized across the two providers
// ---------------------------------------------------------------------------

/** One attempt's result, in the shape both providers reduce to. */
export interface ProviderAttempt {
  success: boolean;
  messageId: string | null;
  failureReason: string | null;
  /** Only a retryable failure is attempted again, and only on the email channel (Req 23.8). */
  retryable: boolean;
}

/** RingCentral: `{ success, messageId?, error? }`. A failure is never retried here. */
export function smsAttempt(result: SmsSendResult): ProviderAttempt {
  return {
    success: result.success === true,
    messageId: nonEmpty(result.messageId),
    failureReason: result.success === true ? null : nonEmpty(result.error) ?? 'RingCentral reported a send failure.',
    retryable: false,
  };
}

/** The email module already reports every provider error as a result rather than throwing. */
export function emailAttempt(result: EmailSendResult): ProviderAttempt {
  return {
    success: result.success === true,
    messageId: nonEmpty(result.messageId),
    failureReason: result.success === true ? null : nonEmpty(result.failureReason) ?? 'The email provider reported a send failure.',
    retryable: result.success === true ? false : result.retryable === true,
  };
}

/** What the whole provider conversation for one message came to. */
export interface ProviderOutcome extends ProviderAttempt {
  /** Attempts made, which is what `attempt_count` stores (Requirement 23.8). */
  attempts: number;
  /** Every attempt in order, for a caller that wants to log the intermediate failures. */
  history: readonly ProviderAttempt[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export type SendClient = SupabaseClient;

export interface SendCommunicationInput {
  /** `sms` or `email` — the delivery channel, not the Contact_Recipient's phone/email channel. */
  channel: RenderChannel;
  /** The E.164 phone number or the lower-cased email address the message goes to. */
  recipient: string;
  /**
   * The renderer's result, passed straight through. `ok: false` returns a blocked outcome with zero
   * rows and zero provider calls, so a content-gate block cannot reach a provider even by mistake
   * (Requirement 14.9).
   */
  rendered: RenderResult;
  /** One target per Idempotency_Key the message covers: 1, or 2 to 10 for a combined message. */
  targets: readonly SendTarget[];
  /**
   * The shared combined-message group identifier (Requirement 13.8). Absent, a group id is
   * generated for a multi-target message and left null on the row for a single-case send.
   */
  combinedGroupId?: string | null;
  /**
   * Email reply-to: the assigned employee's stored address where there is one, otherwise the agency
   * address (Requirements 23.2, 23.7). Absent, `src/lib/email.ts` falls back to
   * `CANCELLATION_EMAIL_REPLY_TO`.
   */
  replyTo?: string | null;
  /** The email from display name. Defaults to the sender name the renderer resolved (Req 14.13, 14.14). */
  senderDisplayName?: string | null;
  client?: SendClient;
  providers?: SendProviders;
  /** Clock seam. Supplies the reserved row's send time and the recorded final send time. */
  now?: () => Date;
  /** Backoff seam, so a three-attempt email test does not wait 20 seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits between consecutive attempts, each clamped into [5 s, 60 s] (Requirement 23.8). */
  backoffMs?: readonly number[];
  /** Group-id seam, so a test can assert a fixed combined group identifier. */
  newGroupId?: () => string;
  /** Set false to skip the `cancellation_communication_cases` rows. Default true. */
  writeLinkRows?: boolean;
}

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

/** Why a key was skipped with zero rows written and zero provider calls. */
export type SendSkipReason =
  /** `23505`: another run already owns this Idempotency_Key (Requirements 12.5, 12.7). */
  | 'existing_record'
  /** The content gate blocked the render (Requirements 14.9, 14.10). */
  | 'render_blocked'
  /** No email credentials, so a later run can still send this key (Requirement 23.3). */
  | 'email_not_configured'
  /** The message has no address to go to, so nothing is reserved. */
  | 'recipient_absent';

export interface SkippedKey {
  key: IdempotencyKey;
  reason: SendSkipReason;
}

/** A key whose row exists and whose provider outcome is known. */
export interface SentKey {
  key: IdempotencyKey;
  /** `sent` where the provider accepted the message, `failed` where it did not. */
  status: 'sent' | 'failed';
  communicationId: string;
  deliveryResult: DeliveryResult;
  /** Stored unchanged, `null` for a success carrying no provider identifier (Requirement 23.4). */
  providerMessageId: string | null;
  failureReason: string | null;
  attemptCount: number;
  /**
   * False where the provider outcome could not be written back through
   * `cancellation_retry_communication`; the reserved row then still reads `Sent`, attempt 1, no
   * provider id, and the matching entry in `failures` says why.
   */
  outcomeRecorded: boolean;
}

export interface SendFailure {
  stage: 'reserve' | 'record_outcome' | 'link_cases';
  key: IdempotencyKey | null;
  message: string;
  code: string | null;
}

/** Carried through on a gate block so the caller can write its audit entry (Requirement 14.9). */
export interface SendBlocked {
  blockedBy: GateBlockedBy;
  match: string;
  field?: 'subject' | 'body';
}

export interface SendCommunicationOutcome {
  /** True where nothing was left failed: every reserved key reads `Sent`, or nothing was sent. */
  ok: boolean;
  channel: RenderChannel;
  recipient: string;
  /** True for a Requirement 13.1 combined multi-policy message. */
  combined: boolean;
  combinedGroupId: string | null;
  /** Keys whose row was reserved and whose provider outcome was recorded on it. */
  keys: SentKey[];
  skipped: SkippedKey[];
  failures: SendFailure[];
  /** Null where no provider was called at all: nothing reserved, blocked, or unconfigured. */
  provider: ProviderOutcome | null;
  /** Set only on a blocked render. */
  blocked: SendBlocked | null;
  /** `cancellation_communication_cases` rows written (Requirement 13.8). */
  linkRowsWritten: number;
  counts: { sent: number; skipped: number; failed: number };
}

// ---------------------------------------------------------------------------
// The send
// ---------------------------------------------------------------------------

/**
 * Reserves every Idempotency_Key of one message, calls the provider once, and records the outcome
 * on every reserved row.
 *
 * A combined message stores one row per included key, all carrying the same template version,
 * rendered subject, rendered body, provider message identifier, delivery result, and
 * `combined_group_id` (Requirements 13.4, 13.8), plus one `cancellation_communication_cases` row
 * per included case. A provider failure marks every row of the group `Failed` with the provider's
 * reason and leaves every case status untouched (Requirements 13.9, 14.18).
 *
 * Never throws for a provider or database outcome: everything is reported as data so a batch run
 * continues with the remaining recipients (Requirements 13.9, 14.18).
 */
export async function sendCommunication(
  input: SendCommunicationInput,
): Promise<SendCommunicationOutcome> {
  const client = input.client ?? getSupabase();
  const providers = resolveProviders(input.providers);
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? defaultSleep;
  const newGroupId = input.newGroupId ?? defaultGroupId;

  const channel = input.channel;
  const recipient = (input.recipient ?? '').trim();
  const targets = dedupeTargets(input.targets);
  const combined = targets.length > 1;
  const combinedGroupId =
    nonEmpty(input.combinedGroupId) ?? (combined ? newGroupId() : null);

  const outcome: SendCommunicationOutcome = {
    ok: true,
    channel,
    recipient,
    combined,
    combinedGroupId,
    keys: [],
    skipped: [],
    failures: [],
    provider: null,
    blocked: null,
    linkRowsWritten: 0,
    counts: { sent: 0, skipped: 0, failed: 0 },
  };

  const keys = targets.map((target) => keyOf(target, channel));

  if (keys.length === 0) return finalize(outcome);

  if (keys.length > MAX_COMBINED_TARGETS) {
    outcome.failures.push({
      stage: 'reserve',
      key: null,
      message: `A combined message covers at most ${MAX_COMBINED_TARGETS} cases; ${keys.length} were passed.`,
      code: null,
    });
    return finalize(outcome);
  }

  // A blocked render never reaches a provider and stores nothing (Requirements 14.9, 14.10).
  if (input.rendered.ok === false) {
    outcome.blocked = {
      blockedBy: input.rendered.blockedBy,
      match: input.rendered.match,
      ...(input.rendered.field === undefined ? {} : { field: input.rendered.field }),
    };
    skipAll(outcome, keys, 'render_blocked');
    return finalize(outcome);
  }

  const rendered = input.rendered;

  if (recipient.length === 0) {
    skipAll(outcome, keys, 'recipient_absent');
    return finalize(outcome);
  }

  // Requirement 23.3: with no email credentials, zero rows are written for the skipped email keys
  // so a later run may send the same Idempotency_Key.
  if (channel === 'email' && !providers.isEmailConfigured()) {
    skipAll(outcome, keys, 'email_not_configured');
    return finalize(outcome);
  }

  // Zero characters as the rendered subject on the SMS channel (Requirement 14.15).
  const subject = channel === 'sms' ? '' : rendered.subject;
  const body = rendered.body;
  const sendTime = now();

  // ── 1. Reserve, one key at a time, so one conflict skips one key and no more.
  const reserved: { key: IdempotencyKey; communicationId: string }[] = [];

  for (const key of keys) {
    const row = {
      case_id: key.caseId,
      contact_id: key.contactId,
      touchpoint: key.touchpoint,
      channel: key.channel,
      template_version_id: rendered.templateVersionId,
      rendered_subject: subject,
      rendered_body: body,
      send_time: sendTime.toISOString(),
      provider_message_id: null,
      delivery_result: RESERVED_DELIVERY_RESULT,
      failure_reason: null,
      attempt_count: 1,
      combined_group_id: combinedGroupId,
    };

    const { data, error } = await client
      .from(COMMUNICATIONS_TABLE)
      .insert(row)
      .select('id')
      .single();

    if (error !== null && error !== undefined) {
      if (isUniqueViolation(error)) {
        // Another run owns the key. No provider call, the stored row untouched, counted skipped.
        outcome.skipped.push({ key, reason: 'existing_record' });
        continue;
      }
      outcome.failures.push({
        stage: 'reserve',
        key,
        message: errorMessage(error, 'The Communication_Record could not be reserved.'),
        code: errorCode(error),
      });
      continue;
    }

    const communicationId = readId(data);
    if (communicationId === null) {
      outcome.failures.push({
        stage: 'reserve',
        key,
        message: 'The reserving insert returned no Communication_Record identifier.',
        code: null,
      });
      continue;
    }

    reserved.push({ key, communicationId });
  }

  // Nothing reserved means nothing to send: the provider is never reached (Requirement 12.7).
  if (reserved.length === 0) return finalize(outcome);

  // ── 2. One provider call for the message, with the email retry policy of Requirement 23.8.
  const provider = await deliverMessage({
    channel,
    recipient,
    subject,
    body,
    senderDisplayName: nonEmpty(input.senderDisplayName) ?? rendered.senderName,
    replyTo: nonEmpty(input.replyTo),
    providers,
    sleep,
    backoffMs: input.backoffMs,
  });
  outcome.provider = provider;

  const deliveryResult: DeliveryResult = provider.success ? 'Sent' : 'Failed';
  const failureReason = provider.success ? null : provider.failureReason;
  const recordedAt = now();

  // ── 3. Record the outcome on every reserved row through the one permitted update path.
  for (const entry of reserved) {
    const { error } = await client.rpc(RETRY_COMMUNICATION_RPC, {
      p_communication_id: entry.communicationId,
      p_delivery_result: deliveryResult,
      p_provider_message_id: provider.messageId,
      p_failure_reason: failureReason,
      p_attempt_count: provider.attempts,
      p_send_time: recordedAt.toISOString(),
    });

    const recorded = error === null || error === undefined;
    if (!recorded) {
      outcome.failures.push({
        stage: 'record_outcome',
        key: entry.key,
        message: errorMessage(error, 'The provider outcome could not be recorded.'),
        code: errorCode(error),
      });
    }

    outcome.keys.push({
      key: entry.key,
      status: provider.success ? 'sent' : 'failed',
      communicationId: entry.communicationId,
      deliveryResult,
      providerMessageId: provider.messageId,
      failureReason,
      attemptCount: provider.attempts,
      outcomeRecorded: recorded,
    });
  }

  // ── The coverage link: which cases this message covered (Requirement 13.8).
  if (input.writeLinkRows !== false) {
    const linkRows = reserved.map((entry) => ({
      communication_id: entry.communicationId,
      // The column is `not null`, and a single-case send has no group: its own record identifies
      // it, which keeps one indexed read by `combined_group_id` the way to resolve any message.
      combined_group_id: combinedGroupId ?? entry.communicationId,
      case_id: entry.key.caseId,
    }));

    const { error } = await client.from(COMMUNICATION_CASES_TABLE).insert(linkRows);
    if (error === null || error === undefined) {
      outcome.linkRowsWritten = linkRows.length;
    } else {
      outcome.failures.push({
        stage: 'link_cases',
        key: null,
        message: errorMessage(error, 'The message-to-case links could not be written.'),
        code: errorCode(error),
      });
    }
  }

  return finalize(outcome);
}

// ---------------------------------------------------------------------------
// The provider conversation
// ---------------------------------------------------------------------------

export interface DeliverMessageInput {
  channel: RenderChannel;
  recipient: string;
  subject: string;
  body: string;
  senderDisplayName: string;
  replyTo?: string | null;
  providers?: SendProviders;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
}

/**
 * Calls the provider once for SMS, and up to three times for a retryable email failure, waiting
 * 5 to 60 seconds between consecutive attempts and stopping at the first non-retryable result
 * (Requirement 23.8). Exported so the retry policy can be tested without a database.
 *
 * A provider that throws in spite of its contract is converted to a non-retryable failure rather
 * than raised, so a batch run continues (Requirements 13.9, 14.18).
 */
export async function deliverMessage(input: DeliverMessageInput): Promise<ProviderOutcome> {
  const providers = resolveProviders(input.providers);
  const sleep = input.sleep ?? defaultSleep;
  const maxAttempts = input.channel === 'sms' ? MAX_SMS_ATTEMPTS : MAX_EMAIL_ATTEMPTS;
  const backoff = retryBackoffDelays(maxAttempts - 1, input.backoffMs);

  const history: ProviderAttempt[] = [];
  let attempt: ProviderAttempt = {
    success: false,
    messageId: null,
    failureReason: 'No send was attempted.',
    retryable: false,
  };

  for (let index = 0; index < maxAttempts; index += 1) {
    if (index > 0) await sleep(backoff[index - 1]);

    attempt = await attemptOnce(input, providers);
    history.push(attempt);

    // A success ends it, and so does a non-retryable failure: zero additional attempts.
    if (attempt.success || !attempt.retryable) break;
  }

  return { ...attempt, attempts: history.length, history };
}

async function attemptOnce(
  input: DeliverMessageInput,
  providers: ResolvedProviders,
): Promise<ProviderAttempt> {
  try {
    if (input.channel === 'sms') {
      return smsAttempt(await providers.sendSms(input.recipient, input.body));
    }
    return emailAttempt(
      await providers.sendEmail({
        to: input.recipient,
        subject: input.subject,
        body: input.body,
        senderDisplayName: input.senderDisplayName,
        replyTo: input.replyTo ?? '',
      }),
    );
  } catch (caught) {
    // Neither provider module is supposed to throw. One that does is a defect, not a transient
    // fault, so the attempt is final: retrying it would only repeat the defect.
    return {
      success: false,
      messageId: null,
      failureReason: caught instanceof Error ? caught.message : 'The provider raised an unknown error.',
      retryable: false,
    };
  }
}

/**
 * The waits between consecutive attempts, each clamped into [5 s, 60 s] so Requirement 23.8 holds
 * whatever a caller passes. A short list is extended with its last value; an absent list uses the
 * module default.
 */
export function retryBackoffDelays(count: number, provided?: readonly number[]): number[] {
  if (count <= 0) return [];
  const source = provided !== undefined && provided.length > 0 ? provided : DEFAULT_EMAIL_BACKOFF_MS;
  const delays: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const raw = source[Math.min(index, source.length - 1)];
    delays.push(clampBackoff(raw));
  }
  return delays;
}

function clampBackoff(value: number): number {
  if (!Number.isFinite(value)) return MIN_RETRY_BACKOFF_MS;
  if (value < MIN_RETRY_BACKOFF_MS) return MIN_RETRY_BACKOFF_MS;
  if (value > MAX_RETRY_BACKOFF_MS) return MAX_RETRY_BACKOFF_MS;
  return Math.round(value);
}

// ---------------------------------------------------------------------------
// Recording an outcome on a stored row (Requirement 17.6)
// ---------------------------------------------------------------------------

export interface RecordOutcomeInput {
  communicationId: string;
  deliveryResult: DeliveryResult;
  providerMessageId?: string | null;
  failureReason?: string | null;
  /** Absent leaves the stored count alone; the function refuses a lower value. */
  attemptCount?: number | null;
  /** Absent means the database clock. */
  sendTime?: Date | string | null;
  client?: SendClient;
}

export type RecordOutcomeResult =
  | { ok: true }
  | { ok: false; failure: SendFailure };

/**
 * Writes a provider outcome onto a stored Communication_Record through
 * `public.cancellation_retry_communication` — the only update path the immutability trigger admits,
 * touching only `send_time`, `provider_message_id`, `delivery_result`, `failure_reason`, and
 * `attempt_count`, and leaving the template version, rendered subject, and rendered body unchanged
 * (Requirements 14.16, 17.6, 22.8).
 *
 * Exported for the drawer's Retry Failed Communication action, which updates the existing row for a
 * failed key instead of inserting a second one.
 */
export async function recordProviderOutcome(
  input: RecordOutcomeInput,
): Promise<RecordOutcomeResult> {
  const client = input.client ?? getSupabase();
  const sendTime =
    input.sendTime === undefined || input.sendTime === null
      ? null
      : input.sendTime instanceof Date
        ? input.sendTime.toISOString()
        : input.sendTime;

  const { error } = await client.rpc(RETRY_COMMUNICATION_RPC, {
    p_communication_id: input.communicationId,
    p_delivery_result: input.deliveryResult,
    p_provider_message_id: input.providerMessageId ?? null,
    p_failure_reason: input.failureReason ?? null,
    p_attempt_count: input.attemptCount ?? null,
    p_send_time: sendTime,
  });

  if (error === null || error === undefined) return { ok: true };

  return {
    ok: false,
    failure: {
      stage: 'record_outcome',
      key: null,
      message: errorMessage(error, 'The provider outcome could not be recorded.'),
      code: errorCode(error),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function keyOf(target: SendTarget, channel: RenderChannel): IdempotencyKey {
  return {
    caseId: target.caseId,
    contactId: target.contactId,
    touchpoint: target.touchpoint,
    channel,
  };
}

/**
 * Drops a repeated target, keeping the first. One message covering the same key twice would race
 * its own reserving insert and report its own key as an existing record, which is a caller defect
 * rather than a send outcome.
 */
function dedupeTargets(targets: readonly SendTarget[] | undefined): SendTarget[] {
  const seen = new Set<string>();
  const unique: SendTarget[] = [];
  for (const target of targets ?? []) {
    const id = `${target.caseId}:${target.contactId}:${target.touchpoint}`;
    if (seen.has(id)) continue;
    seen.add(id);
    unique.push(target);
  }
  return unique;
}

function skipAll(
  outcome: SendCommunicationOutcome,
  keys: readonly IdempotencyKey[],
  reason: SendSkipReason,
): void {
  for (const key of keys) outcome.skipped.push({ key, reason });
}

function finalize(outcome: SendCommunicationOutcome): SendCommunicationOutcome {
  const sent = outcome.keys.filter((entry) => entry.status === 'sent').length;
  const failedKeys = outcome.keys.length - sent;
  const reserveFailures = outcome.failures.filter((entry) => entry.stage === 'reserve').length;

  outcome.counts = {
    sent,
    skipped: outcome.skipped.length,
    failed: failedKeys + reserveFailures,
  };
  outcome.ok = outcome.counts.failed === 0 && outcome.failures.length === 0;
  return outcome;
}

/** True for the `23505` the Idempotency_Key constraint raises (Requirement 12.7). */
export function isUniqueViolation(error: unknown): boolean {
  if (error === null || error === undefined || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate.code === UNIQUE_VIOLATION_CODE) return true;
  const message = typeof candidate.message === 'string' ? candidate.message.toLowerCase() : '';
  return message.includes('duplicate key value') || message.includes('unique constraint');
}

function errorCode(error: unknown): string | null {
  if (error === null || error === undefined || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error !== null && error !== undefined && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return fallback;
}

function readId(data: unknown): string | null {
  if (data === null || data === undefined || typeof data !== 'object') return null;
  const row = Array.isArray(data) ? data[0] : data;
  if (row === null || row === undefined || typeof row !== 'object') return null;
  const id = (row as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : null;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A combined-group identifier. Web Crypto's `randomUUID` is present on the Node runtime this code
 * runs on; the arithmetic fallback exists so a bundler or an older runtime cannot turn a missing
 * global into a thrown send, and the value is a grouping label rather than a secret.
 */
function defaultGroupId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof webCrypto?.randomUUID === 'function') return webCrypto.randomUUID();

  const hex = (length: number): string => {
    let out = '';
    for (let index = 0; index < length; index += 1) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  };
  const variant = (8 + Math.floor(Math.random() * 4)).toString(16);
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}
