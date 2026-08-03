// The Notification_Scheduler batch: one business date in, one run summary out.
//
// `POST /api/cancellations/scheduler` is a six-line handler over `runScheduler` below. The route
// file holds the HTTP surface and nothing else, which is how the batch stays drivable by the
// scheduler suites (tasks 14.3, 14.4) and the authorization suite (task 18.1) without a running
// Next server: every seam this function needs — the Supabase client, both providers, the clock, the
// business date, the backoff sleep, the combined-group identifier — arrives as a parameter.
//
// Requirement 12 is the schedule and the idempotency contract, Requirement 13 the grouping,
// Requirement 23.3 the absent-email-credentials rule, Requirement 26.5 the kill switch:
// - 12.1        the four Touchpoints are the calendar dates 15, 10, 5, and 1 day before the
//               cancellation effective date
// - 12.2 / 12.3 a Touchpoint whose due date equals the current business date is scheduled for a
//               channel with at least one eligible Contact_Recipient, and is evaluated at least
//               once on that date however many runs execute
// - 12.8        a Touchpoint whose due date is earlier than the business date sends zero messages,
//               writes zero rows, and is counted skipped with the due-date-passed reason
// - 12.11       SMS goes through the existing RingCentral service and the provider outcome is
//               recorded on the reserved row
// - 12.12       only a Cancellation_Case whose Case_Status is Imported or Open is sent
//               automatically, with the status read at the moment the send is requested
// - 12.13       the run summary: business date, Touchpoints evaluated, sent, skipped, failed, and
//               the skipped count for each of the five named reasons
// - 13.1 / 13.5 cases sharing a matched customer, a contact value, and a channel become one
//               combined message, chunked at 10 cases in ascending effective-date order
// - 13.6        a contact value shared by two matched customers renders one message per customer
// - 13.7        a chunk renders from the template version of its fewest-days-remaining Touchpoint
// - 18.2 / 19.4 a Payment Reported or Reinstatement Pending case sends nothing and its suppressed
//               Touchpoints are counted skipped
// - 19.6        a case returned to Open resumes, and a Touchpoint whose date has passed is excluded
// - 23.3        with no email credentials, zero emails are sent, SMS continues, and **zero** rows
//               are written for the skipped email keys so a later run may still send them
// - 26.5        with automatic sending disabled, every candidate Touchpoint is counted skipped and
//               zero rows are written
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS FILE DOES NOT DO
// ---------------------------------------------------------------------------------------------
// It does not talk to a provider, insert a Communication_Record, or record a delivery outcome.
// Every one of those goes through `sendCommunication` in `./send`, which reserves each
// Idempotency_Key before the single provider call and records the outcome through
// `cancellation_retry_communication`. It does not render either: `renderMessage` owns the content
// gate, so a blocked message cannot reach a provider from here even by mistake. It does not derive
// Communication_Status in TypeScript — `cancellation_recompute_communication_status` does, under a
// row lock, and this file's job is to hand it the pending-send count only the touchpoint schedule
// can produce. And it never writes `cancellation_cases.case_status`: delivery results never change
// Case_Status (Requirements 15.3, 15.4), so the batch has no code path that could.
//
// ---------------------------------------------------------------------------------------------
// UNIT ACCOUNTING — WHY EVERY EVALUATED THING LANDS IN EXACTLY ONE BUCKET
// ---------------------------------------------------------------------------------------------
// Requirement 12.13 counts Touchpoints evaluated, sent, skipped, and failed, and Requirements 12.5
// and 12.7 count *Idempotency_Keys* in the skipped total. Those two granularities only agree if the
// unit of accounting is fixed once, so it is:
//
//   * one unit per (case, contact, touchpoint, channel) — an Idempotency_Key — wherever the channel
//     has at least one eligible Contact_Recipient;
//   * one unit per (case, touchpoint, channel) where it has none, which is the only shape the
//     no-eligible-contact reason can take, there being no key to count.
//
// `touchpointsEvaluated === sent + skipped + failed` therefore holds for every run, which is what
// lets Property 2 (task 14.3) assert that every skipped key appears in the skipped total.
//
// Only Touchpoints whose due date is *not later than* the business date are units. A future
// Touchpoint is neither evaluated nor skipped: counting it skipped would inflate the total with
// something no criterion names a reason for, and Requirement 12.13's five reasons are the whole
// vocabulary of a skip.
//
// Reason precedence, applied in this fixed order so a unit can never fall in two buckets:
//   1. `automatic_sending_disabled` — the kill switch is global and outranks everything (Req 26.5)
//   2. `excluded_case_status`       — case-level (Requirements 12.12, 18.2, 19.4)
//   3. `existing_record`            — key-level; Requirement 12.8's own condition is "and no
//                                     Communication_Record exists", so a stored row outranks a
//                                     passed due date (Requirements 12.5, 12.7)
//   4. `due_date_passed`            — touchpoint-level (Requirements 12.8, 19.6)
//   5. `email_not_configured`       — channel-level, and filtered out *before* grouping so no email
//                                     message is ever assembled without credentials (Req 23.3)
//   6. otherwise a send candidate, whose outcome is `sent`, `failed`, or a skip
//      `sendCommunication` reports (`existing_record` on a `23505`, `recipient_absent`)
//
// `render_blocked` is the seventh reason and belongs to no criterion's list: a content-gate block
// is a message that was assembled and refused (Requirements 14.9, 14.10). It is counted in the
// skipped total, reported under its own key, and the run continues.
//
// ---------------------------------------------------------------------------------------------
// THE READS, LISTED SO A TEST DOUBLE CAN IMPLEMENT EXACTLY THEM
// ---------------------------------------------------------------------------------------------
// Reads use only `.select(columns)`, `.in(column, values)`, and `.is(column, null)`, awaited
// directly. Writes use `.insert(rows)`, `.insert(row).select('id')`, `.update(values).eq(...)`,
// `.update(values).in(...)`, `.not('cleared_at', 'is', null)`, and one `.rpc(name, args)`:
//
//   select  cancellation_settings
//   select  cancellation_cases                 .in('cancellation_effective_date', dueDates)
//   select  cancellation_contacts              .in('case_id', caseIds)
//   select  cancellation_suppressions          .is('cleared_at', null)
//   select  cancellation_communications        .in('case_id', caseIds)
//   select  cancellation_escalations           .in('case_id', caseIds)
//   select  cancellation_customer_responses    .in('case_id', caseIds)
//   select  cancellation_templates
//   select  cancellation_template_versions
//   select  cancellation_prohibited_phrases
//   select  profiles
//   insert  cancellation_communications        (inside sendCommunication)
//   insert  cancellation_communication_cases   (inside sendCommunication)
//   rpc     cancellation_retry_communication   (inside sendCommunication)
//   insert  cancellation_events                block entries and escalation raise entries
//   update  cancellation_cases                 communication_status / follow_up_deadline only
//   insert  cancellation_escalations           one raise, with the `23505` read as already raised
//   update  cancellation_escalations           a reopen, and the notified_at stamp
//   insert  user_notifications                 the Requirement 20.8 / 20.9 fan-out
//   rpc     cancellation_recompute_communication_status
//
// Every one of them is wrapped: a rejected promise, a returned error, and a double that throws
// synchronously on an unexpected table are all recorded in `summary.failures` and the run carries
// on with the remaining recipients (Requirements 13.9, 14.18).

