// src/features/time-attendance/server/pto-service.ts
// The one write path for time off, and the read behind the Request_Inbox.
//
// Four entry points, and between them everything a leave request can have done
// to it: `listRequests` for the inbox, `submitRequest` for an employee asking,
// `cancelOwnRequest` for an employee withdrawing, and `decide` for an
// administrator answering.
//
// ## Nothing arithmetical is trusted from the browser
//
// This is the whole reason the module exists. The inherited path in `/api/pto`
// took `total_days` from the request body, recounted weekdays in one place and
// not the other, read `pto_balances` into JavaScript, added a figure, and wrote
// the sum back — so two approvals landing together lost one increment, and the
// failure was logged to the console while the endpoint still answered success
// (Appendix A.5).
//
// Here:
//
//   * the working-day count is computed by `countWorkingDays` on the server and
//     stored on the row (Requirement 11, criterion 2), so the figure an employee
//     was shown at submission is the figure a decision debits;
//   * `decide` computes its balance deltas from the stored request row, the
//     stored closed dates, and the stored ledger — never from a day count or a
//     balance figure in the request body (Requirement 10, criteria 13 to 16);
//   * the movement is applied by `pto_decide()`, which locks the request row,
//     re-derives the same arithmetic, and refuses the call if the payload
//     disagrees with what the database can see. The service's deltas are a
//     proposal the database checks, not an instruction it follows.
//
// A browser can therefore lie about a day count and be refused, or lie about a
// balance and be ignored, because neither figure is read from it anywhere.
//
// ## What `decide` returns, and why
//
// A decision answers with the recomputed Projected_Coverage for every date the
// request covers (Requirement 10, criterion 12), taken from the same
// `getCoverage` projected read the Coverage_Calendar and the
// Approval_Impact_Preview make. The pre-decision preview counts the request as a
// *proposed* absence; the post-decision read counts it as an *approved* one. The
// same subtraction either way, so the figure shown before the decision equals the
// figure read after it, which is Correctness Property 17 by construction rather
// than by two implementations happening to agree.
//
// ## Query counts
//
// | call               | configuration | reads                    | writes |
// | ------------------ | ------------- | ------------------------ | ------ |
// | `listRequests`     | 2             | 5 + 4 (coverage)         | 0      |
// | `submitRequest`    | 1             | 3 + 4 (row rebuild)      | 1      |
// | `cancelOwnRequest` | 1             | 2 + 4 (row rebuild)      | 1      |
// | `decide`           | 2             | 3 + 4 or 8 (coverage) + 4 | 1 RPC + coverage assignments |
//
// Every read count is a property of the call, never of the roster size or the
// range length: no query is issued inside a loop over employees or dates
// (Requirements 20.1, 20.2). Coverage assignment is the one place a loop issues
// statements, and it is bounded by the assignments the administrator submitted —
// a list they typed, not a set the data decides.
//
// ## What lives in the domain layer and is only called from here
//
// Working days, per-year attribution, the decision-to-status mapping, which
// decisions move a balance, the below-minimum guard, the submission disclosure,
// the inbox row, its order, its filters, its page cap, and cancellation
// eligibility are all `domain/pto.ts`. Coverage classification, the projection,
// and the interval partition are all `domain/coverage.ts`. This module reads
// rows, asks those functions, and writes what they answer. It contains no
// time-off rule of its own.
//
// Requirements: 7.4 (one row per request), 7.5 (the twelve row fields), 7.6, 7.7
// (the inbox filters), 7.8 (pending before decided), 7.9 (the coverage risk
// indicator comes from the Coverage_Service), 7.11 (a non-administrator sees only
// their own requests), 7.12 (pages of at most 50 rows), 10.1 (the eight decision
// options), 10.2 to 10.7 (what each decision stores), 10.3 (a denial carries a
// reason), 10.8 (coverage assignment creates or amends the covering employee's
// schedule row and links it to the request), 10.9, 10.10 (the below-minimum guard
// and its three escapes), 10.11 (the audit entry, written inside `pto_decide`),
// 10.12 (Projected_Coverage recomputed for every affected date), 10.13 to 10.16
// (the balance movement and its year attribution), 10.17 (a replayed decision
// applies once), 10.18 (a balance change that cannot be recorded leaves the
// status alone and returns the reason), 10.19 (the owner of a request may not
// decide it), 10.20 (only the request types the constraint accepts), 11.1
// (submission), 11.2 (the working-day count computed and stored on the server),
// 11.4, 11.5 (the shortfall and the short-notice condition disclosed), 11.6 (the
// employee's requests in all five states), 11.7 (the reviewer response text),
// 11.8, 11.9, 11.10 (cancellation and its eligibility), 21.1, 21.2 (visibility),
// 21.15 (a call outside the permitted set changes nothing).

import { canAdministerAttendance } from '@/lib/permissions';

import type { DateCoverage } from '../domain/coverage';
import {
  CANCELLABLE_STATUSES,
  DECISION_OPTIONS,
  PTO_TYPE_TO_BALANCE_FIELD,
  approvedRangesForDecision,
  buildRequestRow,
  buildSubmissionDisclosure,
  canCancelRequest,
  collectShortfalls,
  decisionApproves,
  evaluateApprovalGuard,
  filterRequestRows,
  orderRequestRows,
  reasonWithContent,
  remainingBalanceFor,
  requestPageLimit,
  statusForDecision,
  workingDaysByYear,
  type ApprovalGuardVerdict,
  type BalanceDelta,
  type BalanceField,
  type CoverageShortfall,
  type DecisionOption,
  type PTOBalanceRow,
  type PTORequestRecord,
  type RequestInboxRow,
  type RequestQuery,
  type SubmissionDisclosure,
} from '../domain/pto';
import type { AttendancePolicy, DateRange } from '../domain/types';
import { addCalendarDays, workDateOf } from '../domain/work-date';
import type { PTOStatus, PTOType } from '../types';
import type { ApiFailureCode } from './api-response';
import {
  MAX_RANGE_DAYS,
  toAttendanceEmployee,
  type AttendanceClient,
  type AttendanceEmployee,
  type Paged,
  type ProfileRow,
} from './attendance-service';
import {
  getCoverage,
  isComputedCoverageDate,
  type CoverageResponse,
} from './coverage-service';
import {
  loadAttendancePolicy,
  loadStaffingThresholds,
  type StaffingThresholdTable,
} from './policy';
import { visibleProfileIds, type Actor } from './visibility';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * How far back the inbox reads when the caller names no range.
 *
 * The screen supplies its own range — the Coverage_Calendar's displayed month or
 * fortnight — so this is the fallback for a bare call rather than the inbox's
 * real window. A month back and half a year forward covers the decided requests
 * an administrator still wants to see and the requests that have not happened
 * yet, and it is bounded, which reading the whole table is not.
 */
export const DEFAULT_INBOX_LOOKBACK_DAYS = 30;

/** How far forward the inbox reads when the caller names no range. */
export const DEFAULT_INBOX_LOOKAHEAD_DAYS = 180;

/**
 * The widest span a single request may cover, in calendar dates.
 *
 * The same 366 `pto_decide()` refuses an approved range past, so a request the
 * service accepts is a request a decision can be committed against. A leave
 * request longer than a year is a data fault, and discovering that inside a row
 * lock is not the way to find out.
 */
export const MAX_REQUEST_SPAN_DAYS = 366;

/** `pto_requests.status` values the module recognises. */
const KNOWN_PTO_STATUSES = [
  'pending',
  'approved',
  'denied',
  'cancelled',
  'waitlisted',
  'information_requested',
  'partially_approved',
] as const satisfies readonly PTOStatus[];

/** The columns every request read selects. One list, so every read agrees. */
const REQUEST_COLUMNS =
  'id, profile_id, pto_type, start_date, end_date, total_days, working_days, ' +
  'short_notice, status, reason, denial_reason, reviewed_by, reviewed_at, created_at';

/** The columns a balance read selects, matching `PTOBalanceRow`. */
const BALANCE_COLUMNS =
  'profile_id, year, vacation_days, sick_days, personal_days, ' +
  'vacation_used, sick_used, personal_used';

/** The columns a decision read selects. */
const DECISION_COLUMNS =
  'id, request_id, decision, previous_status, new_status, approved_ranges, ' +
  'declined_ranges, suggested_ranges, reason, override_reason, ' +
  'acknowledged_shortfall, actor_profile_id, created_at';

/** The status a schedule row created or amended to cover an absence carries. */
const COVERAGE_SCHEDULE_STATUS = 'published';

