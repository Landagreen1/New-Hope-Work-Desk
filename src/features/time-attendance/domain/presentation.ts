// src/features/time-attendance/domain/presentation.ts
// Presentation choices that carry a rule.
//
// A status becoming a colour is a rule: Requirement 22, criterion 5 states which
// meaning takes which colour role, and criterion 6 states that a colour never
// travels without a label or an icon. Rules belong in the domain layer, where
// they can be enumerated and tested without a DOM, rather than inside four
// components that would each have to be checked separately.
//
// Pure: no React, no I/O, no `Date.now()`. The evaluation instant arrives as an
// argument wherever a rule needs one, so an alert list is a function of its
// inputs alone. The class strings come from `shared/tokens.ts`, which is pure
// data — the one place the six colour roles are given actual colours
// (Requirement 19, criterion 8, applied to the palette).
//
// Four rules live here beside the token table, because each one is a choice
// between named alternatives that a component would otherwise make with an
// inline conditional nobody could test:
//
// - `primaryClockAction` — the one action My Day offers, and the reason a screen
//   cannot show two (Requirement 4, criteria 7 through 11; Requirement 22,
//   criterion 4).
// - `secondaryClockActions` — Clock Out, offered in one state only.
// - `primaryRowAction` — the Exception_Queue row action, a lookup from the row's
//   highest-priority exception (Requirement 12, criteria 6 and 7).
// - `buildMyDayAlerts` — the six alert conditions of Requirement 4, criteria 12
//   through 17, derived from records rather than from component state.
//
// ## What `statusToken` is for
//
// The module renders four families of status, and every one of them appears in
// more than one place:
//
// - `DerivedStatus` — twelve values, on My Day, Team Today, the exception queue,
//   the employee drawer, and the trends view.
// - `CoverageStatus` — four values, on the live coverage panel, the coverage
//   calendar, the approval impact preview, and the coverage date drawer.
// - `RibbonState` — five values, on the health ribbon, which appears on three
//   screens.
// - `PTOStatus` — seven values, on the request inbox, the decision drawer, and
//   the employee's own request list.
//
// One table covers all four, so the same meaning cannot be emerald in one place
// and amber in another, and a value added to any family fails the build until it
// has a role, a label, and an icon (`STATUS_PRESENTATION` is a `Record` over the
// union of the four).
//
// ## Icons are names, not components
//
// `StatusToken.icon` is a string. The domain layer cannot hold a React component
// and stay pure, and it does not need to: `shared/StatusIcon.tsx` is the single
// place a name becomes a glyph, and it is the only module that imports the icon
// set.
//
// Requirements: 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 4.15, 4.16, 4.17,
// 8.4, 12.6, 12.7, 12.9, 18.7, 22.4, 22.5, 22.6, 22.13

import type { PTOStatus } from '../types';
import { COLOR_ROLE_TOKENS, type ColorRole } from '../shared/tokens';
import { MINUTE_MS, roundToTwoDecimals } from './attendance';
import type { CoverageStatus, RibbonState } from './coverage';
import type {
  AttendanceException,
  AttendancePolicy,
  ClockSessionInput,
  DailyAttendanceRecord,
  DerivedStatus,
  ExceptionCode,
} from './types';
import { addCalendarDays } from './work-date';

/**
 * Any value `statusToken` answers for: the four status families, as one union.
 *
 * The families overlap — `healthy`, `warning`, and `critical` belong to both
 * `CoverageStatus` and `RibbonState` — and they mean the same thing in both, so
 * one entry serves both and the union collapses them to a single key.
 */
export type StatusValue = DerivedStatus | CoverageStatus | RibbonState | PTOStatus;

/**
 * How one status renders: a colour role, a label, and an icon, never a colour on
 * its own.
 *
 * `label` and `icon` are both always non-empty, which is Requirement 22,
 * criterion 6 held by construction rather than by review: a component that has a
 * token has something to render beside the colour.
 *
 * `surface` and `text` are the pair from `shared/tokens.ts`, so the text is dark
 * enough to clear 4.5 to 1 against the surface it is placed on (criterion 13).
 */
export interface StatusToken {
  role: ColorRole;
  /** Always non-empty. */
  label: string;
  /** A lucide icon name, resolved by `shared/StatusIcon.tsx`. Always non-empty. */
  icon: string;
  /** Tailwind surface class from the role's token. */
  surface: string;
  /** Tailwind text class from the role's token, paired with `surface`. */
  text: string;
}

