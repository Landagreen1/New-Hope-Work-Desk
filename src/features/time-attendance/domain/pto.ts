// src/features/time-attendance/domain/pto.ts
// The time-off arithmetic: how a requested date range becomes a working-day
// count, how a set of ranges divides across calendar years, and how an approval
// or its reversal becomes balance movements.
//
// This module owns the single implementation of the working-day count rule
// (Requirement 19, criterion 8). It replaces the two copies of `countWeekdays`
// that the redesign inherited — one in `PTORequests.tsx`, one in
// `/api/pto/route.ts` — which could disagree about the same request because
// only one of them consulted anything beyond the day of the week. Nothing else
// in the module is allowed to count working days for itself, which is what makes
// the figure shown at submission the same figure debited at decision time.
//
// It also owns the mapping from a request type to the `pto_balances` column a
// decision moves, and the attribution of each affected date to the calendar year
// that contains it. The inherited approval path bucketed every debit into
// `new Date().getFullYear()` — the year the decision was taken rather than the
// year of the requested dates — so a December approval of January leave debited
// the wrong year, and a range crossing 31 December debited one year twice.
//
// It also owns the decision vocabulary: the eight options the
// Request_Decision_Drawer offers, the stored status each of them produces, which
// of them move a balance, and the below-minimum guard that stands between an
// approval and a shortfall. The inherited path had two options, approve and
// deny, and no guard at all, so protecting coverage meant denying a reasonable
// request.
//
// Finally, it owns what a request looks like on the way in and on the way to a
// decision: the shortfall and the short-notice condition disclosed at
// submission, the context the decision drawer shows around a request, the twelve
// fields the Request_Inbox row carries, the inbox's default order, its six
// filters, and its page cap. All of it derived here rather than in the inbox, so
// the figure an employee saw when they submitted is the figure an administrator
// sees when they decide.
//
// Pure: no I/O, no `Date.now()`, no reads of `process.env`. Every result is a
// function of the arguments alone — the submission date and the evaluation
// instant arrive as arguments. Calendar-date handling goes through
// `domain/work-date.ts`, so no date string is parsed or stepped here.
//
// Requirements: 7.5 (the twelve fields of a Request_Inbox row), 7.6 (the six
// inbox filters), 7.7 (the four status filter values), 7.8 (pending before
// decided), 7.9 (the coverage risk indicator comes from the Projected_Coverage
// the Coverage_Service produced for the requested dates), 7.12 (pages of at most
// 50 rows), 9.8 (the balance before and after approval), 9.9 (calendar days of
// notice), 9.10 (the requester's other approved absences within 14 days), 9.11
// (other pending requests overlapping the range), 9.12 (the available backup
// employees), 10.1 (the eight decision options), 10.2 (approve full sets
// approved), 10.4 (approve part debits only the approved working days), 10.5
// (suggest dates sets information requested and leaves the balance alone), 10.6
// (waitlist), 10.7 (request information), 10.9 (the below-minimum approval
// guard and its three escapes), 10.10 (an override reason carries non-whitespace
// content and is stored), 10.13 (debit the approved working days), 10.14 (credit
// the days previously debited when an approval is reversed), 10.15 (attribute
// each movement to the calendar year containing the affected date), 10.16 (a
// range spanning two years debits each year its own days), 11.2 (the working-day
// count is computed once, on the server, and stored), 11.4 (a submission
// exceeding the balance discloses the shortfall and is still allowed), 11.5 (a
// submission starting fewer than 14 calendar days out records the short-notice
// condition), 19.8 (one implementation of the working-day count rule).

import type { Department, PTOStatus, PTOType } from '../types';
import { MINUTE_MS, roundToTwoDecimals } from './attendance';
import type { CoverageInterval, CoverageStatus, DateCoverage } from './coverage';
import { COVERAGE_SEVERITY } from './coverage';
import type { DateRange } from './types';
import { addCalendarDays, zonedToInstant } from './work-date';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

// The request types and the request statuses are declared once, in `types.ts`,
// and imported here: `PTOType` is exactly the five values the
// `pto_requests.pto_type` check constraint accepts, and `PTOStatus` the seven the
// status constraint accepts once v1.9.3 extends it. This module held local copies
// of both while `types.ts` still declared `vacation | birthday`, which the
// constraint rejected on submission; they are gone, so there is one vocabulary
// rather than two that could drift.

/**
 * The `pto_balances` columns a leave decision can move.
 *
 * These three are the whole set the table carries, and the
 * `pto_balance_ledger.balance_field` check constraint accepts exactly these
 * values.
 */
export type BalanceField = 'vacation_used' | 'sick_used' | 'personal_used';

/**
 * The only mapping from a request type to the balance column it moves.
 *
 * `bereavement` and `unpaid` have no column of their own, so they land on
 * `personal_used`, which is the behaviour the inherited approval path already
 * had ("everything that is not vacation or sick") and is preserved rather than
 * quietly changed. Giving them their own columns is a schema decision, not a
 * derivation decision.
 *
 * Requirements: 10.13, 10.20
 */
export const PTO_TYPE_TO_BALANCE_FIELD: Record<PTOType, BalanceField> = {
  vacation: 'vacation_used',
  sick: 'sick_used',
  personal: 'personal_used',
  bereavement: 'personal_used',
  unpaid: 'personal_used',
};

/**
 * Types that debit a balance column when approved.
 *
 * Unpaid leave is tracked by request only — approving it sets the status to
 * approved but does not debit any balance counter. Legacy types (sick, personal,
 * bereavement) are kept in the map above for existing row display but are no
 * longer requestable; only vacation actually debits a balance today.
 */
export const BALANCE_TRACKED_TYPES: readonly PTOType[] = ['vacation'];

/**
 * One balance movement: a number of days applied to one column of one calendar
 * year's balance row.
 *
 * The shape a `pto_balance_ledger` row is written from, and the payload
 * `pto_decide()` validates against the approved ranges before it applies
 * anything.
 *
 * `deltaDays` is signed the way `pto_balances.*_used` accumulates: positive
 * consumes balance (a debit, Requirement 10, criterion 13) and negative returns
 * it (a credit, criterion 14). Never zero — a year with no working days
 * produces no delta at all rather than a movement of nothing.
 *
 * Requirements: 10.13, 10.14, 10.15
 */
export interface BalanceDelta {
  year: number;
  balanceField: BalanceField;
  deltaDays: number;
}

// ─── The working-day rule ────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** Day-of-week values `Date.prototype.getUTCDay` reports for the weekend. */
const SUNDAY = 0;
const SATURDAY = 6;

/**
 * Midnight UTC on a calendar date.
 *
 * The weekday and the span of a date are properties of the calendar date alone,
 * so the date is anchored in UTC, where every day is exactly 24 hours and no
 * offset applies. Reading them from an instant in a real zone would make the
 * count depend on daylight saving; reading them from the process timezone would
 * make it depend on where the code runs.
 *
 * Routed through `zonedToInstant` because that is the module that owns turning a
 * date string into an instant, and it rejects a string that matches the
 * `YYYY-MM-DD` shape but names no real date, such as `2026-02-30`, rather than
 * rolling it into the following month.
 *
 * @throws RangeError if `date` is malformed or is not a real calendar date.
 */
function utcMidnightOf(date: string): Date {
  return zonedToInstant(date, '00:00:00', 'UTC');
}

/**
 * The calendar year of a `YYYY-MM-DD` date.
 *
 * A field read on a string `work-date.ts` has already validated and produced
 * with a zero-padded four-digit year, not a conversion: no instant and no
 * timezone is involved.
 */
function calendarYearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * The working dates in an inclusive range, ascending.
 *
 * A date is a working date when it is Monday through Friday and is not in
 * `closedDates`. That test appears once, here, and every count in the module
 * comes from this list.
 *
 * Each date is produced by offset from `start` rather than by stepping its
 * predecessor, so nothing accumulates across a month, year, or daylight-saving
 * boundary.
 *
 * @throws RangeError if either bound is malformed or is not a real calendar
 *   date.
 */
function workingDatesBetween(
  start: string,
  end: string,
  closedDates: ReadonlySet<string>,
): string[] {
  const startInstant = utcMidnightOf(start);
  const startMs = startInstant.getTime();
  const endMs = utcMidnightOf(end).getTime();

  // An inverted range covers no dates. Reported as zero rather than rejected:
  // a date picker can produce one mid-edit, and the count is what tells the
  // employee the range is empty.
  if (endMs < startMs) return [];

  const spanDays = (endMs - startMs) / DAY_MS + 1;
  const startWeekday = startInstant.getUTCDay();

  const dates: string[] = [];
  for (let offset = 0; offset < spanDays; offset += 1) {
    // The weekday advances with the offset, so the whole range needs one
    // conversion rather than one per date.
    const weekday = (startWeekday + offset) % 7;
    if (weekday === SUNDAY || weekday === SATURDAY) continue;

    const date = addCalendarDays(start, offset);
    if (closedDates.has(date)) continue;

    dates.push(date);
  }

  return dates;
}

