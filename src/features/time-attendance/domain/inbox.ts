// src/features/time-attendance/domain/inbox.ts
// The Needs_Attention_Inbox: everything the module has left unresolved, gathered
// from three already-derived sources, collapsed to one item per underlying
// record, and ordered worst first.
//
// The inbox exists because the work it lists is spread across four screens.
// Requirement 17, criterion 3 names seven categories that live on the Today
// screen, the Time Off & Coverage screen, and the Review Center, and an
// administrator should not have to visit all three to find out what is waiting.
//
// This module derives nothing. It reads `payrollBlocking`, `exceptions`, and
// `reviewedAt` off Daily_Attendance_Records the Attendance_Service produced,
// `pending`, `coverageRisk`, and `submittedAt` off Request_Inbox rows
// `domain/pto.ts` built, and `status` off the Projected_Coverage the
// Coverage_Service published. A second opinion about whether a punch is missing
// or a date is critical is exactly what Requirement 19, criterion 8 forbids, and
// it is what would let the inbox and the screen that owns the record disagree
// about the same record.
//
// Two structural choices carry most of the requirement:
//
//  1. **Items are keyed `${recordKind}:${recordId}`.** A record that qualifies
//     under several categories is written to the same key each time, so it can
//     only ever produce one item, which is Requirement 17, criterion 4 held by
//     construction rather than by a de-duplication pass afterwards. The item
//     carries the highest-severity category that qualified and the whole set
//     beside it.
//  2. **The key is a navigation target.** `recordKind` is
//     `NavigationTargetRecordKind` — the same three kinds `NavigationTarget`
//     accepts — and `recordId` is in the form
//     `shared/navigation-target.ts` parses: `profileId:workDate` for an
//     attendance day, the row id for a request, `YYYY-MM-DD` for a coverage
//     date. Selecting an item is therefore a `NavigationTarget` built from two
//     fields the item already carries (Requirement 17, criterion 6), and the
//     screen that owns each kind is resolved there rather than here.
//
// Nothing in this module scopes the item set to an employee. Requirement 17,
// criterion 8 is a visibility rule, and visibility is settled once, by
// `server/visibility.ts`, before the sources are read — the same place every
// other read in the module settles it. An inbox that filtered a second time
// would be a second answer to who may see what.
//
// Pure: no React, no I/O, no `Date.now()`. `evaluatedAt` arrives as an argument,
// so the item set and its order are a function of the sources alone.
//
// Requirements: 17.3 (the seven categories), 17.4 (one item per underlying
// record, even when it qualifies under several categories), 17.5 (each item
// carries the category, the affected employee or date, and the reason it is
// unresolved), 17.7 (ordered by category severity then by age, with
// Payroll_Blocking and Critical first), 17.10 (an item whose condition is
// resolved is absent from the next build).

import type { NavigationTargetRecordKind } from '@/components/app-sidebar';

import type { Department } from '../types';
import { PTO_TYPE_LABELS } from '../types';
import {
  MINUTE_MS,
  matchesRecordQuery,
  roundToTwoDecimals,
  type RecordPredicateId,
} from './attendance';
import { COVERAGE_SEVERITY, type CoverageStatus, type DateCoverage } from './coverage';
import { statusToken } from './presentation';
import type { RequestInboxRow } from './pto';
import type { AttendanceException, DailyAttendanceRecord } from './types';
import { zonedToInstant } from './work-date';

// ─── Categories ──────────────────────────────────────────────────────────────

/**
 * The seven categories Requirement 17, criterion 3 lists.
 *
 * Criterion 3 names them as a membership list; the order here is the severity
 * order, worst first, which is what criterion 7 asks the list to be sorted by.
 */
export type InboxCategory =
  | 'payroll_blocking'
  | 'critical_coverage'
  | 'missing_punch'
  | 'pending_request'
  | 'unapproved_unscheduled'
  | 'unapproved_correction'
  | 'unresolved_exception';

/** What one category is, and where it sits in the order. */
interface CategoryRule {
  /** Higher is worse, matching the `COVERAGE_SEVERITY` convention. */
  severity: number;
  /** Visible text for the item's category. Always non-empty. */
  label: string;
  /** What qualifies a record for the category, for a view that names its groups. */
  description: string;
}