/** The shift type a coverage assignment writes. */
const COVERAGE_SHIFT_TYPE = 'regular';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM` or `HH:MM:SS`, which is what the `time` columns accept. */
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * The failures a time-off call can have.
 *
 * Drawn from `ApiFailureCode` rather than declared independently, so every code
 * this module throws already has a shape in `api-response.ts` and `serviceFailure`
 * can map it without a branch of its own. `coverage_shortfall` and
 * `stale_request_state` are the two conflicts, and both carry `current`.
 */
export type PTOServiceErrorCode = Extract<
  ApiFailureCode,
  | 'not_authorised'
  | 'not_visible'
  | 'owner_cannot_decide'
  | 'invalid_parameter'
  | 'invalid_range'
  | 'reason_required'
  | 'coverage_shortfall'
  | 'stale_request_state'
  | 'read_failed'
  | 'write_failed'
>;

/**
 * A time-off call that could not be served.
 *
 * `current` carries the fresh server state for the two conflict codes, which is
 * what lets a screen re-render against the truth instead of re-submitting the
 * same stale decision. `detail` carries supporting facts for the log and for the
 * `field` an invalid-parameter failure names.
 */
export class PTOServiceError extends Error {
  readonly code: PTOServiceErrorCode;
  readonly detail: Readonly<Record<string, string>>;
  readonly current: unknown;

  constructor(
    code: PTOServiceErrorCode,
    message: string,
    options: { detail?: Record<string, string>; current?: unknown } = {},
  ) {
    super(message);
    this.name = 'PTOServiceError';
    this.code = code;
    this.detail = options.detail ?? {};
    this.current = options.current ?? null;
  }
}

/**
 * The `CODE: message` prefixes `pto_decide()` raises, and the failure each one
 * is.
 *
 * The function raises with SQLSTATEs that already carry the right HTTP meaning,
 * but the driver hands back a message rather than a status, so the prefix is what
 * the mapping reads. An unlisted prefix falls through to `write_failed`, which is
 * the honest answer for a refusal the service cannot name.
 */
const RPC_FAILURE_CODES: Readonly<Record<string, PTOServiceErrorCode>> = {
  NOT_AUTHENTICATED: 'not_authorised',
  NOT_AUTHORISED: 'not_authorised',
  OWNER_CANNOT_DECIDE: 'owner_cannot_decide',
  REQUEST_NOT_FOUND: 'not_visible',
  REASON_REQUIRED: 'reason_required',
  IDEMPOTENCY_KEY_REQUIRED: 'invalid_parameter',
  UNKNOWN_DECISION: 'invalid_parameter',
  INVALID_PAYLOAD: 'invalid_parameter',
  INVALID_RANGES: 'invalid_range',
  RANGES_OUTSIDE_REQUEST: 'invalid_range',
  RANGE_TOO_LONG: 'invalid_range',
  STATUS_MISMATCH: 'invalid_parameter',
  SUGGESTED_RANGES_REQUIRED: 'invalid_parameter',
  PARTIAL_RANGES_REQUIRED: 'invalid_parameter',
  UNEXPECTED_APPROVED_RANGES: 'invalid_parameter',
  INVALID_BALANCE_DELTAS: 'invalid_parameter',
  DUPLICATE_BALANCE_DELTAS: 'invalid_parameter',
  BALANCE_FIELD_MISMATCH: 'invalid_parameter',
  UNEXPECTED_BALANCE_DELTAS: 'invalid_parameter',
  DELTA_MISMATCH: 'invalid_parameter',
};

/**
 * Stated when a cancellation the rules permit is refused by row level security.
 *
 * The specific gap this was written for is closed. `v1.6.2-enforce-scoped-
 * supervisor-access.sql` granted an employee an update on their own request only
 * while its status was `pending`, so cancelling a `waitlisted` request — which
 * Requirement 11, criterion 8 offers and criterion 9 accepts — matched no row and
 * was refused. `v1.9.4-attendance-mutations.sql` widened the `using` clause to
 * `status in ('pending', 'waitlisted')` and tightened `with check` to
 * `status in ('pending', 'waitlisted', 'cancelled')` in the same statement, so both
 * eligible statuses now cancel and an employee still cannot write `approved` onto
 * their own row (Requirement 21, criteria 7 and 10).
 *
 * The constant stays as the generic answer for any *other* policy refusal of a
 * cancellation the domain rules permit: the `v1.9.4` rollback restoring the
 * narrower policy, or a later migration that narrows it again. The write is
 * refused rather than mis-applied, which is the safe direction, and this says so
 * — rather than a stale-state message that would send the employee to reload a
 * row that has not moved.
 */
export const CANCEL_REFUSED_BY_POLICY =
  'That request could not be cancelled. The rules permit withdrawing it and the ' +
  'database refused the write, so an administrator needs to withdraw it for you.';

function readFailed(table: string, message: string, code?: string): PTOServiceError {
  return new PTOServiceError('read_failed', `pto: reading ${table} failed: ${message}`, {
    detail: { table, ...(code === undefined ? {} : { pgCode: code }) },
  });
}

/**
 * A read that failed is reported rather than absorbed.
 *
 * Row level security answers a read the caller may not make with zero rows, not
 * with an error, so an error here is a fault worth surfacing. Absorbing it would
 * show an administrator an empty inbox and let them conclude there is nothing to
 * decide.
 */
function rowsOf<T>(
  table: string,
  result: { data: unknown; error: { message: string; code?: string } | null },
): T[] {
  if (result.error) throw readFailed(table, result.error.message, result.error.code);
  return (result.data as T[] | null) ?? [];
}

function singleOf<T>(
  table: string,
  result: { data: unknown; error: { message: string; code?: string } | null },
): T | null {
  if (result.error) throw readFailed(table, result.error.message, result.error.code);
  return (result.data as T | null) ?? null;
}

// ─── Context ─────────────────────────────────────────────────────────────────

/**
 * Everything a time-off call needs besides its own arguments.
 *
 * `evaluatedAt` is the instant the call is evaluated at: the submission date a
 * request records, the instant an inbox row's elapsed figure is measured to, and
 * the instant a coverage read is taken at. Supplied by the caller so a call is
 * reproducible; defaults to the moment the call starts. The domain layer will not
 * read a clock, so this is where the clock is read.
 *
 * `policy` and `thresholds` let a composite request that has already loaded the
 * configuration pass it down instead of reading it again.
 */
export interface PTOContext {
  client: AttendanceClient;
  /** ISO instant. Defaults to the moment the call starts. */
  evaluatedAt?: string;
  policy?: AttendancePolicy;
  thresholds?: StaffingThresholdTable;
}

// ─── Source row shapes ───────────────────────────────────────────────────────

/**
 * A `pto_requests` row as it arrives.
 *
 * Fields a mapping has to check are typed `unknown`, because declaring `status`
 * as `PTOStatus` here would assume the thing the mapping verifies. Exported
 * because the row builders are exported: a caller assembling sources without a
 * database needs the shapes the reads produce.
 */
export interface PTORequestSourceRow {
  id: string;
  profile_id: string;
  pto_type?: unknown;
  start_date: string;
  end_date: string;
  total_days?: unknown;
  working_days?: unknown;
  short_notice?: unknown;
  status?: unknown;
  reason?: unknown;
  denial_reason?: unknown;
  reviewed_by?: unknown;
  reviewed_at?: unknown;
  created_at?: unknown;
}

export interface PTOBalanceSourceRow {
  profile_id: string;
  year?: unknown;
  vacation_days?: unknown;
  sick_days?: unknown;
  personal_days?: unknown;
  vacation_used?: unknown;
  sick_used?: unknown;
  personal_used?: unknown;
}

export interface PTODecisionSourceRow {
  id: string;
  request_id: string;
  decision?: unknown;
  previous_status?: unknown;
  new_status?: unknown;
  approved_ranges?: unknown;
  declined_ranges?: unknown;
  suggested_ranges?: unknown;
  reason?: unknown;
  override_reason?: unknown;
  acknowledged_shortfall?: unknown;
  actor_profile_id?: unknown;
  created_at?: unknown;
}

export interface PTOLedgerSourceRow {
  year?: unknown;
  balance_field?: unknown;
  delta_days?: unknown;
}

export interface ClosedDateSourceRow {
  closed_date: string;
}

export interface ScheduleSourceRow {
  id: string;
  profile_id: string;
  schedule_date: string;
}

// ─── Response shapes ─────────────────────────────────────────────────────────

/** One committed decision, as the drawer and the employee's own list read it. */
export interface RequestDecisionSummary {
  decisionId: string;
  decision: DecisionOption | null;
  previousStatus: string | null;
  newStatus: string | null;
  approvedRanges: DateRange[];
  declinedRanges: DateRange[];
  suggestedRanges: DateRange[];
  /** The denial reason, the question, or the note the reviewer left. */
  reason: string | null;
  overrideReason: string | null;
  acknowledgedShortfall: boolean;
  actorProfileId: string | null;
  decidedAt: string | null;
}

/**
 * One request as the inbox, the composer, and the decision drawer read it.
 *
 * Extends the domain's `RequestInboxRow`, which carries the twelve fields
 * Requirement 7, criterion 5 names, with the four facts a stored row adds: what
 * the employee wrote, what the reviewer answered, the decisions committed against
 * it, and whether the signed-in actor may withdraw it.
 *
 * Requirements: 7.4, 7.5, 11.6, 11.7, 11.8
 */
export interface RequestRow extends RequestInboxRow {
  /** The stored `total_days`, which payroll reads. Null for an unreadable row. */
  totalDays: number | null;
  /** What the employee wrote when they submitted. */
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /**
   * The reviewer's response text, or null while the request waits.
   *
   * The latest decision's reason where there is one, falling back to the stored
   * `denial_reason` for a request decided before `pto_request_decisions` existed.
   * Requirement 11, criterion 7 asks for the response on each decided request,
   * and an employee reads their own decisions through the
   * `pto_decisions_own_select` policy.
   */
  reviewerResponse: string | null;
  /** Every committed decision, newest first. Empty while the request waits. */
  decisions: RequestDecisionSummary[];
  /** True when the signed-in actor may cancel this request (Requirement 11.8). */
  cancellable: boolean;
}

/**
 * The stored state of a request, as a conflict reports it.
 *
 * One shape whichever layer noticed the staleness: the service compares the
 * status it read against the status the caller saw, and `pto_decide()` compares
 * again inside the row lock and returns its own `current` object. Both are
 * normalised here, so a screen reads one shape and does not have to know which
 * check fired.
 */
export interface RequestState {
  requestId: string;
  profileId: string | null;
  ptoType: PTOType | null;
  status: PTOStatus | null;
  startDate: string | null;
  endDate: string | null;
  workingDays: number | null;
  shortNotice: boolean;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

/**
 * Every request a query matches, unpaged.
 *
 * The read `listRequests` pages and the read the Export_Service consumes whole.
 * One shape for both, so the exported rows are the inbox's rows in the inbox's
 * order rather than a second selection that happens to agree (Requirement 15,
 * criteria 2 and 3, and Correctness Property 33).
 */
export interface RequestSet {
  /** Every matched row, pending before decided, then oldest first. */
  rows: RequestRow[];
  /** The filters the rows were selected by, unpaged. */
  query: RequestQuery;
  evaluatedAt: string;
  /** The window the requests and the coverage were read over. */
  range: DateRange;
  /** The employees in scope, whether or not they carry a request. */
  employees: AttendanceEmployee[];
  /** Whether the coverage risk indicators carry a value. */
  coverageAvailable: boolean;
}

/** One page of the Request_Inbox, with what the rows were computed over. */
export interface RequestPage extends Paged<RequestRow> {
  /** The query the rows were selected by, paging as applied. */
  query: RequestQuery;
  evaluatedAt: string;
  /** The window the requests and the coverage were read over. */
  range: DateRange;
  /** The employees in scope, whether or not they carry a request. */
  employees: AttendanceEmployee[];
  /**
   * Whether the coverage risk indicators carry a value.
   *
   * False when no date in the window could be projected, in which case every
   * row's `coverageRisk` is null and the screen states the indicator is unknown
   * rather than showing it as healthy.
   */
  coverageAvailable: boolean;
}

/** What one employee's submission produced. */
export interface SubmissionResult {
  request: RequestRow;
  /**
   * The shortfall and the short-notice condition, as the composer displays them.
   *
   * Derived here so the composer renders rather than decides (Requirements 11.4,
   * 11.5). Neither condition blocks the submission.
   */
  disclosure: SubmissionDisclosure;
}

/** One coverage assignment, as the administrator submitted it. */
export interface CoverageAssignmentInput {
  /** `YYYY-MM-DD`. Must fall inside the request's own range. */
  date: string;
  coveringProfileId: string;
  /** `HH:MM` or `HH:MM:SS`, in the business calendar the schedule grid uses. */
  shiftStart: string;
  shiftEnd: string;
}

/** What one coverage assignment did. */
export interface CoverageAssignmentResult extends CoverageAssignmentInput {
  scheduleId: string;
  /** Whether a schedule row was created for the date or an existing one amended. */
  outcome: 'created' | 'amended';
}

/** One leave decision, as the drawer submits it. */
export interface DecisionInput {
  requestId: string;
  decision: DecisionOption;
  /** The sub-ranges an `approve_partial` decision approves. */
  approvedRanges?: readonly DateRange[];
  /** The sub-ranges an `approve_partial` decision declines. */
  declinedRanges?: readonly DateRange[];
  /** The dates a `suggest_dates` decision offers instead. */
  suggestedRanges?: readonly DateRange[];
  /** Requirement 10, criterion 8. */
  coverageAssignments?: readonly CoverageAssignmentInput[];
  /** The denial reason, the question, or the reviewer's note. */
  reason?: string | null;
  /** Requirement 10, criterion 10. */
  overrideReason?: string | null;
  /** Requirement 10, criterion 9's second escape. */
  acknowledgedShortfall?: boolean;
  /** Requirement 10, criterion 17. Non-blank. */
  idempotencyKey: string;
  /**
   * The status the administrator saw when the drawer opened.
   *
   * Defaults to the status the service reads, which is the status the deltas were
   * computed against. Either way a non-null value reaches `pto_decide()`, so the
   * comparison that matters happens inside the row lock: if the request moved
   * under the caller, the decision is refused with the current row rather than
   * committed against arithmetic that no longer describes it.
   */
  expectedStatus?: PTOStatus;
}

/** What one committed decision produced. */
export interface DecisionResult {
  /**
   * False for a replayed idempotency key: the decision was already committed and
   * nothing moved a second time (Requirement 10, criterion 17).
   */
  applied: boolean;
  requestId: string;
  decisionId: string | null;
  decision: DecisionOption;
  previousStatus: string | null;
  newStatus: string | null;
  /** The working dates the decision debited or credited, ascending. */
  affectedDates: string[];
  workingDays: number;
  /** The movement the database applied, per calendar year. */
  balanceDeltas: BalanceDelta[];
  /** `pto_balances` for the years the decision touched, as they now stand. */
  balances: PTOBalanceRow[];
  /** The `attendance_audit_log` row `pto_decide()` wrote. */
  auditId: string | null;
  /** The shortfalls the approval was evaluated against, and the escapes that held. */
  guard: ApprovalGuardVerdict;
  coverageAssignments: CoverageAssignmentResult[];
  /**
   * Projected_Coverage for every date the request covers, recomputed after the
   * decision committed (Requirement 10, criterion 12).
   */
  coverage: CoverageResponse;
  /** The request as it now stands. */
  request: RequestRow;
}

// ─── Field readers ───────────────────────────────────────────────────────────

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readNumber(value: unknown): number | null {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
}

/** A stored `date` column, which can arrive as `YYYY-MM-DD` or as a timestamp. */
function readDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 10) return null;
  const candidate = value.slice(0, 10);
  return DATE_PATTERN.test(candidate) ? candidate : null;
}

function readStatus(value: unknown): PTOStatus | null {
  return KNOWN_PTO_STATUSES.includes(value as PTOStatus) ? (value as PTOStatus) : null;
}

/**
 * A stored request type, or null when it is not one the constraint accepts.
 *
 * Null rather than a default. `PTO_TYPE_TO_BALANCE_FIELD` is the only mapping
 * from a type to the balance column a decision moves, and reading an unknown
 * type as `vacation` would debit a column the request has nothing to do with.
 * Requirement 10, criterion 20 is why the set is closed.
 */
function readPtoType(value: unknown): PTOType | null {
  return typeof value === 'string' && Object.hasOwn(PTO_TYPE_TO_BALANCE_FIELD, value)
    ? (value as PTOType)
    : null;
}

function readDecisionOption(value: unknown): DecisionOption | null {
  return DECISION_OPTIONS.includes(value as DecisionOption) ? (value as DecisionOption) : null;
}

/**
 * A stored `jsonb` range array, as the domain's `DateRange[]`.
 *
 * Anything that is not an object carrying two calendar-date bounds is dropped: a
 * malformed entry cannot describe dates, and carrying it through would put a
 * range with a missing bound in front of the arithmetic.
 */
function readRanges(value: unknown): DateRange[] {
  if (!Array.isArray(value)) return [];

  const ranges: DateRange[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const from = readDate((entry as Record<string, unknown>).from);
    const to = readDate((entry as Record<string, unknown>).to);
    if (from === null || to === null) continue;
    ranges.push({ from, to });
  }
  return ranges;
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * A `YYYY-MM-DD` value that names a real date.
 *
 * Two checks, because the shape and the date are different mistakes: `2026-2-3`
 * fails the pattern, and `2026-02-30` matches it while naming no date.
 */
function assertCalendarDate(value: string, field: string): string {
  if (typeof value === 'string' && DATE_PATTERN.test(value)) {
    try {
      return addCalendarDays(value, 0);
    } catch {
      // Matches the shape, names no date. Reported below.
    }
  }

  throw new PTOServiceError(
    'invalid_range',
    `pto: ${field} must be a calendar date as YYYY-MM-DD, received "${String(value)}"`,
    { detail: { field, value: String(value) } },
  );
}

/** Calendar dates in an inclusive range, ascending, refusing an over-wide one. */
function datesBetween(range: DateRange, maxDays: number, field: string): string[] {
  const dates: string[] = [];
  for (let cursor = range.from; cursor <= range.to; cursor = addCalendarDays(cursor, 1)) {
    dates.push(cursor);
    if (dates.length > maxDays) {
      throw new PTOServiceError(
        'invalid_range',
        `pto: ${field} may not span more than ${maxDays} dates`,
        { detail: { field, from: range.from, to: range.to, maxDays: String(maxDays) } },
      );
    }
  }
  return dates;
}

/** A validated inclusive range, ordered and inside the width cap. */
function assertRange(from: string, to: string, maxDays: number, field: string): DateRange {
  const range = {
    from: assertCalendarDate(from, `${field}.from`),
    to: assertCalendarDate(to, `${field}.to`),
  };

  if (range.from > range.to) {
    throw new PTOServiceError('invalid_range', `pto: ${field}.from must not follow ${field}.to`, {
      detail: { field, from: range.from, to: range.to },
    });
  }

  datesBetween(range, maxDays, field);
  return range;
}

/** An ISO instant the domain layer will accept as an evaluation instant. */
function assertInstant(value: string, field: string): string {
  if (Number.isFinite(Date.parse(value))) return value;
  throw new PTOServiceError(
    'invalid_parameter',
    `pto: ${field} must be an ISO instant, received "${String(value)}"`,
    { detail: { field } },
  );
}

function invalidParameter(field: string, message: string): PTOServiceError {
  return new PTOServiceError('invalid_parameter', `pto: ${message}`, { detail: { field } });
}

/** A `time` value the schedule columns accept, normalised to `HH:MM:SS`. */
function assertTime(value: string, field: string): string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw invalidParameter(
      field,
      `${field} must be a time as HH:MM or HH:MM:SS, received "${String(value)}"`,
    );
  }
  return value.length === 5 ? `${value}:00` : value;
}

// ─── Row assembly ────────────────────────────────────────────────────────────

/** Everything one row build needs. Pure input; no client, no clock. */
export interface RequestRowSources {
  evaluatedAt: string;
  policy: AttendancePolicy;
  employees: readonly AttendanceEmployee[];
  requests: readonly PTORequestSourceRow[];
  balances: readonly PTOBalanceSourceRow[];
  decisions: readonly PTODecisionSourceRow[];
  closedDates: ReadonlySet<string>;
  /** The projection behind the coverage risk indicator, or null when none was read. */
  coverage: readonly DateCoverage[] | null;
}

/** The calendar year a `YYYY-MM-DD` date falls in. */
function calendarYearOf(date: string): number {
  return Number(date.slice(0, 4));
}

function toBalanceRow(row: PTOBalanceSourceRow): PTOBalanceRow | null {
  const year = readNumber(row.year);
  if (year === null) return null;
  return {
    year,
    vacation_days: readNumber(row.vacation_days) ?? 0,
    sick_days: readNumber(row.sick_days) ?? 0,
    personal_days: readNumber(row.personal_days) ?? 0,
    vacation_used: readNumber(row.vacation_used) ?? 0,
    sick_used: readNumber(row.sick_used) ?? 0,
    personal_used: readNumber(row.personal_used) ?? 0,
  };
}

function toDecisionSummary(row: PTODecisionSourceRow): RequestDecisionSummary {
  return {
    decisionId: row.id,
    decision: readDecisionOption(row.decision),
    previousStatus: readText(row.previous_status),
    newStatus: readText(row.new_status),
    approvedRanges: readRanges(row.approved_ranges),
    declinedRanges: readRanges(row.declined_ranges),
    suggestedRanges: readRanges(row.suggested_ranges),
    reason: readText(row.reason),
    overrideReason: readText(row.override_reason),
    acknowledgedShortfall: row.acknowledged_shortfall === true,
    actorProfileId: readText(row.actor_profile_id),
    decidedAt: readText(row.created_at),
  };
}

/**
 * One stored row as the domain's `PTORequestRecord`.
 *
 * `submissionDate` is resolved through `workDateOf` in the employee's own
 * timezone rather than by slicing the first ten characters off `created_at`.
 * Slicing is the second work-date convention Appendix A.6 records and Requirement
 * 19, criterion 10 removes, and near midnight the two disagree — which would move
 * a request across the short-notice boundary.
 *
 * Returns null for a row whose type, status, or dates cannot be read. Such a row
 * cannot be costed or decided, and inventing a type for it would debit a column
 * the request has nothing to do with.
 */
function toRequestRecord(
  row: PTORequestSourceRow,
  timezone: string,
): PTORequestRecord | null {
  const ptoType = readPtoType(row.pto_type);
  const status = readStatus(row.status);
  const startDate = readDate(row.start_date);
  const endDate = readDate(row.end_date);
  if (ptoType === null || status === null || startDate === null || endDate === null) return null;

  const submittedAt = readText(row.created_at);
  const submissionInstant = submittedAt === null ? null : new Date(submittedAt);
  const submissionDate =
    submissionInstant !== null && Number.isFinite(submissionInstant.getTime())
      ? workDateOf(submissionInstant, timezone)
      : startDate;

  const workingDays = readNumber(row.working_days);
  const record: PTORequestRecord = {
    id: row.id,
    profileId: row.profile_id,
    ptoType,
    startDate,
    endDate,
    status,
    submittedAt: submittedAt ?? `${submissionDate}T00:00:00.000Z`,
    submissionDate,
    decidedAt: readText(row.reviewed_at),
    reason: readText(row.reason),
  };

  // Both stored columns are optional on the record, and a row predating them
  // recomputes rather than reporting a default. Correctness Property 18 is what
  // makes the recomputed count the same number.
  if (workingDays !== null) record.workingDays = workingDays;
  if (typeof row.short_notice === 'boolean') record.shortNotice = row.short_notice;

  return record;
}

/**
 * The stored rows as `RequestRow`s.
 *
 * Every derived field comes from the domain layer: the working days, the
 * remaining balance, the coverage risk, and the elapsed figure all from
 * `buildRequestRow`, and the cancel eligibility from `canCancelRequest`. This
 * function resolves references and nothing else, which is why an inbox row and
 * the calendar cell beside it cannot disagree.
 *
 * A row whose employee is not in scope, or whose type or status cannot be read, is
 * dropped rather than rendered with invented values. The Exception_Queue is where
 * malformed stored data is reported; an inbox that guessed would hide the problem.
 *
 * Requirements: 7.4, 7.5, 7.9, 11.2, 11.6, 11.7, 11.8
 */
export function buildRequestRows(actor: Actor, sources: RequestRowSources): RequestRow[] {
  const employees = new Map(
    sources.employees.map<[string, AttendanceEmployee]>((row) => [row.profileId, row]),
  );

  const balancesByProfileYear = new Map<string, PTOBalanceRow>();
  for (const row of sources.balances) {
    const balance = toBalanceRow(row);
    if (balance !== null) {
      balancesByProfileYear.set(`${row.profile_id}:${balance.year}`, balance);
    }
  }

  const decisionsByRequest = new Map<string, RequestDecisionSummary[]>();
  for (const row of sources.decisions) {
    const list = decisionsByRequest.get(row.request_id);
    const summary = toDecisionSummary(row);
    if (list === undefined) decisionsByRequest.set(row.request_id, [summary]);
    else list.push(summary);
  }
  for (const list of decisionsByRequest.values()) {
    // Newest first, then by identifier so the order is total and does not depend
    // on the order the rows were returned in.
    list.sort((a, b) => {
      const left = a.decidedAt ?? '';
      const right = b.decidedAt ?? '';
      if (left !== right) return left < right ? 1 : -1;
      return a.decisionId < b.decisionId ? 1 : a.decisionId > b.decisionId ? -1 : 0;
    });
  }

  const rows: RequestRow[] = [];
  for (const row of sources.requests) {
    const employee = employees.get(row.profile_id);
    if (employee === undefined) continue;

    const record = toRequestRecord(row, employee.timezone);
    if (record === null) continue;

    const balance =
      balancesByProfileYear.get(`${row.profile_id}:${calendarYearOf(record.startDate)}`) ?? null;

    const inbox = buildRequestRow({
      request: record,
      subject: {
        profileId: employee.profileId,
        employeeName: employee.displayName,
        department: employee.department,
      },
      balance,
      ...(sources.coverage === null ? {} : { coverage: sources.coverage }),
      evaluatedAt: sources.evaluatedAt,
      closedDates: sources.closedDates,
    });

    const decisions = decisionsByRequest.get(row.id) ?? [];
    const latestReason = decisions.find((entry) => entry.reason !== null)?.reason ?? null;

    rows.push({
      ...inbox,
      totalDays: readNumber(row.total_days),
      reason: readText(row.reason),
      reviewedBy: readText(row.reviewed_by),
      reviewedAt: readText(row.reviewed_at),
      reviewerResponse: latestReason ?? readText(row.denial_reason),
      decisions,
      cancellable: row.profile_id === actor.id && canCancelRequest(record.status),
    });
  }

  return rows;
}

/** The stored state of a request, for a conflict payload. */
function toRequestState(row: PTORequestSourceRow): RequestState {
  return {
    requestId: row.id,
    profileId: row.profile_id,
    ptoType: readPtoType(row.pto_type),
    status: readStatus(row.status),
    startDate: readDate(row.start_date),
    endDate: readDate(row.end_date),
    workingDays: readNumber(row.working_days),
    shortNotice: row.short_notice === true,
    reviewedBy: readText(row.reviewed_by),
    reviewedAt: readText(row.reviewed_at),
  };
}

/** `pto_decide()`'s own `current` object, in the same shape. */
function toRequestStateFromEnvelope(requestId: string, current: unknown): RequestState {
  if (typeof current !== 'object' || current === null) {
    return {
      requestId,
      profileId: null,
      ptoType: null,
      status: null,
      startDate: null,
      endDate: null,
      workingDays: null,
      shortNotice: false,
      reviewedBy: null,
      reviewedAt: null,
    };
  }

  const source = current as Record<string, unknown>;
  return toRequestState({
    id: readText(source.request_id) ?? requestId,
    profile_id: readText(source.profile_id) ?? '',
    pto_type: source.pto_type,
    start_date: readDate(source.start_date) ?? '',
    end_date: readDate(source.end_date) ?? '',
    working_days: source.working_days,
    short_notice: source.short_notice,
    status: source.status,
    reviewed_by: source.reviewed_by,
    reviewed_at: source.reviewed_at,
  });
}

// ─── Reads ───────────────────────────────────────────────────────────────────

type ProfileScope = string[] | 'all';

async function readProfiles(
  client: AttendanceClient,
  scope: ProfileScope,
  policy: AttendancePolicy,
): Promise<AttendanceEmployee[]> {
  let query = client
    .from('profiles')
    .select('id, display_name, initials, role, timezone, is_active');
  if (scope !== 'all') query = query.in('id', scope);

  return rowsOf<ProfileRow>('profiles', await query).map((row) =>
    toAttendanceEmployee(row, policy),
  );
}

/**
 * Requests whose dates overlap the window.
 *
 * Overlap, not containment: a request running across the edge of the displayed
 * range is still a request on the dates in view, and hiding it would be the
 * surest way to double-book one of them.
 */
async function readRequests(
  client: AttendanceClient,
  scope: ProfileScope,
  range: DateRange,
): Promise<PTORequestSourceRow[]> {
  let query = client
    .from('pto_requests')
    .select(REQUEST_COLUMNS)
    .lte('start_date', range.to)
    .gte('end_date', range.from);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<PTORequestSourceRow>('pto_requests', await query);
}

async function readRequestById(
  client: AttendanceClient,
  requestId: string,
): Promise<PTORequestSourceRow | null> {
  return singleOf<PTORequestSourceRow>(
    'pto_requests',
    await client.from('pto_requests').select(REQUEST_COLUMNS).eq('id', requestId).maybeSingle(),
  );
}

async function readBalances(
  client: AttendanceClient,
  scope: ProfileScope,
  years: readonly number[],
): Promise<PTOBalanceSourceRow[]> {
  let query = client.from('pto_balances').select(BALANCE_COLUMNS).in('year', years);
  if (scope !== 'all') query = query.in('profile_id', scope);

  return rowsOf<PTOBalanceSourceRow>('pto_balances', await query);
}

async function readDecisions(
  client: AttendanceClient,
  requestIds: readonly string[],
): Promise<PTODecisionSourceRow[]> {
  return rowsOf<PTODecisionSourceRow>(
    'pto_request_decisions',
    await client.from('pto_request_decisions').select(DECISION_COLUMNS).in('request_id', requestIds),
  );
}

/**
 * The decision already recorded under one idempotency key, or null.
 *
 * Read before anything is computed, because a replay is not a stale view. A
 * browser retrying a decision whose response was lost sends the status it last
 * saw — `pending` — while the request now holds the status the first attempt
 * committed. Comparing the two would answer a conflict when the honest answer is
 * that the decision is already in place and nothing needs to happen twice
 * (Requirement 10, criterion 17).
 *
 * `unique (request_id, idempotency_key)` is what makes this lookup exact, and
 * `pto_decide()` performs the same lookup inside the row lock, so a replay
 * arriving between this read and that one is still recognised.
 */
async function readDecisionByKey(
  client: AttendanceClient,
  requestId: string,
  idempotencyKey: string,
): Promise<PTODecisionSourceRow | null> {
  return singleOf<PTODecisionSourceRow>(
    'pto_request_decisions',
    await client
      .from('pto_request_decisions')
      .select(DECISION_COLUMNS)
      .eq('request_id', requestId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle(),
  );
}

/**
 * The dates the organisation is closed, inside the range.
 *
 * The working-day count excludes them, so this read is what makes the count the
 * server computes the same count `pto_decide()` recomputes inside its lock.
 */
async function readClosedDates(
  client: AttendanceClient,
  range: DateRange,
): Promise<ReadonlySet<string>> {
  const rows = rowsOf<ClosedDateSourceRow>(
    'attendance_closed_dates',
    await client
      .from('attendance_closed_dates')
      .select('closed_date')
      .gte('closed_date', range.from)
      .lte('closed_date', range.to),
  );

  const dates = new Set<string>();
  for (const row of rows) {
    const date = readDate(row.closed_date);
    if (date !== null) dates.add(date);
  }
  return dates;
}

/**
 * The balance movements already recorded against one request, per calendar year.
 *
 * This is what makes the movement `decide` proposes the *difference* rather than
 * the debit: approving a pending request has nothing recorded and moves + W,
 * denying a request that was approved has + W recorded and moves − W, and
 * re-approving a narrower range moves the difference. `pto_decide()` computes the
 * same figure from the same table inside its lock and refuses the call if the two
 * disagree, so this read is a proposal rather than an instruction.
 *
 * The ledger is administrator-readable only, which is the only caller `decide`
 * has.
 *
 * Requirements: 10.13, 10.14, 10.17
 */
async function readLedgerByYear(
  client: AttendanceClient,
  requestId: string,
  balanceField: BalanceField,
): Promise<Map<number, number>> {
  const rows = rowsOf<PTOLedgerSourceRow>(
    'pto_balance_ledger',
    await client
      .from('pto_balance_ledger')
      .select('year, balance_field, delta_days')
      .eq('request_id', requestId)
      .eq('balance_field', balanceField),
  );

  const byYear = new Map<number, number>();
  for (const row of rows) {
    const year = readNumber(row.year);
    const delta = readNumber(row.delta_days);
    if (year === null || delta === null) continue;
    byYear.set(year, (byYear.get(year) ?? 0) + delta);
  }
  return byYear;
}

/** Both configuration reads, unless the caller already has them. */
async function resolveConfig(
  context: PTOContext,
): Promise<{ policy: AttendancePolicy; thresholds: StaffingThresholdTable }> {
  const [policy, thresholds] = await Promise.all([
    context.policy ?? loadAttendancePolicy(context.client),
    context.thresholds ?? loadStaffingThresholds(context.client),
  ]);
  return { policy, thresholds };
}

/** The calendar years an inclusive range touches, ascending. */
function yearsIn(range: DateRange): number[] {
  const first = calendarYearOf(range.from);
  const last = calendarYearOf(range.to);
  const years: number[] = [];
  for (let year = first; year <= last; year += 1) years.push(year);
  return years;
}

// ─── Coverage ────────────────────────────────────────────────────────────────

/** The computed per-date projections in a coverage response. */
function projectionsOf(coverage: CoverageResponse): DateCoverage[] {
  return coverage.dates.filter(isComputedCoverageDate).map((date) => date.projection);
}

/**
 * Projected_Coverage for a range, through the one read every coverage surface
 * uses.
 *
 * `getCoverage` is called rather than reimplemented, which is what makes the
 * figure the inbox shows, the figure the calendar shows, the figure the guard
 * blocks on, and the figure a decision returns the same four figures.
 */
async function projectRange(
  actor: Actor,
  range: DateRange,
  context: PTOContext,
  evaluatedAt: string,
  policy: AttendancePolicy,
  thresholds: StaffingThresholdTable,
  proposedAbsence?: { profileId: string; ranges: readonly DateRange[] },
): Promise<CoverageResponse> {
  return getCoverage(
    actor,
    {
      from: range.from,
      to: range.to,
      mode: 'projected',
      ...(proposedAbsence === undefined ? {} : { proposedAbsence }),
    },
    { client: context.client, evaluatedAt, policy, thresholds },
  );
}

// ─── listRequests ────────────────────────────────────────────────────────────

/**
 * The window an inbox read honours.
 *
 * The caller's range when it names one, and a bounded fallback otherwise. Reading
 * the whole table would answer a bare call correctly today and grow without limit;
 * the screen supplies the range it is displaying, so the fallback only has to be
 * sensible rather than complete.
 */
function resolveWindow(
  query: RequestQuery,
  evaluatedAt: string,
  policy: AttendancePolicy,
): DateRange {
  const today = workDateOf(new Date(evaluatedAt), policy.businessTimezone);
  const from = query.from ?? addCalendarDays(today, -DEFAULT_INBOX_LOOKBACK_DAYS);
  const to = query.to ?? addCalendarDays(today, DEFAULT_INBOX_LOOKAHEAD_DAYS);
  return assertRange(from, to, MAX_RANGE_DAYS, 'range');
}

/**
 * The query's filters without its paging.
 *
 * Exported because the Export_Service takes a `RequestQuery` from the requesting
 * view and reads it whole: paging is what an export removes, and removing it in
 * one place keeps the two callers from disagreeing about which fields count as
 * paging.
 */
export function withoutRequestPaging(query: RequestQuery): RequestQuery {
  const filters: RequestQuery = { ...query };
  delete filters.page;
  delete filters.limit;
  return filters;
}

/**
 * Every request a query matches, in the inbox's order, unpaged.
 *
 * Eleven queries for an administrator: the two configuration reads, the five source
 * reads, and the projected coverage read's four. Seven for an employee, who has no
 * coverage risk column to fill. The count does not move with the roster size or the
 * number of requests, which is what lets the whole inbox load in one request — and
 * what makes reading the whole match cost what reading one page of it costs.
 *
 * Scope comes from `visibleProfileIds`, so a non-administrator sees only their own
 * requests (Requirement 7, criterion 11) without the inbox holding a rule of its
 * own about it.
 *
 * Filtering and ordering are the domain's, through `filterRequestRows` and
 * `orderRequestRows`: pending before decided, then oldest first (Requirement 7,
 * criteria 6 through 8). `listRequests` is this read plus a page and the
 * Export_Service is this read without one, so the exported rows are the inbox's
 * rows in the inbox's order (Requirement 15, criteria 2 and 3).
 *
 * Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.11, 11.6, 11.7, 11.8, 15.2,
 * 15.3, 21.1, 21.2
 */
export async function listAllRequests(
  actor: Actor,
  q: RequestQuery,
  context: PTOContext,
): Promise<RequestSet> {
  const evaluatedAt = assertInstant(
    context.evaluatedAt ?? new Date().toISOString(),
    'evaluatedAt',
  );
  const scope = await visibleProfileIds(actor);
  const { policy, thresholds } = await resolveConfig(context);
  const range = resolveWindow(q, evaluatedAt, policy);

  const [employees, requests, balances, closedDates] = await Promise.all([
    readProfiles(context.client, scope, policy),
    readRequests(context.client, scope, range),
    readBalances(context.client, scope, yearsIn(range)),
    readClosedDates(context.client, range),
  ]);

  // Issued whatever the request set holds, so the outbound query count stays a
  // property of the call rather than of the data.
  const decisions = await readDecisions(
    context.client,
    requests.map((row) => row.id),
  );

  // The coverage risk indicator is the administrator's column. A non-administrator's
  // visibility is their own row, so projecting for them would compute staffing over
  // a roster of one and label it a coverage status — a definite claim from data that
  // cannot support it. Their rows report the risk as unknown instead, which the
  // domain already expresses as null.
  const projections = canAdministerAttendance(actor.role)
    ? projectionsOf(
        await projectRange(actor, range, context, evaluatedAt, policy, thresholds),
      )
    : null;

  const rows = buildRequestRows(actor, {
    evaluatedAt,
    policy,
    employees,
    requests,
    balances,
    decisions,
    closedDates,
    coverage: projections,
  });

  // The domain owns filtering and ordering. The rows come back through a lookup
  // rather than a cast, so the result carries the full `RequestRow` the screen
  // needs while the order is still the domain's decision.
  const byId = new Map(rows.map((row) => [row.requestId, row]));
  const matched = orderRequestRows(filterRequestRows(rows, q))
    .map((row) => byId.get(row.requestId))
    .filter((row): row is RequestRow => row !== undefined);

  return {
    rows: matched,
    query: withoutRequestPaging(q),
    evaluatedAt,
    range,
    employees: sortEmployees(employees),
    coverageAvailable: projections !== null && projections.length > 0,
  };
}

/**
 * One page of the Request_Inbox.
 *
 * The whole match from `listAllRequests`, sliced. The page cap of fifty is the
 * domain's `requestPageLimit`, applied here rather than trusted from the query
 * (Requirement 7, criterion 12), and the returned `query` carries the paging that
 * was applied, so a caller replaying it gets the page it was shown.
 *
 * A page number beyond the last page yields no rows rather than the last page,
 * because silently answering a different page than the one asked for would make a
 * paging control lie about where it is.
 *
 * Requirements: 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.11, 7.12, 11.6, 11.7, 11.8,
 * 21.1, 21.2
 */
export async function listRequests(
  actor: Actor,
  q: RequestQuery,
  context: PTOContext,
): Promise<RequestPage> {
  const set = await listAllRequests(actor, q, context);

  const limit = requestPageLimit(q.limit);
  const page =
    typeof q.page === 'number' && Number.isFinite(q.page) ? Math.max(1, Math.floor(q.page)) : 1;

  const start = (page - 1) * limit;
  const rows = set.rows.slice(start, start + limit);

  return {
    rows,
    page,
    limit,
    total: set.rows.length,
    hasMore: start + rows.length < set.rows.length,
    query: { ...set.query, page, limit },
    evaluatedAt: set.evaluatedAt,
    range: set.range,
    employees: set.employees,
    coverageAvailable: set.coverageAvailable,
  };
}

function sortEmployees(employees: readonly AttendanceEmployee[]): AttendanceEmployee[] {
  return [...employees].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.profileId.localeCompare(b.profileId),
  );
}

// ─── One request, rebuilt ────────────────────────────────────────────────────

/**
 * One stored request as a `RequestRow`.
 *
 * Four reads: the requester's profile, their balance for the years the request
 * touches, the closed dates over its range, and the decisions committed against
 * it. Used by the three mutation paths to answer with the row as it now stands,
 * so a screen replaces the affected row from the response rather than reloading
 * the inbox.
 *
 * `coverage` is the projection to read the risk indicator from, or null. A
 * submission and a cancellation pass null: the coverage risk column belongs to the
 * administrator's inbox, and reading it for an employee whose visibility is their
 * own row would report a projection over a roster of one.
 */
async function rebuildRequestRow(
  actor: Actor,
  row: PTORequestSourceRow,
  context: PTOContext,
  evaluatedAt: string,
  policy: AttendancePolicy,
  coverage: readonly DateCoverage[] | null,
): Promise<RequestRow> {
  const range: DateRange = {
    from: readDate(row.start_date) ?? readDate(row.end_date) ?? '1970-01-01',
    to: readDate(row.end_date) ?? readDate(row.start_date) ?? '1970-01-01',
  };

  const [employees, balances, closedDates, decisions] = await Promise.all([
    readProfiles(context.client, [row.profile_id], policy),
    readBalances(context.client, [row.profile_id], yearsIn(range)),
    readClosedDates(context.client, range),
    readDecisions(context.client, [row.id]),
  ]);

  const rows = buildRequestRows(actor, {
    evaluatedAt,
    policy,
    employees,
    requests: [row],
    balances,
    decisions,
    closedDates,
    coverage,
  });

  const built = rows[0];
  if (built === undefined) {
    throw new PTOServiceError(
      'read_failed',
      'pto: that request could not be read as a usable row',
      { detail: { requestId: row.id } },
    );
  }
  return built;
}

// ─── submitRequest ───────────────────────────────────────────────────────────

/** What an employee is asking for. */
export interface SubmissionInput {
  ptoType: PTOType;
  /** `YYYY-MM-DD`, inclusive. */
  startDate: string;
  /** `YYYY-MM-DD`, inclusive. */
  endDate: string;
  reason?: string | null;
}

/**
 * Submit one time-off request for the signed-in employee.
 *
 * The working-day count and the short-notice condition are computed here, on the
 * server, from `countWorkingDays` and the stored closed dates, and both are
 * stored on the row (Requirement 11, criteria 2 and 5). Nothing about either is
 * read from the caller, which is what makes the figure the employee was shown at
 * submission the figure a decision debits (Correctness Property 18).
 *
 * The request belongs to the signed-in employee. `pto_requests_insert` says the
 * same thing underneath — `with check (profile_id = auth.uid())` — so submitting
 * on somebody else's behalf is refused by the database as well as unsupported
 * here. An administrator recording leave for an employee is a decision path, not
 * a submission path.
 *
 * Neither a shortfall nor short notice blocks the submission. Requirement 11,
 * criterion 4 is explicit that a request exceeding the balance is allowed with the
 * shortfall disclosed, and criterion 5 records the short-notice condition rather
 * than refusing it. A range covering only weekends and closed dates is accepted
 * too, and stored as the zero working days it costs.
 *
 * `total_days` is written with the same computed count. The column is `not null`
 * and is what payroll's legacy-parity arithmetic reads, and the inherited path
 * took it from the request body — which is exactly the figure this function
 * exists to stop trusting.
 *
 * Requirements: 11.1, 11.2, 11.4, 11.5, 10.20, 21.1
 */
export async function submitRequest(
  actor: Actor,
  input: SubmissionInput,
  context: PTOContext,
): Promise<SubmissionResult> {
  const evaluatedAt = assertInstant(
    context.evaluatedAt ?? new Date().toISOString(),
    'evaluatedAt',
  );

  const ptoType = readPtoType(input.ptoType);
  if (ptoType === null) {
    throw invalidParameter(
      'ptoType',
      `"${String(input.ptoType)}" is not a request type this organisation accepts`,
    );
  }

  const range = assertRange(
    input.startDate,
    input.endDate,
    MAX_REQUEST_SPAN_DAYS,
    'range',
  );

  const policy = context.policy ?? (await loadAttendancePolicy(context.client));

  const [employees, balances, closedDates] = await Promise.all([
    readProfiles(context.client, [actor.id], policy),
    readBalances(context.client, [actor.id], yearsIn(range)),
    readClosedDates(context.client, range),
  ]);

  const employee = employees.find((candidate) => candidate.profileId === actor.id);
  if (employee === undefined) {
    throw new PTOServiceError(
      'not_authorised',
      'pto: your profile could not be read, so a request cannot be submitted for you',
      { detail: { profileId: actor.id } },
    );
  }

  const startYear = calendarYearOf(range.from);
  const balance =
    balances
      .map(toBalanceRow)
      .find((row): row is PTOBalanceRow => row !== null && row.year === startYear) ?? null;

  const disclosure = buildSubmissionDisclosure({
    ptoType,
    range,
    remainingBalance: remainingBalanceFor(balance, ptoType),
    submissionDate: workDateOf(new Date(evaluatedAt), employee.timezone),
    closedDates,
  });

  const inserted = singleOf<PTORequestSourceRow>(
    'pto_requests',
    await context.client
      .from('pto_requests')
      .insert({
        profile_id: actor.id,
        pto_type: ptoType,
        start_date: range.from,
        end_date: range.to,
        total_days: disclosure.workingDays,
        working_days: disclosure.workingDays,
        short_notice: disclosure.shortNotice,
        reason: reasonWithContent(input.reason),
        status: 'pending',
      })
      .select(REQUEST_COLUMNS)
      .single(),
  );

  if (inserted === null) {
    throw new PTOServiceError('write_failed', 'pto: the request was not stored', {
      detail: { profileId: actor.id },
    });
  }

  return {
    request: await rebuildRequestRow(actor, inserted, context, evaluatedAt, policy, null),
    disclosure,
  };
}

// ─── cancelOwnRequest ────────────────────────────────────────────────────────

/**
 * Withdraw one of the signed-in employee's own requests.
 *
 * Eligible exactly for `pending` and `waitlisted`, which is `canCancelRequest` in
 * the domain layer and therefore the same rule the composer used to decide whether
 * to offer the action (Correctness Property 25). Every other status is refused
 * with the current row, including `approved` and `denied`, which Requirement 11,
 * criterion 10 names, and `cancelled`, which has nothing left to withdraw.
 *
 * Neither eligible status has ever moved a balance — `pending` was never debited
 * and a waitlisting leaves the balance unchanged — so no credit is needed here and
 * the ledger stays the decision path's to reconcile. That is also why cancellation
 * does not go through `pto_decide()`: it is the employee's own act, not a decision
 * about their request.
 *
 * The status test is applied twice. Once against the row that was read, so the
 * refusal can name what the request now holds, and once inside the update itself,
 * as `in ('pending', 'waitlisted')` on the same statement that sets `cancelled` —
 * which is what makes the check atomic without a lock. A concurrent decision
 * therefore either lands first and the cancellation matches no row, or lands
 * second and finds the request already cancelled.
 *
 * The actor and the timestamp are recorded on the request row itself. There is no
 * audit entry: `attendance_audit_log` is administrator-insert-only by design
 * (v1.9.0), and Requirement 10, criterion 11 asks for an audit entry on a
 * *decision*, which this is not.
 *
 * Requirements: 11.8, 11.9, 11.10, 21.1
 */
export async function cancelOwnRequest(
  actor: Actor,
  requestId: string,
  context: PTOContext,
): Promise<RequestRow> {
  const evaluatedAt = assertInstant(
    context.evaluatedAt ?? new Date().toISOString(),
    'evaluatedAt',
  );
  const policy = context.policy ?? (await loadAttendancePolicy(context.client));

  const existing = await readRequestById(context.client, requestId);

  // A request the caller may not see and a request that does not exist are
  // refused identically. Row level security answers an unpermitted read with no
  // rows, so the two are indistinguishable here, and a refusal that named the
  // difference would confirm the existence of a record the caller may not read.
  if (existing === null) {
    throw new PTOServiceError('not_visible', 'pto: that request is not available to you', {
      detail: { requestId },
    });
  }

  if (existing.profile_id !== actor.id) {
    throw new PTOServiceError(
      'not_authorised',
      'pto: only the employee who submitted a request may withdraw it',
      { detail: { requestId } },
    );
  }

  const status = readStatus(existing.status);
  if (status === null || !canCancelRequest(status)) {
    throw new PTOServiceError(
      'stale_request_state',
      `pto: a request with status ${status ?? 'unknown'} can no longer be withdrawn`,
      { current: toRequestState(existing) },
    );
  }

  const updated = rowsOf<PTORequestSourceRow>(
    'pto_requests',
    await context.client
      .from('pto_requests')
      .update({
        status: 'cancelled',
        reviewed_by: actor.id,
        reviewed_at: evaluatedAt,
      })
      .eq('id', requestId)
      .eq('profile_id', actor.id)
      .in('status', CANCELLABLE_STATUSES)
      .select(REQUEST_COLUMNS),
  );

  const cancelled = updated[0];
  if (cancelled === undefined) {
    // Nothing matched. Either the request moved between the read and the write, or
    // row level security refused a write the rules permit. Re-reading is what tells
    // the two apart, and they are different answers: one asks the caller to look
    // again, the other says the rule and the policy disagree.
    const current = await readRequestById(context.client, requestId);
    const currentStatus = current === null ? null : readStatus(current.status);

    if (current !== null && currentStatus !== null && canCancelRequest(currentStatus)) {
      throw new PTOServiceError('write_failed', CANCEL_REFUSED_BY_POLICY, {
        detail: { requestId, status: currentStatus },
      });
    }

    throw new PTOServiceError(
      'stale_request_state',
      `pto: a request with status ${currentStatus ?? 'unknown'} can no longer be withdrawn`,
      { current: current === null ? { requestId } : toRequestState(current) },
    );
  }

  return rebuildRequestRow(actor, cancelled, context, evaluatedAt, policy, null);
}

// ─── decide ──────────────────────────────────────────────────────────────────

/**
 * The balance movement one decision implies, per calendar year.
 *
 * The movement, not the debit: the working days the approved ranges cover, less
 * everything already recorded in the ledger for this request. Approving a pending
 * request gives + W (Requirement 10, criterion 13); denying a request that was
 * approved gives − W, which is criterion 14's credit from the same expression
 * rather than from a second reversal rule that could disagree with it; approving a
 * narrower range after a wider one gives the difference.
 *
 * Only an approving decision and `deny` reconcile. Requirement 10, criteria 5, 6,
 * and 7 leave the balance unchanged for suggest-dates, waitlist, and
 * request-information, and `assign_coverage` does not decide the request at all,
 * so those four move nothing whatever the ledger holds.
 *
 * The per-year attribution is `workingDaysByYear`, so each date lands in the
 * calendar year containing it rather than in the year the decision was taken
 * (criteria 15 and 16).
 *
 * Requirements: 10.13, 10.14, 10.15, 10.16
 */
export function decisionMovement(
  decision: DecisionOption,
  balanceField: BalanceField,
  approvedRanges: readonly DateRange[],
  closedDates: ReadonlySet<string>,
  priorByYear: ReadonlyMap<number, number>,
): BalanceDelta[] {
  const reconciles = decisionApproves(decision) || decision === 'deny';
  if (!reconciles) return [];

  const targetByYear = workingDaysByYear(approvedRanges, closedDates);

  const years = new Set<number>([...targetByYear.keys(), ...priorByYear.keys()]);
  const deltas: BalanceDelta[] = [];
  for (const year of [...years].sort((a, b) => a - b)) {
    const deltaDays = (targetByYear.get(year) ?? 0) - (priorByYear.get(year) ?? 0);
    // A year whose movement is nothing produces no delta at all. The ledger's
    // unique key is per year and field, and a movement of zero is not a movement.
    if (deltaDays !== 0) deltas.push({ year, balanceField, deltaDays });
  }
  return deltas;
}

/** The reason and payload rules the requirements make mandatory. */
function assertDecisionPayload(
  decision: DecisionOption,
  input: DecisionInput,
  approvedRanges: readonly DateRange[],
): void {
  const reason = reasonWithContent(input.reason);

  // Requirement 10, criterion 3.
  if (decision === 'deny' && reason === null) {
    throw new PTOServiceError(
      'reason_required',
      'pto: a denial carries a reason of at least one non-whitespace character',
      { detail: { field: 'reason' } },
    );
  }

  // Requirement 10, criterion 7: the question is the payload that distinguishes
  // requesting information from suggesting dates.
  if (decision === 'request_info' && reason === null) {
    throw new PTOServiceError(
      'reason_required',
      'pto: requesting additional information carries the question',
      { detail: { field: 'reason' } },
    );
  }

  // Requirement 10, criterion 5.
  if (decision === 'suggest_dates' && (input.suggestedRanges ?? []).length === 0) {
    throw invalidParameter(
      'suggestedRanges',
      'suggesting different dates carries the suggested range',
    );
  }

  // Requirement 10, criterion 4: a partial approval records both halves.
  if (decision === 'approve_partial') {
    if (approvedRanges.length === 0) {
      throw invalidParameter('approvedRanges', 'approving part of a request records what was approved');
    }
    if ((input.declinedRanges ?? []).length === 0) {
      throw invalidParameter('declinedRanges', 'approving part of a request records what was declined');
    }
  }

  // Requirement 10, criterion 8: an assignment decision has to assign something.
  if (decision === 'assign_coverage' && (input.coverageAssignments ?? []).length === 0) {
    throw invalidParameter(
      'coverageAssignments',
      'assigning coverage carries at least one assignment',
    );
  }
}

/**
 * Create or amend the covering employee's schedule row for each assigned date,
 * and link it to the request.
 *
 * Requirement 10, criterion 8. A date the covering employee already has a shift
 * on is amended in place rather than duplicated — `unique_schedule_per_person_day`
 * would refuse a second row anyway — and `created_by` is left as it was, because
 * amending a shift does not make the amender its author. A date they have no shift
 * on gets a published row.
 *
 * Every assignment is checked against the request first: the date has to fall
 * inside the requested range, and the covering employee cannot be the requester.
 * Covering an absence with the absent employee is not coverage, and assigning a
 * date the request does not cover is not this request's business.
 *
 * The loop issues one statement per assignment, which is bounded by the list the
 * administrator submitted rather than by the roster or the range — the thing
 * Requirement 20, criteria 1 and 2 rule out for reads.
 */
async function applyCoverageAssignments(
  actor: Actor,
  request: PTORequestSourceRow,
  requestRange: DateRange,
  assignments: readonly CoverageAssignmentInput[],
  context: PTOContext,
): Promise<CoverageAssignmentResult[]> {
  if (assignments.length === 0) return [];

  const checked = assignments.map((assignment) => {
    const date = assertCalendarDate(assignment.date, 'coverageAssignments.date');
    if (date < requestRange.from || date > requestRange.to) {
      throw invalidParameter(
        'coverageAssignments.date',
        `coverage may only be assigned for a requested date; ${date} is outside ` +
          `${requestRange.from} .. ${requestRange.to}`,
      );
    }
    if (assignment.coveringProfileId === request.profile_id) {
      throw invalidParameter(
        'coverageAssignments.coveringProfileId',
        'the employee requesting the absence cannot cover it',
      );
    }
    return {
      date,
      coveringProfileId: assignment.coveringProfileId,
      shiftStart: assertTime(assignment.shiftStart, 'coverageAssignments.shiftStart'),
      shiftEnd: assertTime(assignment.shiftEnd, 'coverageAssignments.shiftEnd'),
    };
  });

  const coveringIds = [...new Set(checked.map((entry) => entry.coveringProfileId))];

  // The covering employees have to exist. The schedule row's foreign key says the
  // same thing, but it says it as a write failure the caller is invited to retry;
  // named here it is the invalid parameter it actually is.
  const covering = rowsOf<{ id: string }>(
    'profiles',
    await context.client.from('profiles').select('id').in('id', coveringIds),
  );
  const known = new Set(covering.map((row) => row.id));
  for (const profileId of coveringIds) {
    if (!known.has(profileId)) {
      throw invalidParameter(
        'coverageAssignments.coveringProfileId',
        `"${profileId}" names no employee`,
      );
    }
  }

  const existing = rowsOf<ScheduleSourceRow>(
    'employee_schedules',
    await context.client
      .from('employee_schedules')
      .select('id, profile_id, schedule_date')
      .in('profile_id', coveringIds)
      .in(
        'schedule_date',
        [...new Set(checked.map((entry) => entry.date))],
      ),
  );

  const existingByKey = new Map<string, string>();
  for (const row of existing) {
    const date = readDate(row.schedule_date);
    if (date !== null) existingByKey.set(`${row.profile_id}:${date}`, row.id);
  }

  const results: CoverageAssignmentResult[] = [];
  for (const entry of checked) {
    const scheduleId = existingByKey.get(`${entry.coveringProfileId}:${entry.date}`);

    const shift = {
      shift_start: entry.shiftStart,
      shift_end: entry.shiftEnd,
      shift_type: COVERAGE_SHIFT_TYPE,
      status: COVERAGE_SCHEDULE_STATUS,
      coverage_for_request_id: request.id,
    };

    const written =
      scheduleId === undefined
        ? singleOf<ScheduleSourceRow>(
            'employee_schedules',
            await context.client
              .from('employee_schedules')
              .insert({
                profile_id: entry.coveringProfileId,
                schedule_date: entry.date,
                created_by: actor.id,
                ...shift,
              })
              .select('id, profile_id, schedule_date')
              .single(),
          )
        : singleOf<ScheduleSourceRow>(
            'employee_schedules',
            await context.client
              .from('employee_schedules')
              .update(shift)
              .eq('id', scheduleId)
              .select('id, profile_id, schedule_date')
              .single(),
          );

    if (written === null) {
      throw new PTOServiceError(
        'write_failed',
        `pto: the covering shift for ${entry.date} could not be stored`,
        { detail: { date: entry.date, coveringProfileId: entry.coveringProfileId } },
      );
    }

    results.push({
      ...entry,
      scheduleId: written.id,
      outcome: scheduleId === undefined ? 'created' : 'amended',
    });
  }

  return results;
}

/**
 * The shortfalls an approval would create across the dates it approves.
 *
 * Read from the Coverage_Status the projection already assigned rather than from a
 * comparison of this module's own, so the guard cannot disagree with the figures
 * the Approval_Impact_Preview displayed. Both a whole-date shortfall and a
 * Coverage_Interval shortfall block, because Requirement 10, criterion 9 names
 * both: a date can be adequately staffed across the day while an hour inside it is
 * short, and an approval that creates that hole is the one the guard exists to
 * catch.
 *
 * Every calendar date the approved ranges cover is considered, not only the working
 * days. A weekend date costs no balance and can still carry a published shift the
 * absence would vacate.
 *
 * Requirements: 10.9
 */
function shortfallsForApproval(
  coverage: CoverageResponse,
  approvedDates: ReadonlySet<string>,
): CoverageShortfall[] {
  const dates = coverage.dates
    .filter(isComputedCoverageDate)
    .filter((date) => approvedDates.has(date.workDate))
    .map((date) => ({ coverage: date.projection, intervals: date.intervals }));

  return collectShortfalls(dates);
}

/** The envelope `pto_decide()` returns, as far as the service reads it. */
interface DecideEnvelope {
  ok?: unknown;
  applied?: unknown;
  code?: unknown;
  error?: unknown;
  current?: unknown;
  request_id?: unknown;
  decision_id?: unknown;
  decision?: unknown;
  previous_status?: unknown;
  new_status?: unknown;
  affected_dates?: unknown;
  working_days?: unknown;
  balance_deltas?: unknown;
  balances?: unknown;
  audit_id?: unknown;
}

/** The failure a raised `pto_decide()` describes, by its `CODE:` prefix. */
function rpcFailure(requestId: string, message: string): PTOServiceError {
  const prefix = message.slice(0, Math.max(0, message.indexOf(':')));
  const code = RPC_FAILURE_CODES[prefix] ?? 'write_failed';
  return new PTOServiceError(code, `pto: ${message}`, { detail: { requestId } });
}

function readDeltas(value: unknown): BalanceDelta[] {
  if (!Array.isArray(value)) return [];

  const deltas: BalanceDelta[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const source = entry as Record<string, unknown>;
    const year = readNumber(source.year);
    const deltaDays = readNumber(source.delta_days);
    const balanceField = readText(source.balance_field);
    if (year === null || deltaDays === null || balanceField === null) continue;
    deltas.push({ year, balanceField: balanceField as BalanceField, deltaDays });
  }
  return deltas;
}

function readBalanceRows(value: unknown): PTOBalanceRow[] {
  if (!Array.isArray(value)) return [];

  const rows: PTOBalanceRow[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const source = entry as Record<string, unknown>;
    const balance = toBalanceRow({
      profile_id: '',
      year: source.year,
      vacation_days: source.vacation_days,
      sick_days: source.sick_days,
      personal_days: source.personal_days,
      vacation_used: source.vacation_used,
      sick_used: source.sick_used,
      personal_used: source.personal_used,
    });
    if (balance !== null) rows.push(balance);
  }
  return rows;
}

function readDateList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const dates: string[] = [];
  for (const entry of value) {
    const date = readDate(entry);
    if (date !== null) dates.push(date);
  }
  return dates.sort();
}

/** Everything `pto_decide()` is called with, once the service has settled it. */
interface CommitParams {
  request: PTORequestSourceRow;
  requestRange: DateRange;
  decision: DecisionOption;
  storedStatus: PTOStatus;
  /**
   * The status the row must still hold, or null to skip the comparison.
   *
   * Null only on a replay, where the status has legitimately moved because the
   * first attempt committed. Non-null on every other path, so the comparison that
   * decides whether the movement still describes the request happens inside the
   * row lock rather than out here.
   */
  expectedStatus: PTOStatus | null;
  /** The status the decision asserts, or null on a replay. */
  newStatus: PTOStatus | null;
  approvedRanges: readonly DateRange[];
  declinedRanges: readonly DateRange[];
  suggestedRanges: readonly DateRange[];
  balanceDeltas: readonly BalanceDelta[];
  reason: string | null;
  overrideReason: string | null;
  acknowledgedShortfall: boolean;
  idempotencyKey: string;
  guard: ApprovalGuardVerdict;
  coverageAssignments: CoverageAssignmentResult[];
}

/**
 * Steps 9 and 10 of a decision: commit it, then answer with the recomputed
 * coverage and the row as it now stands.
 *
 * `pto_decide()` locks the request row, re-derives the working days and the
 * movement from the stored rows, refuses the call if the payload disagrees with
 * them, and applies the status, the ledger row, the balance increment, and the
 * audit entry in one transaction. The service's figures are a proposal the
 * database checks, which is what makes Requirement 10, criterion 18 hold: if
 * anything in that sequence fails, none of it happened and the reason comes back.
 *
 * The projection returned afterwards is the plain projected read the
 * Coverage_Calendar makes. The request is by then an approved absence rather than
 * a proposed one — the same subtraction — so the figure equals the one the
 * Approval_Impact_Preview computed before the decision, which is Correctness
 * Property 17.
 *
 * Requirements: 10.11, 10.12, 10.17, 10.18
 */
async function commitDecision(
  actor: Actor,
  params: CommitParams,
  context: PTOContext,
  evaluatedAt: string,
  policy: AttendancePolicy,
  thresholds: StaffingThresholdTable,
): Promise<DecisionResult> {
  const { request, decision } = params;

  const rpc = await context.client.rpc('pto_decide', {
    p_request_id: request.id,
    p_decision: decision,
    p_new_status: params.newStatus,
    p_approved_ranges: params.approvedRanges,
    p_declined_ranges: params.declinedRanges,
    p_suggested_ranges: params.suggestedRanges,
    p_balance_deltas: params.balanceDeltas.map((delta) => ({
      year: delta.year,
      balance_field: delta.balanceField,
      delta_days: delta.deltaDays,
    })),
    p_reason: params.reason,
    p_override_reason: params.overrideReason,
    p_acknowledged_shortfall: params.acknowledgedShortfall,
    p_idempotency_key: params.idempotencyKey,
    p_expected_status: params.expectedStatus,
  });

  if (rpc.error) throw rpcFailure(request.id, rpc.error.message);

  const envelope = (rpc.data ?? {}) as DecideEnvelope;

  if (envelope.code === 'stale_request_state') {
    throw new PTOServiceError(
      'stale_request_state',
      readText(envelope.error) ?? 'pto: the request moved while the decision was being composed',
      { current: toRequestStateFromEnvelope(request.id, envelope.current) },
    );
  }

  if (envelope.ok !== true) {
    // Requirement 10, criterion 18: the balance change could not be recorded, so
    // the status did not move and the reason is what the caller gets.
    throw new PTOServiceError(
      'write_failed',
      readText(envelope.error) ?? 'pto: that decision could not be recorded. Nothing was changed.',
      { detail: { requestId: request.id, code: String(envelope.code ?? 'unknown') } },
    );
  }

  const coverage = await projectRange(
    actor,
    params.requestRange,
    context,
    evaluatedAt,
    policy,
    thresholds,
  );

  const decided = (await readRequestById(context.client, request.id)) ?? request;
  const row = await rebuildRequestRow(
    actor,
    decided,
    context,
    evaluatedAt,
    policy,
    projectionsOf(coverage),
  );

  return {
    applied: envelope.applied === true,
    requestId: request.id,
    decisionId: readText(envelope.decision_id),
    decision,
    previousStatus: readText(envelope.previous_status) ?? params.storedStatus,
    newStatus: readText(envelope.new_status),
    affectedDates: readDateList(envelope.affected_dates),
    workingDays: readNumber(envelope.working_days) ?? 0,
    balanceDeltas: readDeltas(envelope.balance_deltas),
    balances: readBalanceRows(envelope.balances),
    auditId: readText(envelope.audit_id),
    guard: params.guard,
    coverageAssignments: params.coverageAssignments,
    coverage,
    request: row,
  };
}

/**
 * Commit one leave decision.
 *
 * The order below is the order, and each step is there because skipping it is a
 * way to get a decision wrong:
 *
 *  1. **Authorise.** `canAdministerAttendance` before anything is read, so a call
 *     outside the permitted set touches no data (Requirement 21, criterion 15).
 *     `pto_decide()` asserts the same rule again as the owner of the function.
 *  2. **Read the stored request, and the decision this key may already have
 *     recorded.** Every figure below comes from the row, the stored closed dates,
 *     and the stored ledger. Nothing arithmetical is read from the caller.
 *  3. **Refuse the owner.** Requirement 10, criterion 19, before any other work. A
 *     `super_admin` submitting their own leave is an ordinary case, and it is
 *     exactly the case the check exists for.
 *  4. **Answer a replay.** A key already recorded means this decision is in place,
 *     so nothing below runs: no coverage is assigned a second time, no movement is
 *     computed, and the call answers with the prior decision and `applied: false`
 *     (Requirement 10, criterion 17). A replay is deliberately not treated as a
 *     stale view — the status moved *because* the first attempt succeeded, and a
 *     browser retrying a lost response still sends the status it last saw.
 *  5. **Refuse a genuinely stale view.** The status the administrator saw is
 *     compared here and again inside the row lock, and the second comparison is
 *     the one that matters: it is what stops two administrators deciding the same
 *     request from both debiting it.
 *  6. **Check the payload the requirements make mandatory.** A denial reason, a
 *     question, a suggested range, both halves of a partial approval.
 *  7. **Compute the movement** from the approved ranges, the closed dates, and the
 *     ledger — never from a day count in the request body.
 *  8. **Assign coverage** before projecting, so the projection the guard reads
 *     already counts the shift that was just created. Assignment is an act in its
 *     own right under criterion 8, which is why it survives a refused approval.
 *  9. **Project and guard.** For an approving decision only: a decision that
 *     approves nothing cannot put coverage below anything.
 * 10. **Commit and answer**, in `commitDecision` above.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10,
 * 10.11, 10.12, 10.13, 10.14, 10.15, 10.16, 10.17, 10.18, 10.19, 10.20, 21.2,
 * 21.15
 */
export async function decide(
  actor: Actor,
  input: DecisionInput,
  context: PTOContext,
): Promise<DecisionResult> {
  const evaluatedAt = assertInstant(
    context.evaluatedAt ?? new Date().toISOString(),
    'evaluatedAt',
  );

  // 1. Authorise before touching data.
  if (!canAdministerAttendance(actor.role)) {
    throw new PTOServiceError(
      'not_authorised',
      'pto: only an attendance administrator may decide a time-off request',
      { detail: { role: actor.role } },
    );
  }

  const decision = readDecisionOption(input.decision);
  if (decision === null) {
    throw invalidParameter(
      'decision',
      `"${String(input.decision)}" is not one of the eight decision options`,
    );
  }

  const idempotencyKey = reasonWithContent(input.idempotencyKey);
  if (idempotencyKey === null) {
    throw invalidParameter('idempotencyKey', 'a decision carries a non-blank idempotency key');
  }

  const { policy, thresholds } = await resolveConfig(context);

  // 2. The stored request, and whether this key has already been honoured.
  //    Everything below is computed from the row, never from the caller.
  const [request, priorDecision] = await Promise.all([
    readRequestById(context.client, input.requestId),
    readDecisionByKey(context.client, input.requestId, idempotencyKey),
  ]);

  if (request === null) {
    throw new PTOServiceError('not_visible', 'pto: that request is not available to you', {
      detail: { requestId: input.requestId },
    });
  }

  // 3. The owner of a request may never decide it, whatever their role.
  if (request.profile_id === actor.id) {
    throw new PTOServiceError(
      'owner_cannot_decide',
      'pto: the employee who owns a request may not decide it',
      { detail: { requestId: request.id } },
    );
  }

  const ptoType = readPtoType(request.pto_type);
  const storedStatus = readStatus(request.status);
  if (ptoType === null || storedStatus === null) {
    throw invalidParameter(
      'requestId',
      'that request carries a type or status this organisation does not accept, ' +
        'so it cannot be decided until the row is reconciled',
    );
  }

  // Normalised through `readDate` first, so a stored bound that arrives in the
  // timestamp form some drivers produce is read rather than refused. A bound that
  // genuinely names no date still fails, in `assertRange`.
  const requestRange = assertRange(
    readDate(request.start_date) ?? String(request.start_date),
    readDate(request.end_date) ?? String(request.end_date),
    MAX_REQUEST_SPAN_DAYS,
    'request',
  );

  // 4. A replay. Nothing below runs, and nothing is applied a second time: the
  //    function is called with the key alone and answers with the prior decision.
  //    The guard reports no shortfall and no escape, because this call evaluated
  //    neither — the decision it replays did.
  if (priorDecision !== null) {
    return commitDecision(
      actor,
      {
        request,
        requestRange,
        decision,
        storedStatus,
        expectedStatus: null,
        newStatus: null,
        approvedRanges: [],
        declinedRanges: [],
        suggestedRanges: [],
        balanceDeltas: [],
        reason: null,
        overrideReason: null,
        acknowledgedShortfall: false,
        idempotencyKey,
        guard: evaluateApprovalGuard([]),
        coverageAssignments: [],
      },
      context,
      evaluatedAt,
      policy,
      thresholds,
    );
  }

  // 5. The status the administrator saw. Defaulted to the status the movement was
  //    computed against, so a non-null value always reaches the row lock.
  const expectedStatus = input.expectedStatus ?? storedStatus;
  if (expectedStatus !== storedStatus) {
    throw new PTOServiceError(
      'stale_request_state',
      `pto: the request moved to ${storedStatus} while the decision was being composed`,
      { current: toRequestState(request) },
    );
  }

  const approvedRanges = approvedRangesForDecision(decision, {
    requested: requestRange,
    approved: input.approvedRanges,
  }).map((range) => assertRange(range.from, range.to, MAX_REQUEST_SPAN_DAYS, 'approvedRanges'));

  // 6. The reasons and payloads the requirements make mandatory.
  assertDecisionPayload(decision, input, approvedRanges);

  // Approving more than was asked for is not a decision on this request.
  for (const range of approvedRanges) {
    if (range.from < requestRange.from || range.to > requestRange.to) {
      throw invalidParameter(
        'approvedRanges',
        `an approved range must fall inside ${requestRange.from} .. ${requestRange.to}`,
      );
    }
  }

  const balanceField = PTO_TYPE_TO_BALANCE_FIELD[ptoType];

  // 7. The movement, from stored rows only.
  const [closedDates, priorByYear] = await Promise.all([
    readClosedDates(context.client, requestRange),
    readLedgerByYear(context.client, request.id, balanceField),
  ]);

  const balanceDeltas = decisionMovement(
    decision,
    balanceField,
    approvedRanges,
    closedDates,
    priorByYear,
  );

  // 8. Coverage assignment, before the projection that reads it.
  const coverageAssignments = await applyCoverageAssignments(
    actor,
    request,
    requestRange,
    input.coverageAssignments ?? [],
    context,
  );

  // 9. The projection and the guard, for an approving decision only.
  const approvedDates = new Set(
    approvedRanges.flatMap((range) => datesBetween(range, MAX_REQUEST_SPAN_DAYS, 'approvedRanges')),
  );

  let guard: ApprovalGuardVerdict;
  if (decisionApproves(decision) && approvedDates.size > 0) {
    const preview = await projectRange(
      actor,
      requestRange,
      context,
      evaluatedAt,
      policy,
      thresholds,
      { profileId: request.profile_id, ranges: approvedRanges },
    );

    guard = evaluateApprovalGuard(shortfallsForApproval(preview, approvedDates), {
      coverageAssigned: coverageAssignments.length > 0,
      acknowledgedShortfall: input.acknowledgedShortfall === true,
      overrideReason: input.overrideReason ?? null,
    });

    if (!guard.permitted) {
      throw new PTOServiceError(
        'coverage_shortfall',
        'pto: approving this request would leave staffing below the required minimum. ' +
          'Assign coverage for the shortfall, acknowledge it, or supply an override reason.',
        {
          detail: { requestId: request.id },
          current: { shortfalls: guard.shortfalls, coverage: preview },
        },
      );
    }
  } else {
    guard = evaluateApprovalGuard([], {
      coverageAssigned: coverageAssignments.length > 0,
      acknowledgedShortfall: input.acknowledgedShortfall === true,
      overrideReason: input.overrideReason ?? null,
    });
  }

  // 10. Commit, and answer with the recomputed projection and the current row.
  return commitDecision(
    actor,
    {
      request,
      requestRange,
      decision,
      storedStatus,
      expectedStatus,
      newStatus: statusForDecision(decision, storedStatus),
      approvedRanges,
      declinedRanges: input.declinedRanges ?? [],
      suggestedRanges: input.suggestedRanges ?? [],
      balanceDeltas,
      reason: reasonWithContent(input.reason),
      overrideReason: guard.overrideReason,
      acknowledgedShortfall: input.acknowledgedShortfall === true,
      idempotencyKey,
      guard,
      coverageAssignments,
    },
    context,
    evaluatedAt,
    policy,
    thresholds,
  );
}
