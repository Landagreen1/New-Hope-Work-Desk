// Policy Follow-up: the operational projection (Requirement 5.1).
//
// One renewal record and one cancellation case become the same kind of `PolicyWorkItem` here, so
// My Work and Manager Overview can render both in one list. This is a *read model* built from the
// authoritative domain records and their history — not a second lifecycle database (design 2).
//
// The rule that shapes the whole module: **neither next-action ladder is reimplemented.**
//   * The cancellation action comes from `cancellations/derive.primaryAction`, which is a thin
//     wrapper over `deriveNextRequiredAction` — the same call the drawer and the list cell make.
//     Requirement 5.3 forbids a parallel cancellation engine, and a shared view showing a different
//     action from the drawer it opens would be worse than useless.
//   * The renewal action comes from `renewals/derive.recommendedNextAction`, extended in place for
//     Carrier Non-Renewal and Review renewal rather than re-expressed here (Requirement 5.2).
//
// What *is* new here is the cross-domain vocabulary: the urgency bucket, the waiting reason, and
// the workload points, all three of which have to mean the same thing in both domains or the
// combined list is a lie.
//
// Pure module: no React, no Supabase, no network, no clock. `businessDate` always arrives as a
// parameter, computed once per render by the caller through `currentBusinessDate()`.

import type { AppRole } from '@/lib/types';

import {
  cancellationWorkloadPoints,
  calendarDaysBetween,
  followUpDue,
  renewalWorkloadPoints,
} from './workload';
import {
  normalizeCarrierKey,
  normalizePolicyNumber,
  trimToNull,
  type PolicySourceState,
} from './normalization';
import type {
  PolicyCriticalReason,
  PolicyUrgencyBucket,
  PolicyWorkCounts,
  PolicyWorkItem,
} from './types';
import {
  isCarrierNonRenewalRecord,
  recommendedNextAction,
  renewalNormalizedStatus,
  renewalWaitingReason,
  type RenewalDeriveContact,
  type RenewalDeriveRecord,
  type RenewalRequoteActivity,
} from '../renewals/derive';
import {
  deriveCaseCommunicationStatus,
  deriveLastContact,
  isActiveCancellationCase,
  primaryAction,
  rowDaysRemaining,
  type CancellationRowState,
} from '../cancellations/derive';

// ---------------------------------------------------------------------------
// Shared urgency vocabulary (design 7.4)
// ---------------------------------------------------------------------------

/** Days remaining at or below which an active cancellation is Critical (Requirement 6.2). */
export const CRITICAL_CANCELLATION_DAYS = 3;

/** Days ahead within which a due action is Upcoming rather than Later (Requirement 6.2). */
export const UPCOMING_WINDOW_DAYS = 7;

/**
 * The Communication_Status values that mean an employee has to act by hand.
 *
 * These are exactly the four `NEEDS_ACTION_COMMUNICATION_STATUSES` of the cancellations module. The
 * set is named again here rather than imported so this module states which of them it treats as a
 * *communication failure requiring manual action* — the Requirement 6.2 wording — and a later change
 * to the cancellation filter's own set cannot silently redefine Critical.
 */
const MANUAL_COMMUNICATION_STATUSES: ReadonlySet<string> = new Set([
  'Failed',
  'Partially Failed',
  'Suppressed',
  'Manual Follow-up Required',
]);

/** The two Communication_Status values that are a delivery failure rather than a block. */
const FAILED_COMMUNICATION_STATUSES: ReadonlySet<string> = new Set(['Failed', 'Partially Failed']);

/** The three Case_Status values that mean the case is waiting on a payment or a verification. */
const CANCELLATION_WAITING_STATUSES: ReadonlySet<string> = new Set([
  'Payment Reported',
  'Verification Pending',
  'Reinstatement Pending',
]);

interface UrgencyInput {
  /** When the required action is due, where the domain records one. */
  actionDueDate: string | null;
  /** The event date, used only for the imminent-cancellation clause. */
  eventDaysRemaining: number | null;
  domain: 'renewal' | 'cancellation';
  /** True where an action is required of an employee at all. */
  actionRequired: boolean;
  /** True where a requote is required and no requote activity exists (Requirement 7.2). */
  requoteRequired: boolean;
  /** True where a communication outcome needs manual work (Requirement 6.2). */
  communicationFailed: boolean;
  /** Present where the item is waiting on a recorded dependency. */
  waitingReason: string | null;
  businessDate: string;
}