/**
 * The one table of categories: severity, label, and what the category means.
 *
 * A `Record` over `InboxCategory`, so a category added to the vocabulary fails
 * the build until it has all three — the inbox can never render an item whose
 * category has no words.
 *
 * Severity runs from 6 down to 0 in the order the entries appear. Requirement 17,
 * criterion 7 fixes only the top of that order: Payroll_Blocking and Critical
 * coverage come first, because one holds an employee's pay and the other means a
 * date is staffed below what it requires. The remainder runs by how much of the
 * record is in doubt — a missing punch means the hours are unknown, a pending
 * request is a decision nobody has taken, unapproved unscheduled work and an
 * unreviewed correction are recorded accurately and waiting on a signature, and a
 * plain unresolved exception is the residue: a condition an administrator should
 * see that holds up nothing.
 *
 * `missing_punch` and `payroll_blocking` overlap heavily and are still separate,
 * because the overlap is not total: a missing clock-out always blocks payroll and
 * a missing clock-in blocks it only on a date carrying a published schedule
 * (Requirement 12, criterion 8), so a missing clock-in on an unscheduled date is
 * a missing punch and nothing more. Collapsing the two would lose that item.
 *
 * Requirements: 17.3, 17.7
 */
export const INBOX_CATEGORIES: Record<InboxCategory, CategoryRule> = {
  payroll_blocking: {
    severity: 6,
    label: 'Payroll blocking',
    description: 'The record carries an exception that holds payroll for this employee and date.',
  },
  critical_coverage: {
    severity: 5,
    label: 'Critical coverage',
    description: 'Projected coverage for the date is below the required minimum staffing.',
  },
  missing_punch: {
    severity: 4,
    label: 'Missing punch',
    description: 'A clock-in or a clock-out is missing on the date.',
  },
  pending_request: {
    severity: 3,
    label: 'Pending request',
    description: 'A time-off request is still awaiting its first decision.',
  },
  unapproved_unscheduled: {
    severity: 2,
    label: 'Unapproved unscheduled work',
    description: 'Unscheduled work on the date has not been approved, so payroll is held.',
  },
  unapproved_correction: {
    severity: 1,
    label: 'Unapproved correction',
    description: 'A correction is recorded on the date and the record has not been marked reviewed.',
  },
  unresolved_exception: {
    severity: 0,
    label: 'Unresolved exception',
    description: 'The record carries at least one exception and has not been marked reviewed.',
  },
};

/**
 * How bad each category is, higher being worse.
 *
 * A projection of `INBOX_CATEGORIES` rather than a second table, so the ordering
 * and the wording cannot drift apart.
 *
 * Requirements: 17.7
 */
export const CATEGORY_SEVERITY: Record<InboxCategory, number> = Object.fromEntries(
  Object.entries(INBOX_CATEGORIES).map(([category, rule]) => [category, rule.severity]),
) as Record<InboxCategory, number>;

/**
 * The categories worst first, which is the order items are grouped and sorted in.
 *
 * Derived from the table's severities, so it cannot disagree with them.
 *
 * Requirements: 17.7
 */
export const INBOX_CATEGORY_ORDER: readonly InboxCategory[] = (
  Object.keys(INBOX_CATEGORIES) as InboxCategory[]
).sort((a, b) => CATEGORY_SEVERITY[b] - CATEGORY_SEVERITY[a]);

/**
 * The worst category in a set, or null for an empty set.
 *
 * The collapse of Requirement 17, criterion 4: a record qualifying under several
 * categories carries the most serious of them. A value outside the vocabulary
 * contributes nothing rather than being ranked by accident.
 */
export function worstCategory(categories: Iterable<InboxCategory>): InboxCategory | null {
  let worst: InboxCategory | null = null;
  for (const category of categories) {
    const severity = CATEGORY_SEVERITY[category];
    if (severity === undefined) continue;
    if (worst === null || severity > CATEGORY_SEVERITY[worst]) worst = category;
  }
  return worst;
}

// ─── Item identity ───────────────────────────────────────────────────────────

