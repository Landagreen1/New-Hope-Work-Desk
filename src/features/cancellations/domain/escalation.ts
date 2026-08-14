// Cancellations domain: manual follow-up escalation — the seven reasons, the notification
// plan, and the clear.
//
// Requirement 20 is the whole contract for this module:
// - 20.1        `No Valid Contact` — 0 valid phone rows and 0 valid email rows
// - 20.2        `All Channels Failed` — for one Touchpoint, the most recent record of every
//               enabled channel of every valid authorized Contact_Recipient failed and no
//               record of that Touchpoint delivered
// - 20.3        `SMS Suppressed Without Email` — SMS suppressed on every phone contact and
//               0 valid email rows
// - 20.4        `Customer Assistance Requested` — a recorded response asked for assistance
// - 20.5        `No Delivered Contact` — evaluated exactly 1 day before the effective date on
//               an open case with 0 delivered records
// - 20.6        `Payment Reported` — Case_Status reached Payment Reported
// - 20.7        `Authorization Unknown` — at least 1 valid row, none authorized, every valid
//               row unknown
// - 20.8 / 20.9 the follow-up goes to the assigned employee when present, active, and not
//               deleted, otherwise one `public.user_notifications` row per Manager_Role
//               profile; the deadline is the earlier of escalation time + 24 h and the
//               cancellation effective date; Case_Status is left unchanged and an unassigned
//               case stays unassigned
// - 20.10       an evaluation runs at import completion, on every Notification_Scheduler run,
//               and after every Contact_Recipient change, and at most 1 notification exists
//               for each (case, reason) pair across every one of them
// - 20.11       an uncleared reason holds Communication_Status at Manual Follow-up Required —
//               derived in `./communication-status`, not here
// - 20.12       a manual contact outcome with note text clears every uncleared reason, clears
//               the deadline, recomputes Communication_Status, and is audited
//
// **Pure module.** No React, no Supabase client, no network, no file system, no clock, no
// randomness. The business date and every row arrive as parameters, the escalation time arrives
// as `EscalationPlanOptions.now`, and every function returns a *plan* — the rows a route or the
// scheduler writes — rather than performing a write. That is the pattern `./suppression`
// established, and it is what lets a test drive the evaluator with an in-memory world.
//
// **Requirement 20.10 is enforced by the unique key, not by a read.**
// `cancellation_escalations` is `unique (case_id, reason)` (`v1.10.3`). A caller writes a raise
// in this order and no other:
//
//   1. `insert into cancellation_escalations (case_id, reason, raised_at) ... on conflict
//      (case_id, reason) do nothing returning id`
//   2. only when step 1 returned a row: insert `raise.notifications` into
//      `public.user_notifications`, then stamp `notified_at = raise.notifiedAt` on the row
//      step 1 returned
//   3. write `plan.caseUpdate` and the audit entries
//
// Two concurrent evaluations therefore produce one notification, not two, and neither has to
// read first. `NewEscalationRaise` exists to carry exactly that conditional pair: the insert,
// and the writes that follow only when the insert created a row. A `ReopenedEscalationRaise`
// carries no notification at all — its pair has been notified once already, and Requirement
// 20.10 caps it there for the life of the case.
//
// **This module owns the reason union.** `./communication-status` deliberately types
// `EscalationRecord.reason` as plain text so it can read uncleared rows for Requirement 20.11
// without depending on this file. The dependency runs one way — escalation reads
// communication-status, never the reverse — and `EscalationReason` here is the single
// definition of the seven values `cancellation_escalations.reason` is constrained to.
//
// **Sibling helpers, not second definitions.** Contact validity, per-channel send eligibility,
// suppression, the open Case_Status set, and the whole-day date difference all have exactly one
// definition, in `./suppression` or `./communication-status`, and every criterion below is read
// through it. Nothing here re-derives Communication_Status either: the clear plan asks
// `deriveCaseCommunicationStatus` for the recomputed value Requirement 20.12 calls for.
//
// **Readings recorded where a criterion leaves a condition open.** Each is stated again at the
// function that applies it, and collected here so a reviewer can find them in one place:
//
//  1. *Requirement 20.7 is unsatisfiable as literally written, and is read as "none
//     authorized".* The criterion asks for at least one valid row, "0 Contact_Recipient rows
//     whose authorization status permits contact", and every valid row carrying an unknown
//     status. But Requirements 10.9 and 10.10 make `Unknown` a status that *does* permit
//     contact (`authorizationPermitsContact`), so the second and third clauses can hold
//     together only when there is no valid row at all — contradicting the first. The clause is
//     therefore read as "0 Contact_Recipient rows are `Authorized`", which is the only reading
//     that leaves the reason reachable and matches its name: contact detail is held, and
//     permission was never confirmed.
//  2. *Requirement 20.2's contact set is the eligible set, not every valid authorized row.* The
//     criterion says "every valid authorized Contact_Recipient". A suppressed row is valid and
//     authorized yet can never carry a record — Requirements 21.3 and 21.4 forbid the send — so
//     requiring a failed record from it would make the reason unreachable for exactly the cases
//     that need a person. The set is `eligibleContacts` per enabled channel, which is validity,
//     authorization, and suppression under one definition (Requirement 10.10).
//  3. *Requirement 20.2 needs every eligible pair to carry a record.* A pair with no record for
//     the Touchpoint is a send still pending, not a failure, so the reason does not hold while
//     one is outstanding. Combined with reading 2, `All Channels Failed` means: every pair the
//     module would have attempted for that Touchpoint carries a record, every one of those
//     records failed, and nothing delivered.
//  4. *Requirement 20.2 is existential over Touchpoints.* "for the same Touchpoint" binds a
//     Touchpoint rather than naming the current one, so the reason holds when *any* Touchpoint
//     satisfies it. That is also the only monotone reading: a raise is a one-time event capped
//     by the unique key and cleared only by Requirement 20.12, so a reason that stopped holding
//     because a later Touchpoint delivered must not silently un-raise.
//  5. *Requirement 20.3's "every Contact_Recipient" is every phone Contact_Recipient, over a
//     non-empty phone set.* `sms_suppressed` exists on an email row too, so the literal reading
//     would let an unsuppressed email row block the reason; Requirement 15.8 states the same
//     test channel-scoped ("every Contact_Recipient carrying a phone value"), and this follows
//     it. At least one phone row is required as well, because a case with no phone contact at
//     all is Requirement 20.1's `No Valid Contact`, and naming it `SMS Suppressed Without
//     Email` would describe a suppression that does not exist.
//  6. *Requirement 20.5 is exactly one day, not one day or fewer.* The criterion names "the
//     calendar date exactly 1 day before the cancellation effective date", so an evaluation on
//     the effective date or later does not raise the reason. Nothing is lost: an evaluation runs
//     on every scheduler run (Requirement 20.10), and once raised the reason stays until a
//     manual contact outcome clears it.
//  7. *The effective date clamps the deadline at the start of that date read as UTC.*
//     Requirement 20.8's deadline is "the earlier of 24 hours after the escalation time and the
//     cancellation effective date", and `cancellation_effective_date` is a `date` with no time
//     component. UTC midnight of that date is the earlier of the two candidate instants for
//     `America/New_York`, whose midnight is 4 to 5 hours later, so clamping there can only make
//     the deadline earlier — never later than the moment the policy cancels in agency local
//     time. Where the escalation time is already past that instant, the deadline is in the past,
//     which is what the criterion says and reads correctly as overdue.
//  8. *Requirement 20.9 notifies every Manager_Role profile the caller supplies, active or
//     not.* Criterion 8 qualifies the assigned employee with "present, active, and not marked
//     deleted"; criterion 9 says only "each profile holding Manager_Role". That asymmetry is
//     kept: the module filters the supplied profiles by role and by distinct id, and leaves the
//     activity filter to the query that selects them.
//  9. *A reason recurring after a clear reopens its row and notifies nobody.* The unique key
//     means the pair has one row for the life of the case, so a recurrence is an update —
//     `raised_at` forward, `cleared_at` and `cleared_by` back to null — which is what restores
//     Requirement 20.11's hold on Communication_Status. No second notification is written,
//     because Requirement 20.10 caps them at one per pair across every evaluation, and
//     `notified_at` is already stamped.
// 10. *A raise is audited even though Requirement 20 does not ask for it.* Requirement 20.12
//     requires the clear in the chronological audit timeline, and a clear entry with no matching
//     raise entry cannot be read. Each raise therefore carries one `cancellation_events` entry.
//     Nothing forces a caller to write it.
// 11. *Nothing here recomputes Communication_Status on the raise path.* Requirements 20.1
//     through 20.7 set it to Manual Follow-up Required, which `EscalationCaseUpdate` carries
//     directly; the derivation of every other value stays in `./communication-status`, where
//     Requirement 20.11 reads the uncleared rows. The raise plan writes no Case_Status and no
//     assignment, which is Requirements 20.8 and 20.9 in the type system rather than in a
//     comment.