/** A table entry: everything about a status that is not the palette. */
interface StatusPresentation {
  role: ColorRole;
  label: string;
  icon: string;
}

/**
 * Every status value, with the colour role, label, and icon it renders as.
 *
 * Roles follow Requirement 22, criterion 5. The criterion names the meanings
 * rather than the statuses, so each status is placed by the meaning it carries:
 *
 * - **`neutral`** — normal information. The state is expected and there is
 *   nothing to act on: a shift not started yet, a break in progress, approved
 *   leave, a closed date, a cancelled request.
 * - **`healthy`** — the good outcome. Staffing above requirement, and the
 *   attendance and request states that are its equivalent: working, completed,
 *   approved.
 * - **`warning`** — approaching a problem. Staffing at or near the minimum, and
 *   the attendance states that are a shortfall rather than a failure: late, left
 *   early, partially approved.
 * - **`critical`** — staffing below minimum, and payroll-blocking records. A
 *   missing punch is payroll-blocking by Requirement 12, criterion 8; an absence
 *   on a scheduled date carries the missing clock-in with it; a denial is the
 *   request equivalent of a refusal.
 * - **`pending`** — awaiting review. A record or request whose next step is a
 *   human decision: needs review, unscheduled work not yet approved, and the
 *   three undecided request states.
 * - **`accent`** is deliberately unused here. Criterion 5 assigns it to the
 *   selected item and the primary action, which are interaction states rather
 *   than statuses, so `statusToken` never returns it. A selected filter or a
 *   primary button reads `COLOR_ROLE_TOKENS.accent` directly.
 *
 * Whether a record is payroll-blocking is a property of its exceptions, not of
 * its status (Requirement 12, criterion 8), so `clocked_in_unscheduled` is
 * `pending` — the work is awaiting approval — and the row's own payroll-blocking
 * indicator carries `critical` beside it (criterion 9).
 *
 * Exported so that a test can enumerate the table rather than restate it.
 *
 * Requirements: 8.4, 12.9, 18.7, 22.5, 22.6
 */
export const STATUS_PRESENTATION: Record<StatusValue, StatusPresentation> = {
  // ── DerivedStatus, the twelve values of Requirement 3, criterion 4 ──────────
  scheduled: { role: 'neutral', label: 'Scheduled', icon: 'CalendarClock' },
  working: { role: 'healthy', label: 'Working', icon: 'Activity' },
  on_break: { role: 'neutral', label: 'On Break', icon: 'Coffee' },
  completed: { role: 'healthy', label: 'Completed', icon: 'CircleCheck' },
  late: { role: 'warning', label: 'Late', icon: 'AlarmClock' },
  absent: { role: 'critical', label: 'Absent', icon: 'UserX' },
  approved_time_off: { role: 'neutral', label: 'Approved Time Off', icon: 'TreePalm' },
  clocked_in_unscheduled: { role: 'pending', label: 'Unscheduled Work', icon: 'CalendarPlus' },
  left_early: { role: 'warning', label: 'Left Early', icon: 'LogOut' },
  missing_clock_in: { role: 'critical', label: 'Missing Clock-In', icon: 'LogIn' },
  missing_clock_out: { role: 'critical', label: 'Missing Clock-Out', icon: 'TimerOff' },
  needs_review: { role: 'pending', label: 'Needs Review', icon: 'CircleQuestionMark' },

  // ── CoverageStatus, the four outcomes of Requirement 6 ─────────────────────
  healthy: { role: 'healthy', label: 'Healthy', icon: 'ShieldCheck' },
  warning: { role: 'warning', label: 'Warning', icon: 'TriangleAlert' },
  at_minimum: { role: 'warning', label: 'At Minimum', icon: 'CircleGauge' },
  critical: { role: 'critical', label: 'Critical', icon: 'OctagonAlert' },

  // ── RibbonState, the two states that are not a coverage outcome ────────────
  closed: { role: 'neutral', label: 'Closed', icon: 'CalendarOff' },
  no_schedule: { role: 'neutral', label: 'No Schedule', icon: 'CalendarX' },

  // ── PTOStatus, the seven stored request statuses ───────────────────────────
  pending: { role: 'pending', label: 'Pending', icon: 'Hourglass' },
  approved: { role: 'healthy', label: 'Approved', icon: 'CircleCheck' },
  denied: { role: 'critical', label: 'Denied', icon: 'CircleX' },
  cancelled: { role: 'neutral', label: 'Cancelled', icon: 'Ban' },
  waitlisted: { role: 'pending', label: 'Waitlisted', icon: 'ListOrdered' },
  information_requested: { role: 'pending', label: 'Info Requested', icon: 'MessageSquareWarning' },
  partially_approved: { role: 'warning', label: 'Partially Approved', icon: 'CirclePercent' },
};