/**
 * The key an item is collapsed on: `${recordKind}:${recordId}`.
 *
 * The kind is part of the key so that two record kinds cannot collide on a
 * shared identifier — a coverage date and an attendance day both name a
 * `YYYY-MM-DD`, and they are different records.
 *
 * Requirements: 17.4
 */
export function inboxItemKey(recordKind: NavigationTargetRecordKind, recordId: string): string {
  return `${recordKind}:${recordId}`;
}

/**
 * The record id for one employee on one work date: `profileId:workDate`.
 *
 * The form `parseAttendanceDayRecordId` in `shared/navigation-target.ts` reads,
 * written here so the two halves of the round trip are stated once each.
 *
 * Requirements: 17.6
 */
export function attendanceDayRecordId(profileId: string, workDate: string): string {
  return `${profileId}:${workDate}`;
}

// ─── The item ────────────────────────────────────────────────────────────────

/**
 * Who or what an item is about: the affected employee, the affected date, or
 * both.
 *
 * Requirement 17, criterion 5 asks for "the affected employee or date", so every
 * item carries at least one of them and `label` is the text that names whichever
 * it has. An attendance day has both; a request has an employee and the dates
 * they asked for; a coverage date has a date and no employee.
 */
export interface InboxSubject {
  /** `profiles.id`, or null for an item about a date and nobody in particular. */
  profileId: string | null;
  /** `profiles.display_name`, or null when the roster did not resolve the employee. */
  employeeName: string | null;
  department: Department | null;
  /**
   * The affected work date, `YYYY-MM-DD`, or null when the item names no date.
   *
   * For a request this is the first requested date, which is the date the
   * decision is running out of time against.
   */
  workDate: string | null;
  /** Visible text naming the employee, the date, or both. Always non-empty. */
  label: string;
}

/**
 * One unresolved thing, and everything the inbox displays about it.
 *
 * Requirements: 17.4, 17.5
 */
export interface InboxItem {
  /** `${recordKind}:${recordId}`. Unique across the returned list. */
  key: string;
  /** What `recordId` names, and which screen owns it. */
  recordKind: NavigationTargetRecordKind;
  recordId: string;
  /** The most serious category the record qualified under. */
  category: InboxCategory;
  /** Every category it qualified under, worst first. Always contains `category`. */
  categories: InboxCategory[];
  /** `CATEGORY_SEVERITY[category]`, carried so a view can group without a lookup. */
  severity: number;
  /** The affected employee or date. */
  subject: InboxSubject;
  /** Why the item is unresolved, as a sentence. Always non-empty. */
  reason: string;
  /**
   * The instant the item is aged from: when a request was submitted, or the
   * start of the work date an attendance or coverage item is about.
   *
   * The sort key behind criterion 7's "then by age", and an instant rather than a
   * duration so that the order does not move when `evaluatedAt` does.
   */
  since: string;
  /**
   * `evaluatedAt − since` in minutes.
   *
   * Signed: negative for an item about a date the evaluation instant has not
   * reached, which a critical coverage date next week is. The order follows
   * `since`, so every date already past comes before every date still ahead, and
   * the nearest of those ahead comes first.
   */
  ageMinutes: number;
}

// ─── Sources ─────────────────────────────────────────────────────────────────

/** The employee facts an item displays that a record does not carry. */
export interface InboxEmployee {
  profileId: string;
  /** `profiles.display_name`. */
  employeeName: string;
  department: Department | null;
}

/**
 * Employees keyed by profile id.
 *
 * Structurally the roster the read services already load, so the inbox, the
 * Exception_Queue, and the Request_Inbox name the same employee the same way.
 */
export type InboxEmployeeIndex = ReadonlyMap<string, InboxEmployee>;

/**
 * Everything the inbox is built from: three already-derived sets, the roster
 * that names their employees, and the instant the ages are measured to.
 *
 * Each set is optional, so a caller with nothing to contribute for one source
 * omits it rather than passing an empty array with a comment explaining why.
 *
 * The date window is the caller's. This module holds no notion of "today" and
 * therefore never decides that a date is too old or too far ahead to be worth
 * listing: the service reads the range the screens display, and the item set is
 * whatever is unresolved within it.
 */
