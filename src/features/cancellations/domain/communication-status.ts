// Cancellations domain: Communication_Status derivation and the four derived cancellation-row
// cells.
//
// Requirement 15 is the contract for the two statuses, Requirement 16 criteria 9 and 10 for the
// row cells, and Requirement 20 criterion 11 for the escalation override:
// - 15.1        Case_Status is exactly one of ten values; only Imported and Open are open; a
//               write outside the ten is rejected with the stored value left unchanged
// - 15.2        Communication_Status is exactly one of nine values, rejected the same way
// - 15.3        the two are separate stored values, a delivery result is one of Sent, Delivered,
//               and Failed, a *pending Touchpoint channel send* is one scheduled Touchpoint and
//               channel with no stored Communication_Record, and neither Communication_Status nor
//               any delivery result takes part in a Case_Status derivation
// - 15.4        a record reaching Sent, Delivered, or Failed leaves Case_Status unchanged
// - 15.5-15.8   Delivered, Partially Failed, Failed, and Suppressed
// - 15.9        the fixed nine-step order this module returns, Manual Follow-up Required first
// - 16.9        the SMS status cell, the email status cell, the last contact value, and the next
//               required action, the last naming the same action the drawer makes primary
// - 16.10       a channel with at least one scheduled Touchpoint and zero records reads as the
//               exact character sequence `Scheduled`
// - 20.11       an uncleared escalation reason holds Manual Follow-up Required in preference to
//               every value Requirement 15 derives
//
// **Pure module.** No React, no Supabase client, no network, no file system, no clock, no
// randomness. The current business date and every row arrive as parameters, so the same inputs
// always derive the same status. Nothing here writes anything: `planCommunicationStatusUpdate`
// returns the payload a route or the scheduler writes.
//
// **Storage contract.** `cancellation_cases.communication_status` is checked against the nine
// values of `COMMUNICATION_STATUSES` and `case_status` against the ten of `CASE_STATUSES`
// (`v1.10.0-cancellation-core-tables.sql`). `cancellation_communications` holds one row per
// Idempotency_Key `(case_id, contact_id, touchpoint, channel)` with `delivery_result` checked
// against Sent, Delivered, and Failed (`v1.10.2`). `cancellation_escalations` is unique on
// `(case_id, reason)` with `cleared_at is null` meaning uncleared (`v1.10.3`).
//
// **No delivery-result progression is assumed.** The `delivery_result` column forbids no
// transition — a provider status callback legitimately moves Sent to Delivered or Sent to Failed
// after the fact — so every derivation here reads the current stored values of the rows it is
// handed and never infers a history from them.
//
// **Case_Status is never derived here.** No function in this file returns a `CaseStatus`, and
// `CommunicationStatusUpdate` deliberately carries no `case_status` key: the structural
// guarantee behind Requirements 15.3 and 15.4 is that a recompute has nowhere to put one.
//
// **Suppression is read through the sibling module.** `Suppressed` depends on suppression state,
// which is the flag on the contact row *or* an active `cancellation_suppressions` row for the
// value (`./suppression`), so `isContactSuppressed` asks that module both questions rather than
// trusting the denormalized flag alone. Note the two channel vocabularies:
// `cancellation_contacts.channel` is `'phone' | 'email'` while `cancellation_communications`
// and `cancellation_suppressions` use `'sms' | 'email'`; `suppressionChannelForContactChannel`
// is the only mapping used here.
//
// **Readings recorded where the criteria leave a precedence open.** Each is stated at the
// function that applies it, and collected here so a reviewer can find them in one place:
//
//  1. *Partially Failed outranks Partially Sent, and Failed outranks both.* Not an ambiguity:
//     Requirement 15.9 fixes the order, so a case carrying one failed record and three pending
//     sends reads `Failed`, not `Partially Sent`. Recorded because it surprises on first
//     reading.
//  2. *A channel cell whose records are all `Sent` reads `Sent`.* Requirement 16.9 says to apply
//     criteria 5 through 8, and those four produce nothing for a row set that is all Sent. The
//     ladder is completed with `Sent` from Requirement 15.9 rather than leaving the cell
//     undefined.
//  3. *A channel cell reads `Suppressed` ahead of `Not Scheduled`.* Both hold for a fully
//     suppressed case with zero records: criterion 8 gives Suppressed and criterion 16.9's third
//     clause gives Not Scheduled. Suppressed is returned, matching its position ahead of Not
//     Scheduled in the Requirement 15.9 order and saying more about the row.
//  4. *Requirement 20.11 does not reach the two channel cells.* It holds
//     `Communication_Status` — the case value — at Manual Follow-up Required. The SMS and email
//     cells are derived by Requirement 16.9 from that channel's own records, so an escalation
//     leaves them channel-truthful; the row surfaces the escalation through the next required
//     action, which becomes Call Customer under Requirement 17.4(e).
//  5. *The next required action cell reads as cleared when the stored column is null and
//     Case_Status is Reinstated, Cancelled, or Resolved.* Requirement 16.9 shows an em dash
//     "WHERE the next required action has been cleared", and Requirements 19.3, 19.7, and 19.8
//     are the only criteria that clear it — all three landing in one of those three statuses. A
//     null column on any other Case_Status is an action never set, not one cleared, so the cell
//     is derived.
//  6. *`Sent` requires at least one stored record.* Requirement 15.9's Sent clause is vacuously
//     true for a case with zero records, which would shadow the Not Scheduled clause of the same
//     criterion and contradict Requirement 15.10's freshly imported case. At least one record is
//     required, which is the only reading that leaves both clauses reachable.

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import type { ContactAuthorizationStatus, ContactValidationStatus } from '../import/contacts';
import { parseCancellationDate } from '../import/fields';
// Type-only: the four Touchpoints of Requirement 12.1 are declared once, in the renderer, and
// `import type` compiles away, so this module keeps that single definition without pulling any
// render code into a bundle that only derives statuses.
import type { Touchpoint } from '../render/renderMessage';
import {
  authorizationPermitsContact,
  isContactFlagSuppressed,
  isValueSuppressed,
  suppressionChannelForContactChannel,
  type ChannelEligibilityContact,
  type SuppressionChannel,
  type SuppressionRecord,
} from './suppression';