import { canAccessRenewals, canManageRenewals } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import type { ContactAuthorizationStatus } from '../import/contacts';
import { parseCancellationDate } from '../import/fields';
// Type-only: the assigned-employee facts of Requirement 20.8 are the same three Requirement
// 14.13 tests, and `import type` compiles away, so this module reuses that declaration without
// pulling any render code into a bundle that only evaluates escalations.
import type { AssignedEmployee } from '../render/renderMessage';
import {
  daysRemaining,
  deriveCaseCommunicationStatus,
  isContactSuppressed,
  isOpenCaseStatus,
  isUnclearedEscalation,
  type CaseCommunicationState,
  type CommunicationRecord,
  type CommunicationStatus,
  type CommunicationStatusCase,
  type CustomerResponseRecord,
  type EscalationRecord,
} from './communication-status';
import {
  contactExclusionReason,
  eligibleContacts,
  suppressionChannelForContactChannel,
  SUPPRESSION_CHANNELS,
  type CancellationEventInsert,
  type ChannelEligibilityContact,
  type SuppressionChannel,
  type SuppressionRecord,
} from './suppression';

// ---------------------------------------------------------------------------
// Stored value domain
// ---------------------------------------------------------------------------

/**
 * `cancellation_escalations.reason`, the seven reasons of Requirement 20 criteria 1 through 7.
 *
 * This module owns the union. `./communication-status` carries the same column as plain text on
 * purpose, so that reading uncleared rows for Requirement 20.11 costs it no dependency on this
 * file; a later consolidation may tighten that side, and until then the direction of the
 * dependency is one way.
 */
export type EscalationReason =
  | 'No Valid Contact'
  | 'All Channels Failed'
  | 'SMS Suppressed Without Email'
  | 'Customer Assistance Requested'
  | 'No Delivered Contact'
  | 'Payment Reported'
  | 'Authorization Unknown';

/**
 * The seven reasons in Requirement 20 criteria 1 through 7 order, which is also the order the
 * `cancellation_escalations_reason_values` check constraint lists them in and the order
 * `evaluateEscalations` returns them in.
 */
export const ESCALATION_REASONS = [
  'No Valid Contact',
  'All Channels Failed',
  'SMS Suppressed Without Email',
  'Customer Assistance Requested',
  'No Delivered Contact',
  'Payment Reported',
  'Authorization Unknown',
] as const satisfies readonly EscalationReason[];

/**
 * `public.user_notifications.notification_type` for an escalation notification. Permitted
 * alongside `turn` and `assignment` by `v1.10.7-extend-user-notifications-type.sql`, which is
 * the forward-only migration Requirement 20.8 calls for.
 */
export const CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE = 'cancellation_follow_up';

/** `public.user_notifications.entity_type` for a row addressed at a Cancellation_Case. */
export const CANCELLATION_CASE_ENTITY_TYPE = 'cancellation_case';

/** The Communication_Status every one of the seven reasons sets (Requirement 20 criteria 1–7). */
export const MANUAL_FOLLOW_UP_STATUS = 'Manual Follow-up Required' as const;

/** The Case_Status that raises `Payment Reported` (Requirement 20.6). */
export const PAYMENT_REPORTED_CASE_STATUS = 'Payment Reported';

/** Requirement 20.8's window: 24 hours, before the effective-date clamp. */
export const FOLLOW_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The days remaining at which Requirement 20.5 evaluates: exactly one (reading 6). */
export const NO_DELIVERED_CONTACT_DAYS_REMAINING = 1;