/**
 * The token for a value the table does not name.
 *
 * The union covers every status the module produces, but request statuses arrive
 * from the database, and a row written by a future migration would otherwise
 * reach a screen with no label and no icon. Reporting it as unknown keeps
 * criterion 6 true — there is still a label and an icon beside the colour — and
 * says plainly that the value is unrecognised rather than guessing at a meaning.
 */
const UNKNOWN_STATUS: StatusPresentation = {
  role: 'neutral',
  label: 'Unknown',
  icon: 'CircleQuestionMark',
};

/**
 * The colour role, label, icon, and class pair for one status.
 *
 * The only place in the module where a status becomes a colour. Every screen
 * that shows a status calls this, through `StatusPill` or `CoverageBadge`, which
 * is how Requirement 8, criterion 4, Requirement 12, criterion 9, Requirement
 * 18, criterion 7, and Requirement 22, criterion 6 hold everywhere at once
 * rather than screen by screen.
 *
 * Requirements: 8.4, 12.9, 18.7, 22.5, 22.6, 22.13
 */
export function statusToken(status: StatusValue): StatusToken {
  const presentation: StatusPresentation | undefined = STATUS_PRESENTATION[status];
  const entry = presentation ?? UNKNOWN_STATUS;
  const role = COLOR_ROLE_TOKENS[entry.role];

  return {
    role: entry.role,
    label: entry.label,
    icon: entry.icon,
    surface: role.surface,
    text: role.text,
  };
}

// ─── Shared reading of a record's clock state ────────────────────────────────
//
// Three of the four rules below ask the same two questions of a record: is a
// session still open, and is a break still running on one? They are answered
// once, here, so the action rule and the alert rule cannot disagree about the
// state they are describing.

/** An instant in milliseconds, or null when the value is absent or unreadable. */
function parseInstantMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : null;
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}

/** True when a session has no recorded clock-out. */
function isOpenSession(session: ClockSessionInput): boolean {
  return session.clockOut === null || session.clockOut === undefined;
}

/** True when a break has no recorded end. */
function isUnendedBreak(item: ClockSessionInput['breaks'][number]): boolean {
  return item.end === null || item.end === undefined;
}

/**
 * True when the employee is on a break they can end: an unended break on a
 * session that is still open.
 *
 * Read from the sessions rather than from `derivedStatus`, because the status is
 * single-valued and the break is not the only thing it reports. A session left
 * open past the missing-clock-out tolerance is `missing_clock_out` by rule 2 of
 * the Status Rule Matrix even while a break is still running on it, and
 * Requirement 4, criterion 10 asks for End Break whenever a break is unended —
 * so keying the action on the status would leave that employee with Start Break
 * and no way to end the break they are on.
 *
 * An unended break on a session that has since clocked out is a different
 * condition: nothing can be ended, the hours were measured to the clock-out, and
 * the `open_break_at_clock_out` exception puts it in front of an administrator.
 * It is deliberately not this.
 *
 * Requirements: 4.10
 */
export function hasUnendedBreak(record: DailyAttendanceRecord): boolean {
  return (record.sessions ?? []).some(
    (session) => isOpenSession(session) && (session.breaks ?? []).some(isUnendedBreak),
  );
}

// ─── My Day clock actions ────────────────────────────────────────────────────

/**
 * The clock actions My Day and the Team Today header control can offer.
 *
 * `start_lunch` begins an unpaid break (deducted from worked hours).
 * `start_break` begins a paid break (NOT deducted from worked hours).
 *
 * Requirements: 4.8, 4.9, 4.10
 */
export type ClockAction = 'clock_in' | 'start_lunch' | 'start_break' | 'end_break' | 'clock_out';

/** Button text per action. The one place these are worded. */
export const CLOCK_ACTION_LABELS: Record<ClockAction, string> = {
  clock_in: 'Clock In',
  start_lunch: 'Lunch',
  start_break: 'Break',
  end_break: 'End Break',
  clock_out: 'Clock Out',
};