import type { SupabaseClient } from '@supabase/supabase-js';

import { currentBusinessDate, AGENCY_TIME_ZONE, addDays } from '../../renewals/derive';
import {
  MANUAL_FOLLOW_UP_STATUS,
  planEscalations,
  type EscalationAssignee,
  type EscalationCase,
  type EscalationContact,
  type EscalationPlan,
  type EscalationRecipientProfile,
  type EscalationResponseRecord,
} from '../domain/escalation';
import {
  pendingTouchpointChannelSends,
  type CaseStatus,
  type CommunicationRecord,
  type CommunicationStatus,
  type EscalationRecord,
  type NextRequiredAction,
  type ScheduledSend,
} from '../domain/communication-status';
import {
  eligibleContacts,
  SUPPRESSION_CHANNELS,
  type SuppressionChannel,
  type SuppressionRecord,
} from '../domain/suppression';
import { hasDeletedSuffix } from '../import/fields';
import {
  renderMessage,
  TOUCHPOINTS,
  type ProhibitedPhraseRow,
  type RenderCase,
  type RenderChannel,
  type RenderContact,
  type RenderSettings,
  type RenderResult,
  type TemplateVersionRow,
  type Touchpoint,
} from '../render/renderMessage';
import {
  authorizeSchedulerRequest,
  createSchedulerServiceClient,
  serviceRoleUnconfigured,
  type SchedulerActor,
  type SchedulerAuthorizationOptions,
} from './authorize';
import {
  MAX_COMBINED_TARGETS,
  sendCommunication,
  type SendProviders,
  type SendTarget,
} from './send';

import { isEmailConfigured } from '@/lib/email';
import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The Case_Status values an automatic Touchpoint may be sent for (Requirement 12.12). */
export const SENDABLE_CASE_STATUSES = ['Imported', 'Open'] as const satisfies readonly CaseStatus[];

/** At most this many Cancellation_Case rows share one combined message (Requirements 13.5, 13.8). */
export const MAX_CASES_PER_MESSAGE = MAX_COMBINED_TARGETS;

/** `cancellation_events.event_type` for a content-gate block (Requirements 14.9, 14.10). */
export const SEND_BLOCKED_EVENT_TYPE = 'send_blocked';

/** Milliseconds between consecutive SMS provider calls; RingCentral admits about one per second. */
export const DEFAULT_SMS_PACING_MS = 1_100;

const SETTINGS_COLUMNS =
  'automatic_sending_enabled,office_phone,agency_name,bilingual_separator,holidays';
const CASE_COLUMNS =
  'id,policy_number,cancellation_effective_date,customer_name,customer_match_key,carrier,'
  + 'cancellation_reason,amount_due,case_status,communication_status,next_required_action,'
  + 'assigned_to,producer_label,follow_up_deadline,assistance_requested';
const CONTACT_COLUMNS =
  'id,case_id,channel,normalized_value,validation_status,authorization_status,sms_suppressed,'
  + 'email_suppressed,is_primary,preferred_language,contact_name,segment_index';
const SUPPRESSION_COLUMNS = 'id,channel,normalized_value,cleared_at';
const COMMUNICATION_COLUMNS =
  'id,case_id,contact_id,touchpoint,channel,delivery_result,send_time,failure_reason,'
  + 'attempt_count,combined_group_id';
const ESCALATION_COLUMNS = 'id,case_id,reason,raised_at,cleared_at,cleared_by,notified_at';
const RESPONSE_COLUMNS = 'id,case_id,response_type,response_time';
const TEMPLATE_COLUMNS = 'id,touchpoint';
const TEMPLATE_VERSION_COLUMNS =
  'id,template_id,version,language,subject,body,cancellation_statement,contact_request,fallback_text';
const PHRASE_COLUMNS = 'id,phrase,language,claim_category,is_active';
const PROFILE_COLUMNS = 'id,display_name,role,is_active';

const SETTINGS_TABLE = 'cancellation_settings';
const CASES_TABLE = 'cancellation_cases';
const CONTACTS_TABLE = 'cancellation_contacts';
const SUPPRESSIONS_TABLE = 'cancellation_suppressions';
const COMMUNICATIONS_TABLE = 'cancellation_communications';
const ESCALATIONS_TABLE = 'cancellation_escalations';
const RESPONSES_TABLE = 'cancellation_customer_responses';
const TEMPLATES_TABLE = 'cancellation_templates';
const TEMPLATE_VERSIONS_TABLE = 'cancellation_template_versions';
const PHRASES_TABLE = 'cancellation_prohibited_phrases';
const EVENTS_TABLE = 'cancellation_events';
const NOTIFICATIONS_TABLE = 'user_notifications';
const PROFILES_TABLE = 'profiles';
const RECOMPUTE_RPC = 'cancellation_recompute_communication_status';

/** PostgreSQL `unique_violation`: another run already raised this (case, reason) pair. */
const UNIQUE_VIOLATION_CODE = '23505';

// ---------------------------------------------------------------------------
// Row shapes read from the database
// ---------------------------------------------------------------------------

/** The `cancellation_cases` columns one run reads. Satisfies `EscalationCase` unchanged. */
export interface SchedulerCaseRow extends EscalationCase {
  id: string;
  policy_number: string;
  cancellation_effective_date: string;
  customer_name: string | null;
  customer_match_key: string | null;
  carrier: string | null;
  cancellation_reason: string | null;
  amount_due: string | number | null;
  case_status: CaseStatus;
  communication_status: CommunicationStatus | null;
  next_required_action: NextRequiredAction | null;
  assigned_to: string | null;
  producer_label: string | null;
  follow_up_deadline: string | null;
  assistance_requested: boolean | null;
}

/** The `cancellation_contacts` columns one run reads. Satisfies `EscalationContact` unchanged. */
export interface SchedulerContactRow extends EscalationContact {
  id: string;
  case_id: string;
  normalized_value: string;
  preferred_language: string | null;
  contact_name: string | null;
  segment_index: number | null;
}

/** The `cancellation_settings` row. Its render constants are what `renderMessage` validates. */
export interface SchedulerSettingsRow extends RenderSettings {
  automatic_sending_enabled: boolean;
  holidays?: string[] | null;
}

/** A `public.profiles` row, for the sender name and the escalation fan-out. */
export interface SchedulerProfileRow {
  id: string;
  display_name: string | null;
  role: AppRole;
  is_active: boolean | null;
}

// ---------------------------------------------------------------------------
// The run summary (Requirement 12.13)
// ---------------------------------------------------------------------------

/**
 * Why a unit was skipped. The first five are the reasons Requirement 12.13 names, in its order;
 * the last three are this module's own and are always present, reading zero when unused.
 */