export interface InboxSources {
  /**
   * The instant ages are measured to, ISO. Never read from a clock here — the
   * same instant the records were derived at.
   */
  evaluatedAt: string;
  /**
   * Daily_Attendance_Records, already derived. Five of the seven categories are
   * read from these.
   */
  records?: readonly DailyAttendanceRecord[];
  /** Request_Inbox rows, already built by `domain/pto.ts`. */
  requests?: readonly RequestInboxRow[];
  /** Projected_Coverage per date, as `projectCoverage` produced it. */
  coverage?: readonly DateCoverage[];
  /** Employee names and departments, for the item subjects. */
  employees?: InboxEmployeeIndex;
}

// ─── Which records qualify ───────────────────────────────────────────────────

/**
 * The five record categories, each as a conjunction of named record predicates
 * from `domain/attendance.ts`.
 *
 * Stated as predicate ids rather than as conditions of this module's own, so the
 * inbox and the Exception_Queue's saved filters cannot disagree about what
 * qualifies: an item in the `missing_punch` category is exactly a row the
 * queue's Missing punches filter returns, and selecting it lands on a screen
 * that agrees the record belongs there.
 *
 * Two of them read the review stamp and three deliberately do not. Requirement
 * 17, criterion 10 removes an item when its underlying condition is resolved,
 * and marking a row reviewed does not resolve a held payroll or a punch that is
 * still missing — the correction does. So `payroll_blocking`, `missing_punch`,
 * and `unapproved_unscheduled` persist until the record itself changes, while
 * `unresolved_exception` and `unapproved_correction` are the two whose condition
 * *is* the absence of a review.
 *
 * `unapproved_correction` is `corrected` and `unreviewed` together, which is the
 * only sense in which a correction in this module can be unapproved: corrections
 * apply immediately (Requirement 12, criteria 13 and 14) and carry no approval
 * state of their own, and the review stamp of criteria 15 and 16 is the signature
 * an administrator puts on a corrected record. An item therefore leaves this
 * category when the record is marked reviewed.
 *
 * Requirements: 17.3, 17.10
 */
const RECORD_CATEGORY_PREDICATES = {
  payroll_blocking: ['payroll_blocking'],
  missing_punch: ['missing_punches'],
  unapproved_unscheduled: ['pending_manager_approval'],
  unapproved_correction: ['corrected', 'unreviewed'],
  unresolved_exception: ['needs_attention'],
} as const satisfies Partial<Record<InboxCategory, readonly RecordPredicateId[]>>;

/** The record categories, worst first. */
const RECORD_CATEGORIES: readonly InboxCategory[] = INBOX_CATEGORY_ORDER.filter(
  (category): category is keyof typeof RECORD_CATEGORY_PREDICATES =>
    category in RECORD_CATEGORY_PREDICATES,
);

/**
 * True when a record qualifies for a category.
 *
 * The conjunction is applied by `matchesRecordQuery`, which is also what treats
 * an unrecognised predicate id as unsatisfiable — so a typo could only ever drop
 * a category, never widen one.
 */
function recordQualifies(record: DailyAttendanceRecord, category: InboxCategory): boolean {
  const predicates =
    RECORD_CATEGORY_PREDICATES[category as keyof typeof RECORD_CATEGORY_PREDICATES];
  if (predicates === undefined) return false;
  return matchesRecordQuery(record, { predicates });
}

// ─── Reasons ─────────────────────────────────────────────────────────────────

/** The rule descriptions of the exceptions a filter selects, as one sentence run. */
function describeExceptions(
  exceptions: readonly AttendanceException[],
  keep: (exception: AttendanceException) => boolean,
): string {
  const sentences = new Set<string>();
  for (const exception of exceptions) {
    if (!keep(exception)) continue;
    const description = typeof exception.ruleDescription === 'string'
      ? exception.ruleDescription.trim()
      : '';
    if (description !== '') sentences.add(description);
  }
  return [...sentences].join(' ');
}

const ALWAYS = () => true;

/**
 * Why a record is unresolved under one category.
 *
 * The exception categories report the rule descriptions the Attendance_Service
 * already attached, because Requirement 3, criterion 13 puts the rule that fired
 * on the record for exactly this purpose and rewording it here would be a second
 * account of the same condition. Each has a fallback sentence, so a record
 * carrying a condition with no readable description still states why it is
 * listed: criterion 5 asks for a reason, and an empty one is not a reason.
 *
 * Requirements: 17.5
 */