/**
 * The single action to style as primary on My Day.
 *
 * Total and single-valued over every clock state a record can be in, which is
 * what makes Requirement 4, criterion 7 and Requirement 22, criterion 4
 * structural rather than a rule a component has to remember. The three states of
 * criteria 8 through 10 partition the space:
 *
 * | state                                     | primary        | criterion |
 * | ----------------------------------------- | -------------- | --------- |
 * | no open session                           | `clock_in`     | 8         |
 * | open session, unended break on it         | `end_break`    | 10        |
 * | open session, no unended break            | `start_lunch`  | 9         |
 *
 * Lunch is the primary break action because it is the most common. The paid
 * break (`start_break`) and `clock_out` appear as secondary actions.
 *
 * A day carrying a completed session and nothing open reports `clock_in`, which
 * is what criterion 8 says — it asks about an open session, not about whether the
 * employee has already worked today. Whether a second session is allowed is the
 * server's decision, not the button's.
 *
 * Requirements: 4.7, 4.8, 4.9, 4.10, 4.11, 22.4
 */
export function primaryClockAction(record: DailyAttendanceRecord): ClockAction {
  if (!record.hasOpenSession) return 'clock_in';
  return hasUnendedBreak(record) ? 'end_break' : 'start_lunch';
}

/**
 * The actions offered beside the primary one: `['start_break', 'clock_out']`
 * while a session is open with no unended break (primary is Lunch), and nothing
 * otherwise.
 *
 * Lunch is primary, and Break (paid) plus Clock Out sit beside it as secondary.
 * While a break is running it has to be ended first, so offering other actions
 * there would either lose the break's end or need a second rule about what
 * happens to it — which is why the empty list is the answer in every other state.
 *
 * Requirements: 4.9, 4.11, 22.4
 */
export function secondaryClockActions(record: DailyAttendanceRecord): ClockAction[] {
  return primaryClockAction(record) === 'start_lunch' ? ['start_break', 'clock_out'] : [];
}

// ─── Exception Queue row actions ─────────────────────────────────────────────

/**
 * The six actions an Exception_Queue row can offer, as Requirement 12,
 * criterion 7 names them.
 */
export type RowAction =
  | 'correct_punch'
  | 'add_clock_out'
  | 'review_lateness'
  | 'approve_unscheduled'
  | 'add_manager_note'
  | 'mark_reviewed';

/** Button text per row action. The one place these are worded. */
export const ROW_ACTION_LABELS: Record<RowAction, string> = {
  correct_punch: 'Correct Punch',
  add_clock_out: 'Add Clock-Out',
  review_lateness: 'Review Lateness',
  approve_unscheduled: 'Approve Unscheduled Work',
  add_manager_note: 'Add Manager Note',
  mark_reviewed: 'Mark Reviewed',
};

/**
 * The action each exception code calls for, written in priority order.
 *
 * A `Record` over `ExceptionCode`, so a code added to the vocabulary fails the
 * build until it has an action — the queue can never meet an exception it has no
 * action for. The order of the entries is the priority order, and
 * `EXCEPTION_ACTION_PRIORITY` is derived from these keys, so the ranking is
 * stated once rather than kept in step across two lists.
 *
 * Priority runs payroll-blocking conditions first, then the conditions that put
 * the recorded hours in doubt, then the ones an administrator only has to
 * judge:
 *
 * | code                      | action                | why                                                          |
 * | ------------------------- | --------------------- | ------------------------------------------------------------ |
 * | `missing_clock_out`       | `add_clock_out`       | payroll-blocking, and the missing value is the clock-out      |
 * | `missing_clock_in`        | `correct_punch`       | payroll-blocking on a scheduled date; the punch is supplied   |
 * | `unscheduled_work`        | `approve_unscheduled` | informational; the work is marked as reviewed                 |
 * | `negative_duration`       | `correct_punch`       | a duration runs backwards, so a punch is wrong                |
 * | `overlapping_sessions`    | `correct_punch`       | two sessions share time, so worked hours cannot be trusted    |
 * | `open_break_at_clock_out` | `correct_punch`       | the break has no end, so its minutes were inferred            |
 * | `absent`                  | `add_manager_note`    | the data is complete; the reason is what is missing           |
 * | `late_arrival`            | `review_lateness`     | criterion 7's own action for lateness                         |
 * | `early_departure`         | `add_manager_note`    | as with an absence, the record needs a reason, not a fix      |
 * | `break_overrun`           | `add_manager_note`    | a long break is recorded correctly; correcting it would hide it |
 * | `schedule_without_clock`  | `add_manager_note`    | the schedule row is the fault, and it is fixed on Schedule    |
 *
 * `add_manager_note` carries four codes because four of the eleven conditions
 * are already recorded accurately: the administrator's job on those is to say
 * why, not to change a punch. Reaching for `correct_punch` there would turn the
 * queue into a way to make exceptions disappear.
 *
 * Requirements: 12.7
 */
