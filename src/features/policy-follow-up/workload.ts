// Policy Follow-up: the one workload scoring definition.
//
// Requirement 4.1 rules out distributing by policy count: forty cancellations inside a week is
// more work than seventy renewals ninety days out, and an assignment engine that counts rows will
// bury the agent holding the urgent book. So a policy contributes *points* that rise with urgency
// and with the work it already owes, and an employee's workload is the sum over their open work.
//
// Requirement 4.2 requires one tested default model kept in one shared location so the assignment
// engine and every surface that displays a score cannot drift. This module is that location.
// `policy_followup_workload_weights` in the database is seeded from `POLICY_WORKLOAD_WEIGHTS`
// below and the migration asserts the two agree, so the SQL assignment engine and this module score
// the same policy identically (design 6.1).
//
// Requirement 4.5 is a property of the *caller*, not of this module: scoring decides where unowned
// work goes and must never move owned work. Nothing here writes anything, so the guarantee lives
// in `policy_followup_auto_assign`, which only ever inserts an owner row that does not yet exist.
//
// Pure module: no React, no Supabase, no network, no clock.

// ---------------------------------------------------------------------------
// The weights (Requirement 4.2)
// ---------------------------------------------------------------------------

/**
 * Every weight key. Named rather than positional so the database seed, the SQL scoring function,
 * and this module can be compared key by key.
 */
export type PolicyWorkloadWeightKey =
  // Renewal date bands — the base points of one open renewal.
  | 'renewal_open'
  | 'renewal_due_30'
  | 'renewal_due_15'
  | 'renewal_due_7'
  | 'renewal_due_3'
  // Renewal condition weights.
  | 'renewal_nonrenewal'
  | 'renewal_overdue_followup'
  // Cancellation date bands — the base points of one active cancellation.
  | 'cancellation_active'
  | 'cancellation_due_15'
  | 'cancellation_due_10'
  | 'cancellation_due_5'
  | 'cancellation_due_1'
  // Cancellation condition weights.
  | 'cancellation_payment_verification'
  | 'cancellation_communication_manual'
  | 'cancellation_overdue_followup';

/**
 * The Requirement 4.2 defaults, verbatim.
 *
 * Manager editing is explicitly out of scope for this phase (design 6.1), so these are constants
 * rather than a settings read. They are still mirrored into a database table because the assignment
 * engine runs in SQL and must not carry a second copy of the numbers.
 */
export const POLICY_WORKLOAD_WEIGHTS: Readonly<Record<PolicyWorkloadWeightKey, number>> = {
  renewal_open: 1,
  renewal_due_30: 2,
  renewal_due_15: 3,
  renewal_due_7: 4,
  renewal_due_3: 5,
  renewal_nonrenewal: 7,
  renewal_overdue_followup: 5,

  cancellation_active: 2,
  cancellation_due_15: 3,
  cancellation_due_10: 4,
  cancellation_due_5: 6,
  cancellation_due_1: 10,
  cancellation_payment_verification: 7,
  cancellation_communication_manual: 4,
  cancellation_overdue_followup: 5,
};

export const POLICY_WORKLOAD_WEIGHT_KEYS = Object.keys(
  POLICY_WORKLOAD_WEIGHTS,
) as readonly PolicyWorkloadWeightKey[];

// ---------------------------------------------------------------------------
// Date arithmetic
// ---------------------------------------------------------------------------

const MILLISECONDS_PER_DAY = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Whole calendar days from `businessDate` to `target`, or `null` when either names no date.
 *
 * Both values are calendar dates in the one agency time zone that decides the business date, so the
 * difference is computed from the parsed year, month, and day through `Date.UTC` and carries no
 * dependence on the host time zone or on daylight saving. This is the same arithmetic
 * `renewals/derive.ts` and `cancellations/domain/communication-status.ts` each use for their own
 * domain; it is repeated here rather than imported because both of those are domain modules and
 * this one must not depend on either.
 */
export function calendarDaysBetween(
  businessDate: string | null | undefined,
  target: string | null | undefined,
): number | null {
  const from = CALENDAR_DATE.exec((businessDate ?? '').trim());
  const to = CALENDAR_DATE.exec((target ?? '').trim());
  if (from === null || to === null) return null;
  const fromMs = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]));
  const toMs = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]));
  return Math.round((toMs - fromMs) / MILLISECONDS_PER_DAY);
}

/**
 * True where a scheduled follow-up is due on or before the business date, which is the
 * `overdue required follow-up` condition both domains add points for (Requirement 4.2).
 *
 * A timestamp is reduced to its calendar date first: a follow-up written as `2026-02-10T00:00:00Z`
 * is due *on* the tenth, not at some hour of it.
 */