interface UrgencyResult {
  urgency: PolicyUrgencyBucket;
  criticalReasons: PolicyCriticalReason[];
}

/**
 * The urgency bucket of one work item (Requirement 6.2, design 7.4).
 *
 * Precedence, and why:
 *
 *   1. `critical` — an overdue action, an active cancellation inside three days that still needs
 *      an employee, a requote that has not been started, or a message that failed. Every one of
 *      these is either already late or about to become unrecoverable.
 *   2. `today` — the action is due on the business date.
 *   3. `upcoming` — the action is due inside the next seven days.
 *   4. `waiting` — a recorded dependency holds the item and nothing is due. Checked *after* the
 *      date buckets so a case waiting on a verification that also has a follow-up due today shows
 *      up in Today, where somebody will act on it.
 *   5. `later` — active assigned work with nothing due inside a week.
 *
 * Every critical reason that holds is collected, not just the first, so the row can name all of
 * them; the bucket itself is decided by whether the list is empty.
 */
export function derivePolicyUrgency(input: UrgencyInput): UrgencyResult {
  const criticalReasons: PolicyCriticalReason[] = [];

  const dueIn = input.actionDueDate === null
    ? null
    : calendarDaysBetween(input.businessDate, input.actionDueDate);

  if (input.actionDueDate !== null && dueIn !== null && dueIn < 0) {
    criticalReasons.push('action_overdue');
  }
  if (
    input.domain === 'cancellation'
    && input.actionRequired
    && input.eventDaysRemaining !== null
    && input.eventDaysRemaining <= CRITICAL_CANCELLATION_DAYS
  ) {
    criticalReasons.push('cancellation_imminent');
  }
  if (input.requoteRequired) criticalReasons.push('requote_required');
  if (input.communicationFailed) criticalReasons.push('communication_failed');

  if (criticalReasons.length > 0) return { urgency: 'critical', criticalReasons };
  if (dueIn === 0) return { urgency: 'today', criticalReasons };
  if (dueIn !== null && dueIn > 0 && dueIn <= UPCOMING_WINDOW_DAYS) {
    return { urgency: 'upcoming', criticalReasons };
  }
  if (input.waitingReason !== null) return { urgency: 'waiting', criticalReasons };
  return { urgency: 'later', criticalReasons };
}

// ---------------------------------------------------------------------------
// Renewal adapter (Requirement 5.2, design 7.2)
// ---------------------------------------------------------------------------

/** The `renewal_records` fields the projection reads, beyond what `derive.ts` already declares. */
export type RenewalProjectionRecord = RenewalDeriveRecord & {
  assigned_to?: string | null;
  line_of_business?: string | null;
  source_review_required?: boolean | null;
  source_communication_blocked?: boolean | null;
};

export interface RenewalProjectionInput {
  record: RenewalProjectionRecord;
  /** The contact entries, normally from the bulk summary read (Requirement 5.4). */
  contacts?: readonly RenewalDeriveContact[];
  /** The requote activity entries, normally from the bulk summary read. */
  requotes?: readonly RenewalRequoteActivity[];
  /** The latest contact time as the summary reports it, for the Last contact cell. */
  lastContactAt?: string | null;
  assignedName?: string | null;
  businessDate: string;
}

/**
 * The renewal display vocabulary, re-exported from the renewal domain module.
 *
 * Both live in `renewals/derive.ts` rather than here so the Renewal drawer and the Renewals list can
 * read them without the drawer having to depend on the cancellations module. One definition, three
 * surfaces (Requirements 1.2, 6.2, 6.3, 7.2).
 */
export { renewalNormalizedStatus, renewalWaitingReason } from '../renewals/derive';

/** True where the record has requote activity of any kind recorded against it. */
function hasRenewalRequoteActivity(
  record: RenewalProjectionRecord,
  requotes: readonly RenewalRequoteActivity[],
): boolean {
  if (requotes.length > 0) return true;
  return Boolean(record.requote_sent_at || record.requote_intake_id || record.requote_work_item_id);
}