export const ROW_ACTION_BY_EXCEPTION: Record<ExceptionCode, RowAction> = {
  missing_clock_out: 'add_clock_out',
  missing_clock_in: 'correct_punch',
  unscheduled_work: 'approve_unscheduled',
  negative_duration: 'correct_punch',
  overlapping_sessions: 'correct_punch',
  open_break_at_clock_out: 'correct_punch',
  absent: 'add_manager_note',
  late_arrival: 'review_lateness',
  early_departure: 'add_manager_note',
  break_overrun: 'add_manager_note',
  schedule_without_clock: 'add_manager_note',
};

/**
 * The exception codes in the order they claim a row's one action, highest
 * priority first.
 *
 * Derived from the key order of `ROW_ACTION_BY_EXCEPTION`, which is insertion
 * order for string keys, so the ranking cannot drift from the table it ranks.
 *
 * Requirements: 12.6, 12.7
 */
export const EXCEPTION_ACTION_PRIORITY: readonly ExceptionCode[] = Object.keys(
  ROW_ACTION_BY_EXCEPTION,
) as ExceptionCode[];

/**
 * The action for a row carrying no exception at all.
 *
 * The queue's "all records" filter lists clean rows too, and marking one
 * reviewed is the only thing left to do with it. Repeating it is harmless:
 * Requirement 12, criterion 16 retains the first reviewer and timestamp, so an
 * already-reviewed row does not lose its history to a second click.
 */
const NO_EXCEPTION_ROW_ACTION: RowAction = 'mark_reviewed';

/**
 * The exception that decides a row's action: the first in
 * `EXCEPTION_ACTION_PRIORITY` the record carries, or null when it carries none.
 *
 * Exposed because the queue shows the exception beside the action it produced,
 * and a row displaying one exception while offering another row's action would
 * read as a bug even though both are correct.
 *
 * A code outside the priority table is never selected, so a record written by a
 * future migration falls through to the no-exception action rather than reaching
 * a screen with no action at all.
 *
 * Requirements: 12.5, 12.7
 */
export function highestPriorityException(
  record: DailyAttendanceRecord,
): AttendanceException | null {
  const exceptions = record.exceptions ?? [];
  for (const code of EXCEPTION_ACTION_PRIORITY) {
    const match = exceptions.find((exception) => exception.code === code);
    if (match !== undefined) return match;
  }
  return null;
}

/**
 * The single action to style as primary on an Exception_Queue row: a lookup from
 * the row's highest-priority exception code to one of the six actions.
 *
 * Because it is a lookup, "at most one primary action per row" (Requirement 12,
 * criterion 6) is a property of the function rather than something reviewers
 * have to check row by row, and the answer is total: every record, exception or
 * not, has exactly one action.
 *
 * Requirements: 12.6, 12.7, 22.4
 */
export function primaryRowAction(record: DailyAttendanceRecord): RowAction {
  const exception = highestPriorityException(record);
  return exception === null
    ? NO_EXCEPTION_ROW_ACTION
    : ROW_ACTION_BY_EXCEPTION[exception.code];
}

// ─── My Day alerts ───────────────────────────────────────────────────────────

/**
 * How far before a clock session may begin, or after it may end, before it
 * counts as work outside the scheduled shift: 60 minutes, the figure
 * Requirement 4, criterion 17 states. Not a policy field — the criterion fixes
 * it, and `attendance_policy` holds no equivalent tolerance.
 *
 * Requirements: 4.17
 */
export const OUTSIDE_SHIFT_MARGIN_MINUTES = 60;

/**
 * How many dates before today the missing-clock-out alert looks back over:
 * seven, as Requirement 4, criterion 16 states.
 *
 * Requirements: 4.16
 */