export function followUpDue(
  followUpAt: string | null | undefined,
  businessDate: string | null | undefined,
): boolean {
  const text = (followUpAt ?? '').trim();
  if (text.length === 0) return false;
  const direct = CALENDAR_DATE.exec(text);
  const dueDate = direct !== null
    ? `${direct[1]}-${direct[2]}-${direct[3]}`
    : dateFromTimestamp(text);
  if (dueDate === null) return false;
  const remaining = calendarDaysBetween(businessDate, dueDate);
  return remaining !== null && remaining <= 0;
}

function dateFromTimestamp(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Renewal points (Requirement 4.2)
// ---------------------------------------------------------------------------

export interface RenewalWorkloadInput {
  /** True where a final outcome of Renewed, Lost, or Cancelled is recorded. */
  closed: boolean;
  /** `renewal_records.renewal_date`. */
  renewalDate: string | null | undefined;
  /** True where the normalized source state is Carrier Non-Renewal, or the requote flag is set. */
  carrierNonRenewal: boolean;
  /** `renewal_records.next_follow_up_at`. */
  nextFollowUpAt: string | null | undefined;
  businessDate: string;
}

/**
 * The workload points of one renewal (Requirement 4.2).
 *
 * The five date bands are a *band*, not a running total: a renewal due in two days scores the
 * 3-day band's 5 points, not 1+2+3+4+5. Carrier Non-Renewal is folded in with `Math.max` rather
 * than added, so its 7 points describe a floor — a non-renewal is at least as much work as the
 * band it sits in and a non-renewal due tomorrow does not score 12.
 *
 * A renewal date already past scores the tightest band. The date bands of Requirement 4.2 are
 * written forward-looking and say nothing about a renewal date that has slipped, and treating it as
 * the least urgent case would be exactly backwards.
 *
 * `overdue required follow-up: +5` is additive, because it describes work the employee has already
 * failed to complete rather than how close the renewal is.
 *
 * A closed renewal scores zero (Requirement 4.4): nothing is owed on it.
 */
export function renewalWorkloadPoints(input: RenewalWorkloadInput): number {
  if (input.closed) return 0;

  const weights = POLICY_WORKLOAD_WEIGHTS;
  const remaining = calendarDaysBetween(input.businessDate, input.renewalDate);

  let base: number;
  if (remaining === null) {
    // No readable renewal date: the record is still open work, so it carries the open-renewal
    // floor rather than dropping out of every band and scoring nothing.
    base = weights.renewal_open;
  } else if (remaining <= 3) {
    base = weights.renewal_due_3;
  } else if (remaining <= 7) {
    base = weights.renewal_due_7;
  } else if (remaining <= 15) {
    base = weights.renewal_due_15;
  } else if (remaining <= 30) {
    base = weights.renewal_due_30;
  } else {
    base = weights.renewal_open;
  }

  if (input.carrierNonRenewal) base = Math.max(base, weights.renewal_nonrenewal);
  if (followUpDue(input.nextFollowUpAt, input.businessDate)) base += weights.renewal_overdue_followup;

  return base;
}

// ---------------------------------------------------------------------------
// Cancellation points (Requirement 4.2)
// ---------------------------------------------------------------------------

export interface CancellationWorkloadInput {
  /** True where the case is not one of the five active Case_Status values. */
  closed: boolean;
  /** `cancellation_cases.cancellation_effective_date`. */
  effectiveDate: string | null | undefined;
  /** True where Case_Status is Payment Reported, Verification Pending, or Reinstatement Pending. */
  paymentVerificationRequired: boolean;
  /**
   * True where a communication outcome needs an employee to act by hand: Communication_Status of
   * Failed, Partially Failed, Suppressed, or Manual Follow-up Required.
   */
  manualCommunicationRequired: boolean;
  /** `cancellation_cases.follow_up_deadline`. */
  followUpDeadline: string | null | undefined;
  businessDate: string;
}

/**
 * The workload points of one cancellation (Requirement 4.2).
 *
 * Same shape as the renewal side: banded base, `Math.max` for the payment/verification floor,
 * additive modifiers for work already owed. An effective date already past scores the 1-day band,
 * which is the highest, for the same reason a slipped renewal date does.
 *
 * The 10 points of the 1-day band against a renewal's maximum of 12 with an overdue follow-up is
 * the intended relative weight: Requirement 4.1's own example is that urgent cancellations
 * outweigh distant renewals, and the two ladders are calibrated against each other rather than
 * inside each domain.
 *
 * A resolved case scores zero (Requirement 4.4).
 */
export function cancellationWorkloadPoints(input: CancellationWorkloadInput): number {
  if (input.closed) return 0;

  const weights = POLICY_WORKLOAD_WEIGHTS;
  const remaining = calendarDaysBetween(input.businessDate, input.effectiveDate);

  let base: number;
  if (remaining === null) {
    base = weights.cancellation_active;
  } else if (remaining <= 1) {
    base = weights.cancellation_due_1;
  } else if (remaining <= 5) {
    base = weights.cancellation_due_5;
  } else if (remaining <= 10) {
    base = weights.cancellation_due_10;
  } else if (remaining <= 15) {
    base = weights.cancellation_due_15;
  } else {
    base = weights.cancellation_active;
  }

  if (input.paymentVerificationRequired) {
    base = Math.max(base, weights.cancellation_payment_verification);
  }
  if (input.manualCommunicationRequired) base += weights.cancellation_communication_manual;
  if (followUpDue(input.followUpDeadline, input.businessDate)) {
    base += weights.cancellation_overdue_followup;
  }

  return base;
}

// ---------------------------------------------------------------------------
// Per-employee workload (Requirements 4.4, 9.4)
// ---------------------------------------------------------------------------

/** One employee's workload as the manager surfaces display it (Requirements 4.4, 9.4). */
export interface AgentWorkloadSummary {
  profileId: string;
  displayName: string;
  username: string | null;
  role: string | null;
  /** Whether the employee is currently eligible for automatic balancing (Requirement 3.4). */
  renewalsEnabled: boolean;
  cancellationsEnabled: boolean;
  autoAssignmentEnabled: boolean;
  assignmentMode: string;
  activeRenewals: number;
  activeCancellations: number;
  dueToday: number;
  overdue: number;
  criticalCancellations: number;
  carrierNonRenewals: number;
  waiting: number;
  workloadScore: number;
}

/**
 * The order Requirement 9.4 and design 10.3 put the team table in: most at-risk first.
 *
 * Overdue leads because it is the only column describing work already missed. Display name breaks
 * a full tie so the table does not reshuffle between refreshes.
 */
export function compareAgentWorkload(a: AgentWorkloadSummary, b: AgentWorkloadSummary): number {
  if (a.overdue !== b.overdue) return b.overdue - a.overdue;
  if (a.criticalCancellations !== b.criticalCancellations) {
    return b.criticalCancellations - a.criticalCancellations;
  }
  if (a.workloadScore !== b.workloadScore) return b.workloadScore - a.workloadScore;
  return a.displayName.localeCompare(b.displayName);
}

/**
 * The employee an unowned policy would be balanced to, or `null` where no employee is eligible
 * (Requirements 4.3, 4.5).
 *
 * The deterministic tie break of Requirement 4.3 is applied in order: lowest score, then the oldest
 * `lastAutoAssignedAt` — an employee who has waited longest goes first, and an employee who has
 * never received an automatic assignment sorts ahead of everyone — then the profile id, which is
 * stable and unique so the comparator is a total order.
 *
 * This is the *display and test* form of the rule. The authoritative selection happens inside
 * `policy_followup_auto_assign` under a row lock, because Requirement 4.3 requires two simultaneous
 * imports not be able to pick the same employee from stale state, and no client-side function can
 * promise that.
 */
export function selectLowestWorkload<
  T extends { profileId: string; workloadScore: number; lastAutoAssignedAt?: string | null },
>(candidates: readonly T[]): T | null {
  let best: T | null = null;
  for (const candidate of candidates) {
    if (best === null || compareBalancingCandidates(candidate, best) < 0) best = candidate;
  }
  return best;
}

function compareBalancingCandidates(
  a: { profileId: string; workloadScore: number; lastAutoAssignedAt?: string | null },
  b: { profileId: string; workloadScore: number; lastAutoAssignedAt?: string | null },
): number {
  if (a.workloadScore !== b.workloadScore) return a.workloadScore - b.workloadScore;

  const left = Date.parse(a.lastAutoAssignedAt ?? '');
  const right = Date.parse(b.lastAutoAssignedAt ?? '');
  const leftAt = Number.isNaN(left) ? Number.NEGATIVE_INFINITY : left;
  const rightAt = Number.isNaN(right) ? Number.NEGATIVE_INFINITY : right;
  if (leftAt !== rightAt) return leftAt - rightAt;

  return a.profileId.localeCompare(b.profileId);
}