// ---------------------------------------------------------------------------
// Stored value domain
// ---------------------------------------------------------------------------

/** `cancellation_cases.case_status`, the eleven values the CHECK constraint allows. */
export type CaseStatus =
  | 'Imported'
  | 'Open'
  | 'Payment Reported'
  | 'Verification Pending'
  | 'Reinstatement Pending'
  | 'Reinstated'
  | 'Cancelled'
  | 'Resolved'
  | 'Invalid'
  | 'Duplicate'
  | 'Import Review Required';

export const CASE_STATUSES = [
  'Imported',
  'Open',
  'Payment Reported',
  'Verification Pending',
  'Reinstatement Pending',
  'Reinstated',
  'Cancelled',
  'Resolved',
  'Invalid',
  'Duplicate',
  'Import Review Required',
] as const satisfies readonly CaseStatus[];

/** The two open Case_Status values; every other value excludes automatic sending (Req 15.1, 12.12). */
export const OPEN_CASE_STATUSES = ['Imported', 'Open'] as const satisfies readonly CaseStatus[];

/** `cancellation_cases.communication_status`, the nine values Requirement 15.2 allows. */
export type CommunicationStatus =
  | 'Not Scheduled'
  | 'Scheduled'
  | 'Partially Sent'
  | 'Sent'
  | 'Delivered'
  | 'Partially Failed'
  | 'Failed'
  | 'Suppressed'
  | 'Manual Follow-up Required';

export const COMMUNICATION_STATUSES = [
  'Not Scheduled',
  'Scheduled',
  'Partially Sent',
  'Sent',
  'Delivered',
  'Partially Failed',
  'Failed',
  'Suppressed',
  'Manual Follow-up Required',
] as const satisfies readonly CommunicationStatus[];

/**
 * The nine steps of Requirement 15.9, most preferred first. `deriveCommunicationStatus` returns
 * the first step whose condition holds, and this array is that order written down so a test can
 * assert the sequence rather than restate it.
 */
export const COMMUNICATION_STATUS_PRECEDENCE = [
  'Manual Follow-up Required',
  'Failed',
  'Partially Failed',
  'Suppressed',
  'Partially Sent',
  'Delivered',
  'Sent',
  'Scheduled',
  'Not Scheduled',
] as const satisfies readonly CommunicationStatus[];

/** `cancellation_communications.delivery_result`, the three values Requirement 15.3 allows. */
export type DeliveryResult = 'Sent' | 'Delivered' | 'Failed';

export const DELIVERY_RESULTS = ['Sent', 'Delivered', 'Failed'] as const satisfies readonly DeliveryResult[];

/** `cancellation_cases.next_required_action`, the nine actions of Requirements 16.9 and 17.3. */
export type NextRequiredAction =
  | 'Add Contact Information'
  | 'Send Reminder Now'
  | 'Retry Failed Communication'
  | 'Call Customer'
  | 'Record Customer Response'
  | 'Verify Payment'
  | 'Confirm Reinstatement'
  | 'Confirm Cancellation'
  | 'Mark Resolved';

export const NEXT_REQUIRED_ACTIONS = [
  'Add Contact Information',
  'Send Reminder Now',
  'Retry Failed Communication',
  'Call Customer',
  'Record Customer Response',
  'Verify Payment',
  'Confirm Reinstatement',
  'Confirm Cancellation',
  'Mark Resolved',
] as const satisfies readonly NextRequiredAction[];

/**
 * The four actions Requirement 17.10 hides from Agent_Role. Confirm Cancellation is among them
 * and is never the primary action of Requirement 17.4, so no derivation here returns it: it is
 * reachable only as a value a manager stores directly.
 */
export const MANAGER_ONLY_ACTIONS = [
  'Verify Payment',
  'Confirm Reinstatement',
  'Confirm Cancellation',
  'Retry Failed Communication',
] as const satisfies readonly NextRequiredAction[];