/**
 * The number of working days in the inclusive range `start` through `end`,
 * excluding weekends and the dates the organisation is closed.
 *
 * The one implementation of the working-day count rule (Requirement 19,
 * criterion 8). Because it is a function of the two dates and the closed-date
 * set alone, the count computed when a request is submitted is the same count
 * computed when it is decided, however long the request waits — which is what
 * Requirement 11, criterion 2 needs to be able to store the figure and what
 * Correctness Property 18 asserts.
 *
 * The result is never negative, and never exceeds the number of calendar dates
 * the range spans, because the walk visits each date once and counts at most
 * one per visit.
 *
 * `closedDates` holds `attendance_closed_dates.closed_date` values as
 * `YYYY-MM-DD`. A closed date falling on a weekend changes nothing: the two
 * exclusions overlap freely.
 *
 * @param start Inclusive first date, `YYYY-MM-DD`.
 * @param end Inclusive last date, `YYYY-MM-DD`. Earlier than `start` yields 0.
 * @throws RangeError if either bound is malformed or is not a real calendar
 *   date.
 */
export function countWorkingDays(
  start: string,
  end: string,
  closedDates: ReadonlySet<string>,
): number {
  return workingDatesBetween(start, end, closedDates).length;
}

/**
 * The distinct working dates across `ranges`, ascending.
 *
 * Dates are collected into a set before they are ordered, so overlapping or
 * repeated ranges contribute each date once and the result never depends on the
 * order the ranges arrive in. Every date list in the module comes from here: the
 * per-year counts a decision writes, the dates a decision context reports, and
 * the dates a coverage risk indicator is read across, so those three cannot
 * disagree about which dates a request covers.
 *
 * @throws RangeError if any range bound is malformed or is not a real calendar
 *   date.
 */
export function workingDatesAcross(
  ranges: readonly DateRange[],
  closedDates: ReadonlySet<string>,
): string[] {
  const dates = new Set<string>();
  for (const range of ranges) {
    for (const date of workingDatesBetween(range.from, range.to, closedDates)) {
      dates.add(date);
    }
  }
  return Array.from(dates).sort();
}

/**
 * The working days across `ranges`, counted per calendar year.
 *
 * Each date is attributed to the calendar year containing that date, so a range
 * running from 28 December to 6 January reports both years with their own days
 * (Requirement 10, criteria 15 and 16). The year a decision happens to be taken
 * never enters into it.
 *
 * Dates are collected into a set before they are counted, so overlapping or
 * repeated ranges cannot debit the same day twice. That also makes the result
 * independent of the order the ranges arrive in.
 *
 * Keys are ascending, and a year with no working days is absent rather than
 * present with a count of zero. The sum of the values is therefore the total
 * working days across the distinct dates the ranges cover.
 *
 * @throws RangeError if any range bound is malformed or is not a real calendar
 *   date.
 */
export function workingDaysByYear(
  ranges: readonly DateRange[],
  closedDates: ReadonlySet<string>,
): Map<number, number> {
  // Ascending dates give ascending year keys, and a deterministic order for the
  // ledger rows a decision writes.
  const ascending = workingDatesAcross(ranges, closedDates);

  const byYear = new Map<number, number>();
  for (const date of ascending) {
    const year = calendarYearOf(date);
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }

  return byYear;
}

// ─── Balance movements ───────────────────────────────────────────────────────

/**
 * The balance movements a decision on `ranges` implies: one delta per affected
 * calendar year, all against the balance column `ptoType` maps to.
 *
 * `sign` is `1` for the debit an approval applies (Requirement 10, criterion 13)
 * and `-1` for the credit that reverses it when the approval becomes denied or
 * cancelled (criterion 14). Both come out of this one function over the same
 * stored ranges, so a credit cannot disagree with the debit it reverses:
 * negating the sign negates every `deltaDays` and changes nothing else, which
 * is what Correctness Properties 21 and 24 assert.
 *
 * A decision that leaves the balance alone — deny, suggest dates, waitlist,
 * request information, assign coverage — does not call this at all. There is no
 * "zero delta" result to distinguish, which is why an unaffected year is absent
 * from the list rather than carried with a count of zero.
 *
 * Counts are whole days, so no rounding boundary exists here.
 *
 * @throws RangeError if `sign` is not exactly 1 or -1, if `ptoType` is not an
 *   accepted request type, or if any range bound is not a real calendar date.
 *   A request type outside the accepted set is refused rather than defaulted,
 *   because a delta carrying no balance column would be written to the ledger
 *   as a movement against nothing.
 */
export function balanceDeltas(
  ptoType: PTOType,
  ranges: readonly DateRange[],
  closedDates: ReadonlySet<string>,
  sign: 1 | -1,
): BalanceDelta[] {
  if (sign !== 1 && sign !== -1) {
    throw new RangeError(`balanceDeltas: sign must be 1 or -1, received ${String(sign)}`);
  }

  // Types not in BALANCE_TRACKED_TYPES (e.g. unpaid leave) are tracked by
  // request only — no balance counter is debited or credited.
  if (!BALANCE_TRACKED_TYPES.includes(ptoType)) return [];

  const balanceField = PTO_TYPE_TO_BALANCE_FIELD[ptoType];
  if (!balanceField) {
    throw new RangeError(`balanceDeltas: "${String(ptoType)}" is not an accepted request type`);
  }

  const deltas: BalanceDelta[] = [];
  for (const [year, days] of Array.from(workingDaysByYear(ranges, closedDates))) {
    deltas.push({ year, balanceField, deltaDays: sign * days });
  }

  return deltas;
}

// ─── Decision vocabulary ─────────────────────────────────────────────────────

/**
 * The eight decisions the Request_Decision_Drawer offers.
 *
 * The same eight values the `pto_request_decisions.decision` check constraint
 * accepts, so a decision that compiles is a decision the table will store.
 *
 * Requirements: 10.1
 */
export type DecisionOption =
  | 'approve_full'
  | 'deny'
  | 'approve_partial'
  | 'suggest_dates'
  | 'assign_coverage'
  | 'approve_with_coverage'
  | 'waitlist'
  | 'request_info';

/**
 * The eight options in the order Requirement 10, criterion 1 lists them.
 *
 * The drawer renders this list rather than a list of its own, so the set of
 * options on the screen cannot drift from the set the service and the database
 * accept. Order is a display choice; it lives here so that it is one choice.
 *
 * Requirements: 10.1
 */
export const DECISION_OPTIONS: readonly DecisionOption[] = [
  'approve_full',
  'deny',
  'approve_partial',
  'suggest_dates',
  'assign_coverage',
  'approve_with_coverage',
  'waitlist',
  'request_info',
];

/**
 * The five statuses a decision can set.
 *
 * Eight options collapse onto five statuses, which is why the decision itself is
 * recorded alongside the status in `pto_request_decisions`: the status says what
 * the request now is, the decision says how it got there.
 *
 * `cancelled` is the sixth `PTOStatus` a request can reach and is absent here: it
 * is reachable only by the employee cancelling their own request (Requirement 11,
 * criterion 9), never by a decision.
 *
 * Requirements: 10.2, 10.4, 10.5, 10.6, 10.7
 */
export type DecisionStatus = Extract<
  PTOStatus,
  'approved' | 'partially_approved' | 'denied' | 'waitlisted' | 'information_requested'
>;

/**
 * The payload field that tells a decision apart from another decision storing
 * the same status.
 *
 * Two pairs share a status. `approve_full` and `approve_with_coverage` both
 * store `approved`, and the coverage assignments are what distinguish them;
 * `suggest_dates` and `request_info` both store `information_requested`, and the
 * suggested ranges or the question are what distinguish them (Requirement 10,
 * criteria 5 and 7). `none` means the status alone identifies the decision.
 *
 * A denial reason is not named here. Requirement 10, criterion 3 requires one,
 * but `denied` is reached by exactly one decision, so the reason is a validation
 * rule rather than a discriminator.
 */
export type DecisionPayloadField =
  | 'none'
  | 'approved_and_declined_ranges'
  | 'suggested_ranges'
  | 'coverage_assignments'
  | 'question';

/** What one decision option does. */
export interface DecisionRule {
  /**
   * The status the decision stores, or null when the decision leaves the status
   * as it stands.
   *
   * Only `assign_coverage` is null. Finding or assigning coverage answers the
   * shortfall rather than the request: Requirement 10, criterion 8 has it create
   * or amend a schedule entry and link it to the request, and says nothing about
   * the request's status. The design's decision flow agrees — assigning coverage
   * loops back to re-project the affected dates rather than committing an
   * outcome — so the request is still waiting for one of the other seven.
   */
  status: DecisionStatus | null;
  /**
   * True when the decision approves leave.
   *
   * Two rules read this one field, which is why they cannot disagree: an
   * approving decision debits the balance for its approved working days
   * (Requirement 10, criteria 4 and 13), and an approving decision is the only
   * kind the below-minimum guard applies to (criterion 9, which speaks of what
   * "an approval" would do). The other five leave the balance untouched
   * (criteria 5, 6, and 7).
   */
  approves: boolean;
  /** The payload that distinguishes this decision from others sharing its status. */
  distinguishingPayload: DecisionPayloadField;
}

/**
 * The one table mapping a decision option onto what it does.
 *
 * | option                  | status                  | approves | payload                       |
 * | ----------------------- | ----------------------- | -------- | ----------------------------- |
 * | `approve_full`          | `approved`              | yes      | —                             |
 * | `deny`                  | `denied`                | no       | —                             |
 * | `approve_partial`       | `partially_approved`    | yes      | approved and declined ranges  |
 * | `suggest_dates`         | `information_requested` | no       | suggested ranges              |
 * | `assign_coverage`       | unchanged               | no       | coverage assignments          |
 * | `approve_with_coverage` | `approved`              | yes      | coverage assignments          |
 * | `waitlist`              | `waitlisted`            | no       | —                             |
 * | `request_info`          | `information_requested` | no       | question                      |
 *
 * Requirements: 10.2, 10.4, 10.5, 10.6, 10.7
 */