/**
 * The two `cancellation_customer_responses.response_type` values Requirement 21.7 turns into
 * Requirement 20.4's customer response requesting assistance.
 */
export const ASSISTANCE_RESPONSE_TYPES = ['Assistance requested', 'Callback requested'] as const;

/**
 * The authorization status Requirement 20.7 is read against (reading 1). Deliberately not
 * `authorizationPermitsContact`, which also admits `Unknown` under Requirements 10.9 and 10.10
 * and would leave the criterion unsatisfiable.
 */
export const AUTHORIZED_STATUS: ContactAuthorizationStatus = 'Authorized';

/** The authorization status Requirement 20.7's valid rows must all carry. */
export const UNKNOWN_AUTHORIZATION_STATUS: ContactAuthorizationStatus = 'Unknown';

/** Longest manual contact outcome note accepted, measured after trimming. */
export const MAX_CONTACT_OUTCOME_NOTE_LENGTH = 4000;

/** `cancellation_events.event_type` for a raised escalation reason (reading 10). */
export const ESCALATION_RAISED_EVENT_TYPE = 'escalation_raised';

/** `cancellation_events.event_type` for a cleared escalation reason (Requirement 20.12). */
export const ESCALATION_CLEARED_EVENT_TYPE = 'escalation_cleared';

const ESCALATION_REASON_SET: ReadonlySet<string> = new Set<string>(ESCALATION_REASONS);
const ASSISTANCE_RESPONSE_TYPE_SET: ReadonlySet<string> = new Set<string>(ASSISTANCE_RESPONSE_TYPES);