function recordReason(record: DailyAttendanceRecord, category: InboxCategory): string {
  const exceptions = record.exceptions ?? [];

  switch (category) {
    case 'payroll_blocking': {
      const detail = describeExceptions(exceptions, (exception) => exception.payrollBlocking);
      return detail === ''
        ? 'Payroll is held for this date until the record is corrected.'
        : `Payroll is held for this date. ${detail}`;
    }
    case 'missing_punch': {
      const detail = describeExceptions(exceptions, (exception) =>
        exception.code === 'missing_clock_in' || exception.code === 'missing_clock_out',
      );
      return detail === '' ? 'A punch is missing on this date.' : detail;
    }
    case 'unapproved_unscheduled': {
      const detail = describeExceptions(
        exceptions,
        (exception) => exception.code === 'unscheduled_work',
      );
      return detail === ''
        ? 'Unscheduled work on this date has not been approved, so payroll is held.'
        : detail;
    }
    case 'unapproved_correction':
      return 'A correction is recorded on this date and the record has not been marked reviewed.';
    default: {
      const detail = describeExceptions(exceptions, ALWAYS);
      return detail === ''
        ? 'This record has not been marked reviewed.'
        : `${detail} The date has not been marked reviewed.`;
    }
  }
}

/** `3 working days`, `1 working day`. */
function daysPhrase(days: number): string {
  const value = roundToTwoDecimals(days);
  return `${value} ${value === 1 ? 'working day' : 'working days'}`;
}

/** `on 2026-03-12`, or `from 2026-03-12 to 2026-03-16`. */
function datesPhrase(from: string, to: string): string {
  return from === to ? `on ${from}` : `from ${from} to ${to}`;
}

/**
 * Why a pending request is unresolved: what was asked for, and the two
 * conditions that make it more urgent than its age suggests.
 *
 * The short-notice condition and the coverage risk are read off the row rather
 * than recomputed, so the sentence cannot disagree with the Request_Inbox row it
 * came from. Coverage is mentioned only when it is worse than Healthy: naming a
 * healthy projection would pad every sentence with the one fact that calls for
 * nothing.
 *
 * Requirements: 17.5
 */
function requestReason(row: RequestInboxRow): string {
  const type = PTO_TYPE_LABELS[row.ptoType] ?? 'Time off';
  const parts = [
    `${type} for ${daysPhrase(row.workingDays)} ${datesPhrase(row.startDate, row.endDate)} is awaiting a decision.`,
  ];

  if (row.shortNotice) parts.push('It was submitted on short notice.');
  if (row.coverageRisk !== null && isWorseThanHealthy(row.coverageRisk)) {
    parts.push(`Coverage on the requested dates is ${statusToken(row.coverageRisk).label}.`);
  }

  return parts.join(' ');
}

function isWorseThanHealthy(status: CoverageStatus): boolean {
  const severity = COVERAGE_SEVERITY[status];
  return severity !== undefined && severity > COVERAGE_SEVERITY.healthy;
}

/**
 * Why a date is unresolved: the status the Coverage_Service published for it, and
 * the two figures behind that status.
 *
 * The status label comes from `statusToken`, the one place a status becomes
 * words, so the sentence reads the same as the badge on the Coverage_Calendar
 * cell it refers to.
 *
 * A critical date always carries a configured requirement — `classifyCoverage`
 * reports Healthy when there is none — so the figures are always available in
 * practice; the shorter sentence is there so a projection that somehow lacks them
 * still states the status.
 *
 * Requirements: 17.5
 */
function coverageReason(coverage: DateCoverage): string {
  const label = statusToken(coverage.status).label;
  if (coverage.requiredStaff === null) {
    return `Projected coverage for this date is ${label}.`;
  }
  return `Projected coverage for this date is ${label}: ${coverage.available} of ${coverage.requiredStaff} required staff.`;
}

// ─── Subjects ────────────────────────────────────────────────────────────────

/**
 * The text that names an employee: their display name, or their identifier when
 * the roster did not resolve one.
 *
 * The identifier is not pretty, and it is what an administrator can act on. An
 * item that names nobody could not be followed up at all, and Requirement 17,
 * criterion 5 asks the affected employee to be displayed.
 */