export const DECISION_RULES: Record<DecisionOption, DecisionRule> = {
  approve_full: { status: 'approved', approves: true, distinguishingPayload: 'none' },
  deny: { status: 'denied', approves: false, distinguishingPayload: 'none' },
  approve_partial: {
    status: 'partially_approved',
    approves: true,
    distinguishingPayload: 'approved_and_declined_ranges',
  },
  suggest_dates: {
    status: 'information_requested',
    approves: false,
    distinguishingPayload: 'suggested_ranges',
  },
  assign_coverage: {
    status: null,
    approves: false,
    distinguishingPayload: 'coverage_assignments',
  },
  approve_with_coverage: {
    status: 'approved',
    approves: true,
    distinguishingPayload: 'coverage_assignments',
  },
  waitlist: { status: 'waitlisted', approves: false, distinguishingPayload: 'none' },
  request_info: {
    status: 'information_requested',
    approves: false,
    distinguishingPayload: 'question',
  },
};

/**
 * The rule for one decision option.
 *
 * @throws RangeError if `decision` is not one of the eight options. Refused
 *   rather than defaulted: a decision with no rule would otherwise be written as
 *   a status change to nothing, or as an approval that debits nothing.
 */
export function decisionRule(decision: DecisionOption): DecisionRule {
  const rule = DECISION_RULES[decision];
  if (!rule) {
    throw new RangeError(`decisionRule: "${String(decision)}" is not a decision option`);
  }
  return rule;
}

/**
 * The status a request holds after `decision` is committed.
 *
 * `previousStatus` is returned unchanged for `assign_coverage`, which records a
 * coverage assignment without deciding the request. Every other option returns
 * its mapped status regardless of what the request held before, so the mapping
 * is a function of the decision alone (Correctness Property 19).
 *
 * @throws RangeError if `decision` is not one of the eight options.
 */
export function statusForDecision(
  decision: DecisionOption,
  previousStatus: PTOStatus,
): PTOStatus {
  return decisionRule(decision).status ?? previousStatus;
}

/**
 * True when `decision` approves leave: it debits the balance, and the
 * below-minimum guard applies to it.
 *
 * Exactly `approve_full`, `approve_with_coverage`, and `approve_partial`.
 *
 * Requirements: 10.4, 10.5, 10.6, 10.7, 10.13
 *
 * @throws RangeError if `decision` is not one of the eight options.
 */
export function decisionApproves(decision: DecisionOption): boolean {
  return decisionRule(decision).approves;
}

/**
 * The ranges a decision approves: the request's own range, the sub-ranges an
 * approve-part decision names, or nothing at all.
 *
 * `requested` is the stored request range, and `approved` is the sub-range set
 * an `approve_partial` decision carries. `approve_full` and
 * `approve_with_coverage` approve the whole requested range and ignore
 * `approved` entirely, so a payload that names both cannot approve more than was
 * asked for.
 */
export interface DecisionRanges {
  /** The request's stored range, as submitted. */
  requested: DateRange;
  /** The sub-ranges an `approve_partial` decision approves. */
  approved?: readonly DateRange[];
}

/**
 * The dates `decision` approves, as ranges.
 *
 * A non-approving decision approves nothing and returns an empty list — which is
 * what makes its balance movement zero rather than a movement of nothing
 * (criteria 5, 6, and 7).
 *
 * An `approve_partial` decision naming no approved sub-range also returns an
 * empty list rather than throwing. It approves nothing, so it debits nothing,
 * and the arithmetic stays total for every combination of option and payload.
 * Requiring a partial approval to approve something is Requirement 10,
 * criterion 4's recording rule, which the service validates when it stores the
 * ranges.
 *
 * @throws RangeError if `decision` is not one of the eight options.
 */
export function approvedRangesForDecision(
  decision: DecisionOption,
  ranges: DecisionRanges,
): DateRange[] {
  if (!decisionApproves(decision)) return [];
  if (decision === 'approve_partial') return [...(ranges.approved ?? [])];
  return [ranges.requested];
}

/**
 * The balance movements `decision` implies.
 *
 * One delta per affected calendar year against the column `ptoType` maps to for
 * an approving decision, and an empty list for the other five (criteria 5, 6,
 * and 7). The days counted are the approved working days only, so approving part
 * of a request debits part of it (criterion 4).
 *
 * Computed from the ranges rather than from any day count a caller supplies,
 * which is what keeps the debit equal to the working days the approved ranges
 * actually hold (Correctness Property 19).
 *
 * The reversal of Requirement 10, criterion 14 is not a decision: it calls
 * `balanceDeltas` with `sign: -1` over the ranges the approval stored, so the
 * credit comes out of the same arithmetic as the debit.
 *
 * @throws RangeError if `decision` is not one of the eight options, if `ptoType`
 *   is not an accepted request type, or if any range bound is not a real
 *   calendar date.
 */
export function decisionBalanceDeltas(
  decision: DecisionOption,
  ptoType: PTOType,
  ranges: DecisionRanges,
  closedDates: ReadonlySet<string>,
): BalanceDelta[] {
  // A decision that approves nothing names no balance column, so the request
  // type is never consulted for one. The three that do approve go through
  // `balanceDeltas`, which is where the type and the dates are validated.
  if (!decisionApproves(decision)) return [];
  return balanceDeltas(ptoType, approvedRangesForDecision(decision, ranges), closedDates, 1);
}

// ─── The below-minimum approval guard ────────────────────────────────────────

/**
 * The severity at which coverage is below required staffing.
 *
 * Requirement 10, criterion 9 blocks an approval that would put
 * Projected_Coverage *below* required staffing, which is the Critical outcome of
 * the Requirement 6 matrix and not the At_Minimum one: a date sitting exactly on
 * its minimum is not below it. Compared through `COVERAGE_SEVERITY` rather than
 * against the literal, so the guard reads the coverage module's ordering instead
 * of keeping an opinion of its own.
 */
const BELOW_MINIMUM_SEVERITY = COVERAGE_SEVERITY.critical;

function isBelowMinimum(status: CoverageStatus): boolean {
  return COVERAGE_SEVERITY[status] >= BELOW_MINIMUM_SEVERITY;
}

/**
 * One place where an approval would leave staffing below what is required.
 *
 * `interval` is null for a whole-date shortfall and carries the
 * Coverage_Interval's half-open ISO bounds otherwise. Both kinds block, because
 * criterion 9 names both: a date can be adequately staffed across the day while
 * an interval inside it — a lunch hour, the first hour of an early shift — is
 * short, and an approval that creates that hole is the one the guard exists to
 * catch.
 */
export interface CoverageShortfall {
  /** `YYYY-MM-DD`. */
  workDate: string;
  /** The Coverage_Interval, or null when the whole date is short. */
  interval: { start: string; end: string } | null;
  /** Projected available staffing, as the coverage figure reports it. */
  availableStaff: number;
  /** `staffing_thresholds.minimum_staff` for the slot. */
  requiredStaff: number;
  /** `requiredStaff − availableStaff`. At least 1, since this is a shortfall. */
  shortBy: number;
}

/**
 * One approved date's projection, with the intervals inside it.
 *
 * `coverage` is the Coverage_Service's own `projectCoverage` output for the date
 * with the requested absence included as a proposed absence, and `intervals` is
 * `buildCoverageIntervals` for the same date. Both are carried through rather
 * than recomputed, so what the guard blocks on is exactly what the
 * Approval_Impact_Preview displayed (Requirement 9, criteria 1 through 5).
 *
 * `intervals` is optional: a date whose schedule defines a single start and end
 * instant has nothing to partition, and criterion 9 is then a whole-date
 * question.
 */
export interface ApprovalImpactDate {
  coverage: DateCoverage;
  intervals?: readonly CoverageInterval[];
}

/**
 * The shortfalls across the approved dates and their intervals.
 *
 * A shortfall is read from the Coverage_Status the Coverage_Service already
 * assigned, not from a comparison of its own, so the guard cannot disagree with
 * the figures the preview showed. A date or interval with no configured
 * threshold reports Healthy and is therefore never a shortfall, which is
 * Requirement 6, criterion 4 holding here for free: an unconfigured slot is a
 * gap in the configuration, not a staffing emergency to block an approval on.
 *
 * The caller supplies the approved dates only. An approve-part decision projects
 * its approved sub-ranges, because the dates it declines are not affected by the
 * approval and a shortfall on one of them is not this decision's doing.
 *
 * Order is the order supplied, each date followed by its own intervals, so a
 * shortfall list is stable and the drawer can render it as it stands.
 *
 * `availableStaff` is the reported, floored figure. When absences outnumber
 * schedules the raw projection is negative, and `shortBy` is measured from zero
 * rather than from the negative figure: it is how many people are still needed,
 * and no shortfall calls for more than the requirement itself.
 *
 * Requirements: 10.9
 */