/**
 * One renewal as a `PolicyWorkItem` (Requirement 5.1, design 7.2).
 *
 * The next action is `recommendedNextAction`, unchanged: the same function the Renewals list cell
 * calls, given the same contacts and requote activity, so the two surfaces cannot disagree.
 */
export function renewalWorkItem(input: RenewalProjectionInput): PolicyWorkItem {
  const { record, businessDate } = input;
  const contacts = input.contacts ?? [];
  const requotes = input.requotes ?? [];

  const closed = record.status === 'renewed' || record.status === 'lost' || record.status === 'cancelled';
  const carrierNonRenewal = isCarrierNonRenewalRecord(record) || record.requote_requested === true;
  const requoteRequired = !closed
    && isCarrierNonRenewalRecord(record)
    && !hasRenewalRequoteActivity(record, requotes);

  const nextAction = closed ? null : recommendedNextAction(record, contacts, requotes);
  const actionDueDate = trimToNull(record.next_follow_up_at);
  const waitingReason = closed ? null : renewalWaitingReason(record);
  const eventDaysRemaining = calendarDaysBetween(businessDate, record.renewal_date);

  const { urgency, criticalReasons } = derivePolicyUrgency({
    actionDueDate,
    eventDaysRemaining,
    domain: 'renewal',
    actionRequired: nextAction !== null,
    requoteRequired,
    communicationFailed: false,
    waitingReason,
    businessDate,
  });

  return {
    domain: 'renewal',
    sourceId: record.id,
    carrier: record.carrier ?? null,
    carrierKey: normalizeCarrierKey(record.carrier),
    policyNumber: record.policy_number,
    policyNumberNormalized: normalizePolicyNumber(record.policy_number),
    customerName: record.customer_name,
    assignedTo: record.assigned_to ?? null,
    assignedName: input.assignedName ?? null,
    eventDate: record.renewal_date ?? null,
    daysRemaining: eventDaysRemaining,
    eventDateEstimated: false,
    normalizedStatus: renewalNormalizedStatus(record),
    sourceState: (record.source_state_normalized as PolicySourceState | null | undefined) ?? null,
    nextAction,
    actionDueDate,
    lastContactAt: input.lastContactAt ?? latestContactAt(contacts),
    waitingReason,
    urgency,
    criticalReasons,
    workloadPoints: renewalWorkloadPoints({
      closed,
      renewalDate: record.renewal_date,
      carrierNonRenewal,
      nextFollowUpAt: record.next_follow_up_at,
      businessDate,
    }),
    reviewRequired: record.source_review_required === true
      || record.source_state_normalized === 'review_required',
    communicationBlocked: record.source_communication_blocked === true,
  };
}

/** The latest readable `occurred_at` of a contact list, or `null`. */
function latestContactAt(contacts: readonly RenewalDeriveContact[]): string | null {
  let bestText: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const contact of contacts) {
    const at = Date.parse(contact.occurred_at ?? '');
    if (Number.isNaN(at) || at <= bestMs) continue;
    bestMs = at;
    bestText = contact.occurred_at;
  }
  return bestText;
}

// ---------------------------------------------------------------------------
// Cancellation adapter (Requirement 5.3, design 7.3)
// ---------------------------------------------------------------------------

export interface CancellationProjectionInput {
  /**
   * The state bundle the cancellations module already builds for its own list, unchanged.
   * `CancellationsPage.buildRowStates` produces exactly this.
   */
  state: CancellationRowState;
  /** The role the action ladder is evaluated for (Requirement 17.10 of the cancellation spec). */
  viewerRole?: AppRole | null;
  assignedName?: string | null;
  /** True where the effective date is the collector estimate (Requirement 8.3). */
  eventDateEstimated?: boolean;
  businessDate: string;
}

/**
 * Why a cancellation is waiting rather than owed an action, or `null`.
 *
 * The three statuses named are the ones that record a dependency on somebody other than the
 * assigned agent: a customer's reported payment awaiting a manager's verification, and a
 * reinstatement awaiting the carrier. An `Imported` or `Open` case is never waiting.
 */
export function cancellationWaitingReason(caseStatus: string): string | null {
  switch (caseStatus) {
    case 'Payment Reported': return 'Payment reported — waiting on verification';
    case 'Verification Pending': return 'Waiting on payment verification';
    case 'Reinstatement Pending': return 'Waiting on carrier reinstatement';
    default: return null;
  }
}