/**
 * The three Case_Status values reached by a criterion that clears the next required action
 * (Requirements 19.3, 19.7, 19.8). Reading 5 of the file header.
 */
export const ACTION_CLEARING_CASE_STATUSES = [
  'Reinstated',
  'Cancelled',
  'Resolved',
] as const satisfies readonly CaseStatus[];

/**
 * The exact character sequence Requirement 16.10 fixes for a channel carrying at least one
 * scheduled Touchpoint and zero records. There is no per-channel column on
 * `cancellation_cases`; the two cells are derived, and this constant is what stops a caller
 * inventing a label such as `Scheduled (SMS)`.
 */
export const CHANNEL_SCHEDULED_CELL: CommunicationStatus = 'Scheduled';

/** The em dash Requirement 16.9 shows for an absent last contact or a cleared next action. */
export const EM_DASH = '\u2014';

const CASE_STATUS_SET: ReadonlySet<string> = new Set<string>(CASE_STATUSES);
const OPEN_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>(OPEN_CASE_STATUSES);
const COMMUNICATION_STATUS_SET: ReadonlySet<string> = new Set<string>(COMMUNICATION_STATUSES);
const DELIVERY_RESULT_SET: ReadonlySet<string> = new Set<string>(DELIVERY_RESULTS);
const NEXT_REQUIRED_ACTION_SET: ReadonlySet<string> = new Set<string>(NEXT_REQUIRED_ACTIONS);
const ACTION_CLEARING_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>(ACTION_CLEARING_CASE_STATUSES);

/** Case_Status values whose primary action is Mark Resolved (Requirement 17.4(g)). */
const MARK_RESOLVED_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>([
  'Reinstated',
  'Cancelled',
  'Invalid',
  'Duplicate',
]);

/** Case_Status values whose primary action is Verify Payment (Requirement 17.4(a)). */
const VERIFY_PAYMENT_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>([
  'Payment Reported',
  'Verification Pending',
]);

// ---------------------------------------------------------------------------
// Value-set guards and write rejection (Requirements 15.1, 15.2, 15.3)
// ---------------------------------------------------------------------------

export function isCaseStatus(value: unknown): value is CaseStatus {
  return typeof value === 'string' && CASE_STATUS_SET.has(value);
}

/** True for Imported and Open, the only open Case_Status values (Requirement 15.1). */
export function isOpenCaseStatus(value: unknown): boolean {
  return typeof value === 'string' && OPEN_CASE_STATUS_SET.has(value);
}

export function isCommunicationStatus(value: unknown): value is CommunicationStatus {
  return typeof value === 'string' && COMMUNICATION_STATUS_SET.has(value);
}

export function isDeliveryResult(value: unknown): value is DeliveryResult {
  return typeof value === 'string' && DELIVERY_RESULT_SET.has(value);
}

export function isNextRequiredAction(value: unknown): value is NextRequiredAction {
  return typeof value === 'string' && NEXT_REQUIRED_ACTION_SET.has(value);
}

/** Why a status write was refused. */
export type StatusRejectionCode =
  | 'case_status_not_allowed'
  | 'communication_status_not_allowed'
  | 'delivery_result_not_allowed';

export interface StatusRejection {
  code: StatusRejectionCode;
  message: string;
}

export type StatusValidation<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; rejection: StatusRejection };

/** A value for display inside a rejection message, quoted and clipped. */
function sample(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length <= 60 ? text : `${text.slice(0, 60)}…`;
}

/**
 * Accepts one of the ten Case_Status values and refuses everything else (Requirement 15.1). The
 * caller writes nothing on a refusal, which is what leaves the stored value unchanged.
 */
export function validateCaseStatus(value: unknown): StatusValidation<CaseStatus> {
  if (isCaseStatus(value)) return { ok: true, value };
  return {
    ok: false,
    rejection: {
      code: 'case_status_not_allowed',
      message: `"${sample(value)}" is not an allowed Case_Status.`,
    },
  };
}

/** Accepts one of the nine Communication_Status values and refuses everything else (Req 15.2). */
export function validateCommunicationStatus(value: unknown): StatusValidation<CommunicationStatus> {
  if (isCommunicationStatus(value)) return { ok: true, value };
  return {
    ok: false,
    rejection: {
      code: 'communication_status_not_allowed',
      message: `"${sample(value)}" is not an allowed Communication_Status.`,
    },
  };
}