export function collectShortfalls(dates: readonly ApprovalImpactDate[]): CoverageShortfall[] {
  const shortfalls: CoverageShortfall[] = [];

  for (const { coverage, intervals } of dates) {
    if (isBelowMinimum(coverage.status) && coverage.requiredStaff !== null) {
      shortfalls.push(
        toShortfall(coverage.workDate, null, coverage.available, coverage.requiredStaff),
      );
    }

    for (const interval of intervals ?? []) {
      if (!isBelowMinimum(interval.status) || interval.requiredStaff === null) continue;
      shortfalls.push(
        toShortfall(
          coverage.workDate,
          { start: interval.start, end: interval.end },
          interval.availableStaff,
          interval.requiredStaff,
        ),
      );
    }
  }

  return shortfalls;
}

function toShortfall(
  workDate: string,
  interval: { start: string; end: string } | null,
  availableStaff: number,
  requiredStaff: number,
): CoverageShortfall {
  return {
    workDate,
    interval,
    availableStaff,
    requiredStaff,
    shortBy: requiredStaff - availableStaff,
  };
}

/** The three ways Requirement 10, criterion 9 lets an approval through a shortfall. */
export type ApprovalEscape = 'coverage_assigned' | 'shortfall_acknowledged' | 'override_reason';

/**
 * What the administrator has offered against the shortfall.
 *
 * Every field is optional and absence means the escape does not hold, so an
 * approval submitted with none of them is blocked by omission rather than by an
 * explicit denial of each.
 */
export interface ApprovalEscapes {
  /**
   * Coverage has been assigned for the shortfall.
   *
   * The design's decision flow assigns coverage by re-projecting the affected
   * dates, which removes the shortfall from the projection outright. This flag
   * covers the other path: a decision payload that carries its coverage
   * assignments alongside the approval, where the projection the drawer holds
   * still shows the hole the assignments fill.
   */
  coverageAssigned?: boolean;
  /** The administrator has acknowledged the shortfall and is approving anyway. */
  acknowledgedShortfall?: boolean;
  /** The override reason, which must carry non-whitespace content to count. */
  overrideReason?: string | null;
}

/** Whether an approval may proceed, and what it may proceed on. */
export interface ApprovalGuardVerdict {
  /** True when the approval may be committed. */
  permitted: boolean;
  /**
   * The shortfalls the decision was evaluated against, as supplied.
   *
   * Carried through even when the approval is permitted, because a shortfall
   * approved under an escape is still a shortfall and is what the audit entry
   * and the decision row record.
   */
  shortfalls: CoverageShortfall[];
  /**
   * The escapes that hold, in the order criterion 9 lists them.
   *
   * Reported whether or not a shortfall exists. An escape is a fact about the
   * submission, not about the outcome.
   */
  escapes: ApprovalEscape[];
  /**
   * The override reason to store, trimmed, or null when none with content was
   * supplied.
   *
   * Requirement 10, criterion 10 requires at least one non-whitespace character
   * and requires the reason to be stored. Trimming is what makes those two the
   * same test: a reason that survives trimming is a reason with content, and it
   * is the value the caller stores.
   */
  overrideReason: string | null;
  /**
   * `coverage_shortfall` when blocked, matching the route's error code, and null
   * when permitted.
   */
  code: 'coverage_shortfall' | null;
}

/**
 * Whether an approval may proceed given the shortfalls it would create and what
 * the administrator has offered against them.
 *
 * Permitted exactly when no shortfall exists or at least one of the three
 * escapes holds (Correctness Property 16). The three escapes are independent and
 * any one is enough — criterion 9 joins them with "or" — so there is no ordering
 * among them to get wrong, and a submission carrying all three is permitted for
 * the same reason a submission carrying one is.
 *
 * A blank or whitespace-only override reason is not an escape. It carries no
 * content, so per criterion 10 there is nothing to require and nothing to store,
 * and an approval resting on it alone stays blocked. That is the difference the
 * guard exists to draw: an administrator who types a space has not explained
 * anything.
 *
 * Nothing here is decided from a shortfall's size. One person short of a
 * requirement of two blocks exactly as a whole department missing does; the
 * figures are carried through for the drawer to show, not to weigh.
 *
 * The guard applies to approving decisions only. `decisionApproves` names them,
 * and a decision that approves nothing cannot put coverage below anything.
 *
 * Requirements: 10.9, 10.10
 */
export function evaluateApprovalGuard(
  shortfalls: readonly CoverageShortfall[],
  escapes: ApprovalEscapes = {},
): ApprovalGuardVerdict {
  const overrideReason = reasonWithContent(escapes.overrideReason);

  const held: ApprovalEscape[] = [];
  if (escapes.coverageAssigned === true) held.push('coverage_assigned');
  if (escapes.acknowledgedShortfall === true) held.push('shortfall_acknowledged');
  if (overrideReason !== null) held.push('override_reason');

  const permitted = shortfalls.length === 0 || held.length > 0;

  return {
    permitted,
    shortfalls: [...shortfalls],
    escapes: held,
    overrideReason,
    code: permitted ? null : 'coverage_shortfall',
  };
}

/**
 * The reason to store, trimmed, or null when the value carries no content.
 *
 * The one implementation of "at least one non-whitespace character", which
 * Requirement 10 asks for twice — of a denial reason in criterion 3 and of an
 * override reason in criterion 10 — and which the inherited approval path
 * applied to neither. A null or undefined value is treated as no reason rather
 * than rejected, so a caller need not distinguish "absent" from "blank" before
 * asking.
 *
 * Requirements: 10.3, 10.10
 */
export function reasonWithContent(reason: string | null | undefined): string | null {
  if (typeof reason !== 'string') return null;
  const trimmed = reason.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// ─── Calendar-day arithmetic ─────────────────────────────────────────────────

/** No closed dates, for the entry points where the set is optional. */
const NO_CLOSED_DATES: ReadonlySet<string> = new Set<string>();

/**
 * Whole calendar days from `from` to `to`: positive when `to` is the later date,
 * negative when it is earlier, zero when they are the same date.
 *
 * Calendar arithmetic over two date strings, not a duration between two
 * instants. No timezone is involved and no hour is implied, so a span crossing a
 * daylight-saving transition still counts one day per date — which is what makes
 * the notice figure the same number an employee counts on a wall calendar.
 *
 * The one implementation of the calendar-day difference this module needs, and
 * both fourteen-day rules read it: the short-notice test of Requirement 11,
 * criterion 5 and the nearby-absence window of Requirement 9, criterion 10.
 *
 * @throws RangeError if either date is malformed or is not a real calendar date.
 */
export function calendarDaysBetween(from: string, to: string): number {
  return (utcMidnightOf(to).getTime() - utcMidnightOf(from).getTime()) / DAY_MS;
}

/**
 * True when two inclusive date ranges share at least one calendar date.
 *
 * Compared as strings, which is exact for the zero-padded `YYYY-MM-DD` form
 * every range in the module uses.
 *
 * An inverted range — `to` earlier than `from` — covers no dates and therefore
 * overlaps nothing, which is the same reading `countWorkingDays` gives it. A
 * date picker can produce one mid-edit, and it must not match every range in the
 * inbox while it does.
 */
function rangesOverlap(a: DateRange, b: DateRange): boolean {
  if (a.from > a.to || b.from > b.to) return false;
  return a.from <= b.to && b.from <= a.to;
}

/** True when an inclusive range covers `date`. */
function rangeCovers(range: DateRange, date: string): boolean {
  if (range.from > range.to) return false;
  return range.from <= date && date <= range.to;
}

/** An instant, or null when the value is absent or unreadable. */
function parseInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : null;
}

// ─── Remaining balance ───────────────────────────────────────────────────────

/** The `pto_balances` allocation columns. */
export type AllowanceField = 'vacation_days' | 'sick_days' | 'personal_days';

/**
 * The allocation column each request type draws against.
 *
 * Paired one-for-one with `PTO_TYPE_TO_BALANCE_FIELD`: a type's remaining
 * balance is its allocation column minus its usage column, so the two maps have
 * to name the same pair for every type. `bereavement` and `unpaid` land on the
 * personal pair for the same reason they do there — the table carries no column
 * of their own, and giving them one is a schema decision.
 *
 * Requirements: 11.3
 */
export const PTO_TYPE_TO_ALLOWANCE_FIELD: Record<PTOType, AllowanceField> = {
  vacation: 'vacation_days',
  sick: 'sick_days',
  personal: 'personal_days',
  bereavement: 'personal_days',
  unpaid: 'personal_days',
};

/**
 * One `pto_balances` row: the allocations and the days used, for one employee
 * and one calendar year.
 *
 * Columns are named as the table names them, which is also how `BalanceField`
 * names the usage columns the ledger moves — so the allowance column and the
 * usage column a request type draws against are exactly what the two maps
 * return, with no third naming convention in between.
 *
 * `carryover_days` is deliberately absent. It is stored and read by nothing
 * today (Appendix A.5), and folding it into the remaining figure would invent an
 * allowance rule rather than derive one.
 */
export interface PTOBalanceRow {
  year: number;
  vacation_days: number;
  sick_days: number;
  personal_days: number;
  vacation_used: number;
  sick_used: number;
  personal_used: number;
}