export type SchedulerSkipReason =
  /** A Communication_Record already exists for the Idempotency_Key (Requirements 12.5, 12.7). */
  | 'existing_record'
  /** The Touchpoint due date is earlier than the business date (Requirements 12.8, 19.6). */
  | 'due_date_passed'
  /** The channel has no valid, authorized, unsuppressed Contact_Recipient (Requirement 12.2). */
  | 'no_eligible_contact'
  /** Case_Status is outside Imported and Open (Requirements 12.12, 18.2, 19.4). */
  | 'excluded_case_status'
  /** No email service credentials, so zero rows are written for the key (Requirement 23.3). */
  | 'email_not_configured'
  /** Automatic sending is disabled (Requirement 26.5). */
  | 'automatic_sending_disabled'
  /** The content gate blocked the assembled message (Requirements 14.9, 14.10). */
  | 'render_blocked'
  /** The stored contact value carried no address to send to, so nothing was reserved. */
  | 'recipient_absent';

export const SCHEDULER_SKIP_REASONS = [
  'existing_record',
  'due_date_passed',
  'no_eligible_contact',
  'excluded_case_status',
  'email_not_configured',
  'automatic_sending_disabled',
  'render_blocked',
  'recipient_absent',
] as const satisfies readonly SchedulerSkipReason[];

export type SchedulerSkipCounts = Record<SchedulerSkipReason, number>;

/** One thing that went wrong without ending the run (Requirements 13.9, 14.18). */
export interface SchedulerFailure {
  stage: string;
  caseId: string | null;
  message: string;
  code: string | null;
}