export const MY_DAY_ALERT_HISTORY_DAYS = 7;

/**
 * The six alert conditions of Requirement 4, criteria 12 through 17, in the
 * order the criteria state them.
 */
export type MyDayAlertKind =
  | 'unscheduled_today'
  | 'late_arrival'
  | 'break_active'
  | 'shift_ended_open_session'
  | 'missing_clock_out_recent'
  | 'outside_scheduled_shift';

/** How one alert kind renders, and the criterion it comes from. */
interface MyDayAlertPresentation {
  role: ColorRole;
  icon: string;
  /** The criterion of Requirement 4 this kind implements. */
  criterion: number;
}

/**
 * Colour role and icon per alert kind.
 *
 * Roles follow the same reading of Requirement 22, criterion 5 that
 * `STATUS_PRESENTATION` uses, so an alert about a condition and the status pill
 * for that condition carry the same colour: a running break is normal
 * information, lateness and an overrun shift are approaching a problem, a
 * missing clock-out is payroll-blocking, and unscheduled work is awaiting a
 * decision.
 *
 * Every icon name is one `shared/StatusIcon.tsx` already registers.
 *
 * Requirements: 22.5, 22.6
 */
export const MY_DAY_ALERT_PRESENTATION: Record<MyDayAlertKind, MyDayAlertPresentation> = {
  unscheduled_today: { role: 'pending', icon: 'CalendarPlus', criterion: 12 },
  late_arrival: { role: 'warning', icon: 'AlarmClock', criterion: 13 },
  break_active: { role: 'neutral', icon: 'Coffee', criterion: 14 },
  shift_ended_open_session: { role: 'warning', icon: 'LogOut', criterion: 15 },
  missing_clock_out_recent: { role: 'critical', icon: 'TimerOff', criterion: 16 },
  outside_scheduled_shift: { role: 'warning', icon: 'TriangleAlert', criterion: 17 },
};

/** The six kinds, in criterion order. Derived from the table's key order. */
export const MY_DAY_ALERT_KINDS: readonly MyDayAlertKind[] = Object.keys(
  MY_DAY_ALERT_PRESENTATION,
) as MyDayAlertKind[];

/**
 * One alert on My Day.
 *
 * `message` is a full sentence and is always non-empty, because Requirement 22,
 * criterion 7 asks for the reason as visible text rather than as a tooltip: the
 * panel renders this string, it does not assemble one from the kind.
 */
export interface MyDayAlert {
  kind: MyDayAlertKind;
  /** The work date the alert is about, `YYYY-MM-DD`. */
  workDate: string;
  role: ColorRole;
  /** A lucide icon name, resolved by `shared/StatusIcon.tsx`. */
  icon: string;
  /** Visible text, always non-empty. */
  message: string;
  /** Figures behind the message, for a caller that wants them separately. */
  detail?: Record<string, number | string>;
}

function alertOf(
  kind: MyDayAlertKind,
  workDate: string,
  message: string,
  detail?: Record<string, number | string>,
): MyDayAlert {
  const presentation = MY_DAY_ALERT_PRESENTATION[kind];
  return {
    kind,
    workDate,
    role: presentation.role,
    icon: presentation.icon,
    message,
    ...(detail === undefined ? {} : { detail }),
  };
}

/** `12 minutes`, `1 minute`. Minutes are rounded at the boundary, as elsewhere. */
function minutesPhrase(minutes: number): string {
  const value = roundToTwoDecimals(atLeastZero(minutes));
  return `${value} ${value === 1 ? 'minute' : 'minutes'}`;
}

/** Elapsed minutes of the running break, measured to the evaluation instant. */
function activeBreakMinutes(record: DailyAttendanceRecord, evaluatedAtMs: number): number {
  let earliestStartMs: number | null = null;

  for (const session of record.sessions ?? []) {
    if (!isOpenSession(session)) continue;
    for (const item of session.breaks ?? []) {
      if (!isUnendedBreak(item)) continue;
      const startMs = parseInstantMs(item.start);
      if (startMs === null) continue;
      if (earliestStartMs === null || startMs < earliestStartMs) earliestStartMs = startMs;
    }
  }

  if (earliestStartMs === null) return 0;
  return atLeastZero((evaluatedAtMs - earliestStartMs) / MINUTE_MS);
}