/**
 * The remaining balance for one request type: the allocation minus the days
 * used.
 *
 * The one implementation of "remaining balance". The inherited screen had two
 * that disagreed and a gap: vacation as `vacation_days - vacation_used`,
 * birthday as `max(0, 1 - personal_used)` with the allocation hardcoded to one
 * day while an administrator could edit `personal_days`, and sick hidden
 * altogether. The figure shown before submission, the figure on the inbox row,
 * and the figures the decision drawer shows before and after approval are all
 * this one.
 *
 * Not floored at zero. A balance already overdrawn — which the shortfall
 * disclosure of Requirement 11, criterion 4 permits by allowing submission — is
 * reported as the negative figure it is, because flooring it would hide the
 * overdraft from the next request's shortfall.
 *
 * A missing row means no allocation has been recorded for that employee and
 * year, which reports zero rather than an unbounded balance.
 *
 * @throws RangeError if `ptoType` is not an accepted request type.
 */
export function remainingBalanceFor(
  balance: PTOBalanceRow | null | undefined,
  ptoType: PTOType,
): number {
  const allowanceField = PTO_TYPE_TO_ALLOWANCE_FIELD[ptoType];
  const usedField = PTO_TYPE_TO_BALANCE_FIELD[ptoType];
  if (!allowanceField || !usedField) {
    throw new RangeError(`remainingBalanceFor: "${String(ptoType)}" is not an accepted request type`);
  }
  if (balance === null || balance === undefined) return 0;

  const allowance = numberOrZero(balance[allowanceField]);
  const used = numberOrZero(balance[usedField]);
  return roundToTwoDecimals(allowance - used);
}

/** A stored numeric column, or zero when the row carries nothing readable. */
function numberOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ─── Submission disclosure ───────────────────────────────────────────────────

/**
 * The notice below which a request is short notice: fewer than 14 calendar days
 * between the submission date and the requested start.
 *
 * The inherited path applied the same fortnight as a client-side warning and
 * nothing else — the server accepted any date and recorded nothing — so a
 * request that arrived the day before could not be told from one submitted a
 * month ahead. Here it is computed once and stored on the request.
 *
 * Requirements: 11.5
 */
export const SHORT_NOTICE_DAYS = 14;

/** What an employee is submitting, and what they hold to cover it. */
export interface SubmissionDisclosureInput {
  ptoType: PTOType;
  /** The requested dates, inclusive at both ends. */
  range: DateRange;
  /** Remaining balance for `ptoType`, as `remainingBalanceFor` reports it. */
  remainingBalance: number;
  /** The date the request is submitted on, `YYYY-MM-DD`. Never read from a clock. */
  submissionDate: string;
  closedDates?: ReadonlySet<string>;
}

/**
 * What the composer displays when a request is submitted, and what the request
 * stores.
 *
 * Requirements: 11.2, 11.4, 11.5
 */
export interface SubmissionDisclosure {
  /**
   * Always true. Neither a shortfall nor short notice blocks a submission
   * (Requirement 11, criterion 4 allows submission with the shortfall
   * disclosed), so there is no rejecting branch here — the field states that
   * plainly rather than leaving its absence to be inferred.
   */
  accepted: true;
  ptoType: PTOType;
  range: DateRange;
  /** The server-computed count the request stores (Requirement 11, criterion 2). */
  workingDays: number;
  /** Remaining balance before the request, as supplied and rounded at the boundary. */
  remainingBalance: number;
  /** `remainingBalance − workingDays`. Negative exactly when there is a shortfall. */
  balanceAfter: number;
  /** `workingDays − remainingBalance`, floored at zero. */
  shortfallDays: number;
  /** True when `shortfallDays` is above zero: the request exceeds the balance. */
  exceedsBalance: boolean;
  /** Calendar days from the submission date to the requested start. */
  noticeDays: number;
  /** True when `noticeDays` is below `SHORT_NOTICE_DAYS`. */
  shortNotice: boolean;
}

/**
 * The shortfall and the short-notice condition for a submission.
 *
 * Both figures are functions of the arguments alone, so the composer, the route,
 * and the stored row cannot disagree about either. The working-day count comes
 * from `countWorkingDays`, which is what makes the count shown at submission the
 * count debited at decision time (Correctness Property 18).
 *
 * The shortfall is floored at zero, so a request comfortably inside the balance
 * reports no shortfall rather than a negative one. `balanceAfter` is not
 * floored: an administrator deciding the request needs to see that approving it
 * would leave the employee two days overdrawn, and the two figures are the same
 * arithmetic read in the two directions the two screens need.
 *
 * A requested start on or before the submission date has zero or negative
 * notice, which is fewer than fourteen days and therefore short notice. The
 * comparison needs no special case for it.
 *
 * Nothing here rejects anything. Requirement 11, criterion 4 is explicit that a
 * submission exceeding the balance is allowed with the shortfall disclosed, and
 * criterion 5 records the short-notice condition rather than refusing it.
 *
 * Requirements: 11.2, 11.4, 11.5
 *
 * @throws RangeError if `ptoType` is not an accepted request type, or if the
 *   submission date or either range bound is not a real calendar date.
 */
export function buildSubmissionDisclosure(
  input: SubmissionDisclosureInput,
): SubmissionDisclosure {
  const balanceField = PTO_TYPE_TO_BALANCE_FIELD[input.ptoType];
  if (!balanceField) {
    throw new RangeError(
      `buildSubmissionDisclosure: "${String(input.ptoType)}" is not an accepted request type`,
    );
  }

  const closedDates = input.closedDates ?? NO_CLOSED_DATES;
  const workingDays = countWorkingDays(input.range.from, input.range.to, closedDates);
  const remainingBalance = roundToTwoDecimals(numberOrZero(input.remainingBalance));
  const shortfallDays = roundToTwoDecimals(Math.max(0, workingDays - remainingBalance));
  const noticeDays = calendarDaysBetween(input.submissionDate, input.range.from);

  return {
    accepted: true,
    ptoType: input.ptoType,
    range: { from: input.range.from, to: input.range.to },
    workingDays,
    remainingBalance,
    balanceAfter: roundToTwoDecimals(remainingBalance - workingDays),
    shortfallDays,
    exceedsBalance: shortfallDays > 0,
    noticeDays,
    shortNotice: noticeDays < SHORT_NOTICE_DAYS,
  };
}

// ─── Requests, absences, and schedules as the domain reads them ──────────────

/**
 * One `pto_requests` row, in the shape the domain speaks.
 *
 * `workingDays` is the stored `working_days` column and `shortNotice` the stored
 * `short_notice` column, both written at submission from
 * `buildSubmissionDisclosure`. Both are optional because rows predating the two
 * columns carry neither: the count is then recomputed, which by Correctness
 * Property 18 gives the same answer, and the short-notice test is re-applied to
 * the submission date and the requested start.
 */
export interface PTORequestRecord {
  id: string;
  profileId: string;
  ptoType: PTOType;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string;
  status: PTOStatus;
  /** ISO instant, `created_at`. What the elapsed figure is measured from. */
  submittedAt: string;
  /**
   * The calendar date `submittedAt` falls on, `YYYY-MM-DD`.
   *
   * Resolved by the caller through `workDateOf` in the employee's timezone, and
   * carried rather than sliced off the instant: slicing the first ten characters
   * of an ISO string is the second work-date convention Appendix A.6 records and
   * Requirement 19, criterion 10 removes, and near midnight the two conventions
   * disagree — which would move a request across the short-notice boundary.
   */
  submissionDate: string;
  /** ISO instant of the decision, `reviewed_at`; null while the request waits. */
  decidedAt?: string | null;
  /** The stored working-day count, or null for a row predating the column. */
  workingDays?: number | null;
  /** The stored short-notice condition. */
  shortNotice?: boolean;
  reason?: string | null;
}

/**
 * One approved absence, as the dates an employee is away.
 *
 * A range rather than a request, because a partially approved request is absent
 * on its approved sub-ranges only. The caller resolves a request into the ranges
 * it actually carries; this module never reads an absence out of a status.
 */
export interface ApprovedAbsence {
  requestId: string;
  profileId: string;
  ptoType: PTOType;
  range: DateRange;
}

/** One published schedule row: an employee expected to work on one date. */
export interface ScheduledShift {
  profileId: string;
  /** `YYYY-MM-DD`. */
  workDate: string;
}

/**
 * True when a request is still awaiting its first decision.
 *
 * The one place the pending-against-decided line is drawn, which the inbox's
 * default order (Requirement 7, criterion 8) and the overlapping-request set of
 * Requirement 9, criterion 11 both read. `waitlisted` and
 * `information_requested` are decided: a decision was committed, recorded, and
 * audited, and the request is waiting on an answer rather than on a first look.
 *
 * Requirements: 7.8, 9.11
 */
export function isPendingRequest(status: PTOStatus): boolean {
  return status === 'pending';
}

/**
 * The statuses an employee may cancel their own request from.
 *
 * Exactly the two Requirement 11, criterion 8 names. `approved` and `denied` are
 * excluded by criterion 10, and the other three by the same reasoning the
 * criterion rests on: a decision has been committed, recorded, and audited, and
 * unwinding it is an administrator's decision rather than the employee's.
 * `cancelled` is excluded because there is nothing left to cancel.
 *
 * Neither of the two has ever moved a balance, which is why cancellation needs no
 * credit of its own: `pending` was never debited, and a `waitlisted` decision
 * leaves the balance unchanged (criterion 6). The reversal of Requirement 10,
 * criterion 14 therefore belongs to the decision path, where the ledger it
 * reconciles against is writable.
 *
 * Requirements: 11.8, 11.10
 */