function employeeLabel(profileId: string, employeeName: string | null): string {
  return employeeName === null || employeeName.trim() === '' ? profileId : employeeName.trim();
}

function employeeSubject(
  profileId: string,
  workDate: string | null,
  employees: InboxEmployeeIndex | undefined,
  known: { employeeName: string | null; department: Department | null } | null,
  label: (named: string) => string,
): InboxSubject {
  const resolved = employees?.get(profileId) ?? null;
  const employeeName = known?.employeeName ?? resolved?.employeeName ?? null;
  const department = known?.department ?? resolved?.department ?? null;

  return {
    profileId,
    employeeName,
    department,
    workDate,
    label: label(employeeLabel(profileId, employeeName)),
  };
}

// ─── Ages ────────────────────────────────────────────────────────────────────

/** An instant in milliseconds, or null when the value is absent or unreadable. */
function parseInstantMs(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? epochMs : null;
}

/**
 * The instant a calendar date begins, anchored in UTC.
 *
 * A work date is a property of the calendar date alone, so it is anchored where
 * every day is exactly 24 hours and no offset applies — the same anchor
 * `domain/pto.ts` uses for its calendar arithmetic, and for the same reason:
 * reading it in a real zone would make the ordering depend on daylight saving,
 * and reading it in the process timezone would make it depend on where the code
 * runs. The anchor only ever has to order dates against each other and against
 * request instants, which it does consistently.
 *
 * Null for a date that is malformed or names no real date, so one unreadable row
 * cannot blank the inbox.
 */
function dateAnchorMs(workDate: string): number | null {
  try {
    return zonedToInstant(workDate, '00:00:00', 'UTC').getTime();
  } catch {
    return null;
  }
}

// ─── Building ────────────────────────────────────────────────────────────────

/** One key's accumulated categories, before the worst of them is chosen. */
interface InboxDraft {
  recordKind: NavigationTargetRecordKind;
  recordId: string;
  subject: InboxSubject;
  sinceMs: number;
  /** The reason per category, from whichever source contributed that category. */
  reasons: Map<InboxCategory, string>;
}

/**
 * Add one qualifying category to a key, creating the draft on first sight.
 *
 * The first source seen for a key settles the subject and the age; later
 * contributions add categories only. Two records for the same employee and date
 * should not exist — the Attendance_Service produces at most one per employee per
 * date (Requirement 3, criterion 1) — and if one arrives anyway it merges into
 * the item already there rather than producing a second, which is the same
 * reading `deriveRibbonStates` gives a repeated date.
 */
function addCategory(
  drafts: Map<string, InboxDraft>,
  draft: Omit<InboxDraft, 'reasons'>,
  category: InboxCategory,
  reason: string,
): void {
  const key = inboxItemKey(draft.recordKind, draft.recordId);
  const existing = drafts.get(key);

  if (existing === undefined) {
    drafts.set(key, { ...draft, reasons: new Map([[category, reason]]) });
    return;
  }

  if (!existing.reasons.has(category)) existing.reasons.set(category, reason);
}

/**
 * Compare two items in the inbox's order: severity descending, then age key
 * ascending, then key.
 *
 * Requirement 17, criterion 7 states the first two: category severity, then age,
 * with Payroll_Blocking and Critical first. Severity descending puts those two
 * at the top by construction, since they hold the two highest severities in
 * `INBOX_CATEGORIES`. Ascending `since` puts the item that has been unresolved
 * longest first, which is descending age — the item that has waited longest is
 * the one to read first, the same choice `compareRequestRows` makes in
 * `domain/pto.ts`.
 *
 * The key breaks the remaining ties, so the order is total and does not depend on
 * the order the sources arrived in.
 *
 * Requirements: 17.7
 */