/**
 * The largest excursion either side of the scheduled shift, in minutes.
 *
 * Both figures are zero when the date carries no schedule, which is what makes
 * criterion 17 silent on an unscheduled date: there is no shift to be outside
 * of, and criterion 12 already reports the date as unscheduled.
 */
function shiftExcursionMinutes(record: DailyAttendanceRecord): {
  beforeStart: number;
  afterEnd: number;
} {
  const scheduledStartMs = parseInstantMs(record.scheduledStart);
  const scheduledEndMs = parseInstantMs(record.scheduledEnd);

  let beforeStart = 0;
  let afterEnd = 0;

  for (const session of record.sessions ?? []) {
    const clockInMs = parseInstantMs(session.clockIn);
    const clockOutMs = parseInstantMs(session.clockOut);

    if (scheduledStartMs !== null && clockInMs !== null) {
      beforeStart = Math.max(beforeStart, (scheduledStartMs - clockInMs) / MINUTE_MS);
    }
    // An open session has not ended, so it cannot have ended late. A session
    // still running past the scheduled end is criterion 15's alert instead.
    if (scheduledEndMs !== null && clockOutMs !== null) {
      afterEnd = Math.max(afterEnd, (clockOutMs - scheduledEndMs) / MINUTE_MS);
    }
  }

  return { beforeStart: atLeastZero(beforeStart), afterEnd: atLeastZero(afterEnd) };
}

/**
 * The alerts My Day shows, derived from today's record and the records of the
 * preceding dates.
 *
 * One list, six conditions, each from a criterion of Requirement 4:
 *
 * | kind                       | condition                                                                 | criterion |
 * | -------------------------- | ------------------------------------------------------------------------- | --------- |
 * | `unscheduled_today`        | today carries the `unscheduled_work` exception                            | 12        |
 * | `late_arrival`             | today carries the `late_arrival` exception                                | 13        |
 * | `break_active`             | an unended break on an open session                                       | 14        |
 * | `shift_ended_open_session` | the scheduled end has passed and a session is still open                   | 15        |
 * | `missing_clock_out_recent` | a preceding date within seven days has status `missing_clock_out`          | 16        |
 * | `outside_scheduled_shift`  | a session began or ended more than 60 minutes outside the scheduled shift  | 17        |
 *
 * Each condition is read from the record the Attendance_Service produced, never
 * recomputed here. This module decides which alerts appear and how they read, not
 * whether an employee was late: the grace period and the tolerances are applied
 * once, by the exception rules.
 *
 * Criteria 12 and 13 name a Derived_Status, and both are read from the matching
 * exception instead, because the status is single-valued and these two conditions
 * are not the only thing it reports. An employee clocked in on an unscheduled
 * date is `working` by rule 4 of the Status Rule Matrix, which outranks rule 5,
 * and an employee still working after a late arrival is `working` rather than
 * `late` — so keying either alert on the status would hide it for exactly as long
 * as the employee is still on the clock, which is when it is worth showing. The
 * exception holds in every case the status holds, so each criterion is satisfied
 * and the two open-session cases are covered as well. Criterion 16 does read the
 * derived status, because a closed past date has nothing competing for it.
 *
 * `evaluatedAt` is the caller's evaluation instant, the same one the records were
 * derived at. It is an argument rather than a clock reading so that the list is a
 * function of its inputs and the "has passed" and "elapsed" figures are testable.
 *
 * `precedingSevenDays` is filtered to the seven dates before today's work date,
 * so passing a longer history — the My Day history panel loads fourteen dates —
 * still produces exactly the alerts criterion 16 asks for. Today's own record is
 * excluded from that scan for the same reason: an open session today is
 * criterion 15's alert, not a missing clock-out.
 *
 * Alerts are returned in criterion order, and the missing-clock-out alerts among
 * them by ascending date, so the list does not depend on the order the history
 * arrived in.
 *
 * @throws RangeError if `evaluatedAt` is not a readable instant or
 *   `today.workDate` is not a calendar date. Both are constructed by the caller,
 *   so either is programmer error rather than attendance data.
 *
 * Requirements: 4.12, 4.13, 4.14, 4.15, 4.16, 4.17, 22.7
 */