export const CANCELLABLE_STATUSES = [
  'pending',
  'waitlisted',
] as const satisfies readonly PTOStatus[];

/**
 * True when an employee may cancel their own request in this status.
 *
 * The one implementation of the rule, read by the composer to decide whether to
 * offer the cancel action and by the service to decide whether to honour it — so
 * the button and the endpoint cannot disagree about what is cancellable
 * (Correctness Property 25).
 *
 * Requirements: 11.8, 11.9, 11.10
 */
export function canCancelRequest(status: PTOStatus): boolean {
  return (CANCELLABLE_STATUSES as readonly PTOStatus[]).includes(status);
}

// ─── Coverage risk ───────────────────────────────────────────────────────────

/**
 * The worst status in a set, or null for an empty set.
 *
 * Severity is read from `COVERAGE_SEVERITY` rather than from an ordering of this
 * module's own, so the inbox's idea of "worse" is the coverage module's idea of
 * it. A value outside the vocabulary contributes nothing rather than being
 * ranked by accident.
 *
 * Null for an empty set is deliberate: no projection is not the same as a
 * healthy one. Inventing Healthy would claim coverage nobody computed, and
 * inventing Critical would raise an alarm from missing data.
 *
 * Requirements: 7.9
 */
export function worstCoverageStatus(
  statuses: readonly CoverageStatus[],
): CoverageStatus | null {
  let worst: CoverageStatus | null = null;
  for (const status of statuses) {
    const severity = COVERAGE_SEVERITY[status];
    if (severity === undefined) continue;
    if (worst === null || severity > COVERAGE_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/** The dates a request covers, and the projection the Coverage_Service made for them. */
export interface CoverageRiskInput {
  /** The requested ranges. Usually the one stored range. */
  ranges: readonly DateRange[];
  /**
   * The Coverage_Service's own `projectCoverage` output for the dates in view.
   *
   * Carried through rather than recomputed: the indicator on the row is the
   * status the service published, so a row and the Coverage_Calendar cell beside
   * it cannot disagree (Requirement 7, criterion 9).
   */
  coverage: readonly DateCoverage[];
  closedDates?: ReadonlySet<string>;
  /**
   * Read the named department's row of each date's breakdown instead of the
   * whole-organisation figure. The requester's department, when the inbox knows
   * it. A projection carrying no breakdown is read at its whole-date figure
   * either way.
   */
  department?: Department | null;
}

/**
 * The coverage risk indicator for a request: the worst Coverage_Status across
 * the working dates it covers.
 *
 * Worst rather than first or last, because a request is as risky as its riskiest
 * date: one Critical Friday inside an otherwise Healthy fortnight is what an
 * administrator needs to see on the row.
 *
 * Only working dates are considered, the same dates the balance is debited for.
 * A weekend inside a requested range costs no leave and removes nobody from a
 * shift, so a shortfall on it is not this request's doing.
 *
 * A requested date the coverage set does not cover contributes nothing, and a
 * request whose dates are covered by nothing at all reports null: the indicator
 * is unknown, which the row states rather than dressing up as healthy.
 *
 * When `department` is named, each date's projection is read at that department
 * where it carries a breakdown and at the whole-organisation figure where it
 * carries none. A breakdown that names other departments but not this one
 * contributes nothing: that department has nobody scheduled and no requirement on
 * the date, so it has no status to read.
 *
 * Requirements: 7.5, 7.9
 *
 * @throws RangeError if any range bound is malformed or is not a real calendar
 *   date.
 */
export function coverageRiskForRequest(input: CoverageRiskInput): CoverageStatus | null {
  const dates = new Set(
    workingDatesAcross(input.ranges, input.closedDates ?? NO_CLOSED_DATES),
  );
  if (dates.size === 0) return null;

  const department = input.department ?? null;
  const statuses: CoverageStatus[] = [];
  for (const dateCoverage of input.coverage) {
    if (!dates.has(dateCoverage.workDate)) continue;
    const status = statusForDepartment(dateCoverage, department);
    if (status !== null) statuses.push(status);
  }

  return worstCoverageStatus(statuses);
}

/**
 * A date's whole-organisation status, or one department's status within it.
 *
 * A projection carrying no department rows at all was not asked for a
 * breakdown — the Health_Ribbon's query is one — and its whole-date figure is
 * the projection the Coverage_Service produced for that date, so that is what
 * the indicator reads.
 *
 * A projection that does carry a breakdown and has no row for the named
 * department is a different statement: that department has nobody scheduled and
 * no configured requirement on the date, so it has no status of its own and
 * contributes nothing. Substituting the organisation's figure there would report
 * a department's health from other departments' staffing.
 */
function statusForDepartment(
  coverage: DateCoverage,
  department: Department | null,
): CoverageStatus | null {
  if (department === null || coverage.departments.length === 0) return coverage.status;
  const row = coverage.departments.find((entry) => entry.department === department);
  return row === undefined ? null : row.status;
}

// ─── The decision context ────────────────────────────────────────────────────

/**
 * The window either side of a requested range within which another absence of
 * the same employee is close enough to matter: 14 days.
 *
 * The same number as `SHORT_NOTICE_DAYS` and a different rule, so it is a
 * different constant. One could change without the other.
 *
 * Requirements: 9.10
 */
export const NEARBY_ABSENCE_DAYS = 14;

/** Everything the decision context is computed from. */
export interface DecisionContextInput {
  request: PTORequestRecord;
  /**
   * The sub-ranges a decision would approve. Defaults to the whole requested
   * range, which is what the drawer shows when it opens; an approve-part
   * decision passes the sub-ranges it is considering, so the after-approval
   * balance follows the decision being contemplated.
   */
  approvedRanges?: readonly DateRange[];
  /** Remaining balance for the requested type before the decision. */
  remainingBalance: number;
  /**
   * Every other request in scope. The pending ones whose dates overlap are the
   * conflicts of Requirement 9, criterion 11; the rest are ignored here.
   */
  otherRequests?: readonly PTORequestRecord[];
  /**
   * Approved absences for any employee, as ranges. The requester's own are the
   * nearby absences of criterion 10; everybody's are what disqualifies a backup
   * under criterion 12.
   */
  approvedAbsences?: readonly ApprovedAbsence[];
  /** Published schedule rows covering the requested dates. */
  schedules?: readonly ScheduledShift[];
  closedDates?: ReadonlySet<string>;
}

/** The employees available to cover one requested date. */
export interface DateBackup {
  /** `YYYY-MM-DD`. */
  workDate: string;
  /** Scheduled on the date with no approved absence on it, ascending. */
  profileIds: string[];
}

/**
 * What the Request_Decision_Drawer shows around one request.
 *
 * Requirements: 9.8, 9.9, 9.10, 9.11, 9.12
 */
export interface DecisionContext {
  requestId: string;
  profileId: string;
  ptoType: PTOType;
  /** The stored requested range. */
  requestedRange: DateRange;
  /** The ranges the contemplated decision would approve. */
  approvedRanges: DateRange[];
  /** The working dates those ranges cover, ascending. */
  approvedDates: string[];
  /** `approvedDates.length`: the working days an approval would debit. */
  workingDays: number;
  /** The `pto_balances` column an approval would move. */
  balanceField: BalanceField;
  /** Remaining balance before the decision. */
  balanceBefore: number;
  /** `balanceBefore − workingDays`. Not floored: an overdraft is shown as one. */
  balanceAfter: number;
  /** `workingDays − balanceBefore`, floored at zero. */
  shortfallDays: number;
  /** Calendar days from the submission date to the requested start. */
  noticeDays: number;
  /** True when `noticeDays` is below `SHORT_NOTICE_DAYS`. */
  shortNotice: boolean;
  /**
   * The requester's other approved absences within `NEARBY_ABSENCE_DAYS` of the
   * requested range, by start date.
   */
  nearbyAbsences: ApprovedAbsence[];
  /**
   * Other pending requests, from any employee, whose dates overlap the requested
   * range, by start date.
   */
  overlappingPending: PTORequestRecord[];
  /**
   * Employees available to cover at least one requested date, ascending. The
   * requester is never among them.
   */
  backupProfileIds: string[];
  /** The same set broken down per requested date, in date order. */
  backupsByDate: DateBackup[];
}

/**
 * The context for one request: what approving it would cost, how much notice it
 * gave, what else is happening around it, and who could cover.
 *
 * Every figure is derived from the rows supplied, so the drawer renders and
 * decides nothing. Five separate answers, in the order Requirement 9 states
 * them:
 *
 * - **Balance before and after** (criterion 8). After is before minus the
 *   working days the contemplated decision would approve, so approving part of a
 *   request moves the balance by part of it. Not floored, because an approval
 *   that overdraws a balance is a fact the administrator is being asked to
 *   accept.
 * - **Notice** (criterion 9). Calendar days from the submission date to the
 *   requested start, the same figure and the same comparison the composer showed
 *   the employee at submission.
 * - **Nearby absences** (criterion 10). The requester's other approved absences
 *   whose dates come within a fortnight of the requested range. The request
 *   under decision is excluded — it is the subject, not its own context — and so
 *   is every other employee's leave, which is what criterion 12's backup set
 *   answers for.
 * - **Overlapping pending requests** (criterion 11). Pending requests from any
 *   employee whose dates overlap the range, which is how an administrator sees
 *   that approving this one commits the date before the next one is read.
 * - **Backup employees** (criterion 12). Per requested date, the employees with
 *   a published schedule on that date and no approved absence covering it. The
 *   requester is excluded: the request being decided is precisely a proposed
 *   absence on those dates, and somebody who may not be there is not backup.
 *
 * Both fourteen-day windows are inclusive of the boundary: an absence exactly
 * fourteen days from the range is nearby, and notice of exactly fourteen days is
 * not short. That is the same boundary in both directions of the same fortnight.
 *
 * Requirements: 9.8, 9.9, 9.10, 9.11, 9.12
 *
 * @throws RangeError if the request's type is not an accepted request type, or if
 *   any date the context is computed over is not a real calendar date.
 */
export function buildDecisionContext(input: DecisionContextInput): DecisionContext {
  const { request } = input;
  const balanceField = PTO_TYPE_TO_BALANCE_FIELD[request.ptoType];
  if (!balanceField) {
    throw new RangeError(
      `buildDecisionContext: "${String(request.ptoType)}" is not an accepted request type`,
    );
  }

  const closedDates = input.closedDates ?? NO_CLOSED_DATES;
  const requestedRange: DateRange = { from: request.startDate, to: request.endDate };
  const approvedRanges = (input.approvedRanges ?? [requestedRange]).map((range) => ({
    from: range.from,
    to: range.to,
  }));

  const approvedDates = workingDatesAcross(approvedRanges, closedDates);
  const workingDays = approvedDates.length;

  const balanceBefore = roundToTwoDecimals(numberOrZero(input.remainingBalance));
  const noticeDays = calendarDaysBetween(request.submissionDate, request.startDate);

  return {
    requestId: request.id,
    profileId: request.profileId,
    ptoType: request.ptoType,
    requestedRange,
    approvedRanges,
    approvedDates,
    workingDays,
    balanceField,
    balanceBefore,
    balanceAfter: roundToTwoDecimals(balanceBefore - workingDays),
    shortfallDays: roundToTwoDecimals(Math.max(0, workingDays - balanceBefore)),
    noticeDays,
    shortNotice: noticeDays < SHORT_NOTICE_DAYS,
    nearbyAbsences: nearbyAbsencesFor(request, requestedRange, input.approvedAbsences ?? []),
    overlappingPending: overlappingPendingFor(request, requestedRange, input.otherRequests ?? []),
    ...backupsFor(request, approvedDates, input.schedules ?? [], input.approvedAbsences ?? []),
  };
}

/**
 * The requester's other approved absences within `NEARBY_ABSENCE_DAYS` of the
 * requested range.
 *
 * The window is the requested range widened by a fortnight at each end, and an
 * absence qualifies when it overlaps that window — so an absence inside the
 * requested range itself qualifies too, at a distance of nothing.
 */
function nearbyAbsencesFor(
  request: PTORequestRecord,
  requestedRange: DateRange,
  absences: readonly ApprovedAbsence[],
): ApprovedAbsence[] {
  const window: DateRange = {
    from: addCalendarDays(requestedRange.from, -NEARBY_ABSENCE_DAYS),
    to: addCalendarDays(requestedRange.to, NEARBY_ABSENCE_DAYS),
  };

  return absences
    .filter(
      (absence) =>
        absence.profileId === request.profileId &&
        absence.requestId !== request.id &&
        rangesOverlap(absence.range, window),
    )
    .sort(byRangeThenId);
}

function byRangeThenId(
  a: { range: DateRange; requestId: string },
  b: { range: DateRange; requestId: string },
): number {
  if (a.range.from !== b.range.from) return a.range.from < b.range.from ? -1 : 1;
  if (a.range.to !== b.range.to) return a.range.to < b.range.to ? -1 : 1;
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

/**
 * Other pending requests whose dates overlap the requested range, from any
 * employee.
 *
 * The request under decision is excluded by identifier rather than by employee,
 * so the requester's own second pending request still shows up — two requests
 * from one employee for overlapping dates is exactly the conflict criterion 11
 * exists to surface.
 */
function overlappingPendingFor(
  request: PTORequestRecord,
  requestedRange: DateRange,
  others: readonly PTORequestRecord[],
): PTORequestRecord[] {
  return others
    .filter(
      (other) =>
        other.id !== request.id &&
        isPendingRequest(other.status) &&
        rangesOverlap({ from: other.startDate, to: other.endDate }, requestedRange),
    )
    .sort((a, b) =>
      byRangeThenId(
        { range: { from: a.startDate, to: a.endDate }, requestId: a.id },
        { range: { from: b.startDate, to: b.endDate }, requestId: b.id },
      ),
    );
}

/**
 * The employees who could cover each requested date, and the union across them.
 *
 * Scheduled on the date, holding no approved absence covering it, and not the
 * requester. Computed per date and then unioned, so an employee available on one
 * requested date and away on another appears in the union while `backupsByDate`
 * still says which dates they can actually take.
 */
function backupsFor(
  request: PTORequestRecord,
  approvedDates: readonly string[],
  schedules: readonly ScheduledShift[],
  absences: readonly ApprovedAbsence[],
): { backupProfileIds: string[]; backupsByDate: DateBackup[] } {
  const union = new Set<string>();
  const backupsByDate: DateBackup[] = [];

  for (const workDate of approvedDates) {
    const available = new Set<string>();

    for (const shift of schedules) {
      if (shift.workDate !== workDate) continue;
      if (shift.profileId === request.profileId) continue;
      available.add(shift.profileId);
    }

    for (const absence of absences) {
      if (!rangeCovers(absence.range, workDate)) continue;
      available.delete(absence.profileId);
    }

    for (const profileId of available) union.add(profileId);
    backupsByDate.push({ workDate, profileIds: [...available].sort() });
  }

  return { backupProfileIds: [...union].sort(), backupsByDate };
}

// ─── The Request_Inbox row ───────────────────────────────────────────────────

/** The employee facts an inbox row carries that a request row does not hold. */
export interface RequestSubject {
  profileId: string;
  /** `profiles.display_name`. */
  employeeName: string;
  department: Department | null;
}

/** Everything one inbox row is built from. */
export interface RequestRowInput {
  request: PTORequestRecord;
  /** The requester, from the roster the read already loaded. */
  subject?: RequestSubject | null;
  /**
   * The requester's `pto_balances` row for the year the request starts in.
   * Omitted when the caller has no balance to hand, which reports the remaining
   * balance as unknown rather than as zero.
   */
  balance?: PTOBalanceRow | null;
  /** The Coverage_Service's projection for the dates in view. */
  coverage?: readonly DateCoverage[];
  /** ISO instant the row is built at, for the elapsed figure. Never a clock read. */
  evaluatedAt: string;
  closedDates?: ReadonlySet<string>;
}

/**
 * One compact Request_Inbox row.
 *
 * Twelve fields are displayed: the eleven Requirement 7, criterion 5 names, plus
 * the request identifier the row is keyed by and the decision drawer is opened
 * from. `profileId`, `pending`, and `shortNotice` are carried alongside them for
 * scoping, ordering, and labelling — derived here so the screen groups and
 * labels rather than decides.
 *
 * Requirements: 7.4, 7.5
 */
export interface RequestInboxRow {
  requestId: string;
  profileId: string;
  /** Null when the requester could not be resolved in the roster. */
  employeeName: string | null;
  department: Department | null;
  ptoType: PTOType;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string;
  workingDays: number;
  status: PTOStatus;
  /** Remaining balance for the requested type, or null when none was supplied. */
  remainingBalance: number | null;
  /** The worst Coverage_Status across the requested dates, or null when unknown. */
  coverageRisk: CoverageStatus | null;
  /** ISO instant, `created_at`. */
  submittedAt: string;
  /**
   * Minutes the request has been awaiting review: to the decision instant once
   * it has one, to the evaluation instant while it waits.
   */
  awaitingReviewMinutes: number;
  /** True while the request awaits its first decision. */
  pending: boolean;
  /** The stored short-notice condition, or the same test applied to the row. */
  shortNotice: boolean;
}

/**
 * Build one inbox row.
 *
 * Every derived field on the row comes from this module: the working days from
 * `countWorkingDays`, the remaining balance from `remainingBalanceFor`, the
 * coverage risk from `coverageRiskForRequest`, and the elapsed figure from the
 * supplied evaluation instant. The inbox derives nothing of its own
 * (Requirement 3, criteria 14 and 15 applied to the time-off screen).
 *
 * The stored `working_days` is preferred when the row carries one, because that
 * is the figure the employee was shown at submission and the figure a decision
 * debits. A row predating the column falls back to recomputing the count, which
 * by Correctness Property 18 is the same number.
 *
 * A decided request's elapsed figure stops at its decision: it reports how long
 * the request waited, not how long ago it was submitted. An unreadable submission
 * or decision instant reports zero minutes rather than throwing — a bad
 * timestamp on one row must not blank the inbox.
 *
 * Requirements: 7.4, 7.5, 7.9, 11.2
 *
 * @throws RangeError if the request's type is not an accepted type, if
 *   `evaluatedAt` is not an instant, or if a date the row has to compute over —
 *   a requested bound, or the submission date where the stored short-notice flag
 *   is absent — is not a real calendar date.
 */
export function buildRequestRow(input: RequestRowInput): RequestInboxRow {
  const { request } = input;
  if (!PTO_TYPE_TO_BALANCE_FIELD[request.ptoType]) {
    throw new RangeError(
      `buildRequestRow: "${String(request.ptoType)}" is not an accepted request type`,
    );
  }

  const evaluatedAtMs = parseInstant(input.evaluatedAt);
  if (evaluatedAtMs === null) {
    throw new RangeError(
      `buildRequestRow: evaluatedAt must be an instant, received "${String(input.evaluatedAt)}"`,
    );
  }

  const closedDates = input.closedDates ?? NO_CLOSED_DATES;
  const range: DateRange = { from: request.startDate, to: request.endDate };
  const subject =
    input.subject !== undefined &&
    input.subject !== null &&
    input.subject.profileId === request.profileId
      ? input.subject
      : null;

  const workingDays =
    typeof request.workingDays === 'number' && Number.isFinite(request.workingDays)
      ? request.workingDays
      : countWorkingDays(range.from, range.to, closedDates);

  const submittedAtMs = parseInstant(request.submittedAt);
  const decidedAtMs = parseInstant(request.decidedAt);
  const untilMs = decidedAtMs ?? evaluatedAtMs;
  const awaitingReviewMinutes =
    submittedAtMs === null ? 0 : roundToTwoDecimals(Math.max(0, (untilMs - submittedAtMs) / MINUTE_MS));

  return {
    requestId: request.id,
    profileId: request.profileId,
    employeeName: subject === null ? null : subject.employeeName,
    department: subject === null ? null : subject.department,
    ptoType: request.ptoType,
    startDate: range.from,
    endDate: range.to,
    workingDays,
    status: request.status,
    remainingBalance:
      input.balance === undefined || input.balance === null
        ? null
        : remainingBalanceFor(input.balance, request.ptoType),
    coverageRisk:
      input.coverage === undefined
        ? null
        : coverageRiskForRequest({
            ranges: [range],
            coverage: input.coverage,
            closedDates,
            department: subject === null ? null : subject.department,
          }),
    submittedAt: request.submittedAt,
    awaitingReviewMinutes,
    pending: isPendingRequest(request.status),
    shortNotice:
      typeof request.shortNotice === 'boolean'
        ? request.shortNotice
        : calendarDaysBetween(request.submissionDate, range.from) < SHORT_NOTICE_DAYS,
  };
}

// ─── The inbox: order, filters, and paging ───────────────────────────────────

/**
 * The four status filter values the inbox control offers.
 *
 * Requirement 7, criterion 7 names exactly these. `RequestQuery.statuses` accepts
 * the whole seven-value vocabulary, so a caller can also filter to the three
 * decision statuses the extended vocabulary added — the criterion sets a floor
 * on what the control offers, not a ceiling on what the query can express.
 *
 * Requirements: 7.7
 */
export const REQUEST_STATUS_FILTERS = [
  'pending',
  'approved',
  'denied',
  'cancelled',
] as const satisfies readonly PTOStatus[];

/**
 * The most rows the Request_Inbox loads in one page.
 *
 * Requirements: 7.12
 */
export const REQUEST_PAGE_LIMIT = 50;

/**
 * Compare two rows in the inbox's default order.
 *
 * Pending before decided (Requirement 7, criterion 8), then longest awaiting
 * review first, then by request identifier so the order is total and does not
 * depend on the order the rows arrived in.
 *
 * Oldest first inside each group is a display choice, and it lives here so that
 * it is one choice: the row that has waited longest is the row the administrator
 * should read first, and it is the row the elapsed-time column already draws the
 * eye to.
 *
 * Requirements: 7.8
 */
export function compareRequestRows(a: RequestInboxRow, b: RequestInboxRow): number {
  if (a.pending !== b.pending) return a.pending ? -1 : 1;
  if (a.submittedAt !== b.submittedAt) return a.submittedAt < b.submittedAt ? -1 : 1;
  return a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0;
}

/**
 * The rows in the inbox's default order. Does not mutate the input.
 *
 * Requirements: 7.8
 */
export function orderRequestRows(rows: readonly RequestInboxRow[]): RequestInboxRow[] {
  return [...rows].sort(compareRequestRows);
}

/**
 * The six Request_Inbox filters, plus the paging the view applies.
 *
 * Every field is a conjunct, and an array field is satisfied when the row's
 * value is one of the listed values — so an empty array is satisfied by nothing,
 * which is the intersection with an empty set rather than a filter that does
 * nothing. This is the same reading `RecordQuery` uses in `domain/attendance.ts`.
 *
 * `from` and `to` bound the requested dates by overlap rather than containment: a
 * request running across the edge of the displayed range is still a request on
 * the dates in view, and hiding it would be the surest way to double-book one of
 * them.
 *
 * Requirements: 7.6, 7.7, 7.12
 */
export interface RequestQuery {
  /** Status filter. The four values of criterion 7 are what the control offers. */
  statuses?: readonly PTOStatus[];
  /** Department filter, read from the row's resolved department. */
  departments?: readonly Department[];
  /** Employee filter. */
  profileIds?: readonly string[];
  /** Request-type filter. */
  ptoTypes?: readonly PTOType[];
  /** Date-range filter: requests whose requested dates overlap `from`..`to`. */
  from?: string;
  to?: string;
  /** Coverage-risk filter, against the row's indicator. */
  coverageRisks?: readonly CoverageStatus[];
  /** 1-based page number. */
  page?: number;
  /** Rows per page, capped at `REQUEST_PAGE_LIMIT`. */
  limit?: number;
}

/**
 * True when a row satisfies every active filter.
 *
 * A row whose department or coverage risk is unknown does not match a filter on
 * that field. A filter can only be confirmed against a value the row carries, and
 * showing a row the filter cannot be confirmed for would quietly widen the
 * result set — the same rule `matchesRecordQuery` applies to a missing
 * department.
 *
 * `page` and `limit` are ignored here: paging selects rows from a match, it is
 * not part of matching.
 *
 * Requirements: 7.6, 7.7
 */
export function matchesRequestQuery(
  row: RequestInboxRow,
  query: RequestQuery = {},
): boolean {
  if (query.statuses !== undefined && !query.statuses.includes(row.status)) return false;

  if (query.departments !== undefined) {
    if (row.department === null || !query.departments.includes(row.department)) return false;
  }

  if (query.profileIds !== undefined && !query.profileIds.includes(row.profileId)) return false;

  if (query.ptoTypes !== undefined && !query.ptoTypes.includes(row.ptoType)) return false;

  if (query.from !== undefined || query.to !== undefined) {
    const window: DateRange = {
      from: query.from ?? row.startDate,
      to: query.to ?? row.endDate,
    };
    if (!rangesOverlap({ from: row.startDate, to: row.endDate }, window)) return false;
  }

  if (query.coverageRisks !== undefined) {
    if (row.coverageRisk === null || !query.coverageRisks.includes(row.coverageRisk)) return false;
  }

  return true;
}

/** The rows a query matches, in the order they were given. */
export function filterRequestRows(
  rows: readonly RequestInboxRow[],
  query: RequestQuery = {},
): RequestInboxRow[] {
  return rows.filter((row) => matchesRequestQuery(row, query));
}

/**
 * The page size a query asks for, capped at `REQUEST_PAGE_LIMIT` and floored at
 * one.
 *
 * The cap is applied here rather than trusted from the query, so a caller asking
 * for a thousand rows receives fifty (Requirement 7, criterion 12).
 */
export function requestPageLimit(limit?: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return REQUEST_PAGE_LIMIT;
  const whole = Math.floor(limit);
  if (whole < 1) return 1;
  return Math.min(whole, REQUEST_PAGE_LIMIT);
}

/** One page of the Request_Inbox. */
export interface RequestInboxPage {
  /** The page's rows, in the default order. Never more than `limit`. */
  rows: RequestInboxRow[];
  /** 1-based page number, as applied. */
  page: number;
  /** Rows per page, as applied. Never above `REQUEST_PAGE_LIMIT`. */
  limit: number;
  /** Rows the query matches, before paging. */
  totalRows: number;
  /** Pages the matching rows fill. At least one, so a screen always has a page. */
  totalPages: number;
  /** The query the page was produced under. */
  query: RequestQuery;
}

/**
 * One page of the inbox: the rows a query matches, in the default order, capped
 * at fifty.
 *
 * Filtering, ordering, and paging in that order and in one place, so the row an
 * administrator sees at the top of page one is the oldest pending request the
 * filters admit.
 *
 * A page number beyond the last page yields no rows rather than the last page,
 * because silently answering a different page than the one asked for would make
 * a paging control lie about where it is.
 *
 * Requirements: 7.6, 7.7, 7.8, 7.12
 */
export function buildRequestInbox(
  rows: readonly RequestInboxRow[],
  query: RequestQuery = {},
): RequestInboxPage {
  const limit = requestPageLimit(query.limit);
  const page =
    typeof query.page === 'number' && Number.isFinite(query.page)
      ? Math.max(1, Math.floor(query.page))
      : 1;

  const matched = orderRequestRows(filterRequestRows(rows, query));
  const start = (page - 1) * limit;

  return {
    rows: matched.slice(start, start + limit),
    page,
    limit,
    totalRows: matched.length,
    totalPages: Math.max(1, Math.ceil(matched.length / limit)),
    query: { ...query },
  };
}