/** What one Notification_Scheduler run did (Requirement 12.13). */
export interface SchedulerRunSummary {
  /** The current business date of the run, as `YYYY-MM-DD`. */
  businessDate: string;
  /** False where the Requirement 26.4 kill switch was off: every candidate was skipped. */
  automaticSendingEnabled: boolean;
  /** False where `isEmailConfigured()` was false: zero emails, SMS continued (Req 23.3). */
  emailConfigured: boolean;
  /** Cancellation_Case rows whose Touchpoints the run evaluated. */
  casesEvaluated: number;
  /** Units evaluated; always equal to `sent + skipped + failed`. */
  touchpointsEvaluated: number;
  /** Idempotency_Keys whose provider accepted the message. */
  sent: number;
  /** Units that sent zero messages, for the reasons in `skippedByReason`. */
  skipped: number;
  /** Idempotency_Keys whose provider refused the message, plus reservations that failed. */
  failed: number;
  skippedByReason: SchedulerSkipCounts;
  /** Provider calls made: one per message, not one per key (Requirement 13.4). */
  messagesAttempted: number;
  /** Messages covering more than one Cancellation_Case (Requirement 13.1). */
  combinedMessages: number;
  /** Messages the content gate refused (Requirements 14.9, 14.10). */
  blockedMessages: number;
  /** `cancellation_communications` rows written. */
  communicationRowsWritten: number;
  /** `cancellation_communication_cases` rows written (Requirement 13.8). */
  linkRowsWritten: number;
  /** `cancellation_escalations` rows raised or reopened this run (Requirement 20.10). */
  escalationsRaised: number;
  /** `public.user_notifications` rows written (Requirements 20.8, 20.9). */
  notificationsWritten: number;
  /** Cases whose Communication_Status was recomputed (Requirement 15.9). */
  statusRecomputed: number;
  /** Every case the run evaluated, in the order it read them. */
  caseIds: string[];
  failures: SchedulerFailure[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface SchedulerRunInput {
  /**
   * The service-role client. `cancellation_retry_communication` admits Manager_Role, the service
   * role, and nothing else, so this is what reaches `sendCommunication`; under any weaker client
   * the recording step fails and rows stay reading `Sent`, attempt 1, no provider id.
   */
  client: SupabaseClient;
  providers?: SendProviders;
  /** Clock seam. Supplies send times, escalation times, and the default business date. */
  now?: () => Date;
  /** Pins the business date. Absent, it is the calendar date in `timeZone` at `now()`. */
  businessDate?: string;
  /** The agency time zone the business date resolves in. Defaults to `America/New_York`. */
  timeZone?: string;
  /** Backoff seam for the email retry policy, so a test does not wait 20 seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits between consecutive email attempts, each clamped into [5 s, 60 s] (Req 23.8). */
  backoffMs?: readonly number[];
  /** Combined-group identifier seam, so a test can assert a fixed value (Requirement 13.8). */
  newGroupId?: () => string;
  /**
   * Milliseconds to wait between consecutive SMS provider calls. Defaults to 0 here and to
   * `DEFAULT_SMS_PACING_MS` on the HTTP path, so a direct call runs at full speed and a real run
   * stays inside RingCentral's roughly one-per-second limit.
   */
  smsPacingMs?: number;
  /**
   * The email reply-to for a case (Requirement 23.7). Absent, `null` is passed and
   * `src/lib/email.ts` falls back to `CANCELLATION_EMAIL_REPLY_TO` (Requirement 23.2).
   *
   * A seam rather than a read because `public.profiles` carries no email column today: Requirement
   * 23.7's "employee's stored email address" has nowhere to come from until one exists, and
   * guessing an address would be worse than the agency default.
   */
  resolveReplyTo?: (context: {
    caseIds: readonly string[];
    assignedTo: string | null;
    profile: SchedulerProfileRow | null;
  }) => string | null;
  /** The authorized caller, recorded as `actor_id` on the audit entries the run writes. */
  actor?: SchedulerActor | null;
}

// ---------------------------------------------------------------------------
// Touchpoint arithmetic (Requirement 12.1)
// ---------------------------------------------------------------------------

/** The due date of one Touchpoint: the calendar date `touchpoint` days before the effective date. */
export function touchpointDueDate(effectiveDate: string, touchpoint: Touchpoint): string {
  return addDays(effectiveDate, -touchpoint);
}

/** The four cancellation effective dates whose Touchpoints come due on `businessDate`. */
export function dueEffectiveDates(businessDate: string): string[] {
  return TOUCHPOINTS.map((touchpoint) => addDays(businessDate, touchpoint));
}

/** One Touchpoint of one case, with its due date resolved against the business date. */
export interface TouchpointWindow {
  touchpoint: Touchpoint;
  dueDate: string;
  /** True where the due date equals the business date: the Touchpoint is due now (Req 12.2). */
  due: boolean;
  /** True where the due date is earlier than the business date (Requirement 12.8). */
  passed: boolean;
}

/**
 * The Touchpoints of one case whose due date is not later than the business date, most days
 * remaining first.
 *
 * A future Touchpoint is deliberately absent: it is not evaluated this run and Requirement 12.13
 * has no reason to count it under. A passed Touchpoint is present, because Requirement 12.8
 * requires it to be counted skipped rather than silently dropped.
 */
export function evaluableTouchpoints(
  effectiveDate: string,
  businessDate: string,
): TouchpointWindow[] {
  const windows: TouchpointWindow[] = [];
  for (const touchpoint of TOUCHPOINTS) {
    const dueDate = touchpointDueDate(effectiveDate, touchpoint);
    if (dueDate > businessDate) continue;
    windows.push({ touchpoint, dueDate, due: dueDate === businessDate, passed: dueDate < businessDate });
  }
  return windows;
}

// ---------------------------------------------------------------------------
// Grouping (Requirement 13)
// ---------------------------------------------------------------------------

/** One (case, contact, touchpoint, channel) the run intends to send. */
export interface SchedulerCandidate {
  caseRow: SchedulerCaseRow;
  contact: SchedulerContactRow;
  touchpoint: Touchpoint;
  channel: RenderChannel;
}

/**
 * The bucket a candidate joins: same matched customer, same normalized contact value, same channel
 * (Requirements 13.1, 13.5, 13.6).
 *
 * A case whose `customer_match_key` is null or blank gets a key carrying its own case id, so it
 * can never join another case's bucket. Requirement 9.5 leaves the match key null exactly where
 * neither a client identifier nor a customer name was importable, and two such cases are not known
 * to be the same customer — combining them could put another customer's policy number in front of
 * this one (Requirement 13.6).
 */
export function candidateBucketKey(candidate: SchedulerCandidate): string {
  const matchKey = (candidate.caseRow.customer_match_key ?? '').trim();
  const identity = matchKey.length > 0 ? `key:${matchKey}` : `case:${candidate.caseRow.id}`;
  return `${identity}|${candidate.contact.normalized_value}|${candidate.channel}`;
}

/**
 * The messages one run sends: candidates bucketed by (matched customer, contact value, channel),
 * each bucket ordered by ascending cancellation effective date and cut into chunks of at most 10
 * cases (Requirements 13.1, 13.5, 13.6).
 *
 * Bucket insertion order is preserved, and within a bucket the order is effective date, then policy
 * number, then case id, so one input always produces the same messages in the same order — which is
 * what makes a repeated run comparable in Property 2.
 */
export function groupCandidates(
  candidates: readonly SchedulerCandidate[],
): SchedulerCandidate[][] {
  const buckets = new Map<string, SchedulerCandidate[]>();
  for (const candidate of candidates) {
    const key = candidateBucketKey(candidate);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [candidate]);
    else bucket.push(candidate);
  }

  const chunks: SchedulerCandidate[][] = [];
  for (const bucket of buckets.values()) {
    const ordered = [...bucket].sort(compareCandidates);
    for (let index = 0; index < ordered.length; index += MAX_CASES_PER_MESSAGE) {
      chunks.push(ordered.slice(index, index + MAX_CASES_PER_MESSAGE));
    }
  }
  return chunks;
}

function compareCandidates(left: SchedulerCandidate, right: SchedulerCandidate): number {
  const byDate = left.caseRow.cancellation_effective_date.localeCompare(
    right.caseRow.cancellation_effective_date,
  );
  if (byDate !== 0) return byDate;
  const byPolicy = left.caseRow.policy_number.localeCompare(right.caseRow.policy_number);
  if (byPolicy !== 0) return byPolicy;
  return left.caseRow.id.localeCompare(right.caseRow.id);
}

/** The applied Touchpoint of a chunk: the fewest days remaining among its cases (Req 13.7). */
export function chunkTouchpoint(chunk: readonly SchedulerCandidate[]): Touchpoint {
  let applied: Touchpoint = 15;
  for (const candidate of chunk) {
    if (candidate.touchpoint < applied) applied = candidate.touchpoint;
  }
  return applied;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * One Notification_Scheduler run.
 *
 * Order, which is the design's run order:
 *  1. read `cancellation_settings`; with automatic sending off, count every candidate skipped and
 *     write nothing (Requirement 26.5);
 *  2. compute the business date and select the candidate cases by their four Touchpoint due dates
 *     (Requirement 12.1);
 *  3. resolve eligible Contact_Recipients per channel through `eligibleContacts` (Req 12.2);
 *  4. bucket and chunk the remaining candidates (Requirement 13);
 *  5. render, then reserve-then-send each chunk through `sendCommunication` (Requirement 12.4);
 *  6. run the escalation evaluation and the Communication_Status recompute for every evaluated
 *     case, and return the run summary (Requirements 20.10, 15.9, 12.13).
 *
 * Never throws for a database or provider outcome: everything is reported in the summary so one bad
 * recipient cannot end a run (Requirements 13.9, 14.18).
 */
export async function runScheduler(input: SchedulerRunInput): Promise<SchedulerRunSummary> {
  const now = input.now ?? (() => new Date());
  const timeZone = input.timeZone ?? AGENCY_TIME_ZONE;
  const businessDate = input.businessDate ?? currentBusinessDate(now(), timeZone);
  const providers = input.providers;
  const emailConfigured = resolveEmailConfigured(providers);
  const smsPacingMs = Math.max(0, input.smsPacingMs ?? 0);
  const sleep = input.sleep ?? defaultSleep;
  const client = input.client;

  const summary: SchedulerRunSummary = {
    businessDate,
    automaticSendingEnabled: true,
    emailConfigured,
    casesEvaluated: 0,
    touchpointsEvaluated: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    skippedByReason: emptySkipCounts(),
    messagesAttempted: 0,
    combinedMessages: 0,
    blockedMessages: 0,
    communicationRowsWritten: 0,
    linkRowsWritten: 0,
    escalationsRaised: 0,
    notificationsWritten: 0,
    statusRecomputed: 0,
    caseIds: [],
    failures: [],
  };

  const skip = (reason: SchedulerSkipReason, count = 1): void => {
    summary.skipped += count;
    summary.touchpointsEvaluated += count;
    summary.skippedByReason[reason] += count;
  };

  // ── 1. The settings row, which carries the kill switch and every render constant.
  const settingsRead = await readRows<SchedulerSettingsRow>(
    () => client.from(SETTINGS_TABLE).select(SETTINGS_COLUMNS),
    'read_settings',
  );
  if (settingsRead.failure !== null) {
    summary.failures.push(settingsRead.failure);
    return summary;
  }
  const settings = settingsRead.rows[0];
  if (settings === undefined) {
    summary.failures.push({
      stage: 'read_settings',
      caseId: null,
      message:
        'The cancellation_settings row is absent, so no compliant message could be rendered. Nothing was sent.',
      code: null,
    });
    return summary;
  }
  summary.automaticSendingEnabled = settings.automatic_sending_enabled !== false;

  // ── 2. The candidate cases: those with a Touchpoint due date on the business date (Req 12.1).
  const caseRead = await readRows<SchedulerCaseRow>(
    () => client.from(CASES_TABLE).select(CASE_COLUMNS).in(
      'cancellation_effective_date',
      dueEffectiveDates(businessDate),
    ),
    'read_cases',
  );
  if (caseRead.failure !== null) {
    summary.failures.push(caseRead.failure);
    return summary;
  }
  const cases = caseRead.rows.filter((row) => typeof row.id === 'string' && row.id.length > 0);
  summary.casesEvaluated = cases.length;
  summary.caseIds = cases.map((row) => row.id);
  if (cases.length === 0) return summary;

  const caseIds = summary.caseIds;

  // ── 3. Contacts and suppressions, which together decide channel eligibility (Req 12.2, 21.3).
  const contactRead = await readRows<SchedulerContactRow>(
    () => client.from(CONTACTS_TABLE).select(CONTACT_COLUMNS).in('case_id', caseIds),
    'read_contacts',
  );
  if (contactRead.failure !== null) summary.failures.push(contactRead.failure);

  const suppressionRead = await readRows<SuppressionRecord>(
    () => client.from(SUPPRESSIONS_TABLE).select(SUPPRESSION_COLUMNS).is('cleared_at', null),
    'read_suppressions',
  );
  if (suppressionRead.failure !== null) summary.failures.push(suppressionRead.failure);

  const communicationRead = await readRows<CommunicationRecord>(
    () => client.from(COMMUNICATIONS_TABLE).select(COMMUNICATION_COLUMNS).in('case_id', caseIds),
    'read_communications',
  );
  if (communicationRead.failure !== null) summary.failures.push(communicationRead.failure);

  const contactsByCase = groupBy(contactRead.rows, (row) => row.case_id ?? '');
  const activeSuppressions = suppressionRead.rows;
  const storedCommunications = communicationRead.rows;
  const storedKeys = new Set(storedCommunications.map(communicationKey));
  const communicationsByCase = groupBy(storedCommunications, (row) => row.case_id ?? '');

  // The per-channel recipient list of every case, resolved once: the enumeration below reads it
  // four times per case and the escalation pass reads it again.
  const eligibleByCase = new Map<string, Record<SuppressionChannel, SchedulerContactRow[]>>();
  for (const caseRow of cases) {
    const contacts = contactsByCase.get(caseRow.id) ?? [];
    eligibleByCase.set(caseRow.id, {
      sms: eligibleContacts(contacts, activeSuppressions, 'sms'),
      email: eligibleContacts(contacts, activeSuppressions, 'email'),
    });
  }

  // ── The unit enumeration and the reason precedence, in the fixed order of the file header.
  const candidates: SchedulerCandidate[] = [];
  for (const caseRow of cases) {
    const excluded = !isSendableCaseStatus(caseRow.case_status);
    const eligible = eligibleByCase.get(caseRow.id) ?? { sms: [], email: [] };

    for (const window of evaluableTouchpoints(caseRow.cancellation_effective_date, businessDate)) {
      for (const channel of SUPPRESSION_CHANNELS) {
        const recipients = eligible[channel];

        if (recipients.length === 0) {
          // No key exists to count, so the unit is the (case, touchpoint, channel) triple.
          skip(summary.automaticSendingEnabled
            ? (excluded ? 'excluded_case_status' : 'no_eligible_contact')
            : 'automatic_sending_disabled');
          continue;
        }

        for (const contact of recipients) {
          if (!summary.automaticSendingEnabled) {
            skip('automatic_sending_disabled');
            continue;
          }
          if (excluded) {
            skip('excluded_case_status');
            continue;
          }
          if (storedKeys.has(keyOf(caseRow.id, contact.id, window.touchpoint, channel))) {
            skip('existing_record');
            continue;
          }
          if (window.passed) {
            skip('due_date_passed');
            continue;
          }
          if (channel === 'email' && !emailConfigured) {
            skip('email_not_configured');
            continue;
          }
          candidates.push({ caseRow, contact, touchpoint: window.touchpoint, channel });
        }
      }
    }
  }

  // Requirement 26.5: the run ends here with every candidate counted skipped and nothing written.
  if (!summary.automaticSendingEnabled) return summary;

  // ── The remaining reads: templates, phrases, profiles, escalations, responses.
  const templateRead = await readRows<{ id: string; touchpoint: Touchpoint }>(
    () => client.from(TEMPLATES_TABLE).select(TEMPLATE_COLUMNS),
    'read_templates',
  );
  if (templateRead.failure !== null) summary.failures.push(templateRead.failure);

  const versionRead = await readRows<TemplateVersionRow>(
    () => client.from(TEMPLATE_VERSIONS_TABLE).select(TEMPLATE_VERSION_COLUMNS),
    'read_template_versions',
  );
  if (versionRead.failure !== null) summary.failures.push(versionRead.failure);

  const phraseRead = await readRows<ProhibitedPhraseRow>(
    () => client.from(PHRASES_TABLE).select(PHRASE_COLUMNS),
    'read_prohibited_phrases',
  );
  if (phraseRead.failure !== null) summary.failures.push(phraseRead.failure);

  const profileRead = await readRows<SchedulerProfileRow>(
    () => client.from(PROFILES_TABLE).select(PROFILE_COLUMNS),
    'read_profiles',
  );
  if (profileRead.failure !== null) summary.failures.push(profileRead.failure);

  const escalationRead = await readRows<EscalationRecord>(
    () => client.from(ESCALATIONS_TABLE).select(ESCALATION_COLUMNS).in('case_id', caseIds),
    'read_escalations',
  );
  if (escalationRead.failure !== null) summary.failures.push(escalationRead.failure);

  const responseRead = await readRows<EscalationResponseRecord>(
    () => client.from(RESPONSES_TABLE).select(RESPONSE_COLUMNS).in('case_id', caseIds),
    'read_responses',
  );
  if (responseRead.failure !== null) summary.failures.push(responseRead.failure);

  const templateVersions = joinTemplateTouchpoints(versionRead.rows, templateRead.rows);
  const prohibitedPhrases = phraseRead.rows;
  const profilesById = new Map(profileRead.rows.map((row) => [row.id, row]));
  const managerProfiles: EscalationRecipientProfile[] = profileRead.rows
    .filter((row) => isBroadManagerRole(row.role))
    .map((row) => ({ id: row.id, role: row.role }));
  const escalationsByCase = groupBy(escalationRead.rows, (row) => row.case_id ?? '');
  const responsesByCase = groupBy(responseRead.rows, (row) => row.case_id ?? '');

  // ── 4 and 5. Group, render, reserve-then-send.
  const writtenByCase = new Map<string, CommunicationRecord[]>();
  const blockedCaseIds = new Set<string>();
  let smsMessages = 0;

  for (const chunk of groupCandidates(candidates)) {
    const channel = chunk[0].channel;
    const recipient = chunk[0].contact.normalized_value;
    const touchpoint = chunkTouchpoint(chunk);
    const chunkCaseIds = chunk.map((candidate) => candidate.caseRow.id);
    const assignee = resolveChunkAssignee(chunk, profilesById);

    let rendered: RenderResult;
    try {
      rendered = renderMessage({
        templateVersions,
        cases: chunk.map(renderCaseOf),
        contact: chunk.map(renderContactOf),
        touchpoint,
        channel,
        settings,
        senderName: assignee.employee,
        combined: chunk.length > 1,
        prohibitedPhrases,
      });
    } catch (caught) {
      // A render input defect — a missing template version row, an unreadable effective date — is
      // one message's problem, not the run's (design: "The scheduler catches it per message").
      summary.failed += chunk.length;
      summary.touchpointsEvaluated += chunk.length;
      summary.failures.push({
        stage: 'render',
        caseId: chunkCaseIds[0] ?? null,
        message: errorText(caught, 'The message could not be rendered.'),
        code: null,
      });
      continue;
    }

    // Requirements 14.9 and 14.10: zero provider calls, zero Communication_Record rows, a block
    // entry in the audit timeline, Manual Follow-up Required on every included case, run continues.
    if (rendered.ok === false) {
      summary.blockedMessages += 1;
      skip('render_blocked', chunk.length);
      for (const caseId of chunkCaseIds) blockedCaseIds.add(caseId);
      await recordGateBlock({
        client,
        summary,
        caseIds: chunkCaseIds,
        actorId: actorProfileId(input.actor),
        blocked: rendered,
        channel,
        touchpoint,
        at: now(),
      });
      continue;
    }

    if (channel === 'sms' && smsMessages > 0 && smsPacingMs > 0) await sleep(smsPacingMs);

    const targets: SendTarget[] = chunk.map((candidate) => ({
      caseId: candidate.caseRow.id,
      contactId: candidate.contact.id,
      touchpoint: candidate.touchpoint,
    }));

    const outcome = await sendCommunication({
      channel,
      recipient,
      rendered,
      targets,
      client,
      providers,
      now,
      sleep: input.sleep,
      backoffMs: input.backoffMs,
      newGroupId: input.newGroupId,
      replyTo: input.resolveReplyTo?.({
        caseIds: chunkCaseIds,
        assignedTo: assignee.profileId,
        profile: assignee.profile,
      }) ?? null,
    });

    summary.messagesAttempted += outcome.provider === null ? 0 : 1;
    if (chunk.length > 1) summary.combinedMessages += 1;
    if (channel === 'sms' && outcome.provider !== null) smsMessages += 1;

    summary.sent += outcome.counts.sent;
    summary.failed += outcome.counts.failed;
    summary.touchpointsEvaluated += outcome.counts.sent + outcome.counts.failed;
    for (const entry of outcome.skipped) skip(mapSendSkipReason(entry.reason));
    for (const failure of outcome.failures) {
      summary.failures.push({
        stage: `send:${failure.stage}`,
        caseId: failure.key?.caseId ?? chunkCaseIds[0] ?? null,
        message: failure.message,
        code: failure.code,
      });
    }

    summary.communicationRowsWritten += outcome.keys.length;
    summary.linkRowsWritten += outcome.linkRowsWritten;

    // The rows this run wrote, so the escalation evaluation and the pending-send count see them.
    for (const key of outcome.keys) {
      const list = writtenByCase.get(key.key.caseId) ?? [];
      list.push({
        id: key.communicationId,
        case_id: key.key.caseId,
        contact_id: key.key.contactId,
        touchpoint: key.key.touchpoint,
        channel: key.key.channel,
        delivery_result: key.deliveryResult,
        send_time: null,
        failure_reason: key.failureReason,
        attempt_count: key.attemptCount,
        combined_group_id: outcome.combinedGroupId,
      });
      writtenByCase.set(key.key.caseId, list);
    }
  }

  // ── 6. The escalation evaluation and the Communication_Status recompute, for every case the run
  //       evaluated (Requirement 20.10 runs the evaluation on every scheduler run).
  for (const caseRow of cases) {
    const contacts = contactsByCase.get(caseRow.id) ?? [];
    const eligible = eligibleByCase.get(caseRow.id) ?? { sms: [], email: [] };
    const communications = [
      ...(communicationsByCase.get(caseRow.id) ?? []),
      ...(writtenByCase.get(caseRow.id) ?? []),
    ];
    const scheduledSends = scheduledSendsFor(caseRow, eligible, businessDate);
    const pending = pendingTouchpointChannelSends(scheduledSends, communications);
    const employee = assigneeOf(caseRow, profilesById);

    const planned = planEscalations(
      {
        case: caseRow,
        contacts,
        communications,
        responses: responsesByCase.get(caseRow.id) ?? [],
        escalations: escalationsByCase.get(caseRow.id) ?? [],
        suppressions: activeSuppressions,
        scheduledSends,
        businessDate,
        enabledChannels: emailConfigured ? SUPPRESSION_CHANNELS : (['sms'] as const),
      },
      { now: now(), assignedEmployee: employee, managerProfiles },
    );

    if (planned.ok) {
      await applyEscalationPlan({ client, summary, plan: planned.plan, actorId: actorProfileId(input.actor) });
    } else {
      summary.failures.push({
        stage: 'escalation_plan',
        caseId: caseRow.id,
        message: planned.rejection.message,
        code: planned.rejection.code,
      });
    }

    // Requirement 14.10 sets Manual Follow-up Required for every case in a blocked message, and
    // the recompute would derive it away again: `cancellation_recompute_communication_status`
    // reads Manual Follow-up Required only from an uncleared `cancellation_escalations` row, and a
    // content-gate block is none of the seven reasons that table's check constraint admits. So a
    // case blocked this run keeps the status the block wrote and is not recomputed. Every other
    // case is (Requirement 15.9).
    if (blockedCaseIds.has(caseRow.id)) continue;

    const recomputed = await callRpc(
      client,
      RECOMPUTE_RPC,
      { p_case_id: caseRow.id, p_pending_sends: pending.length },
      'recompute_status',
      caseRow.id,
    );
    if (recomputed === null) summary.statusRecomputed += 1;
    else summary.failures.push(recomputed);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// The HTTP path
// ---------------------------------------------------------------------------

export interface SchedulerRequestOptions extends SchedulerAuthorizationOptions {
  /** Overrides for the batch, so a test can inject a client, providers, and a clock. */
  run?: Partial<Omit<SchedulerRunInput, 'client'>> & { client?: SupabaseClient };
  /** The batch seam itself, so an authorization test needs no store at all. */
  runner?: (input: SchedulerRunInput) => Promise<SchedulerRunSummary>;
}

/**
 * `POST /api/cancellations/scheduler`, minus the route file.
 *
 * Authorization first and always: an unauthorized request is answered 403 before a Supabase client
 * exists, so it sends zero messages and writes zero rows (Requirements 12.9, 12.10). Then the
 * service-role client, then the batch, then the run summary.
 */
export async function handleSchedulerRequest(
  request: Request,
  options: SchedulerRequestOptions = {},
): Promise<Response> {
  const authorization = await authorizeSchedulerRequest(request, {
    ...(options.cronSecret === undefined ? {} : { cronSecret: options.cronSecret }),
    ...(options.resolveSession === undefined ? {} : { resolveSession: options.resolveSession }),
  });
  if (!authorization.ok) return authorization.response;

  const client = options.run?.client ?? createSchedulerServiceClient();
  if (client === null) return serviceRoleUnconfigured();

  const runner = options.runner ?? runScheduler;
  const summary = await runner({
    smsPacingMs: DEFAULT_SMS_PACING_MS,
    ...options.run,
    client,
    actor: options.run?.actor ?? authorization.actor,
  });

  return Response.json({ success: true, summary });
}

// ---------------------------------------------------------------------------
// Reading and writing, every call wrapped
// ---------------------------------------------------------------------------

interface ReadResult<TRow> {
  rows: TRow[];
  failure: SchedulerFailure | null;
}

interface PostgrestLike {
  data?: unknown;
  error?: unknown;
}

/**
 * One read, with every failure mode reduced to data: a returned error, a rejected promise, and a
 * client that throws synchronously all produce an empty row list and a recorded failure.
 */
async function readRows<TRow>(
  build: () => unknown,
  stage: string,
): Promise<ReadResult<TRow>> {
  try {
    const result = (await build()) as PostgrestLike | null | undefined;
    const error = result?.error;
    if (error !== null && error !== undefined) {
      return { rows: [], failure: { stage, caseId: null, message: errorText(error, `The ${stage} query failed.`), code: errorCode(error) } };
    }
    const data = result?.data;
    return { rows: Array.isArray(data) ? (data as TRow[]) : [], failure: null };
  } catch (caught) {
    return {
      rows: [],
      failure: { stage, caseId: null, message: errorText(caught, `The ${stage} query failed.`), code: errorCode(caught) },
    };
  }
}

/** One write. Returns the failure, or `null` where it succeeded. */
async function writeRows(
  build: () => unknown,
  stage: string,
  caseId: string | null,
): Promise<SchedulerFailure | null> {
  try {
    const result = (await build()) as PostgrestLike | null | undefined;
    const error = result?.error;
    if (error === null || error === undefined) return null;
    return { stage, caseId, message: errorText(error, `The ${stage} write failed.`), code: errorCode(error) };
  } catch (caught) {
    return { stage, caseId, message: errorText(caught, `The ${stage} write failed.`), code: errorCode(caught) };
  }
}

async function callRpc(
  client: SupabaseClient,
  name: string,
  args: Record<string, unknown>,
  stage: string,
  caseId: string | null,
): Promise<SchedulerFailure | null> {
  return writeRows(() => client.rpc(name, args), stage, caseId);
}

// ---------------------------------------------------------------------------
// The content-gate block (Requirements 14.9, 14.10)
// ---------------------------------------------------------------------------

interface GateBlockInput {
  client: SupabaseClient;
  summary: SchedulerRunSummary;
  caseIds: readonly string[];
  actorId: string | null;
  blocked: Extract<RenderResult, { ok: false }>;
  channel: RenderChannel;
  touchpoint: Touchpoint;
  at: Date;
}

/**
 * The two writes a blocked message produces: one `cancellation_events` entry per included case
 * carrying the matched phrase or token, and `communication_status = 'Manual Follow-up Required'` on
 * every one of them. No Communication_Record is written and no provider was called — the block
 * happened inside `renderMessage`, before this function was reached.
 */
async function recordGateBlock(input: GateBlockInput): Promise<void> {
  const eventTime = input.at.toISOString();
  const rows = input.caseIds.map((caseId) => ({
    case_id: caseId,
    actor_id: input.actorId,
    event_type: SEND_BLOCKED_EVENT_TYPE,
    event_time: eventTime,
    detail: {
      blocked_by: input.blocked.blockedBy,
      match: input.blocked.match,
      field: input.blocked.field ?? null,
      channel: input.channel,
      touchpoint: input.touchpoint,
      covered_case_ids: [...input.caseIds],
    },
  }));

  const eventFailure = await writeRows(
    () => input.client.from(EVENTS_TABLE).insert(rows),
    'block_event',
    input.caseIds[0] ?? null,
  );
  if (eventFailure !== null) input.summary.failures.push(eventFailure);

  const statusFailure = await writeRows(
    () => input.client
      .from(CASES_TABLE)
      .update({ communication_status: MANUAL_FOLLOW_UP_STATUS })
      .in('id', [...input.caseIds]),
    'block_status',
    input.caseIds[0] ?? null,
  );
  if (statusFailure !== null) input.summary.failures.push(statusFailure);
}

// ---------------------------------------------------------------------------
// The escalation plan (Requirement 20)
// ---------------------------------------------------------------------------

interface EscalationApplyInput {
  client: SupabaseClient;
  summary: SchedulerRunSummary;
  plan: EscalationPlan;
  actorId: string | null;
}

/**
 * Applies one escalation plan.
 *
 * A new reason is inserted first. Only where that insert succeeded are the notifications written
 * and `notified_at` stamped, so a `23505` from a concurrent run — which means that run took the
 * notification — notifies nobody a second time. That conditional is the whole of Requirement 20.10.
 * A reopened reason writes no notification at all: the pair has already had its one.
 */
async function applyEscalationPlan(input: EscalationApplyInput): Promise<void> {
  const { client, summary, plan } = input;
  if (plan.raises.length === 0) return;

  for (const raise of plan.raises) {
    if (raise.kind === 'new') {
      const inserted = await insertEscalation(client, raise.insert);
      if (inserted.failure !== null) {
        summary.failures.push(inserted.failure);
        continue;
      }
      // A conflict means another evaluation owns the pair, and its notification.
      if (!inserted.created) continue;
      summary.escalationsRaised += 1;

      if (raise.notifications.length > 0) {
        const failure = await writeRows(
          () => client.from(NOTIFICATIONS_TABLE).insert([...raise.notifications]),
          'escalation_notifications',
          plan.caseId,
        );
        if (failure === null) summary.notificationsWritten += raise.notifications.length;
        else summary.failures.push(failure);
      }

      const stamp = await writeRows(
        () => client
          .from(ESCALATIONS_TABLE)
          .update({ notified_at: raise.notifiedAt })
          .eq('case_id', plan.caseId)
          .eq('reason', raise.reason),
        'escalation_notified_at',
        plan.caseId,
      );
      if (stamp !== null) summary.failures.push(stamp);
    } else {
      const failure = await writeRows(
        () => client
          .from(ESCALATIONS_TABLE)
          .update({
            raised_at: raise.reopen.raised_at,
            cleared_at: raise.reopen.cleared_at,
            cleared_by: raise.reopen.cleared_by,
          })
          .eq('case_id', plan.caseId)
          .eq('reason', raise.reason)
          .not('cleared_at', 'is', null),
        'escalation_reopen',
        plan.caseId,
      );
      if (failure === null) summary.escalationsRaised += 1;
      else summary.failures.push(failure);
    }

    const eventFailure = await writeRows(
      () => client.from(EVENTS_TABLE).insert({
        case_id: raise.event.case_id,
        actor_id: input.actorId,
        event_type: raise.event.event_type,
        event_time: raise.event.event_time,
        detail: raise.event.detail,
      }),
      'escalation_event',
      plan.caseId,
    );
    if (eventFailure !== null) summary.failures.push(eventFailure);
  }

  if (plan.caseUpdate !== null) {
    const failure = await writeRows(
      () => client
        .from(CASES_TABLE)
        .update({
          communication_status: plan.caseUpdate!.communication_status,
          follow_up_deadline: plan.caseUpdate!.follow_up_deadline,
        })
        .eq('id', plan.caseId),
      'escalation_case_update',
      plan.caseId,
    );
    if (failure !== null) summary.failures.push(failure);
  }
}

async function insertEscalation(
  client: SupabaseClient,
  row: { case_id: string; reason: string; raised_at: string },
): Promise<{ created: boolean; failure: SchedulerFailure | null }> {
  try {
    const result = (await client.from(ESCALATIONS_TABLE).insert(row).select('id')) as PostgrestLike;
    const error = result?.error;
    if (error === null || error === undefined) return { created: true, failure: null };
    if (errorCode(error) === UNIQUE_VIOLATION_CODE) return { created: false, failure: null };
    return {
      created: false,
      failure: {
        stage: 'escalation_insert',
        caseId: row.case_id,
        message: errorText(error, 'The escalation reason could not be raised.'),
        code: errorCode(error),
      },
    };
  } catch (caught) {
    if (errorCode(caught) === UNIQUE_VIOLATION_CODE) return { created: false, failure: null };
    return {
      created: false,
      failure: {
        stage: 'escalation_insert',
        caseId: row.case_id,
        message: errorText(caught, 'The escalation reason could not be raised.'),
        code: errorCode(caught),
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySkipCounts(): SchedulerSkipCounts {
  const counts = {} as SchedulerSkipCounts;
  for (const reason of SCHEDULER_SKIP_REASONS) counts[reason] = 0;
  return counts;
}

/** True for Imported and Open, the two Case_Status values an automatic send permits (Req 12.12). */
export function isSendableCaseStatus(status: CaseStatus | null | undefined): boolean {
  return status === 'Imported' || status === 'Open';
}

/**
 * Whether email may be sent at all this run (Requirement 23.3).
 *
 * Mirrors `resolveProviders` in `./send`: an injected `isEmailConfigured` decides, otherwise an
 * injected `sendEmail` counts as configured — a caller that supplied its own sender is not asking
 * about `RESEND_API_KEY` — otherwise the real credential check runs.
 */
export function resolveEmailConfigured(providers: SendProviders | undefined): boolean {
  if (providers?.isEmailConfigured !== undefined) return providers.isEmailConfigured();
  if (providers?.sendEmail !== undefined) return true;
  return isEmailConfigured();
}

function keyOf(caseId: string, contactId: string, touchpoint: Touchpoint, channel: RenderChannel): string {
  return `${caseId}|${contactId}|${touchpoint}|${channel}`;
}

function communicationKey(row: CommunicationRecord): string {
  return `${row.case_id ?? ''}|${row.contact_id ?? ''}|${row.touchpoint}|${row.channel}`;
}

/** `SendSkipReason` onto the run summary's vocabulary. */
function mapSendSkipReason(reason: string): SchedulerSkipReason {
  switch (reason) {
    case 'existing_record':
      return 'existing_record';
    case 'email_not_configured':
      return 'email_not_configured';
    case 'render_blocked':
      return 'render_blocked';
    default:
      return 'recipient_absent';
  }
}

function groupBy<TRow>(rows: readonly TRow[], key: (row: TRow) => string): Map<string, TRow[]> {
  const grouped = new Map<string, TRow[]>();
  for (const row of rows) {
    const id = key(row);
    if (id.length === 0) continue;
    const list = grouped.get(id);
    if (list === undefined) grouped.set(id, [row]);
    else list.push(row);
  }
  return grouped;
}

/**
 * The template version rows with their template's Touchpoint attached.
 *
 * `cancellation_template_versions` carries no Touchpoint — the column lives on
 * `cancellation_templates` — and `selectTemplateVersion` needs it to pick the 15, 10, 5, or 1-day
 * template. Joining here keeps that knowledge out of the renderer, which stays pure.
 */
export function joinTemplateTouchpoints(
  versions: readonly TemplateVersionRow[],
  templates: readonly { id: string; touchpoint: Touchpoint }[],
): TemplateVersionRow[] {
  const touchpointById = new Map(templates.map((row) => [row.id, row.touchpoint]));
  return versions.map((version) => ({
    ...version,
    touchpoint: version.template_id ? touchpointById.get(version.template_id) ?? null : null,
  }));
}

function renderCaseOf(candidate: SchedulerCandidate): RenderCase {
  const row = candidate.caseRow;
  return {
    id: row.id,
    policy_number: row.policy_number,
    cancellation_effective_date: row.cancellation_effective_date,
    customer_name: row.customer_name,
    carrier: row.carrier,
    cancellation_reason: row.cancellation_reason,
    amount_due: row.amount_due,
    touchpoint: candidate.touchpoint,
  };
}

function renderContactOf(candidate: SchedulerCandidate): RenderContact {
  const contact = candidate.contact;
  return {
    id: contact.id,
    channel: contact.channel,
    normalized_value: contact.normalized_value,
    preferred_language: contact.preferred_language,
    contact_name: contact.contact_name,
  };
}

/** The assigned employee of a case, as Requirements 14.13, 14.14, and 20.8 test one. */
function assigneeOf(
  caseRow: SchedulerCaseRow,
  profilesById: ReadonlyMap<string, SchedulerProfileRow>,
): EscalationAssignee | null {
  const assignedTo = caseRow.assigned_to;
  if (typeof assignedTo !== 'string' || assignedTo.length === 0) return null;
  const profile = profilesById.get(assignedTo);
  if (profile === undefined) return null;
  return {
    id: profile.id,
    display_name: profile.display_name,
    is_active: profile.is_active,
    // Requirement 9.7's `(Deleted)` producer-label suffix is the only deletion marker the data
    // carries; `public.profiles` has no deleted column.
    is_deleted: hasDeletedSuffix(caseRow.producer_label),
  };
}

/**
 * The sender name a chunk renders with (Requirements 14.13, 14.14).
 *
 * A single-case message uses that case's assigned employee. A combined message uses one only where
 * every included case shares the same assigned employee; otherwise the message names no employee
 * and `renderMessage` falls back to Agency_Name, because a message covering two employees' cases
 * cannot be signed by one of them without misstating who to reply to.
 */
function resolveChunkAssignee(
  chunk: readonly SchedulerCandidate[],
  profilesById: ReadonlyMap<string, SchedulerProfileRow>,
): { employee: EscalationAssignee | null; profileId: string | null; profile: SchedulerProfileRow | null } {
  const first = chunk[0].caseRow.assigned_to ?? null;
  const shared = chunk.every((candidate) => (candidate.caseRow.assigned_to ?? null) === first);
  if (!shared || first === null) return { employee: null, profileId: null, profile: null };
  return {
    employee: assigneeOf(chunk[0].caseRow, profilesById),
    profileId: first,
    profile: profilesById.get(first) ?? null,
  };
}

/**
 * The Touchpoint and channel pairs scheduled for one case — the input the pending-send count of
 * Requirement 15.3 subtracts the stored rows from.
 *
 * A pair is scheduled where its due date has not passed and the channel has at least one eligible
 * Contact_Recipient (Requirement 12.2). A passed Touchpoint is excluded because Requirement 12.8
 * will never send it, so calling it pending would hold a case at Partially Sent forever. An email
 * pair with no credentials stays scheduled, which is what makes Requirement 23.3's Partially Sent
 * come out of the recompute for a case whose SMS succeeded.
 */
export function scheduledSendsFor(
  caseRow: Pick<SchedulerCaseRow, 'cancellation_effective_date'>,
  eligible: Record<SuppressionChannel, readonly SchedulerContactRow[]>,
  businessDate: string,
): ScheduledSend[] {
  const sends: ScheduledSend[] = [];
  for (const touchpoint of TOUCHPOINTS) {
    if (touchpointDueDate(caseRow.cancellation_effective_date, touchpoint) < businessDate) continue;
    for (const channel of SUPPRESSION_CHANNELS) {
      if (eligible[channel].length === 0) continue;
      sends.push({ touchpoint, channel });
    }
  }
  return sends;
}

function actorProfileId(actor: SchedulerActor | null | undefined): string | null {
  if (actor === null || actor === undefined) return null;
  return actor.kind === 'session' ? actor.profileId : null;
}

function errorCode(error: unknown): string | null {
  if (error === null || error === undefined || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (error !== null && error !== undefined && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return fallback;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