export function buildMyDayAlerts(
  today: DailyAttendanceRecord,
  precedingSevenDays: readonly DailyAttendanceRecord[],
  policy: AttendancePolicy,
  evaluatedAt: string,
): MyDayAlert[] {
  const evaluatedAtMs = parseInstantMs(evaluatedAt);
  if (evaluatedAtMs === null) {
    throw new RangeError(`presentation: evaluatedAt must be an instant, received "${evaluatedAt}"`);
  }

  const alerts: MyDayAlert[] = [];
  const workDate = today.workDate;

  const codes = new Set((today.exceptions ?? []).map((exception) => exception.code));

  // Criterion 12 — clocked in on a date carrying no published schedule.
  if (codes.has('unscheduled_work')) {
    alerts.push(
      alertOf(
        'unscheduled_today',
        workDate,
        'You are not scheduled today, so today\u2019s clock session is recorded as unscheduled work and needs approval before it is paid.',
      ),
    );
  }

  // Criterion 13 — the service reported a late condition for today.
  if (codes.has('late_arrival')) {
    alerts.push(
      alertOf(
        'late_arrival',
        workDate,
        `You clocked in ${minutesPhrase(today.lateMinutes)} after your scheduled start, past the ${minutesPhrase(policy.gracePeriodMinutes)} grace period.`,
        {
          lateMinutes: roundToTwoDecimals(atLeastZero(today.lateMinutes)),
          gracePeriodMinutes: policy.gracePeriodMinutes,
        },
      ),
    );
  }

  // Criterion 14 — a break is still running, with the elapsed duration.
  if (hasUnendedBreak(today)) {
    const elapsed = activeBreakMinutes(today, evaluatedAtMs);
    alerts.push(
      alertOf(
        'break_active',
        workDate,
        `Your break is still active, ${minutesPhrase(elapsed)} so far. End the break to resume recording worked time.`,
        { breakMinutes: roundToTwoDecimals(elapsed) },
      ),
    );
  }

  // Criterion 15 — the scheduled end has passed with a session still open.
  const scheduledEndMs = parseInstantMs(today.scheduledEnd);
  if (scheduledEndMs !== null && evaluatedAtMs > scheduledEndMs && today.hasOpenSession) {
    const past = (evaluatedAtMs - scheduledEndMs) / MINUTE_MS;
    alerts.push(
      alertOf(
        'shift_ended_open_session',
        workDate,
        `Your scheduled shift ended ${minutesPhrase(past)} ago and your clock session is still open.`,
        { minutesPastScheduledEnd: roundToTwoDecimals(past) },
      ),
    );
  }

  // Criterion 16 — a missing clock-out on one of the seven preceding dates.
  const windowStart = addCalendarDays(workDate, -MY_DAY_ALERT_HISTORY_DAYS);
  const missingClockOutDates = [
    ...new Set(
      (precedingSevenDays ?? [])
        .filter(
          (record) =>
            record.derivedStatus === 'missing_clock_out' &&
            record.workDate < workDate &&
            record.workDate >= windowStart,
        )
        .map((record) => record.workDate),
    ),
  ].sort();

  for (const date of missingClockOutDates) {
    alerts.push(
      alertOf(
        'missing_clock_out_recent',
        date,
        `A clock-out is missing for ${date}. Ask an administrator to correct it, because the date cannot be paid until it is.`,
        { workDate: date },
      ),
    );
  }

  // Criterion 17 — a session well outside the scheduled shift.
  const excursion = shiftExcursionMinutes(today);
  const startedEarly = excursion.beforeStart > OUTSIDE_SHIFT_MARGIN_MINUTES;
  const endedLate = excursion.afterEnd > OUTSIDE_SHIFT_MARGIN_MINUTES;
  if (startedEarly || endedLate) {
    const parts: string[] = [];
    if (startedEarly) {
      parts.push(`began ${minutesPhrase(excursion.beforeStart)} before your scheduled start`);
    }
    if (endedLate) {
      parts.push(`ended ${minutesPhrase(excursion.afterEnd)} after your scheduled end`);
    }
    alerts.push(
      alertOf(
        'outside_scheduled_shift',
        workDate,
        `You are working outside your scheduled shift: a clock session ${parts.join(', and one ')}.`,
        {
          minutesBeforeScheduledStart: roundToTwoDecimals(excursion.beforeStart),
          minutesAfterScheduledEnd: roundToTwoDecimals(excursion.afterEnd),
          marginMinutes: OUTSIDE_SHIFT_MARGIN_MINUTES,
        },
      ),
    );
  }

  return alerts;
}