export function compareInboxItems(a: InboxItem, b: InboxItem): number {
  if (a.severity !== b.severity) return b.severity - a.severity;
  if (a.since !== b.since) return a.since < b.since ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Everything unresolved across the three sources, one item per underlying
 * record, worst first.
 *
 * The whole item set in one pass over each source, which is what lets
 * `/api/attendance/inbox` answer Requirement 17, criterion 9 in a single
 * request: the reads the screens already perform supply the sources, and this
 * function adds no read of its own.
 *
 * Criterion 10 needs no removal step. The item set is rebuilt from the sources
 * each time, and a record that no longer qualifies for any category contributes
 * no key — so resolving the underlying condition removes the item on the next
 * build, and there is no stored item that could outlive it.
 *
 * @throws RangeError if `evaluatedAt` is not a readable instant. It is
 *   constructed by the caller, so an unreadable one is programmer error rather
 *   than attendance data; every timestamp that arrives *with* the data is
 *   tolerated instead, because one bad row must not blank the inbox.
 *
 * Requirements: 17.3, 17.4, 17.5, 17.7, 17.10
 */
export function buildInbox(sources: InboxSources): InboxItem[] {
  const evaluatedAtMs = parseInstantMs(sources.evaluatedAt);
  if (evaluatedAtMs === null) {
    throw new RangeError(
      `buildInbox: evaluatedAt must be an instant, received "${String(sources.evaluatedAt)}"`,
    );
  }

  const drafts = new Map<string, InboxDraft>();
  const employees = sources.employees;

  // ── Attendance records: five of the seven categories ──────────────────────
  for (const record of sources.records ?? []) {
    const qualifying = RECORD_CATEGORIES.filter((category) => recordQualifies(record, category));
    if (qualifying.length === 0) continue;

    const draft = {
      recordKind: 'attendance_day' as const,
      recordId: attendanceDayRecordId(record.profileId, record.workDate),
      subject: employeeSubject(
        record.profileId,
        record.workDate,
        employees,
        null,
        (named) => `${named} on ${record.workDate}`,
      ),
      sinceMs: dateAnchorMs(record.workDate) ?? evaluatedAtMs,
    };

    for (const category of qualifying) {
      addCategory(drafts, draft, category, recordReason(record, category));
    }
  }

  // ── Requests: the ones awaiting a first decision ──────────────────────────
  for (const row of sources.requests ?? []) {
    if (!row.pending) continue;

    addCategory(
      drafts,
      {
        recordKind: 'pto_request',
        recordId: row.requestId,
        subject: employeeSubject(
          row.profileId,
          row.startDate,
          employees,
          { employeeName: row.employeeName, department: row.department },
          (named) => `${named}, ${datesPhrase(row.startDate, row.endDate)}`,
        ),
        // A row whose submission instant cannot be read is aged from the
        // evaluation instant, so it sorts last within its category rather than
        // taking the list off the screen.
        sinceMs: parseInstantMs(row.submittedAt) ?? evaluatedAtMs,
      },
      'pending_request',
      requestReason(row),
    );
  }

  // ── Coverage: the dates below their required minimum ──────────────────────
  for (const dateCoverage of sources.coverage ?? []) {
    if (dateCoverage.status !== 'critical') continue;

    addCategory(
      drafts,
      {
        recordKind: 'coverage_date',
        recordId: dateCoverage.workDate,
        subject: {
          profileId: null,
          employeeName: null,
          department: null,
          workDate: dateCoverage.workDate,
          label: dateCoverage.workDate,
        },
        sinceMs: dateAnchorMs(dateCoverage.workDate) ?? evaluatedAtMs,
      },
      'critical_coverage',
      coverageReason(dateCoverage),
    );
  }

  const items: InboxItem[] = [];
  for (const [key, draft] of drafts) {
    const categories = INBOX_CATEGORY_ORDER.filter((category) => draft.reasons.has(category));
    const category = worstCategory(categories);
    // Unreachable: a draft exists only because a category was added to it.
    if (category === null) continue;

    items.push({
      key,
      recordKind: draft.recordKind,
      recordId: draft.recordId,
      category,
      categories,
      severity: CATEGORY_SEVERITY[category],
      subject: draft.subject,
      reason: draft.reasons.get(category) ?? INBOX_CATEGORIES[category].description,
      since: new Date(draft.sinceMs).toISOString(),
      ageMinutes: roundToTwoDecimals((evaluatedAtMs - draft.sinceMs) / MINUTE_MS),
    });
  }

  return items.sort(compareInboxItems);
}