/**
 * One cancellation as a `PolicyWorkItem` (Requirement 5.1, design 7.3).
 *
 * `nextAction` is `primaryAction(state, viewerRole)` — the cancellations module's own eight-step
 * ladder, called with the caller's role so a manager-only action is not offered to an agent. This
 * is the single assertion Requirement 5.3 and task 6.5 turn on: the shared item's action equals
 * the action the existing drawer and list cell show for the same state and role.
 *
 * `normalizedStatus` is the stored `case_status`. Unlike the renewal side there is nothing to
 * translate: the cancellation vocabulary is already English operational language, and rewording it
 * here would put the shared view and the drawer into disagreement over what the case *is*.
 */
export function cancellationWorkItem(input: CancellationProjectionInput): PolicyWorkItem {
  const { state, businessDate } = input;
  const caseRow = state.case;
  const active = isActiveCancellationCase(caseRow);

  const communicationStatus = deriveCaseCommunicationStatus(state);
  const manualCommunicationRequired = MANUAL_COMMUNICATION_STATUSES.has(communicationStatus);
  const communicationFailed = active && FAILED_COMMUNICATION_STATUSES.has(communicationStatus);

  // Requirement 5.3, without qualification: the action is whatever the cancellation ladder says,
  // for every Case_Status. It is deliberately *not* gated on `isActiveCancellationCase` — an
  // `Invalid` or `Duplicate` case is inactive but still owes somebody a `Mark Resolved`, the drawer
  // offers exactly that, and suppressing it here would hide real work and put the two surfaces into
  // disagreement. The ladder returns `null` on its own for the three statuses whose action has been
  // cleared, which is what keeps a genuinely finished case out of My Work.
  const nextAction = primaryAction(state, input.viewerRole);
  const actionDueDate = trimToNull(caseRow.follow_up_deadline);
  const waitingReason = active ? cancellationWaitingReason(caseRow.case_status) : null;
  const eventDaysRemaining = rowDaysRemaining({ ...state, businessDate });

  const { urgency, criticalReasons } = derivePolicyUrgency({
    actionDueDate,
    eventDaysRemaining,
    domain: 'cancellation',
    // The imminent-cancellation clause is about a policy that is actually about to cancel, so it
    // stays restricted to an active case: an `Invalid` case whose date has passed is a bookkeeping
    // task, not an emergency.
    actionRequired: active && nextAction !== null,
    requoteRequired: false,
    communicationFailed,
    waitingReason,
    businessDate,
  });

  const policyNumber = caseRow.policy_number ?? '';

  return {
    domain: 'cancellation',
    sourceId: caseRow.id ?? '',
    carrier: caseRow.carrier ?? null,
    carrierKey: normalizeCarrierKey(caseRow.carrier),
    policyNumber,
    policyNumberNormalized: normalizePolicyNumber(policyNumber),
    customerName: trimToNull(caseRow.customer_name) ?? policyNumber,
    assignedTo: caseRow.assigned_to ?? null,
    assignedName: input.assignedName ?? trimToNull(state.assignedEmployee?.display_name),
    eventDate: caseRow.cancellation_effective_date ?? null,
    daysRemaining: eventDaysRemaining,
    eventDateEstimated: input.eventDateEstimated === true,
    normalizedStatus: caseRow.case_status,
    sourceState: cancellationSourceState(caseRow.case_status),
    nextAction,
    actionDueDate,
    lastContactAt: deriveLastContact(state),
    waitingReason,
    urgency,
    criticalReasons,
    workloadPoints: cancellationWorkloadPoints({
      closed: !active,
      effectiveDate: caseRow.cancellation_effective_date,
      paymentVerificationRequired: CANCELLATION_WAITING_STATUSES.has(caseRow.case_status),
      manualCommunicationRequired,
      followUpDeadline: caseRow.follow_up_deadline,
      businessDate,
    }),
    reviewRequired: caseRow.case_status === 'Import Review Required',
    communicationBlocked: caseRow.case_status === 'Import Review Required'
      || input.eventDateEstimated === true,
  };
}