/** Accepts Sent, Delivered, or Failed and refuses everything else (Requirement 15.3). */
export function validateDeliveryResult(value: unknown): StatusValidation<DeliveryResult> {
  if (isDeliveryResult(value)) return { ok: true, value };
  return {
    ok: false,
    rejection: {
      code: 'delivery_result_not_allowed',
      message: `"${sample(value)}" is not an allowed Communication_Record delivery result.`,
    },
  };
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The `cancellation_cases` columns a status derivation reads. Structural, so a full database row
 * and a test fixture both satisfy it. `communication_status` is the currently stored value, read
 * only to report whether a recompute changes it.
 */
export interface CommunicationStatusCase {
  id?: string | null;
  case_status: CaseStatus;
  communication_status?: CommunicationStatus | null;
  /** `date` column, so `YYYY-MM-DD`; `M/D/YYYY` parses too, through the import parser. */
  cancellation_effective_date?: string | null;
  next_required_action?: NextRequiredAction | null;
}

/**
 * The `cancellation_communications` columns a status derivation reads. One row exists per
 * Idempotency_Key, so a `(touchpoint, channel)` pair may appear once per Contact_Recipient.
 *
 * `channel` is the send channel, `'sms' | 'email'` — not the `'phone' | 'email'` of
 * `cancellation_contacts`.
 */
export interface CommunicationRecord {
  id?: string | null;
  case_id?: string | null;
  contact_id?: string | null;
  touchpoint: Touchpoint;
  channel: SuppressionChannel;
  delivery_result: DeliveryResult;
  /** `timestamptz`; the most recent one over sent and delivered rows is half of last contact. */
  send_time?: string | null;
  failure_reason?: string | null;
  attempt_count?: number | null;
  combined_group_id?: string | null;
}

/**
 * One Touchpoint and channel scheduled for a case under Requirement 12.2. Subtracting the
 * stored records from these gives the pending Touchpoint channel sends of Requirement 15.3.
 */
export interface ScheduledSend {
  touchpoint: Touchpoint;
  channel: SuppressionChannel;
}

/**
 * The `cancellation_escalations` columns this module reads. `cleared_at` absent or null means
 * uncleared, which is the whole of Requirement 20.11 as far as a status derivation is
 * concerned; the seven-reason vocabulary belongs to the escalation evaluator, so `reason` is
 * carried as plain text here and no reason is treated differently from any other.
 */
export interface EscalationRecord {
  id?: string | null;
  case_id?: string | null;
  reason?: string | null;
  raised_at?: string | null;
  cleared_at?: string | null;
  cleared_by?: string | null;
  notified_at?: string | null;
}

/** The `cancellation_customer_responses` column the last contact value reads (Req 16.9). */
export interface CustomerResponseRecord {
  id?: string | null;
  case_id?: string | null;
  response_time?: string | null;
}

/**
 * Everything the derivations of one Cancellation_Case read. Every list defaults to empty and
 * every optional value to the reading recorded at the function that uses it, so a caller builds
 * one object and the row cells and the drawer cannot disagree about the facts behind them.
 *
 * `businessDate` is the current business date as `YYYY-MM-DD`, the caller's clock: it decides
 * the current Touchpoint of Requirement 17.5 and nothing else. `viewerRole` gates the primary
 * action under Requirement 17.10 and defaults to the unrestricted Manager_Role view.
 */
export interface CaseCommunicationState {
  case: CommunicationStatusCase;
  contacts?: readonly ChannelEligibilityContact[];
  communications?: readonly CommunicationRecord[];
  /** Touchpoint and channel pairs scheduled under Requirement 12.2. */
  scheduledSends?: readonly ScheduledSend[];
  escalations?: readonly EscalationRecord[];
  responses?: readonly CustomerResponseRecord[];
  /** `cancellation_suppressions` rows; may be the whole table, cleared rows included. */
  suppressions?: readonly SuppressionRecord[];
  businessDate?: string | null;
  viewerRole?: AppRole | null;
}

/** The four derived cells of one cancellation row, alongside the case value they share. */
export interface CancellationRowCells {
  /** `cancellation_cases.communication_status` as recomputed (Requirement 15.9). */
  communicationStatus: CommunicationStatus;
  /** The SMS status cell (Requirements 16.9, 16.10). */
  smsStatus: CommunicationStatus;
  /** The email status cell (Requirements 16.9, 16.10). */
  emailStatus: CommunicationStatus;
  /** The most recent contact event time, or `null`, which the cell renders as `EM_DASH`. */
  lastContact: string | null;
  /** The primary action, or `null` where cleared, which the cell renders as `EM_DASH`. */
  nextRequiredAction: NextRequiredAction | null;
}

/**
 * The single `cancellation_cases` write a recompute produces. There is deliberately no
 * `case_status` key: Requirements 15.3 and 15.4 keep Case_Status out of every derivation that
 * reads a delivery result, and the plan having nowhere to put one is that guarantee in the type
 * system rather than in a comment.
 */
export interface CommunicationStatusUpdate {
  case_id: string | null;
  communication_status: CommunicationStatus;
  /** True when the derived value differs from the value stored on the case row. */
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Escalation override (Requirement 20.11)
// ---------------------------------------------------------------------------

/** True for an escalation row that has not been cleared (Requirement 20.12). */
export function isUnclearedEscalation(row: EscalationRecord): boolean {
  return row.cleared_at === null || row.cleared_at === undefined;
}

/**
 * True when at least one escalation reason of the case is uncleared, which is the one condition
 * that outranks every other step of the ladder (Requirement 20.11).
 */
export function hasUnclearedEscalation(escalations: readonly EscalationRecord[]): boolean {
  return escalations.some(isUnclearedEscalation);
}

// ---------------------------------------------------------------------------
// Suppression state (Requirement 15.8)
// ---------------------------------------------------------------------------

/**
 * True when a contact row is suppressed on its own channel: a phone row on `sms`, an email row
 * on `email` (`suppressionChannelForContactChannel`).
 *
 * Both halves of the suppression state are asked, because either one alone is incomplete. The
 * `cancellation_contacts` boolean is a denormalized mirror, and a contact row an import created
 * after the opt-out carries it cleared; the active `cancellation_suppressions` row is keyed by
 * normalized value, so it catches that row (Requirements 21.3, 21.4).
 */
export function isContactSuppressed(
  contact: ChannelEligibilityContact,
  suppressions: readonly SuppressionRecord[] = [],
): boolean {
  const channel = suppressionChannelForContactChannel(contact.channel);
  return (
    isContactFlagSuppressed(contact, channel) ||
    isValueSuppressed(contact.normalized_value, suppressions, channel)
  );
}

/**
 * Requirement 15.8's contact condition: at least one Contact_Recipient, SMS suppression set on
 * every row carrying a phone value, and email suppression set on every row carrying an email
 * value. `cancellation_contacts` holds one row per channel and value, so those three clauses
 * reduce to "every row is suppressed on its own channel" over a non-empty set — a case holding
 * only phone rows satisfies the email clause with nothing in it.
 */
export function everyContactSuppressed(
  contacts: readonly ChannelEligibilityContact[],
  suppressions: readonly SuppressionRecord[] = [],
): boolean {
  if (contacts.length === 0) return false;
  return contacts.every((contact) => isContactSuppressed(contact, suppressions));
}

// ---------------------------------------------------------------------------
// Contactability (Requirement 17.4(c))
// ---------------------------------------------------------------------------

/** The `cancellation_contacts` columns the contactability test of Requirement 17.4(c) reads. */
export interface ContactabilityContact {
  validation_status: ContactValidationStatus;
  authorization_status: ContactAuthorizationStatus;
}

/**
 * True for a contact row whose validation status is valid and whose authorization status permits
 * contact. Deliberately neither channel-scoped nor suppression-scoped: Requirement 17.4(c) asks
 * whether the case holds any usable contact detail at all, which is a different question from
 * the per-channel send eligibility of Requirement 10.10.
 */
export function isContactable(contact: ContactabilityContact): boolean {
  return contact.validation_status === 'valid' && authorizationPermitsContact(contact.authorization_status);
}

/** True when at least one contact row of the case is contactable (Requirement 17.4(c)). */
export function hasContactableContact(contacts: readonly ContactabilityContact[]): boolean {
  return contacts.some(isContactable);
}

// ---------------------------------------------------------------------------
// Touchpoints and the business date
// ---------------------------------------------------------------------------

/**
 * The whole-day difference from the business date to the cancellation effective date
 * (Requirement 16.1): 0 on the effective date, negative after it. `null` where either date is
 * absent or names no calendar date.
 *
 * Both values are calendar dates in the one time zone that decides the business date, so the
 * difference is computed from the parsed year, month, and day through `Date.UTC` and carries no
 * dependence on the host time zone or on daylight saving.
 */
export function daysRemaining(
  cancellationEffectiveDate: string | null | undefined,
  businessDate: string | null | undefined,
): number | null {
  const effective = parseCancellationDate(cancellationEffectiveDate);
  const current = parseCancellationDate(businessDate);
  if (!effective.ok || !current.ok) return null;
  const effectiveMs = Date.UTC(effective.year, effective.month - 1, effective.day);
  const currentMs = Date.UTC(current.year, current.month - 1, current.day);
  return Math.round((effectiveMs - currentMs) / 86_400_000);
}

/**
 * The current Touchpoint of Requirement 17.5: the Touchpoint whose due date is the latest one
 * not later than the business date, and the 15-day Touchpoint where no due date has arrived.
 *
 * A Touchpoint's due date is the effective date minus its days, so a due date on or before the
 * business date means the Touchpoint's days are at least the days remaining, and the latest such
 * due date belongs to the fewest such days. 12 days remaining resolves to the 15-day Touchpoint,
 * 0 and every negative number to the 1-day Touchpoint.
 */
export function currentTouchpoint(remainingDays: number): Touchpoint {
  if (remainingDays <= 1) return 1;
  if (remainingDays <= 5) return 5;
  if (remainingDays <= 10) return 10;
  return 15;
}

/**
 * The current Touchpoint of one case. Where the business date or the effective date is absent or
 * unparseable, Requirement 17.5's own fallback applies and the 15-day Touchpoint is returned:
 * with no date to compare, no Touchpoint due date is known to have arrived.
 */
export function currentTouchpointForCase(state: CaseCommunicationState): Touchpoint {
  const remaining = daysRemaining(state.case.cancellation_effective_date, state.businessDate);
  return remaining === null ? 15 : currentTouchpoint(remaining);
}

/** True when the case holds at least one record for a Touchpoint, on any channel (Req 17.4(f)). */
export function hasRecordForTouchpoint(
  communications: readonly CommunicationRecord[],
  touchpoint: Touchpoint,
): boolean {
  return communications.some((row) => row.touchpoint === touchpoint);
}

/**
 * The most recent Touchpoint among a set of records — the one with the fewest days remaining,
 * whose due date is the latest — or `null` for an empty set (Requirement 16.9).
 */
export function mostRecentTouchpoint(communications: readonly CommunicationRecord[]): Touchpoint | null {
  let latest: Touchpoint | null = null;
  for (const row of communications) {
    if (latest === null || row.touchpoint < latest) latest = row.touchpoint;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Pending Touchpoint channel sends (Requirement 15.3)
// ---------------------------------------------------------------------------

const sendKey = (send: ScheduledSend): string => `${send.touchpoint}|${send.channel}`;

/**
 * The scheduled Touchpoint and channel pairs carrying no stored Communication_Record — the
 * pending Touchpoint channel sends of Requirement 15.3.
 *
 * The subtraction is idempotent: a pending send has no stored row by definition, so passing an
 * already-filtered pending list returns it unchanged. That is why `deriveCommunicationStatus`
 * runs it over whatever the caller hands to its `pendingSends` slot — the scheduled set or the
 * pending set — and cannot get the subtraction wrong either way. Duplicate pairs collapse.
 */
export function pendingTouchpointChannelSends(
  scheduledSends: readonly ScheduledSend[],
  communications: readonly CommunicationRecord[],
): ScheduledSend[] {
  const stored = new Set<string>(communications.map(sendKey));
  const seen = new Set<string>();
  const pending: ScheduledSend[] = [];
  for (const send of scheduledSends) {
    const key = sendKey(send);
    if (stored.has(key) || seen.has(key)) continue;
    seen.add(key);
    pending.push({ touchpoint: send.touchpoint, channel: send.channel });
  }
  return pending;
}

// ---------------------------------------------------------------------------
// Communication_Status (Requirement 15.9)
// ---------------------------------------------------------------------------

/**
 * The Communication_Status of one Cancellation_Case: the first match in the fixed nine-step
 * order of Requirement 15.9, which is `COMMUNICATION_STATUS_PRECEDENCE`.
 *
 * 1. `Manual Follow-up Required` — an uncleared escalation reason. Requirement 20.11 makes this
 *    an override rather than a step: it is returned in preference to every value the remaining
 *    eight steps derive, including `Delivered` for a case whose every message arrived.
 * 2. `Failed` — at least one record, every record `Failed` (Requirement 15.7).
 * 3. `Partially Failed` — at least one `Failed` and at least one other (Requirement 15.6).
 * 4. `Suppressed` — zero records, at least one contact, every contact suppressed on its own
 *    channel (Requirement 15.8).
 * 5. `Partially Sent` — at least one record and at least one pending send.
 * 6. `Delivered` — at least one record, every record `Delivered`, zero pending (Req 15.5).
 * 7. `Sent` — zero pending and every record `Sent` or `Delivered`, at least one record.
 * 8. `Scheduled` — zero records, at least one pending send.
 * 9. `Not Scheduled` — zero records, zero pending sends.
 *
 * Steps 2 and 3 outrank step 5, so a case carrying one failed record and three pending sends
 * reads `Failed` rather than `Partially Sent`: the order of Requirement 15.9 is explicit and a
 * failure is the fact worth surfacing. Steps 1 through 9 are exhaustive — after step 3 no record
 * is `Failed`, which leaves steps 6 and 7 covering every remaining record set — so the function
 * is total and needs no fallback beyond step 9.
 *
 * Every value is read from the rows as they stand. No progression between delivery results is
 * assumed, because a provider callback may move `Sent` to `Delivered` or to `Failed` at any time.
 *
 * `pendingSends` is the design's slot for the scheduled Touchpoint and channel pairs; stored rows
 * are subtracted here (`pendingTouchpointChannelSends`), so passing the scheduled set and passing
 * the already-pending set give the same answer. `suppressions` may be the whole
 * `cancellation_suppressions` table and is needed only for step 4.
 */
export function deriveCommunicationStatus(
  caseRow: CommunicationStatusCase,
  contacts: readonly ChannelEligibilityContact[],
  communications: readonly CommunicationRecord[],
  pendingSends: readonly ScheduledSend[],
  escalations: readonly EscalationRecord[],
  suppressions: readonly SuppressionRecord[] = [],
): CommunicationStatus {
  // 1 — Requirement 20.11. Checked first and unconditionally: no record state clears it.
  if (hasUnclearedEscalation(escalations)) return 'Manual Follow-up Required';

  const recordCount = communications.length;
  const failedCount = communications.filter((row) => row.delivery_result === 'Failed').length;
  const pendingCount = pendingTouchpointChannelSends(pendingSends, communications).length;

  // 2 — Requirement 15.7.
  if (recordCount > 0 && failedCount === recordCount) return 'Failed';
  // 3 — Requirement 15.6. Past step 2, a failure here sits beside a non-failure.
  if (failedCount > 0) return 'Partially Failed';
  // 4 — Requirement 15.8.
  if (recordCount === 0 && everyContactSuppressed(contacts, suppressions)) return 'Suppressed';
  // 5 — Requirement 15.9.
  if (recordCount > 0 && pendingCount > 0) return 'Partially Sent';
  // 6 — Requirement 15.5.
  if (recordCount > 0 && pendingCount === 0 && communications.every((row) => row.delivery_result === 'Delivered')) {
    return 'Delivered';
  }
  // 7 — Requirement 15.9. At least one record is required: the clause is vacuously true for a
  //     case with none, which would shadow step 9 (reading 6 of the file header).
  if (recordCount > 0 && pendingCount === 0) return 'Sent';
  // 8 — Requirement 15.9.
  if (pendingCount > 0) return 'Scheduled';
  // 9 — Requirement 15.9, and the value Requirement 15.10 stores on a freshly imported case.
  return 'Not Scheduled';
}

/** The Communication_Status of the case described by a state bundle (Requirement 15.9). */
export function deriveCaseCommunicationStatus(state: CaseCommunicationState): CommunicationStatus {
  return deriveCommunicationStatus(
    state.case,
    state.contacts ?? [],
    state.communications ?? [],
    state.scheduledSends ?? [],
    state.escalations ?? [],
    state.suppressions ?? [],
  );
}

/**
 * The one `cancellation_cases` write a recompute produces (Requirement 15.9). `changed` is false
 * where the stored value already matches, so a caller can skip the write and the audit entry.
 *
 * The plan carries no `case_status`: a delivery result reaching Sent, Delivered, or Failed leaves
 * Case_Status unchanged (Requirements 15.3, 15.4), and there is nowhere here to write one.
 */
export function planCommunicationStatusUpdate(state: CaseCommunicationState): CommunicationStatusUpdate {
  const derived = deriveCaseCommunicationStatus(state);
  return {
    case_id: state.case.id ?? null,
    communication_status: derived,
    changed: (state.case.communication_status ?? null) !== derived,
  };
}

// ---------------------------------------------------------------------------
// Row cells (Requirements 16.9, 16.10)
// ---------------------------------------------------------------------------

/**
 * Requirement 15 criteria 5 through 7 applied to one non-empty set of records, completed with
 * `Sent`. Criteria 5 through 8 leave a set that is entirely `Sent` undefined, so the ladder is
 * finished from Requirement 15.9 rather than returning nothing (reading 2 of the file header).
 */
function recordSetStatus(communications: readonly CommunicationRecord[]): CommunicationStatus {
  const failedCount = communications.filter((row) => row.delivery_result === 'Failed').length;
  if (failedCount === communications.length) return 'Failed';
  if (failedCount > 0) return 'Partially Failed';
  if (communications.every((row) => row.delivery_result === 'Delivered')) return 'Delivered';
  return 'Sent';
}

/**
 * The status cell of one channel (Requirements 16.9, 16.10).
 *
 * Where the channel carries records, the cell reads the most recent Touchpoint that has any —
 * the fewest days remaining — and applies Requirement 15 criteria 5 through 7 to that
 * Touchpoint's records on that channel alone. An older Touchpoint's failure is therefore not
 * carried forward: the cell answers "how did the latest attempt on this channel go".
 *
 * Where the channel carries none, the cell reads `Suppressed` for a fully suppressed case
 * (criterion 8), otherwise the exact sequence `Scheduled` where the channel has at least one
 * scheduled Touchpoint (Requirement 16.10), otherwise `Not Scheduled`. Suppressed is preferred
 * to Not Scheduled where both hold, matching its position in the Requirement 15.9 order
 * (reading 3 of the file header).
 *
 * An uncleared escalation does not reach this cell: Requirement 20.11 holds the case's
 * Communication_Status, and the two channel cells stay truthful about their own channel
 * (reading 4 of the file header).
 */
export function deriveChannelStatusCell(
  channel: SuppressionChannel,
  state: CaseCommunicationState,
): CommunicationStatus {
  const onChannel = (state.communications ?? []).filter((row) => row.channel === channel);
  const latest = mostRecentTouchpoint(onChannel);
  if (latest !== null) {
    return recordSetStatus(onChannel.filter((row) => row.touchpoint === latest));
  }

  if (everyContactSuppressed(state.contacts ?? [], state.suppressions ?? [])) return 'Suppressed';
  const scheduled = (state.scheduledSends ?? []).some((send) => send.channel === channel);
  return scheduled ? CHANNEL_SCHEDULED_CELL : 'Not Scheduled';
}

/** The SMS status cell (Requirements 16.9, 16.10). */
export function deriveSmsStatusCell(state: CaseCommunicationState): CommunicationStatus {
  return deriveChannelStatusCell('sms', state);
}

/** The email status cell (Requirements 16.9, 16.10). */
export function deriveEmailStatusCell(state: CaseCommunicationState): CommunicationStatus {
  return deriveChannelStatusCell('email', state);
}

/**
 * The last contact value (Requirement 16.9): the most recent event time among the send times of
 * records whose delivery result is Sent or Delivered and the response times of recorded customer
 * responses, or `null` where no such event exists, which the cell renders as `EM_DASH`.
 *
 * A failed record contributes nothing — nothing reached the customer. Times are compared as
 * instants rather than as text, so a `timestamptz` rendered with a different offset still orders
 * correctly, and the stored string is returned unchanged. An absent or unparseable time is
 * skipped rather than treated as the epoch.
 */
export function deriveLastContact(state: CaseCommunicationState): string | null {
  let bestText: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;

  const consider = (value: string | null | undefined): void => {
    if (value === null || value === undefined) return;
    const ms = Date.parse(value);
    if (Number.isNaN(ms) || ms <= bestMs) return;
    bestMs = ms;
    bestText = value;
  };

  for (const row of state.communications ?? []) {
    if (row.delivery_result === 'Failed') continue;
    consider(row.send_time);
  }
  for (const response of state.responses ?? []) {
    consider(response.response_time);
  }
  return bestText;
}

/**
 * True where the next required action of the case has been cleared, which Requirement 16.9 shows
 * as an em dash.
 *
 * Reading 5 of the file header: the stored column is null *and* Case_Status is one of the three
 * values reached by a criterion that clears it (Requirements 19.3, 19.7, 19.8). A null column on
 * any other Case_Status is an action never set — every freshly imported case has one — so that
 * row's cell is derived rather than blanked.
 */
export function nextRequiredActionCleared(caseRow: CommunicationStatusCase): boolean {
  return (
    (caseRow.next_required_action ?? null) === null &&
    ACTION_CLEARING_CASE_STATUS_SET.has(caseRow.case_status)
  );
}

/**
 * The next required action (Requirement 16.9): the primary action of the cancellation detail
 * drawer, so the list cell and the drawer name the same action, or `null` where it has been
 * cleared.
 *
 * The ordered list is Requirement 17.4 exactly: (a) Verify Payment, (b) Confirm Reinstatement,
 * (c) Add Contact Information, (d) Retry Failed Communication, (e) Call Customer, (f) Send
 * Reminder Now, (g) Mark Resolved, (h) Record Customer Response. Each candidate must also be
 * shown to the signed-in profile under Requirement 17.10, which hides Verify Payment, Confirm
 * Reinstatement, and Retry Failed Communication from Agent_Role — so an agent looking at a case
 * whose Communication_Status is Partially Failed is offered the next action they can actually
 * take rather than one they cannot see. `viewerRole` absent reads as the unrestricted
 * Manager_Role view.
 *
 * Step (d) and step (e) read the case's Communication_Status, escalation override included, so
 * an escalated case names Call Customer. Step (f) reads the current Touchpoint of Requirement
 * 17.5, on any channel. Confirm Cancellation is never returned: Requirement 17.4 does not list
 * it as a primary-action candidate.
 */
export function deriveNextRequiredAction(state: CaseCommunicationState): NextRequiredAction | null {
  const caseRow = state.case;
  if (nextRequiredActionCleared(caseRow)) return null;

  const manager = isBroadManagerRole(state.viewerRole ?? 'manager');
  const status = deriveCaseCommunicationStatus(state);

  // (a)
  if (manager && VERIFY_PAYMENT_CASE_STATUS_SET.has(caseRow.case_status)) return 'Verify Payment';
  // (b)
  if (manager && caseRow.case_status === 'Reinstatement Pending') return 'Confirm Reinstatement';
  // (c)
  if (!hasContactableContact(state.contacts ?? [])) return 'Add Contact Information';
  // (d)
  if (manager && (status === 'Failed' || status === 'Partially Failed')) return 'Retry Failed Communication';
  // (e)
  if (status === 'Manual Follow-up Required') return 'Call Customer';
  // (f)
  if (
    isOpenCaseStatus(caseRow.case_status) &&
    !hasRecordForTouchpoint(state.communications ?? [], currentTouchpointForCase(state))
  ) {
    return 'Send Reminder Now';
  }
  // (g)
  if (MARK_RESOLVED_CASE_STATUS_SET.has(caseRow.case_status)) return 'Mark Resolved';
  // (h)
  return 'Record Customer Response';
}

/**
 * The four derived cells of one cancellation row, plus the Communication_Status they are
 * recomputed alongside (Requirements 15.9, 16.9, 16.10). One entry point over one state bundle,
 * so the list surface and the drawer cannot disagree.
 */
export function deriveRowCells(state: CaseCommunicationState): CancellationRowCells {
  return {
    communicationStatus: deriveCaseCommunicationStatus(state),
    smsStatus: deriveSmsStatusCell(state),
    emailStatus: deriveEmailStatusCell(state),
    lastContact: deriveLastContact(state),
    nextRequiredAction: deriveNextRequiredAction(state),
  };
}

/** A derived cell value for display: the value itself, or an em dash where it is absent. */
export function cellText(value: string | null): string {
  return value === null ? EM_DASH : value;
}