/** True for one of the seven reasons `cancellation_escalations.reason` permits. */
export function isEscalationReason(value: unknown): value is EscalationReason {
  return typeof value === 'string' && ESCALATION_REASON_SET.has(value);
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The `cancellation_cases` columns an escalation evaluation and its plan read. Extends the case
 * shape `./communication-status` derives from with the four columns Requirement 20 adds, so one
 * selected row satisfies both.
 */
export interface EscalationCase extends CommunicationStatusCase {
  /** Requirement 21.7's stored flag, the denormalized half of Requirement 20.4. */
  assistance_requested?: boolean | null;
  /** `cancellation_cases.assigned_to`; the profile itself arrives as `assignedEmployee`. */
  assigned_to?: string | null;
  /** The currently stored deadline. Read only to report whether a plan changes it. */
  follow_up_deadline?: string | null;
  /** Notification text only (Requirements 20.8, 20.9). No derivation reads either of these. */
  policy_number?: string | null;
  customer_name?: string | null;
}

/**
 * A `cancellation_contacts` row as an escalation evaluation reads it: the eligibility columns of
 * `./suppression` plus the row id.
 *
 * The id is required rather than optional because Requirement 20.2 pairs a record with the
 * contact it was addressed to through `cancellation_communications.contact_id`, and a contact
 * with no id pairs with nothing. Every stored row has one.
 */
export interface EscalationContact extends ChannelEligibilityContact {
  id: string;
  case_id?: string | null;
}

/**
 * A `cancellation_customer_responses` row as Requirement 20.4 reads it. Extends the shape
 * `./communication-status` uses for the last contact value with the response type.
 *
 * `response_type` stays plain text: the six-value vocabulary of Requirement 21.5 belongs to the
 * response-recording module, and this file needs only the two values Requirement 21.7 promotes
 * to an assistance request.
 */
export interface EscalationResponseRecord extends CustomerResponseRecord {
  response_type?: string | null;
}

/** The assigned employee of a case, as Requirement 20.8 tests it. */
export interface EscalationAssignee extends AssignedEmployee {
  id: string;
}

/**
 * A profile in the Requirement 20.9 fan-out. `role` is filtered through `isBroadManagerRole`, so
 * a caller may hand over a wider profile list without notifying anyone outside Manager_Role.
 */
export interface EscalationRecipientProfile {
  id: string;
  role: AppRole;
}

/**
 * Everything an escalation evaluation of one Cancellation_Case reads. Extends the state bundle
 * `./communication-status` derives from, so one object serves the status derivation, the row
 * cells, and the seven reasons, and they cannot disagree about the facts behind them.
 *
 * `businessDate` is the current business date as `YYYY-MM-DD` and decides Requirement 20.5 and
 * nothing else. `escalations` is the stored `cancellation_escalations` rows of the case, cleared
 * rows included, which is what tells a plan whether a reason is new, a reopen, or already
 * raised.
 */
export interface EscalationState extends CaseCommunicationState {
  case: EscalationCase;
  contacts?: readonly EscalationContact[];
  responses?: readonly EscalationResponseRecord[];
  /**
   * The send channels the module can currently use — Requirement 20.2's "enabled channel". No
   * criterion enumerates them and `cancellation_settings` carries no per-channel switch, so a
   * caller that has no email credentials (Requirement 12.13) passes `['sms']`. Both channels by
   * default.
   */
  enabledChannels?: readonly SuppressionChannel[];
}

/** One `cancellation_escalations` insert; the database owns `id` and the column defaults. */
export interface EscalationInsert {
  case_id: string;
  reason: EscalationReason;
  raised_at: string;
}

/**
 * The reopen of one cleared `cancellation_escalations` row (reading 9). Written as
 * `update ... set raised_at = ..., cleared_at = null, cleared_by = null where case_id = ? and
 * reason = ? and cleared_at is not null`, so an evaluation that loses a race to another reopen
 * changes nothing. `notified_at` is deliberately absent: the pair was notified once and
 * Requirement 20.10 caps it there.
 */
export interface EscalationReopen {
  escalation_id: string | null;
  case_id: string;
  reason: EscalationReason;
  raised_at: string;
  cleared_at: null;
  cleared_by: null;
}

/** One `public.user_notifications` insert (Requirements 20.8, 20.9). */
export interface UserNotificationInsert {
  recipient_profile_id: string;
  notification_type: typeof CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE;
  title: string;
  message: string;
  entity_type: typeof CANCELLATION_CASE_ENTITY_TYPE;
  entity_id: string | null;
}

/** Which of Requirements 20.8 and 20.9 supplied the recipients of a raise. */
export type EscalationRecipientRule = 'assigned_employee' | 'manager_role';

/** `detail` of a raise audit entry (reading 10). */
export interface EscalationRaisedEventDetail {
  reason: EscalationReason;
  raised_at: string;
  follow_up_deadline: string;
  /** The rule that supplied the recipients, or `null` for a reopen, which notifies nobody. */
  recipients: EscalationRecipientRule | null;
  notified_profile_ids: string[];
  reopened: boolean;
}

/** `detail` of a clear audit entry (Requirement 20.12). */
export interface EscalationClearedEventDetail {
  reasons: string[];
  note: string;
  recomputed_communication_status: CommunicationStatus;
}

interface EscalationRaiseBase {
  reason: EscalationReason;
  raisedAt: string;
  /** The earlier of the escalation time + 24 h and the effective date (Requirement 20.8). */
  followUpDeadline: string;
  /**
   * The `public.user_notifications` rows to write, and only ever *after* the escalation write of
   * this same raise has been shown to have changed a row (Requirement 20.10). Empty for a
   * reopen.
   */
  notifications: UserNotificationInsert[];
  event: CancellationEventInsert<EscalationRaisedEventDetail>;
}

/**
 * A reason with no stored `cancellation_escalations` row.
 *
 * `insert` goes in with `on conflict (case_id, reason) do nothing returning id`. Only when that
 * returns a row does the caller write `notifications` and stamp `notified_at = notifiedAt` on
 * it. A concurrent evaluation that inserted first takes the notification; this one writes none.
 * That ordering is the whole of Requirement 20.10.
 */
export interface NewEscalationRaise extends EscalationRaiseBase {
  kind: 'new';
  insert: EscalationInsert;
  /** The stamp for the row `insert` created, written with the notifications and never without. */
  notifiedAt: string;
  recipients: EscalationRecipientRule;
}

/**
 * A reason whose row exists cleared, recurring after a Requirement 20.12 clear (reading 9). The
 * row is reopened so Requirement 20.11 holds Communication_Status again; `notifications` is
 * empty because the pair has been notified once and cannot be notified twice.
 */
export interface ReopenedEscalationRaise extends EscalationRaiseBase {
  kind: 'reopened';
  reopen: EscalationReopen;
}

export type EscalationRaise = NewEscalationRaise | ReopenedEscalationRaise;

/**
 * The single `cancellation_cases` write a raise produces (Requirements 20.1–20.9).
 *
 * There is deliberately no `case_status` key and no `assigned_to` key: Requirement 20.8 leaves
 * Case_Status unchanged and Requirement 20.9 leaves an unassigned case unassigned, and the plan
 * having nowhere to put either one is that guarantee in the type system rather than in a
 * comment.
 */
export interface EscalationCaseUpdate {
  case_id: string;
  communication_status: typeof MANUAL_FOLLOW_UP_STATUS;
  follow_up_deadline: string;
  /** True when the derived deadline differs from the value stored on the case row. */
  deadlineChanged: boolean;
}

/** The writes one escalation evaluation produces. */
export interface EscalationPlan {
  caseId: string;
  /** Every reason the evaluation finds, in Requirement 20 criteria 1–7 order. */
  reasons: EscalationReason[];
  /** Reasons whose row is already stored uncleared: raised and notified, so nothing to write. */
  alreadyRaised: EscalationReason[];
  /** One entry per reason needing a write, in the same criteria order. */
  raises: EscalationRaise[];
  /**
   * The one `cancellation_cases` write, or `null` when nothing was raised. Requirement 20.8's
   * deadline is set when Communication_Status *becomes* Manual Follow-up Required, so an
   * evaluation that finds only reasons already raised writes nothing and does not push the
   * deadline forward.
   */
  caseUpdate: EscalationCaseUpdate | null;
}

/** Why a plan could not be built. */
export type EscalationRejectionCode = 'case_id_required';

export interface EscalationRejection {
  code: EscalationRejectionCode;
  message: string;
}

export type EscalationPlanResult =
  | { ok: true; plan: EscalationPlan }
  | { ok: false; rejection: EscalationRejection };

/** The profile a Requirement 20.12 clear is attributed to. */
export interface ContactOutcomeActor {
  id: string;
  role: AppRole;
}

/**
 * One `cancellation_escalations` clear (Requirement 20.12). Written as
 * `update ... set cleared_at = ..., cleared_by = ... where case_id = ? and reason = ? and
 * cleared_at is null`, so a row another clear already closed is not rewritten.
 */
export interface EscalationClearUpdate {
  escalation_id: string | null;
  case_id: string;
  /**
   * The stored reason text. `cancellation_escalations.reason` is constrained to the seven
   * values, and a value outside them is still cleared rather than left uncleared.
   */
  reason: string;
  cleared_at: string;
  cleared_by: string;
}

/**
 * The single `cancellation_cases` write a clear produces (Requirement 20.12): the deadline
 * cleared and Communication_Status recomputed under Requirement 15. No `case_status` key, for
 * the same reason `EscalationCaseUpdate` has none.
 */
export interface ClearEscalationsCaseUpdate {
  case_id: string;
  follow_up_deadline: null;
  communication_status: CommunicationStatus;
}

/** The writes one manual contact outcome produces (Requirement 20.12). */
export interface ClearEscalationsPlan {
  caseId: string;
  clearedAt: string;
  clearedBy: string;
  /** The note text as stored: trimmed, at least one character. */
  note: string;
  /** Every reason marked cleared, as stored, in the order the rows arrived. */
  clearedReasons: string[];
  updates: EscalationClearUpdate[];
  caseUpdate: ClearEscalationsCaseUpdate;
  /** One entry carrying the clearing profile, the clearing time, and every cleared reason. */
  event: CancellationEventInsert<EscalationClearedEventDetail>;
}

/** Why a clear was refused. */
export type ClearEscalationsRejectionCode =
  | 'role_not_permitted'
  | 'actor_required'
  | 'case_id_required'
  | 'note_text_empty'
  | 'note_text_too_long'
  | 'case_not_escalated';

export interface ClearEscalationsRejection {
  code: ClearEscalationsRejectionCode;
  message: string;
}

export type ClearEscalationsResult =
  | { ok: true; plan: ClearEscalationsPlan }
  | { ok: false; rejection: ClearEscalationsRejection };

// ---------------------------------------------------------------------------
// Contact-state reads, each through one sibling definition
// ---------------------------------------------------------------------------

/** No suppression rows: the list a validity-only question passes to `contactExclusionReason`. */
const NO_SUPPRESSIONS: readonly SuppressionRecord[] = [];

/** True when a contact row belongs to a send channel: `sms` addresses phone rows. */
function isOnSendChannel(contact: ChannelEligibilityContact, channel: SuppressionChannel): boolean {
  return suppressionChannelForContactChannel(contact.channel) === channel;
}

/**
 * True for a contact row whose validation status is valid — the "valid phone" and "valid email"
 * rows of Requirement 20 criteria 1, 3, and 7.
 *
 * Read through `contactExclusionReason` against the row's own send channel so this module
 * carries no second definition of a valid contact row. The suppression list is empty and only
 * `validation_invalid` is compared, because these criteria count *valid* rows rather than
 * sendable ones: an unknown-authorization row and a suppressed row are both still valid.
 */
export function isValidContactRow(contact: ChannelEligibilityContact): boolean {
  const channel = suppressionChannelForContactChannel(contact.channel);
  return contactExclusionReason(contact, NO_SUPPRESSIONS, channel) !== 'validation_invalid';
}

/**
 * The most recent record of a set: the latest parsed `send_time`, with stored input order
 * breaking a tie and standing in for an absent or unparseable time (Requirement 16.7's
 * insertion-order rule). `null` for an empty set.
 *
 * `unique (case_id, contact_id, touchpoint, channel)` means a set narrowed to one contact,
 * channel, and Touchpoint holds at most one stored row, so this matters only where a caller
 * hands over duplicates.
 */
function mostRecentRecord(records: readonly CommunicationRecord[]): CommunicationRecord | null {
  let best: CommunicationRecord | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const row of records) {
    const parsed = row.send_time === null || row.send_time === undefined ? Number.NaN : Date.parse(row.send_time);
    const rank = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    if (best === null || rank >= bestMs) {
      best = row;
      bestMs = rank;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// The seven reasons (Requirement 20 criteria 1 through 7)
// ---------------------------------------------------------------------------

/** Requirement 20.1: 0 valid phone rows and 0 valid email rows, a case with no contacts included. */
function noValidContact(state: EscalationState): boolean {
  return !(state.contacts ?? []).some(isValidContactRow);
}

/**
 * Requirement 20.2, under readings 2, 3, and 4: there is a Touchpoint for which every
 * (eligible contact, enabled channel) pair carries a record, the most recent record of every one
 * of those pairs failed, and no record of that Touchpoint delivered.
 *
 * The pair set comes from `eligibleContacts` per enabled channel, which is Requirement 10.10's
 * one definition of a recipient — valid, authorized, unsuppressed. A contact whose channel is
 * not enabled contributes no pair, which is how a run with no email credentials
 * (Requirement 12.13) escalates on SMS alone instead of waiting forever for an email record.
 */
function allChannelsFailed(state: EscalationState): boolean {
  const communications = state.communications ?? [];
  if (communications.length === 0) return false;

  const suppressions = state.suppressions ?? [];
  const pairs: { contactId: string; channel: SuppressionChannel }[] = [];
  for (const channel of state.enabledChannels ?? SUPPRESSION_CHANNELS) {
    for (const contact of eligibleContacts(state.contacts ?? [], suppressions, channel)) {
      pairs.push({ contactId: contact.id, channel });
    }
  }
  if (pairs.length === 0) return false;

  const touchpoints = [...new Set(communications.map((row) => row.touchpoint))];
  return touchpoints.some((touchpoint) => {
    const forTouchpoint = communications.filter((row) => row.touchpoint === touchpoint);
    if (forTouchpoint.some((row) => row.delivery_result === 'Delivered')) return false;
    return pairs.every(({ contactId, channel }) => {
      const addressed = forTouchpoint.filter(
        (row) => row.channel === channel && (row.contact_id ?? null) === contactId,
      );
      const latest = mostRecentRecord(addressed);
      return latest !== null && latest.delivery_result === 'Failed';
    });
  });
}

/**
 * Requirement 20.3, under reading 5: at least one phone Contact_Recipient, SMS suppression set
 * on every one of them, and 0 valid email rows.
 *
 * `isContactSuppressed` asks both halves of the suppression state — the row's own flag and an
 * active `cancellation_suppressions` row for the value — so a phone row an import created after
 * the opt-out counts as suppressed (Requirements 21.3, 21.4).
 */
function smsSuppressedWithoutEmail(state: EscalationState): boolean {
  const contacts = state.contacts ?? [];
  const suppressions = state.suppressions ?? [];
  const phone = contacts.filter((contact) => isOnSendChannel(contact, 'sms'));
  if (phone.length === 0) return false;
  if (!phone.every((contact) => isContactSuppressed(contact, suppressions))) return false;
  return !contacts.some((contact) => isOnSendChannel(contact, 'email') && isValidContactRow(contact));
}

/**
 * Requirement 20.4, through Requirement 21.7: a recorded response whose type is
 * `Assistance requested` or `Callback requested`, or the stored `assistance_requested` flag those
 * two response types set.
 *
 * Both are read, because either alone is incomplete: a caller that selected the flag but not the
 * response rows still evaluates correctly, and so does one that recorded the response in the same
 * transaction as the evaluation, before the flag write landed.
 */
function customerAssistanceRequested(state: EscalationState): boolean {
  if ((state.case.assistance_requested ?? false) === true) return true;
  return (state.responses ?? []).some(
    (row) =>
      typeof row.response_type === 'string' && ASSISTANCE_RESPONSE_TYPE_SET.has(row.response_type),
  );
}

/**
 * Requirement 20.5, under reading 6: the evaluation falls on the calendar date exactly one day
 * before the cancellation effective date, Case_Status is Imported or Open, and no record of the
 * case delivered.
 *
 * `daysRemaining` and `isOpenCaseStatus` are the sibling's single definitions of the whole-day
 * difference and the open Case_Status set. An absent or unparseable business or effective date
 * gives `null`, which is not one, so the reason does not hold.
 */
function noDeliveredContact(state: EscalationState): boolean {
  if (!isOpenCaseStatus(state.case.case_status)) return false;
  const remaining = daysRemaining(state.case.cancellation_effective_date, state.businessDate);
  if (remaining !== NO_DELIVERED_CONTACT_DAYS_REMAINING) return false;
  return !(state.communications ?? []).some((row) => row.delivery_result === 'Delivered');
}

/** Requirement 20.6: Case_Status reached Payment Reported. */
function paymentReported(state: EscalationState): boolean {
  return state.case.case_status === PAYMENT_REPORTED_CASE_STATUS;
}

/**
 * Requirement 20.7, under reading 1: at least one valid Contact_Recipient row, no
 * Contact_Recipient row carrying `Authorized`, and every valid row carrying `Unknown`.
 *
 * The middle clause is the criterion's "0 Contact_Recipient rows whose authorization status
 * permits contact", read as `Authorized` alone. `authorizationPermitsContact` also admits
 * `Unknown` (Requirements 10.9, 10.10), and using it here would make the criterion contradict
 * its own first and third clauses and never hold. The quantifier scopes are kept as written: the
 * middle clause is over every contact row, the third over the valid ones.
 */
function authorizationUnknown(state: EscalationState): boolean {
  const contacts = state.contacts ?? [];
  const valid = contacts.filter(isValidContactRow);
  if (valid.length === 0) return false;
  if (contacts.some((contact) => contact.authorization_status === AUTHORIZED_STATUS)) return false;
  return valid.every((contact) => contact.authorization_status === UNKNOWN_AUTHORIZATION_STATUS);
}

const REASON_PREDICATES: Record<EscalationReason, (state: EscalationState) => boolean> = {
  'No Valid Contact': noValidContact,
  'All Channels Failed': allChannelsFailed,
  'SMS Suppressed Without Email': smsSuppressedWithoutEmail,
  'Customer Assistance Requested': customerAssistanceRequested,
  'No Delivered Contact': noDeliveredContact,
  'Payment Reported': paymentReported,
  'Authorization Unknown': authorizationUnknown,
};

/**
 * Whether one escalation reason holds for a Cancellation_Case. One definition per reason, so the
 * evaluator, the plan, and a test all ask the same question.
 */
export function escalationReasonHolds(reason: EscalationReason, state: EscalationState): boolean {
  return REASON_PREDICATES[reason](state);
}

/**
 * Every escalation reason that holds for a Cancellation_Case, in Requirement 20 criteria 1
 * through 7 order.
 *
 * More than one reason can hold at once and every one of them is returned: they are separate
 * `cancellation_escalations` rows under `unique (case_id, reason)`, and Requirement 20.12 clears
 * each of them by name. An empty result means no reason holds — which clears nothing, because
 * Requirement 20.12 is the only criterion that clears.
 */
export function evaluateCaseEscalations(state: EscalationState): EscalationReason[] {
  return ESCALATION_REASONS.filter((reason) => escalationReasonHolds(reason, state));
}

/**
 * The design's positional entry point:
 * `evaluateEscalations(case, contacts, communications, responses, businessDate)`.
 *
 * `suppressions` and `enabledChannels` follow as optional trailing parameters. Suppression is
 * read by Requirements 20.2 and 20.3, keyed by normalized value rather than by the contact
 * flags alone, and Requirement 20.2's "enabled channel" has no stored switch to read; both
 * default to the unrestricted case — no active suppression rows, both channels enabled.
 */
export function evaluateEscalations(
  caseRow: EscalationCase,
  contacts: readonly EscalationContact[],
  communications: readonly CommunicationRecord[],
  responses: readonly EscalationResponseRecord[],
  businessDate: string | null | undefined,
  suppressions: readonly SuppressionRecord[] = [],
  enabledChannels: readonly SuppressionChannel[] = SUPPRESSION_CHANNELS,
): EscalationReason[] {
  return evaluateCaseEscalations({
    case: caseRow,
    contacts,
    communications,
    responses,
    businessDate,
    suppressions,
    enabledChannels,
  });
}

// ---------------------------------------------------------------------------
// The follow-up deadline (Requirement 20.8)
// ---------------------------------------------------------------------------

/**
 * The earlier of 24 hours after the escalation time and the cancellation effective date
 * (Requirement 20.8), as an ISO instant for `cancellation_cases.follow_up_deadline`.
 *
 * Reading 7: `cancellation_effective_date` is a `date`, so it is clamped at the start of that
 * calendar date read as UTC — the earlier of the two candidate instants for the agency time
 * zone, whose midnight falls 4 to 5 hours later. The clamp can therefore only pull the deadline
 * earlier, never past the moment the policy cancels locally. An escalation time already beyond
 * that instant yields a deadline in the past, which is what the criterion says and reads as
 * overdue. An absent or unparseable effective date leaves the 24-hour window unclamped.
 */
export function followUpDeadline(
  escalationTime: Date,
  cancellationEffectiveDate: string | null | undefined,
): string {
  const windowEnd = escalationTime.getTime() + FOLLOW_UP_WINDOW_MS;
  const effective = parseCancellationDate(cancellationEffectiveDate);
  if (!effective.ok) return new Date(windowEnd).toISOString();
  const effectiveMs = Date.UTC(effective.year, effective.month - 1, effective.day);
  return new Date(Math.min(windowEnd, effectiveMs)).toISOString();
}

// ---------------------------------------------------------------------------
// Notification recipients (Requirements 20.8, 20.9)
// ---------------------------------------------------------------------------

/** The assigned employee of Requirement 20.8, or `null` where the criterion's test fails. */
export function followUpAssignee(
  employee: EscalationAssignee | null | undefined,
): EscalationAssignee | null {
  if (employee === null || employee === undefined) return null;
  if (trimToNull(employee.id) === null) return null;
  if ((employee.is_active ?? true) !== true) return null;
  if ((employee.is_deleted ?? false) === true) return null;
  return employee;
}

/**
 * The profiles a raise notifies, and which criterion supplied them.
 *
 * Requirement 20.8 where the assigned employee is present, active, and not marked deleted —
 * exactly one profile. Requirement 20.9 otherwise — one row per Manager_Role profile, filtered
 * through `isBroadManagerRole` and deduplicated by id so "exactly 1 row for each profile" holds
 * even where a caller repeats one. Reading 8: activity is not filtered here, because criterion 9
 * does not qualify it the way criterion 8 does.
 */
export function followUpRecipients(
  assignedEmployee: EscalationAssignee | null | undefined,
  managerProfiles: readonly EscalationRecipientProfile[] = [],
): { rule: EscalationRecipientRule; profileIds: string[] } {
  const assignee = followUpAssignee(assignedEmployee);
  if (assignee !== null) return { rule: 'assigned_employee', profileIds: [assignee.id] };

  const profileIds: string[] = [];
  const seen = new Set<string>();
  for (const profile of managerProfiles) {
    const id = trimToNull(profile.id);
    if (id === null || seen.has(id)) continue;
    if (!canManageRenewals(profile.role)) continue;
    seen.add(id);
    profileIds.push(id);
  }
  return { rule: 'manager_role', profileIds };
}

// ---------------------------------------------------------------------------
// The raise plan (Requirements 20.8, 20.9, 20.10)
// ---------------------------------------------------------------------------

/** Everything a raise plan needs beyond the state bundle. */
export interface EscalationPlanOptions {
  /** The escalation time: the caller's clock, and what `raised_at` and the deadline are cut from. */
  now: Date;
  /** The assigned employee of the case, as Requirement 20.8 tests it. */
  assignedEmployee?: EscalationAssignee | null;
  /** Every Manager_Role profile, for the Requirement 20.9 fan-out. */
  managerProfiles?: readonly EscalationRecipientProfile[];
}

/**
 * The writes one escalation evaluation produces (Requirement 20 criteria 1 through 10).
 *
 * The evaluation finds its reasons through `evaluateCaseEscalations`, then splits them against
 * `state.escalations`:
 *
 * - a reason with no stored row becomes a `new` raise: an insert to run with
 *   `on conflict (case_id, reason) do nothing returning id`, plus the notification rows and the
 *   `notified_at` stamp to write **only when that insert returned a row**. That conditional is
 *   Requirement 20.10 — one notification per (case, reason) pair across every evaluation and
 *   every scheduler run — and it holds under concurrency without either evaluation reading
 *   first, because the unique key decides which insert wins.
 * - a reason whose row is stored cleared becomes a `reopened` raise: the row is reopened so
 *   Requirement 20.11 holds Communication_Status again, and no notification is written, because
 *   the pair has already had its one (reading 9).
 * - a reason whose row is stored uncleared is reported in `alreadyRaised` and produces nothing.
 *
 * `caseUpdate` appears only where something was raised: Requirement 20.8 sets the deadline when
 * Communication_Status *becomes* Manual Follow-up Required, so an evaluation that finds only
 * reasons already raised must not push it forward. It carries no Case_Status and no assignment,
 * which is Requirements 20.8 and 20.9 held in the type rather than in a comment.
 *
 * Nothing here clears a reason that stopped holding. Requirement 20.12 is the only criterion
 * that clears, and it is a user recording a manual contact outcome, not an evaluation.
 */
export function planEscalations(
  state: EscalationState,
  options: EscalationPlanOptions,
): EscalationPlanResult {
  const caseId = trimToNull(state.case.id ?? null);
  if (caseId === null) {
    return {
      ok: false,
      rejection: {
        code: 'case_id_required',
        message: 'An escalation plan needs the stored Cancellation_Case id.',
      },
    };
  }

  const reasons = evaluateCaseEscalations(state);
  const raisedAt = options.now.toISOString();
  const deadline = followUpDeadline(options.now, state.case.cancellation_effective_date);
  const stored = new Map<string, EscalationRecord>();
  for (const row of state.escalations ?? []) {
    if (typeof row.reason === 'string' && !stored.has(row.reason)) stored.set(row.reason, row);
  }

  const { rule, profileIds } = followUpRecipients(options.assignedEmployee, options.managerProfiles);
  const alreadyRaised: EscalationReason[] = [];
  const raises: EscalationRaise[] = [];

  for (const reason of reasons) {
    const row = stored.get(reason);
    if (row !== undefined && isUnclearedEscalation(row)) {
      alreadyRaised.push(reason);
      continue;
    }

    if (row === undefined) {
      raises.push({
        kind: 'new',
        reason,
        raisedAt,
        followUpDeadline: deadline,
        insert: { case_id: caseId, reason, raised_at: raisedAt },
        notifiedAt: raisedAt,
        recipients: rule,
        notifications: profileIds.map((recipientId) => ({
          recipient_profile_id: recipientId,
          notification_type: CANCELLATION_FOLLOW_UP_NOTIFICATION_TYPE,
          title: notificationTitle(reason),
          message: notificationMessage(reason, state.case, deadline),
          entity_type: CANCELLATION_CASE_ENTITY_TYPE,
          entity_id: caseId,
        })),
        event: raiseEvent(caseId, reason, raisedAt, deadline, rule, profileIds, false),
      });
      continue;
    }

    raises.push({
      kind: 'reopened',
      reason,
      raisedAt,
      followUpDeadline: deadline,
      reopen: {
        escalation_id: row.id ?? null,
        case_id: caseId,
        reason,
        raised_at: raisedAt,
        cleared_at: null,
        cleared_by: null,
      },
      notifications: [],
      event: raiseEvent(caseId, reason, raisedAt, deadline, null, [], true),
    });
  }

  return {
    ok: true,
    plan: {
      caseId,
      reasons: [...reasons],
      alreadyRaised,
      raises,
      caseUpdate:
        raises.length === 0
          ? null
          : {
              case_id: caseId,
              communication_status: MANUAL_FOLLOW_UP_STATUS,
              follow_up_deadline: deadline,
              deadlineChanged: (state.case.follow_up_deadline ?? null) !== deadline,
            },
    },
  };
}

// ---------------------------------------------------------------------------
// The clear (Requirement 20.12)
// ---------------------------------------------------------------------------

/**
 * The writes one manual contact outcome produces (Requirement 20.12).
 *
 * The signature widens the task's `clearEscalations(caseId, actorId, note)` on two counts, both
 * forced by purity. It takes the state bundle rather than a case id, because the criterion also
 * requires Communication_Status to be recomputed under Requirement 15 and the rows that
 * derivation reads have to arrive as parameters; the case id is `state.case.id`. And it takes
 * `now`, the clearing time, because this module reads no clock and the criterion stores that time
 * on every row it writes.
 *
 * Agent_Role and Manager_Role may record the outcome, which is exactly the Policy_Follow_Up
 * workspace access set (`canAccessRenewals`: `agent`, `customer_service`, `sales_supervisor`,
 * `manager`, `super_admin`); every other role is refused so a route can answer 403 with nothing
 * written. Note text is required and stored trimmed, at least one character and at most 4,000,
 * matching the `char_length(btrim(note)) between 1 and 4000` constraint on
 * `cancellation_notes.note` that a manual contact outcome is stored against.
 *
 * The trigger condition is a case whose Communication_Status is Manual Follow-up Required, so a
 * case in any other status is refused. A case in that status with no uncleared row is not an
 * error: nothing is cleared, the deadline still clears, and the recomputed status still comes
 * back, which repairs a status that drifted.
 *
 * Every uncleared reason is cleared — the criterion's "every uncleared escalation reason", not
 * the ones a caller names — each update guarded by `cleared_at is null` so a row another clear
 * already closed keeps its original clearing profile and time. The recomputed
 * Communication_Status is derived with those rows cleared, which is what lets Requirement 15's
 * ladder past step 1 for the first time since the raise.
 */
export function clearEscalations(
  state: EscalationState,
  actor: ContactOutcomeActor,
  note: string | null | undefined,
  now: Date,
): ClearEscalationsResult {
  if (!canAccessRenewals(actor.role)) {
    return {
      ok: false,
      rejection: {
        code: 'role_not_permitted',
        message: 'Recording a manual contact outcome is reserved to Agent_Role and Manager_Role.',
      },
    };
  }

  const clearedBy = trimToNull(actor.id);
  if (clearedBy === null) {
    return {
      ok: false,
      rejection: { code: 'actor_required', message: 'A manual contact outcome must store the recording profile.' },
    };
  }

  const caseId = trimToNull(state.case.id ?? null);
  if (caseId === null) {
    return {
      ok: false,
      rejection: { code: 'case_id_required', message: 'A clear needs the stored Cancellation_Case id.' },
    };
  }

  const noteText = (note ?? '').trim();
  if (noteText.length === 0) {
    return {
      ok: false,
      rejection: {
        code: 'note_text_empty',
        message: 'A manual contact outcome requires note text of at least one non-whitespace character.',
      },
    };
  }
  if (noteText.length > MAX_CONTACT_OUTCOME_NOTE_LENGTH) {
    return {
      ok: false,
      rejection: {
        code: 'note_text_too_long',
        message: `Note text must be ${MAX_CONTACT_OUTCOME_NOTE_LENGTH} characters or fewer; this one is ${noteText.length}.`,
      },
    };
  }

  if ((state.case.communication_status ?? null) !== MANUAL_FOLLOW_UP_STATUS) {
    return {
      ok: false,
      rejection: {
        code: 'case_not_escalated',
        message: `A manual contact outcome clears escalations only on a Cancellation_Case whose Communication_Status is ${MANUAL_FOLLOW_UP_STATUS}.`,
      },
    };
  }

  const escalations = state.escalations ?? [];
  const uncleared = escalations.filter(isUnclearedEscalation);
  const clearedAt = now.toISOString();

  const updates: EscalationClearUpdate[] = uncleared.map((row) => ({
    escalation_id: row.id ?? null,
    case_id: caseId,
    reason: row.reason ?? '',
    cleared_at: clearedAt,
    cleared_by: clearedBy,
  }));

  const clearedReasons = updates.map((update) => update.reason);
  const cleared: EscalationRecord[] = escalations.map((row) =>
    isUnclearedEscalation(row) ? { ...row, cleared_at: clearedAt, cleared_by: clearedBy } : row,
  );
  const recomputed = deriveCaseCommunicationStatus({ ...state, escalations: cleared });

  return {
    ok: true,
    plan: {
      caseId,
      clearedAt,
      clearedBy,
      note: noteText,
      clearedReasons,
      updates,
      caseUpdate: {
        case_id: caseId,
        follow_up_deadline: null,
        communication_status: recomputed,
      },
      event: {
        case_id: caseId,
        actor_id: clearedBy,
        event_type: ESCALATION_CLEARED_EVENT_TYPE,
        event_time: clearedAt,
        detail: {
          reasons: clearedReasons,
          note: noteText,
          recomputed_communication_status: recomputed,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function raiseEvent(
  caseId: string,
  reason: EscalationReason,
  raisedAt: string,
  deadline: string,
  recipients: EscalationRecipientRule | null,
  notifiedProfileIds: readonly string[],
  reopened: boolean,
): CancellationEventInsert<EscalationRaisedEventDetail> {
  return {
    case_id: caseId,
    actor_id: null,
    event_type: ESCALATION_RAISED_EVENT_TYPE,
    event_time: raisedAt,
    detail: {
      reason,
      raised_at: raisedAt,
      follow_up_deadline: deadline,
      recipients,
      notified_profile_ids: [...notifiedProfileIds],
      reopened,
    },
  };
}

/** `user_notifications.title`; the column is `not null` and no criterion fixes the text. */
function notificationTitle(reason: EscalationReason): string {
  return `Cancellation follow-up required: ${reason}`;
}

/**
 * `user_notifications.message`; the column is `not null` and no criterion fixes the text. Every
 * optional value is dropped rather than rendered, so no absent policy number or customer name
 * reaches the inbox as the text `null`.
 */
function notificationMessage(reason: EscalationReason, caseRow: EscalationCase, deadline: string): string {
  const customer = trimToNull(caseRow.customer_name) ?? 'this customer';
  const policy = trimToNull(caseRow.policy_number);
  const effective = trimToNull(caseRow.cancellation_effective_date);
  const parts = [`Automatic contact cannot proceed for ${customer}`];
  if (policy !== null) parts.push(`policy ${policy}`);
  if (effective !== null) parts.push(`cancelling ${effective}`);
  return `${parts.join(', ')}. Reason: ${reason}. Contact the customer by ${deadline}.`;
}

/** Trimmed text, or `null` where it is absent or carries no non-whitespace character. */
function trimToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