/**
 * The normalized source state one Case_Status corresponds to, for the cross-domain vocabulary.
 *
 * This is a *view* of the stored status, not a second source of truth: nothing writes it back, and
 * `case_status` remains authoritative for every cancellation rule.
 */
function cancellationSourceState(caseStatus: string): PolicySourceState | null {
  switch (caseStatus) {
    case 'Imported':
    case 'Open':
      return 'pending_cancellation';
    case 'Payment Reported':
    case 'Verification Pending':
    case 'Reinstatement Pending':
    case 'Reinstated':
      return 'payment_signal';
    case 'Cancelled':
      return 'cancelled_signal';
    case 'Import Review Required':
      return 'review_required';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The combined list (Requirements 6.2, 7.5)
// ---------------------------------------------------------------------------

const URGENCY_ORDER: Readonly<Record<PolicyUrgencyBucket, number>> = {
  critical: 0,
  today: 1,
  upcoming: 2,
  waiting: 3,
  later: 4,
};

/**
 * The My Work order of task 7.5: Critical first, then the due or overdue action date, then the
 * policy event date, then the customer name.
 *
 * An item with no action date sorts after every item that has one inside its bucket — a dated
 * obligation outranks an undated one — and the source id breaks a full tie so the comparator is a
 * total order and the list does not reshuffle between refreshes.
 */
export function comparePolicyWorkItems(a: PolicyWorkItem, b: PolicyWorkItem): number {
  const byUrgency = URGENCY_ORDER[a.urgency] - URGENCY_ORDER[b.urgency];
  if (byUrgency !== 0) return byUrgency;

  if (a.actionDueDate !== b.actionDueDate) {
    if (a.actionDueDate === null) return 1;
    if (b.actionDueDate === null) return -1;
    return a.actionDueDate < b.actionDueDate ? -1 : 1;
  }

  if (a.eventDate !== b.eventDate) {
    if (a.eventDate === null) return 1;
    if (b.eventDate === null) return -1;
    return a.eventDate < b.eventDate ? -1 : 1;
  }

  const byName = a.customerName.toLowerCase().localeCompare(b.customerName.toLowerCase());
  if (byName !== 0) return byName;

  return a.sourceId.localeCompare(b.sourceId);
}

/** The items in the task 7.5 order, as a new array; the input is left unchanged. */
export function sortPolicyWorkItems(items: readonly PolicyWorkItem[]): PolicyWorkItem[] {
  return [...items].sort(comparePolicyWorkItems);
}

/** The five bucket counters (Requirement 7.3). */
export function policyWorkCounts(items: readonly PolicyWorkItem[]): PolicyWorkCounts {
  const counts: PolicyWorkCounts = { critical: 0, today: 0, upcoming: 0, waiting: 0, later: 0 };
  for (const item of items) counts[item.urgency] += 1;
  return counts;
}

/** The items of one bucket, in the task 7.5 order. */
export function policyWorkBucket(
  items: readonly PolicyWorkItem[],
  bucket: PolicyUrgencyBucket,
): PolicyWorkItem[] {
  return sortPolicyWorkItems(items.filter((item) => item.urgency === bucket));
}

/**
 * The items one employee owns (Requirement 6.1).
 *
 * Read scope is enforced by row level security and by each domain's own read functions; this is the
 * ownership filter on top of what the caller was already allowed to read, not a substitute for it.
 */
export function policyWorkForProfile(
  items: readonly PolicyWorkItem[],
  profileId: string,
): PolicyWorkItem[] {
  return items.filter((item) => item.assignedTo === profileId);
}

/**
 * True where an item is closed and belongs in no My Work bucket (Requirement 6.2, task 6.8).
 *
 * Both adapters already return `nextAction: null` for a closed record, and neither produces a
 * closed item with a waiting reason, so the test is "nothing is required and nothing is pending".
 */
export function isClosedWorkItem(item: PolicyWorkItem): boolean {
  return item.nextAction === null && item.waitingReason === null;
}

/** Every open item, which is what My Work renders (task 6.8). */
export function openPolicyWorkItems(items: readonly PolicyWorkItem[]): PolicyWorkItem[] {
  return items.filter((item) => !isClosedWorkItem(item));
}

/** Re-exported so a caller scoring one item does not have to reach into two modules. */
export { followUpDue };
