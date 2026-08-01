// src/features/time-attendance/timeoff/RequestDecisionDrawer.tsx
// One time-off request, everything an administrator needs to answer it, and the
// eight ways they can.
//
// This is the third pane of the Time Off & Coverage screen and the seam
// `TimeOffCoverageScreen` calls `renderDecision`. The screen owns the heading, the
// close control, and whether the pane is a column or a full-width drawer; this
// component owns the content. It answers Requirement 9 and the decision half of
// Requirement 10:
//
// | shown                                    | read from                              | criterion |
// | ---------------------------------------- | -------------------------------------- | --------- |
// | employee, department, type, dates, days  | the `RequestRow` the inbox returned    | 9.7       |
// | the stated reason                        | `request.reason`                       | 9.7       |
// | balance before and after approval        | `DecisionContext.balanceBefore/After`  | 9.8       |
// | calendar days of notice                  | `DecisionContext.noticeDays`           | 9.9       |
// | the requester's other absences ±14 days  | `DecisionContext.nearbyAbsences`       | 9.10      |
// | overlapping pending requests             | `DecisionContext.overlappingPending`   | 9.11      |
// | available backup employees               | `DecisionContext.backupsByDate`        | 9.12      |
// | notes and the entries against the request | `request.reason`, `request.decisions` | 9.13      |
// | the projection per date and interval     | `ApprovalImpactPreview`                | 9.1–9.6   |
// | a date with no projection, and why       | `unavailable.reason`                   | 9.14      |
// | all eight decision options               | `DECISION_OPTIONS`                     | 10.1      |
// | a denial carries a reason                | `reasonWithContent`                    | 10.3      |
// | the below-minimum guard and its escapes  | `evaluateApprovalGuard`                | 10.9, 10.10 |
//
// ## It derives nothing
//
// Every figure above comes from `domain/pto.ts` — `buildDecisionContext` for the
// context, `evaluateApprovalGuard` for the guard, `collectShortfalls` for what the
// guard is evaluated against, `approvedRangesForDecision` for what a decision
// approves, `decisionApproves` for which decisions the guard applies to — or from
// the Coverage_Service's own projection. That matters twice over: the balance
// after approval shown here is the movement `pto_decide()` will apply, and the
// shortfall this drawer blocks on is the shortfall the service blocks on, because
// both read the same function over the same projection (Correctness Properties 16
// and 17).
//
// ## Two reads, and why neither is per date
//
// **`/api/coverage/impact?request_id=…`** is the impact preview: the projection
// for every requested date with this request counted as a proposed absence. One
// request for the whole range.
//
// **`/api/pto?from=…&to=…`** over the requested range widened by
// `NEARBY_ABSENCE_DAYS` at each end is the context: the requester's other
// absences, the pending requests that overlap, and the roster the names and the
// coverage assignment control are drawn from. One request for the whole window.
//
// The impact read is skipped where it would say something untrue rather than
// something useful. A request already recorded as an approved absence is counted
// in the projection already, and asking for it again as a *proposed* absence would
// subtract the same person twice — `projectCoverage` documents that it counts the
// two lists independently, and rightly so. Those requests get the reason instead
// of a doubled figure. It is also skipped for a reader who does not administer
// attendance: their visibility is their own row, so the projection would be
// staffing computed over a roster of one, presented as a coverage status.
//
// ## The guard
//
// Requirement 10, criterion 9 blocks an approval that would put projected coverage
// below required staffing until one of three things is offered: coverage assigned
// for the shortfall, the shortfall acknowledged, or an override reason with
// content. All three are here, and the same three are what the service's 409
// `coverage_shortfall` invites — so a shortfall the drawer did not see, because
// the projection moved while the decision was being composed, arrives back with
// its own figures and the same three ways out.
//
// The guard is a client-side affordance over a server-side rule. `decide`
// re-projects and re-evaluates inside the request's row lock, so a browser that
// skipped the guard is refused rather than obeyed.
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13,
// 9.14, 10.1, 10.3, 10.9, 10.10, 10.17, 10.19, 22.5, 22.6, 22.7, 22.9, 22.12,
// 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../../nhwd-shared/types';
import { statusLabel, ui } from '../../nhwd-shared/ui';
import {
  DECISION_OPTIONS,
  NEARBY_ABSENCE_DAYS,
  REQUEST_PAGE_LIMIT,
  SHORT_NOTICE_DAYS,
  approvedRangesForDecision,
  buildDecisionContext,
  calendarDaysBetween,
  decisionApproves,
  evaluateApprovalGuard,
  reasonWithContent,
  type ApprovedAbsence,
  type CoverageShortfall,
  type DecisionContext,
  type DecisionOption,
  type PTORequestRecord,
  type ScheduledShift,
} from '../domain/pto';
import type { DateRange } from '../domain/types';
import { addCalendarDays, consecutiveDates, workDateOf } from '../domain/work-date';
import type { AttendanceEmployee } from '../server/attendance-service';
import type { ImpactResponse } from '../server/coverage-service';
import type { DecisionResult, RequestDecisionSummary, RequestRow } from '../server/pto-service';
import { asApiFailure, attendanceJson, jsonRequest, type ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { formatDays, formatInstantDate, formatTimeOfDay, formatWorkDate, NO_VALUE } from '../shared/format';
import { newIdempotencyKey } from '../shared/idempotency';
import { requestQueryUrl } from '../shared/request-query';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken } from '../shared/tokens';
import { useAsyncResource } from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS, PTO_TYPE_LABELS, type PTOStatus } from '../types';
import { ApprovalImpactPreview, impactShortfalls } from './ApprovalImpactPreview';
import type { DecisionPaneContext, RequestInboxResponse } from './TimeOffCoverageScreen';

// ─── The eight options, in words ─────────────────────────────────────────────

/**
 * What each decision is called, in the words Requirement 10, criterion 1 uses.
 *
 * Wording only. The set of options is `DECISION_OPTIONS`, the status each one
 * stores is `DECISION_RULES`, and which of them approve leave is
 * `decisionApproves` — all in `domain/pto.ts`, all shared with the service and the
 * database's check constraint. This map cannot add an option or change what one
 * does; it can only name them, which is why it lives beside the screen that
 * renders them.
 *
 * Requirements: 10.1
 */
export const DECISION_LABELS: Record<DecisionOption, string> = {
  approve_full: 'Approve full request',
  deny: 'Deny request',
  approve_partial: 'Approve part of the request',
  suggest_dates: 'Suggest different dates',
  assign_coverage: 'Find or assign coverage',
  approve_with_coverage: 'Approve after assigning coverage',
  waitlist: 'Add to waitlist',
  request_info: 'Request additional information',
};

/** What each decision does to the request, said before it is committed. */
export const DECISION_NOTES: Record<DecisionOption, string> = {
  approve_full:
    'Approves every requested date and debits the balance for the working days it covers.',
  deny: 'Denies the request. A reason is required and is shown to the employee.',
  approve_partial:
    'Approves the dates you name and declines the rest. Only the approved working days are debited.',
  suggest_dates:
    'Asks the employee to consider other dates. The status becomes information requested and the balance is untouched.',
  assign_coverage:
    'Creates or amends the covering employee\u2019s shift and links it to this request. The request itself stays as it is, waiting for one of the other decisions.',
  approve_with_coverage:
    'Assigns the coverage below, then approves every requested date and debits the balance.',
  waitlist: 'Holds the request on the waitlist. The balance is untouched.',
  request_info:
    'Asks the employee a question. The status becomes information requested and the balance is untouched.',
};

/** The reason field a decision carries, and whether the requirements make it mandatory. */
const REASON_FIELD: Record<DecisionOption, { label: string; placeholder: string; required: boolean }> = {
  approve_full: {
    label: 'Note (optional)',
    placeholder: 'Stored with the decision and shown to the employee.',
    required: false,
  },
  // Requirement 10, criterion 3.
  deny: {
    label: 'Denial reason',
    placeholder: 'Why the request is refused. Shown to the employee.',
    required: true,
  },
  approve_partial: {
    label: 'Note (optional)',
    placeholder: 'Why part of the request could not be approved.',
    required: false,
  },
  suggest_dates: {
    label: 'Note (optional)',
    placeholder: 'Why these dates work better.',
    required: false,
  },
  assign_coverage: {
    label: 'Note (optional)',
    placeholder: 'Stored with the coverage assignment.',
    required: false,
  },
  approve_with_coverage: {
    label: 'Note (optional)',
    placeholder: 'Stored with the decision and shown to the employee.',
    required: false,
  },
  waitlist: {
    label: 'Note (optional)',
    placeholder: 'What the employee is waiting on.',
    required: false,
  },
  // Requirement 10, criterion 7: the question is the payload that tells this
  // decision apart from suggesting dates.
  request_info: {
    label: 'Question',
    placeholder: 'What the employee needs to answer.',
    required: true,
  },
};

/** `pto_requests` statuses that already record an absence in the projection. */
const COUNTED_ABSENCE_STATUSES: readonly PTOStatus[] = ['approved', 'partially_approved'];

// ─── Sentences the reader sees ───────────────────────────────────────────────

const NOT_ADMINISTRATOR_NOTE =
  'Deciding a time-off request is an attendance administrator\u2019s action. What you can see here is your own request and the reviewer\u2019s answer to it.';

/** Requirement 10, criterion 19, said before the request is submitted rather than after. */
const OWNER_CANNOT_DECIDE_NOTE =
  'You submitted this request, so you cannot decide it. Another attendance administrator has to.';

const ALREADY_COUNTED_NOTE =
  'This request is already recorded as an approved absence, so the projection has already subtracted it. Counting it again as a proposal would subtract the same person twice, so no impact preview is shown \u2014 the Coverage_Calendar shows these dates as they now stand.';

const PROJECTION_NOT_FOR_EMPLOYEE_NOTE =
  'Projected coverage is computed across the team, which is an attendance administrator\u2019s view, so it is not shown here.';

const GUARD_BLOCKED =
  'Approving this would leave staffing below the required minimum. Assign coverage for the shortfall, acknowledge it, or supply an override reason.';

const OVERRIDE_REASON_BLANK =
  'An override reason has to say something. A blank or whitespace-only reason is not an override.';

// ─── Calendar helpers ────────────────────────────────────────────────────────
//
// Both go through `domain/work-date.ts` and `domain/pto.ts`, which own the
// module's calendar arithmetic. Nothing here steps a date by hand.

/** `date` shifted by `days`, or `fallback` when it is not a date this module can step. */
function shiftedDate(date: string, days: number, fallback: string): string {
  try {
    return addCalendarDays(date, days);
  } catch {
    return fallback;
  }
}

/** Every calendar date an inclusive range covers, or none when it is unreadable. */
function datesOfRange(range: DateRange): string[] {
  try {
    const span = calendarDaysBetween(range.from, range.to) + 1;
    return span < 1 ? [] : consecutiveDates(range.from, span);
  } catch {
    return [];
  }
}

/** Every calendar date a set of ranges covers. */
function datesOf(ranges: readonly DateRange[]): Set<string> {
  const dates = new Set<string>();
  for (const range of ranges) {
    for (const date of datesOfRange(range)) dates.add(date);
  }
  return dates;
}

// ─── Stored rows as the domain reads them ────────────────────────────────────

/**
 * One inbox row as the domain's `PTORequestRecord`.
 *
 * The one field the row does not carry is `submissionDate`, the calendar date
 * `created_at` fell on, which the notice figure of criterion 9 is measured from.
 * It is resolved through `workDateOf` in the requester's own timezone — the same
 * conversion `pto-service` makes — rather than by slicing ten characters off the
 * instant, which near midnight is a different date and would move a request across
 * the short-notice boundary (Requirement 19, criterion 10).
 *
 * A row whose submission instant cannot be read falls back to the requested start,
 * which reports zero days of notice. That is the safe direction: it reads as short
 * notice rather than as a comfortable fortnight nobody can evidence.
 */
function toRequestRecord(row: RequestRow, timeZone: string): PTORequestRecord {
  const submitted = new Date(row.submittedAt);
  let submissionDate = row.startDate;
  if (Number.isFinite(submitted.getTime())) {
    try {
      submissionDate = workDateOf(submitted, timeZone);
    } catch {
      submissionDate = row.startDate;
    }
  }

  return {
    id: row.requestId,
    profileId: row.profileId,
    ptoType: row.ptoType,
    startDate: row.startDate,
    endDate: row.endDate,
    status: row.status,
    submittedAt: row.submittedAt,
    submissionDate,
    decidedAt: row.reviewedAt,
    workingDays: row.workingDays,
    shortNotice: row.shortNotice,
    reason: row.reason,
  };
}

/**
 * The dates one decided request actually keeps the employee away for.
 *
 * A fully approved request is away for its whole requested range. A partially
 * approved one is away for the sub-ranges its decision recorded, so the drawer
 * reads those from the decision rather than assuming the whole range — which would
 * report an employee absent on the dates their request was declined for.
 *
 * Every other status keeps nobody away: a pending or waitlisted request is a
 * proposal, and a denied or cancelled one is nothing at all.
 *
 * Requirements: 9.10, 9.12, 10.4
 */
function approvedAbsencesOf(row: RequestRow): ApprovedAbsence[] {
  if (!COUNTED_ABSENCE_STATUSES.includes(row.status)) return [];

  const base = { requestId: row.requestId, profileId: row.profileId, ptoType: row.ptoType };

  if (row.status === 'partially_approved') {
    const decided = row.decisions.find((entry) => entry.approvedRanges.length > 0);
    if (decided !== undefined) {
      return decided.approvedRanges.map((range) => ({ ...base, range }));
    }
  }

  return [{ ...base, range: { from: row.startDate, to: row.endDate } }];
}

/**
 * Who carries a published shift on each requested date, from the impact read.
 *
 * The projection already resolved the schedule rows for every date in the range,
 * so the backup set of criterion 12 is read off the same answer the coverage
 * figures came from rather than from a second schedule read that could disagree
 * with it.
 */
function scheduledShiftsOf(impact: ImpactResponse | null): ScheduledShift[] {
  if (impact === null) return [];

  const shifts: ScheduledShift[] = [];
  for (const date of impact.coverage.dates) {
    if (date.unavailable !== undefined) continue;
    for (const employee of date.scheduled) {
      shifts.push({ profileId: employee.profileId, workDate: date.workDate });
    }
  }
  return shifts;
}

/** The dates inside the requested range the organisation is closed. */
function closedDatesOf(impact: ImpactResponse | null): Set<string> {
  const closed = new Set<string>();
  if (impact === null) return closed;

  for (const date of impact.coverage.dates) {
    if (date.unavailable === undefined && date.closed) closed.add(date.workDate);
  }
  return closed;
}

/**
 * What is left of the requested range once `approved` is taken out of it: the
 * dates a partial approval declines.
 *
 * Requirement 10, criterion 4 records both halves, and the service refuses a
 * partial approval that names no declined range. The remainder is the leading and
 * trailing stretches either side of the approved sub-range, so an administrator
 * names the part they are approving and the part they are refusing follows from it
 * rather than being typed twice and risking a gap between the two.
 */
function declinedRemainder(requested: DateRange, approved: DateRange): DateRange[] {
  const declined: DateRange[] = [];

  if (approved.from > requested.from) {
    const to = shiftedDate(approved.from, -1, approved.from);
    if (to >= requested.from) declined.push({ from: requested.from, to });
  }

  if (approved.to < requested.to) {
    const from = shiftedDate(approved.to, 1, approved.to);
    if (from <= requested.to) declined.push({ from, to: requested.to });
  }

  return declined;
}

/**
 * The shortfalls a 409 `coverage_shortfall` carried, or null when the body held
 * none this drawer can read.
 *
 * The service answers that conflict with `current: { shortfalls, coverage }`,
 * which is the projection it evaluated inside the decision path. Those figures
 * supersede the ones the preview is holding — the projection can move between the
 * preview and the commit, and that is exactly the case the conflict exists for.
 * Fields are checked rather than cast: the body is untrusted input, and a
 * malformed entry would otherwise be rendered as a shortfall of `undefined`.
 */
function readServerShortfalls(current: unknown): CoverageShortfall[] | null {
  if (typeof current !== 'object' || current === null) return null;
  const listed = (current as { shortfalls?: unknown }).shortfalls;
  if (!Array.isArray(listed)) return null;

  const shortfalls: CoverageShortfall[] = [];
  for (const entry of listed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const source = entry as Record<string, unknown>;
    if (typeof source.workDate !== 'string') continue;
    if (typeof source.availableStaff !== 'number' || typeof source.requiredStaff !== 'number') {
      continue;
    }

    const interval = source.interval;
    const bounds =
      typeof interval === 'object' &&
      interval !== null &&
      typeof (interval as { start?: unknown }).start === 'string' &&
      typeof (interval as { end?: unknown }).end === 'string'
        ? {
            start: (interval as { start: string }).start,
            end: (interval as { end: string }).end,
          }
        : null;

    shortfalls.push({
      workDate: source.workDate,
      interval: bounds,
      availableStaff: source.availableStaff,
      requiredStaff: source.requiredStaff,
      shortBy:
        typeof source.shortBy === 'number'
          ? source.shortBy
          : source.requiredStaff - source.availableStaff,
    });
  }

  return shortfalls;
}

/** The status a 409 `stale_request_state` reported, or null. */
function readCurrentStatus(current: unknown): string | null {
  if (typeof current !== 'object' || current === null) return null;
  const status = (current as { status?: unknown }).status;
  return typeof status === 'string' && status !== '' ? status : null;
}

// ─── Presentational pieces ───────────────────────────────────────────────────

/** A titled block inside the pane. */
function Block({
  title,
  note,
  count,
  children,
}: {
  title: string;
  note?: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</h3>
        {count !== undefined && (
          <span
            className={`text-lg font-black tracking-tight ${count === 0 ? 'text-slate-300' : 'text-slate-800'}`}
          >
            {count}
          </span>
        )}
      </div>
      {note !== undefined && <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** One label-and-value pair. */
function Field({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div className="min-w-[6rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="text-[13px] font-black text-slate-900">{value}</dd>
      {note !== undefined && note !== null && note !== '' && (
        <p className="text-[11px] font-semibold text-slate-500">{note}</p>
      )}
    </div>
  );
}

/** Said in place of a list with nothing in it. */
function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-[12px] font-bold text-slate-400">{children}</p>;
}

/** A failure, with the fact that nothing was changed by it. */
function FailureNotice({ failure, children }: { failure: ApiFailure; children?: ReactNode }) {
  const critical = colorRoleToken('critical');

  return (
    <div
      role="alert"
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${critical.surface} ${critical.text} ${critical.border}`}
    >
      <StatusIcon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="text-[11px] font-black uppercase tracking-wider">Not recorded</p>
        <p className="mt-0.5 text-[12px] font-semibold">{failure.reason}</p>
        {children}
      </div>
    </div>
  );
}

// ─── Coverage assignment drafts ──────────────────────────────────────────────

/** One row of the coverage assignment editor. */
interface AssignmentDraft {
  key: string;
  /** `YYYY-MM-DD`, one of the requested dates. */
  date: string;
  coveringProfileId: string;
  /** `HH:MM`, as the time control produces it. */
  shiftStart: string;
  shiftEnd: string;
}

/** True when every field of an assignment is filled in. */
function isComplete(draft: AssignmentDraft): boolean {
  return (
    draft.date !== '' &&
    draft.coveringProfileId !== '' &&
    draft.shiftStart !== '' &&
    draft.shiftEnd !== ''
  );
}

// ─── The pane ────────────────────────────────────────────────────────────────

export interface RequestDecisionDrawerProps extends DecisionPaneContext {
  /**
   * The signed-in user.
   *
   * Two rules read it, and both are the module's shared ones rather than this
   * component's: `canAdministerAttendance` decides whether the decision controls
   * exist at all, and the identifier decides whether Requirement 10, criterion 19
   * applies — the owner of a request may not decide it, whatever their role.
   */
  profile: ProfileLite;
  /**
   * The zone dates and interval bounds are read in: the business timezone. These
   * figures describe the organisation's working day rather than any one reader's
   * clock.
   */
  timeZone?: string;
}

/**
 * The Request_Decision_Drawer's content.
 *
 * Requirements: 9.1, 9.3, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 10.1,
 * 10.3, 10.9, 10.10, 10.17, 10.19
 */
export function RequestDecisionDrawer({
  request,
  onCommitted,
  onClose,
  profile,
  timeZone = 'UTC',
}: RequestDecisionDrawerProps) {
  const canAdminister = canAdministerAttendance(profile.role);
  const ownRequest = request.profileId === profile.id;
  const canDecide = canAdminister && !ownRequest;
  const alreadyCounted = COUNTED_ABSENCE_STATUSES.includes(request.status);

  const [decision, setDecision] = useState<DecisionOption | null>(null);
  const [reason, setReason] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [partialFrom, setPartialFrom] = useState('');
  const [partialTo, setPartialTo] = useState('');
  const [suggestedFrom, setSuggestedFrom] = useState('');
  const [suggestedTo, setSuggestedTo] = useState('');
  const [assignments, setAssignments] = useState<AssignmentDraft[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [serverShortfalls, setServerShortfalls] = useState<CoverageShortfall[] | null>(null);
  const [staleStatus, setStaleStatus] = useState<string | null>(null);
  const [replayed, setReplayed] = useState(false);

  // One key per composed decision, kept across a retry and replaced once the
  // decision is in place. A resubmission after a failed attempt is then the replay
  // `/api/pto/decisions` is built for: it applies once if the first attempt never
  // landed, and answers `applied: false` if it did (Requirement 10, criterion 17).
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey());

  const requestedRange = useMemo<DateRange>(
    () => ({ from: request.startDate, to: request.endDate }),
    [request.startDate, request.endDate],
  );

  // ── The two reads ──────────────────────────────────────────────────────────

  const impactUrl = `/api/coverage/impact?request_id=${encodeURIComponent(request.requestId)}`;
  const impactEnabled = canAdminister && !alreadyCounted;

  const impact = useAsyncResource(
    (signal) => attendanceJson<ImpactResponse>(impactUrl, { signal }),
    {
      deps: [impactUrl],
      enabled: impactEnabled,
      subject: 'the coverage projection',
      filters: [
        { label: 'Dates', value: `${formatWorkDate(request.startDate)} to ${formatWorkDate(request.endDate)}` },
      ],
      isEmpty: (response) => response.coverage.dates.length === 0,
    },
  );

  // The requested range widened by a fortnight at each end, which is the window
  // criterion 10 measures a nearby absence against. One read for the whole window.
  const contextWindow = useMemo<DateRange>(
    () => ({
      from: shiftedDate(request.startDate, -NEARBY_ABSENCE_DAYS, request.startDate),
      to: shiftedDate(request.endDate, NEARBY_ABSENCE_DAYS, request.endDate),
    }),
    [request.startDate, request.endDate],
  );

  const contextRead = useMemo(
    () =>
      requestQueryUrl('/api/pto', {
        from: contextWindow.from,
        to: contextWindow.to,
        page: 1,
        limit: REQUEST_PAGE_LIMIT,
      }),
    [contextWindow],
  );

  const context = useAsyncResource(
    (signal) => attendanceJson<RequestInboxResponse>(contextRead.url, { signal }),
    {
      deps: [contextRead.url],
      subject: 'the requests around these dates',
      filters: [
        {
          label: 'Dates',
          value: `${formatWorkDate(contextWindow.from)} to ${formatWorkDate(contextWindow.to)}`,
        },
      ],
      // A window with no other request in it is not an empty screen: the request
      // being decided is the content, and the context around it is allowed to be
      // nothing.
      isEmpty: () => false,
    },
  );

  // Both memoised so the derivations below see a stable array: `?? []` produces a
  // new empty array on every render, and the decision context is rebuilt from it.
  const contextRows = useMemo<readonly RequestRow[]>(
    () => context.data?.rows ?? [],
    [context.data],
  );
  const employees = useMemo<readonly AttendanceEmployee[]>(
    () => context.data?.employees ?? [],
    [context.data],
  );

  const employeeById = useMemo(
    () => new Map(employees.map((employee) => [employee.profileId, employee])),
    [employees],
  );

  /** An employee's name, or something a reader can still tell two rows apart by. */
  const nameOf = useCallback(
    (profileId: string | null): string => {
      if (profileId === null || profileId === '') return 'Unknown employee';
      if (profileId === profile.id) return 'You';
      return employeeById.get(profileId)?.displayName ?? `Employee ${profileId.slice(0, 8)}`;
    },
    [employeeById, profile.id],
  );

  /** The requester's own zone, for the submission date the notice figure needs. */
  const requesterZone = employeeById.get(request.profileId)?.timezone ?? timeZone;

  // ── What decision is being composed ────────────────────────────────────────

  const partialRange = useMemo<DateRange | null>(
    () => (partialFrom === '' || partialTo === '' ? null : { from: partialFrom, to: partialTo }),
    [partialFrom, partialTo],
  );

  /**
   * The ranges an approval would take, for the context figures.
   *
   * The whole requested range, or the sub-range a partial approval names. Read
   * independently of which decision is selected, because criterion 8 asks for the
   * balance that *would* result after approval and criterion 12 for who could
   * cover the requested dates — both facts about the request, which an
   * administrator needs while they are still deciding whether to approve it at all.
   */
  const contemplatedRanges = useMemo<DateRange[]>(
    () =>
      decision === 'approve_partial' && partialRange !== null ? [partialRange] : [requestedRange],
    [decision, partialRange, requestedRange],
  );

  /**
   * The ranges the selected decision actually approves.
   *
   * `approvedRangesForDecision` is the domain's answer, so a non-approving
   * decision approves nothing and the guard has nothing to evaluate — which is
   * criterion 9 applying to approvals only, expressed once.
   */
  const approvedRanges = useMemo<DateRange[]>(
    () =>
      decision === null
        ? []
        : approvedRangesForDecision(decision, {
            requested: requestedRange,
            ...(partialRange === null ? {} : { approved: [partialRange] }),
          }),
    [decision, partialRange, requestedRange],
  );

  const approving = decision !== null && decisionApproves(decision);

  /**
   * The dates the shortfall count is taken over.
   *
   * The dates the selected decision approves once one is selected and it approves
   * something; the whole requested range before then, because the preview's
   * question until a decision is picked is "what would approving this do".
   */
  const countedDates = useMemo(
    () => datesOf(approving ? approvedRanges : [requestedRange]),
    [approving, approvedRanges, requestedRange],
  );

  const localShortfalls = useMemo(
    () => impactShortfalls(impact.data, countedDates),
    [impact.data, countedDates],
  );

  // The service's own figures win where it has answered a conflict: the projection
  // can move between the preview and the commit, and that is what the conflict is.
  const shortfalls = serverShortfalls ?? localShortfalls;

  // ── The decision context ───────────────────────────────────────────────────

  const approvedAbsences = useMemo<ApprovedAbsence[]>(
    () => contextRows.flatMap(approvedAbsencesOf),
    [contextRows],
  );

  const otherRequests = useMemo<PTORequestRecord[]>(
    () =>
      contextRows.map((row) =>
        toRequestRecord(row, employeeById.get(row.profileId)?.timezone ?? timeZone),
      ),
    [contextRows, employeeById, timeZone],
  );

  const decisionContext = useMemo<DecisionContext | null>(() => {
    try {
      return buildDecisionContext({
        request: toRequestRecord(request, requesterZone),
        approvedRanges: contemplatedRanges,
        // A row carrying no balance reports the remaining figure as unknown, and
        // the domain's own reading of a missing `pto_balances` row is none — so
        // that is what is passed, and the display says which of the two it is.
        remainingBalance: request.remainingBalance ?? 0,
        otherRequests,
        approvedAbsences,
        schedules: scheduledShiftsOf(impact.data),
        closedDates: closedDatesOf(impact.data),
      });
    } catch (error) {
      // The dates and the type came from the service already validated, so this is
      // unreachable short of a contract change. The context is dropped rather than
      // taking the pane down with it.
      console.error('[time-attendance] decision context could not be built', error);
      return null;
    }
  }, [approvedAbsences, contemplatedRanges, impact.data, otherRequests, request, requesterZone]);

  // ── The guard ──────────────────────────────────────────────────────────────

  const completeAssignments = useMemo(() => assignments.filter(isComplete), [assignments]);

  const verdict = useMemo(
    () =>
      evaluateApprovalGuard(approving ? shortfalls : [], {
        coverageAssigned: completeAssignments.length > 0,
        acknowledgedShortfall: acknowledged,
        overrideReason,
      }),
    [acknowledged, approving, completeAssignments.length, overrideReason, shortfalls],
  );

  const guardApplies = approving && shortfalls.length > 0;
  const guardBlocks = guardApplies && !verdict.permitted;

  // ── Composing ──────────────────────────────────────────────────────────────

  /**
   * A change to *what is being approved* invalidates the last verdict entirely.
   *
   * The shortfalls a 409 carried describe a particular set of approved dates, and
   * the replay notice describes the decision that landed. Neither survives a
   * change of decision or of the dates it approves.
   */
  const resetVerdict = useCallback(() => {
    setServerShortfalls(null);
    setStaleStatus(null);
    setReplayed(false);
    setBlocker(null);
    setFailure(null);
  }, []);

  /**
   * Offering an escape is not a change to what is being approved, so it clears
   * only the note about what was missing.
   *
   * The shortfall the service reported has to stay on screen while the
   * administrator answers it — coverage assigned, shortfall acknowledged, or an
   * override reason — because it is the thing they are answering.
   */
  const clearBlocker = useCallback(() => setBlocker(null), []);

  const selectDecision = useCallback(
    (next: DecisionOption) => {
      resetVerdict();
      setDecision((current) => (current === next ? null : next));
      setReason('');
      setOverrideReason('');
      setAcknowledged(false);
      // A fresh key: a different decision is a different change, not a retry of
      // the last one.
      idempotencyKeyRef.current = newIdempotencyKey();
    },
    [resetVerdict],
  );

  const addAssignment = useCallback(() => {
    clearBlocker();
    setAssignments((current) => [
      ...current,
      {
        key: newIdempotencyKey(),
        date: request.startDate,
        coveringProfileId: '',
        shiftStart: '',
        shiftEnd: '',
      },
    ]);
  }, [clearBlocker, request.startDate]);

  const changeAssignment = useCallback(
    (key: string, patch: Partial<Omit<AssignmentDraft, 'key'>>) => {
      clearBlocker();
      setAssignments((current) =>
        current.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)),
      );
    },
    [clearBlocker],
  );

  const removeAssignment = useCallback(
    (key: string) => {
      clearBlocker();
      setAssignments((current) => current.filter((draft) => draft.key !== key));
    },
    [clearBlocker],
  );

  /**
   * What is still missing before the decision can be submitted, or null.
   *
   * An affordance, not the rule: `assertDecisionPayload` in `pto-service.ts` is
   * the authority and refuses the same shapes. Stating them here saves a round
   * trip and puts the requirement beside the control it is about.
   */
  const missing = useMemo<string | null>(() => {
    if (decision === null) return 'Choose a decision.';

    const field = REASON_FIELD[decision];
    if (field.required && reasonWithContent(reason) === null) {
      return decision === 'deny'
        ? 'A denial carries a reason of at least one non-whitespace character.'
        : 'Requesting information carries the question you want answered.';
    }

    if (decision === 'approve_partial') {
      if (partialRange === null) return 'Name the dates you are approving.';
      if (partialRange.from > partialRange.to) return 'The approved range runs backwards.';
      if (partialRange.from < requestedRange.from || partialRange.to > requestedRange.to) {
        return `The approved dates have to fall inside ${formatWorkDate(requestedRange.from)} to ${formatWorkDate(requestedRange.to)}.`;
      }
      if (declinedRemainder(requestedRange, partialRange).length === 0) {
        return 'That approves every requested date, which is Approve full request.';
      }
    }

    if (decision === 'suggest_dates') {
      if (suggestedFrom === '' || suggestedTo === '') return 'Name the dates you are suggesting.';
      if (suggestedFrom > suggestedTo) return 'The suggested range runs backwards.';
    }

    if (decision === 'assign_coverage' && completeAssignments.length === 0) {
      return 'Assigning coverage carries at least one complete assignment.';
    }

    if (assignments.length > completeAssignments.length) {
      return 'Every coverage assignment needs a date, an employee, and both shift times.';
    }

    for (const draft of completeAssignments) {
      if (draft.date < requestedRange.from || draft.date > requestedRange.to) {
        return 'Coverage can only be assigned for a requested date.';
      }
      if (draft.coveringProfileId === request.profileId) {
        return 'The employee requesting the absence cannot cover it.';
      }
      if (draft.shiftStart >= draft.shiftEnd) {
        return 'A covering shift has to end after it starts.';
      }
    }

    if (guardBlocks) return GUARD_BLOCKED;

    return null;
  }, [
    assignments.length,
    completeAssignments,
    decision,
    guardBlocks,
    partialRange,
    reason,
    request.profileId,
    requestedRange,
    suggestedFrom,
    suggestedTo,
  ]);

  // ── Committing ─────────────────────────────────────────────────────────────

  const refreshImpact = impact.refresh;
  const refreshContext = context.refresh;

  const submit = useCallback(() => {
    if (decision === null || busy) return;
    if (missing !== null) {
      setBlocker(missing);
      return;
    }

    const trimmedReason = reasonWithContent(reason);

    const body: Record<string, unknown> = {
      request_id: request.requestId,
      decision,
      idempotency_key: idempotencyKeyRef.current,
      // The status the drawer opened against. Compared inside the request's row
      // lock, so two administrators deciding the same request cannot both debit it.
      expected_status: request.status,
    };

    if (decision === 'approve_partial' && partialRange !== null) {
      body.approved_ranges = [partialRange];
      body.declined_ranges = declinedRemainder(requestedRange, partialRange);
    }

    if (decision === 'suggest_dates') {
      body.suggested_ranges = [{ from: suggestedFrom, to: suggestedTo }];
    }

    if (completeAssignments.length > 0) {
      body.coverage_assignments = completeAssignments.map((draft) => ({
        date: draft.date,
        covering_profile_id: draft.coveringProfileId,
        shift_start: draft.shiftStart,
        shift_end: draft.shiftEnd,
      }));
    }

    if (trimmedReason !== null) body.reason = trimmedReason;

    // The two escapes that travel with the decision. Sent only where a shortfall
    // was there to escape: an acknowledgement of nothing is not a fact worth
    // storing, and `verdict.overrideReason` is the trimmed value criterion 10
    // requires to be stored.
    if (guardApplies) {
      if (acknowledged) body.acknowledged_shortfall = true;
      if (verdict.overrideReason !== null) body.override_reason = verdict.overrideReason;
    }

    setBusy(true);
    setBlocker(null);
    setFailure(null);
    setStaleStatus(null);
    setReplayed(false);

    void (async () => {
      try {
        const result = await attendanceJson<DecisionResult>(
          '/api/pto/decisions',
          jsonRequest('POST', body),
        );

        // Nothing is applied locally: the response carries the request rebuilt
        // from stored rows, and the screen replaces its held row from that.
        onCommitted(result.request);
        setReplayed(!result.applied);
        setDecision(null);
        setReason('');
        setOverrideReason('');
        setAcknowledged(false);
        setAssignments([]);
        setPartialFrom('');
        setPartialTo('');
        setSuggestedFrom('');
        setSuggestedTo('');
        setServerShortfalls(null);
        // The decision is in place, so the next submission is a new decision.
        idempotencyKeyRef.current = newIdempotencyKey();
        // Both reads moved: the projection because an absence was decided, the
        // context because this request's own status changed.
        refreshImpact();
        refreshContext();
      } catch (error) {
        const next = asApiFailure(error);
        setFailure(next);

        // The guard firing server-side. Its figures replace the preview's, and the
        // three escapes below are what it is asking for.
        if (next.code === 'coverage_shortfall') {
          const reported = readServerShortfalls(next.current);
          if (reported !== null) setServerShortfalls(reported);
        }

        if (next.code === 'stale_request_state') {
          setStaleStatus(readCurrentStatus(next.current));
        }
      } finally {
        setBusy(false);
      }
    })();
  }, [
    acknowledged,
    busy,
    completeAssignments,
    decision,
    guardApplies,
    missing,
    onCommitted,
    partialRange,
    reason,
    refreshContext,
    refreshImpact,
    request.requestId,
    request.status,
    requestedRange,
    suggestedFrom,
    suggestedTo,
    verdict.overrideReason,
  ]);

  // ── Rendering ──────────────────────────────────────────────────────────────

  const critical = colorRoleToken('critical');
  const warning = colorRoleToken('warning');
  const accent = colorRoleToken('accent');
  const healthy = colorRoleToken('healthy');

  const requestedDates = useMemo(() => datesOfRange(requestedRange), [requestedRange]);
  const assignableEmployees = useMemo(
    () => employees.filter((employee) => employee.profileId !== request.profileId),
    [employees, request.profileId],
  );
  const backupIds = new Set(decisionContext?.backupProfileIds ?? []);

  const reasonField = decision === null ? null : REASON_FIELD[decision];

  const impactNote = !canAdminister
    ? PROJECTION_NOT_FOR_EMPLOYEE_NOTE
    : alreadyCounted
      ? ALREADY_COUNTED_NOTE
      : null;

  return (
    <div className="space-y-3">
      {/* Criterion 7: what was asked for, by whom, for which dates, and why. The
          employee's name and the dates are the pane's heading, which the screen
          owns; repeated here only as the department and the type that qualify them. */}
      <div className="rounded-2xl bg-slate-50 px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] font-black text-slate-900">
            {PTO_TYPE_LABELS[request.ptoType]}
            <span className="ml-1.5 text-[11px] font-bold text-slate-400">
              {request.department === null
                ? 'No department'
                : DEPARTMENT_LABELS[request.department]}
            </span>
          </span>
          <StatusPill status={request.status} size="md" />
        </div>

        <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
          <Field
            label="Requested"
            value={`${formatWorkDate(request.startDate)} \u2013 ${formatWorkDate(request.endDate)}`}
            note={`${formatDays(request.workingDays)} of leave`}
          />
          {/* Criterion 8. Not floored: an approval that overdraws a balance is a
              fact the administrator is being asked to accept. */}
          <Field
            label="Balance now"
            value={formatDays(decisionContext?.balanceBefore ?? request.remainingBalance)}
            note={
              request.remainingBalance === null
                ? 'No balance row is recorded for that year, so the allocation reads as none.'
                : undefined
            }
          />
          <Field
            label="After approval"
            value={
              decisionContext === null ? NO_VALUE : formatDays(decisionContext.balanceAfter)
            }
            note={
              decisionContext !== null && decisionContext.shortfallDays > 0
                ? `${formatDays(decisionContext.shortfallDays)} beyond the balance`
                : undefined
            }
          />
          {/* Criterion 9. */}
          <Field
            label="Notice"
            value={
              decisionContext === null ? NO_VALUE : `${decisionContext.noticeDays} calendar days`
            }
            note={`Submitted ${formatInstantDate(request.submittedAt, requesterZone)}`}
          />
        </dl>

        {request.shortNotice && (
          <p className={`mt-1.5 text-[12px] font-black ${warning.text}`}>
            Short notice: fewer than {SHORT_NOTICE_DAYS} calendar days between submission and the
            requested start.
          </p>
        )}

        <div className="mt-2">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
            Stated reason
          </p>
          <p className="text-[12px] font-semibold text-slate-600">
            {request.reason ?? 'The employee gave no reason.'}
          </p>
        </div>
      </div>

      {/* Criteria 1 through 6 and 14. */}
      <ApprovalImpactPreview
        impact={impact.data}
        approvedDates={countedDates}
        shortfalls={shortfalls}
        status={impact.status}
        failure={impact.failure}
        pending={impact.pending}
        onRetry={impact.retry}
        emptyMessage={impact.emptyMessage}
        timeZone={timeZone}
        unavailableNote={impactNote}
      />

      {/* The decision itself. Requirement 10, criteria 1, 3, 9, and 10. */}
      {canDecide ? (
        <section
          aria-labelledby="request-decision-options-heading"
          className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3"
        >
          <h3
            id="request-decision-options-heading"
            className="text-xs font-black uppercase tracking-[0.14em] text-slate-500"
          >
            Decision
          </h3>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-500">
            {alreadyCounted
              ? 'This request already carries a decision. A further decision moves the status and reconciles the balance against what was already recorded.'
              : 'One of eight. The balance moves only for the three that approve leave.'}
          </p>

          {/* Criterion 1: all eight, in the order the criterion names them, read
              from the domain's list rather than from a list of this file's own. */}
          <div className="mt-2 flex flex-wrap gap-2">
            {DECISION_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => selectDecision(option)}
                aria-pressed={decision === option}
                disabled={busy}
                className={[
                  'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] font-black transition disabled:cursor-not-allowed disabled:opacity-40',
                  decision === option
                    ? `${accent.surface} ${accent.border} ${accent.text}`
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                ].join(' ')}
              >
                {DECISION_LABELS[option]}
              </button>
            ))}
          </div>

          {decision !== null && reasonField !== null && (
            <div className="mt-2.5 space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
              <p className="text-[12px] font-semibold text-slate-600">{DECISION_NOTES[decision]}</p>

              {/* Criterion 4: the dates being approved. What is declined follows
                  from them, so the two halves cannot leave a gap between them. */}
              {decision === 'approve_partial' && (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap gap-2">
                    <label className="block min-w-[9rem] flex-1">
                      <span className={ui.label}>Approve from</span>
                      <input
                        type="date"
                        value={partialFrom}
                        min={requestedRange.from}
                        max={requestedRange.to}
                        disabled={busy}
                        onChange={(event) => {
                          resetVerdict();
                          setPartialFrom(event.target.value);
                        }}
                        className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                      />
                    </label>
                    <label className="block min-w-[9rem] flex-1">
                      <span className={ui.label}>Approve to</span>
                      <input
                        type="date"
                        value={partialTo}
                        min={requestedRange.from}
                        max={requestedRange.to}
                        disabled={busy}
                        onChange={(event) => {
                          resetVerdict();
                          setPartialTo(event.target.value);
                        }}
                        className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                      />
                    </label>
                  </div>
                  {partialRange !== null && (
                    <p className="text-[11px] font-semibold text-slate-500">
                      Declined:{' '}
                      {declinedRemainder(requestedRange, partialRange)
                        .map(
                          (range) =>
                            `${formatWorkDate(range.from)} \u2013 ${formatWorkDate(range.to)}`,
                        )
                        .join(', ') || 'nothing'}
                    </p>
                  )}
                </div>
              )}

              {/* Criterion 5: the dates being offered instead. */}
              {decision === 'suggest_dates' && (
                <div className="flex flex-wrap gap-2">
                  <label className="block min-w-[9rem] flex-1">
                    <span className={ui.label}>Suggest from</span>
                    <input
                      type="date"
                      value={suggestedFrom}
                      disabled={busy}
                      onChange={(event) => {
                        resetVerdict();
                        setSuggestedFrom(event.target.value);
                      }}
                      className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                    />
                  </label>
                  <label className="block min-w-[9rem] flex-1">
                    <span className={ui.label}>Suggest to</span>
                    <input
                      type="date"
                      value={suggestedTo}
                      disabled={busy}
                      onChange={(event) => {
                        resetVerdict();
                        setSuggestedTo(event.target.value);
                      }}
                      className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                    />
                  </label>
                </div>
              )}

              {/* Criterion 8: the covering employee's shift, on a requested date,
                  linked to this request by the service. */}
              {(decision === 'assign_coverage' || decision === 'approve_with_coverage') && (
                <div className="space-y-2">
                  <p className="text-[11px] font-semibold text-slate-500">
                    Each assignment creates or amends that employee&rsquo;s shift on the date and
                    links it to this request.
                  </p>

                  {assignments.map((draft) => (
                    <div
                      key={draft.key}
                      className="space-y-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2"
                    >
                      <div className="flex flex-wrap gap-2">
                        <label className="block min-w-[8rem] flex-1">
                          <span className={ui.label}>Date</span>
                          <select
                            value={draft.date}
                            disabled={busy}
                            onChange={(event) =>
                              changeAssignment(draft.key, { date: event.target.value })
                            }
                            className={`${ui.select} mt-1 py-1.5 text-[13px]`}
                          >
                            {requestedDates.map((date) => (
                              <option key={date} value={date}>
                                {formatWorkDate(date)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block min-w-[10rem] flex-1">
                          <span className={ui.label}>Covering employee</span>
                          <select
                            value={draft.coveringProfileId}
                            disabled={busy}
                            onChange={(event) =>
                              changeAssignment(draft.key, {
                                coveringProfileId: event.target.value,
                              })
                            }
                            className={`${ui.select} mt-1 py-1.5 text-[13px]`}
                          >
                            <option value="">Choose an employee</option>
                            {assignableEmployees.map((employee) => (
                              <option key={employee.profileId} value={employee.profileId}>
                                {employee.displayName}
                                {backupIds.has(employee.profileId) ? ' \u00b7 available' : ''}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>

                      <div className="flex flex-wrap items-end gap-2">
                        <label className="block min-w-[7rem] flex-1">
                          <span className={ui.label}>Shift start</span>
                          <input
                            type="time"
                            value={draft.shiftStart}
                            disabled={busy}
                            onChange={(event) =>
                              changeAssignment(draft.key, { shiftStart: event.target.value })
                            }
                            className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                          />
                        </label>
                        <label className="block min-w-[7rem] flex-1">
                          <span className={ui.label}>Shift end</span>
                          <input
                            type="time"
                            value={draft.shiftEnd}
                            disabled={busy}
                            onChange={(event) =>
                              changeAssignment(draft.key, { shiftEnd: event.target.value })
                            }
                            className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                          />
                        </label>
                        <button
                          type="button"
                          onClick={() => removeAssignment(draft.key)}
                          disabled={busy}
                          className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}

                  <button
                    type="button"
                    onClick={addAssignment}
                    disabled={busy || assignableEmployees.length === 0}
                    className={`${ui.btnSecondary} px-3 py-1.5 text-[13px]`}
                  >
                    Add an assignment
                  </button>

                  {assignableEmployees.length === 0 && (
                    <p className="text-[11px] font-semibold text-slate-400">
                      No other employee is readable in this window, so coverage cannot be assigned
                      from here.
                    </p>
                  )}
                </div>
              )}

              <label className="block">
                <span className={ui.label}>{reasonField.label}</span>
                <textarea
                  value={reason}
                  rows={2}
                  disabled={busy}
                  onChange={(event) => {
                    clearBlocker();
                    setReason(event.target.value);
                  }}
                  className={`${ui.textarea} mt-1 py-1.5 text-[13px]`}
                  placeholder={reasonField.placeholder}
                />
              </label>

              {/* Criterion 9: the guard, and the three ways past it. It is shown
                  whenever an approval would create a shortfall, so the escapes are
                  where the shortfall is stated rather than behind a refusal. */}
              {guardApplies && (
                <div
                  className={`space-y-2 rounded-xl border px-3 py-2.5 ${critical.surface} ${critical.border}`}
                >
                  <p className={`text-[12px] font-black ${critical.text}`}>{GUARD_BLOCKED}</p>

                  <ul className="space-y-0.5">
                    {shortfalls.map((shortfall) => (
                      <li
                        key={`${shortfall.workDate}-${shortfall.interval?.start ?? 'day'}`}
                        className={`text-[11px] font-bold ${critical.text}`}
                      >
                        {formatWorkDate(shortfall.workDate)}
                        {shortfall.interval === null
                          ? ''
                          : ` ${formatTimeOfDay(shortfall.interval.start, timeZone)}\u2013${formatTimeOfDay(shortfall.interval.end, timeZone)}`}
                        {`: ${shortfall.availableStaff} of ${shortfall.requiredStaff}, short by ${shortfall.shortBy}`}
                      </li>
                    ))}
                  </ul>

                  <p className="text-[11px] font-semibold text-slate-600">
                    Assign coverage above, acknowledge the shortfall, or supply an override reason.
                    Any one of the three is enough.
                  </p>

                  <label className={ui.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={acknowledged}
                      disabled={busy}
                      onChange={(event) => {
                        clearBlocker();
                        setAcknowledged(event.target.checked);
                      }}
                    />
                    <span className="text-[12px] font-bold text-slate-700">
                      I have seen the shortfall and am approving anyway
                    </span>
                  </label>

                  <label className="block">
                    <span className={ui.label}>Override reason</span>
                    <input
                      type="text"
                      value={overrideReason}
                      disabled={busy}
                      onChange={(event) => {
                        clearBlocker();
                        setOverrideReason(event.target.value);
                      }}
                      className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                      placeholder="Stored with the decision and on the audit entry."
                    />
                  </label>

                  {/* Requirement 10, criterion 10: a reason with no content is not
                      an override. Said where it is typed rather than left to the
                      submit control to refuse. */}
                  {overrideReason !== '' && overrideReason.trim() === '' && (
                    <p className={`text-[11px] font-bold ${critical.text}`}>
                      {OVERRIDE_REASON_BLANK}
                    </p>
                  )}

                  {verdict.escapes.length > 0 && (
                    <p className={`text-[11px] font-black ${healthy.text}`}>
                      {`${verdict.escapes.map((escape) => statusLabel(escape)).join(', ')} \u2014 the approval may proceed.`}
                    </p>
                  )}
                </div>
              )}

              {blocker !== null && (
                <p role="alert" className={`text-[12px] font-bold ${critical.text}`}>
                  {blocker}
                </p>
              )}

              {failure !== null && (
                <FailureNotice failure={failure}>
                  {staleStatus === null ? (
                    <p className="mt-0.5 text-[11px] font-semibold opacity-80">
                      The request is exactly as it was.
                    </p>
                  ) : (
                    <>
                      <p className="mt-0.5 text-[11px] font-semibold opacity-80">
                        It now holds status {statusLabel(staleStatus)}. Reload it and decide against
                        what it says.
                      </p>
                      <button
                        type="button"
                        onClick={() => onCommitted(request)}
                        className="mt-1.5 rounded-lg border border-current/20 bg-white/70 px-2.5 py-1.5 text-[11px] font-black transition hover:bg-white"
                      >
                        Reload this request
                      </button>
                    </>
                  )}
                </FailureNotice>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={submit}
                  disabled={busy || guardBlocks}
                  className={`${ui.btnPrimary} px-3 py-1.5 text-[13px]`}
                >
                  {busy ? 'Submitting\u2026' : DECISION_LABELS[decision]}
                </button>
                <button
                  type="button"
                  onClick={() => selectDecision(decision)}
                  disabled={busy}
                  className={`${ui.btnSecondary} px-3 py-1.5 text-[13px]`}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Requirement 10, criterion 17 as the reader sees it: the decision was
              already in place, so nothing moved a second time. */}
          {replayed && (
            <p className={`mt-2 text-[12px] font-bold ${warning.text}`}>
              That decision was already recorded, so nothing was applied again.
            </p>
          )}
        </section>
      ) : (
        <p className="rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-[12px] font-semibold text-slate-600">
          {ownRequest && canAdminister ? OWNER_CANNOT_DECIDE_NOTE : NOT_ADMINISTRATOR_NOTE}
        </p>
      )}

      {/* The context read behind criteria 10 through 12, with its own states. */}
      <AsyncStateBlock
        status={context.status}
        failure={context.failure}
        pending={context.pending}
        onRetry={context.retry}
        subject="the requests around these dates"
        message={context.emptyMessage}
      />

      {context.data !== null && context.data.hasMore && (
        <p className="text-[11px] font-semibold text-slate-400">
          More requests fall in this window than one page carries, so the three lists below describe
          the first {context.data.limit}.
        </p>
      )}

      {/* Criterion 10. */}
      <Block
        title="Their other absences"
        note={`Approved time off for this employee within ${NEARBY_ABSENCE_DAYS} days of the requested dates.`}
        count={decisionContext?.nearbyAbsences.length ?? 0}
      >
        {decisionContext === null || decisionContext.nearbyAbsences.length === 0 ? (
          <Nothing>No approved absence of theirs falls near these dates.</Nothing>
        ) : (
          <ul className="space-y-1">
            {decisionContext.nearbyAbsences.map((absence) => (
              <li
                key={`${absence.requestId}-${absence.range.from}`}
                className="text-[13px] font-semibold text-slate-700"
              >
                {formatWorkDate(absence.range.from)} {'\u2013'} {formatWorkDate(absence.range.to)}
                <span className="ml-1.5 text-[11px] font-bold text-slate-400">
                  {PTO_TYPE_LABELS[absence.ptoType]}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {/* Criterion 11. */}
      <Block
        title="Overlapping pending requests"
        note="Awaiting a decision, from any employee, on dates this request covers."
        count={decisionContext?.overlappingPending.length ?? 0}
      >
        {decisionContext === null || decisionContext.overlappingPending.length === 0 ? (
          <Nothing>Nothing else is waiting on these dates.</Nothing>
        ) : (
          <ul className="space-y-1">
            {decisionContext.overlappingPending.map((pending) => (
              <li key={pending.id} className="text-[13px] font-semibold text-slate-700">
                {nameOf(pending.profileId)}
                <span className="ml-1.5 text-[11px] font-bold text-slate-400">
                  {PTO_TYPE_LABELS[pending.ptoType]} {'\u00b7'} {formatWorkDate(pending.startDate)}{' '}
                  {'\u2013'} {formatWorkDate(pending.endDate)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Block>

      {/* Criterion 12. */}
      <Block
        title="Available backup"
        note="Scheduled on the requested dates and holding no approved absence on them."
        count={decisionContext?.backupProfileIds.length ?? 0}
      >
        {decisionContext === null || decisionContext.backupsByDate.length === 0 ? (
          <Nothing>
            {impactEnabled
              ? 'Nobody else is scheduled on these dates.'
              : 'The published schedules behind this list come from the coverage projection, which is not read here.'}
          </Nothing>
        ) : (
          <ul className="space-y-1">
            {decisionContext.backupsByDate.map((entry) => (
              <li key={entry.workDate} className="text-[12px] font-semibold text-slate-700">
                <span className="font-black text-slate-900">{formatWorkDate(entry.workDate)}</span>
                {': '}
                {entry.profileIds.length === 0
                  ? 'nobody available'
                  : entry.profileIds.map((profileId) => nameOf(profileId)).join(', ')}
              </li>
            ))}
          </ul>
        )}
      </Block>

      {/* Criterion 13, first half: what has been written about this request. */}
      <Block
        title="Notes"
        note="What the employee wrote, and what a reviewer has answered."
        count={request.decisions.filter((entry) => entry.reason !== null).length}
      >
        <ul className="space-y-2">
          <li className="rounded-xl bg-slate-50 px-3 py-2">
            <p className="text-[12px] font-semibold text-slate-700">
              {request.reason ?? 'The employee gave no reason.'}
            </p>
            <p className="mt-0.5 text-[11px] font-bold text-slate-400">
              {nameOf(request.profileId)} {'\u00b7'} on submission
            </p>
          </li>

          {request.reviewerResponse === null ? (
            <li>
              <Nothing>No reviewer response yet.</Nothing>
            </li>
          ) : (
            <li className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-[12px] font-semibold text-slate-700">{request.reviewerResponse}</p>
              <p className="mt-0.5 text-[11px] font-bold text-slate-400">
                {nameOf(request.reviewedBy)}
                {request.reviewedAt === null
                  ? ''
                  : ` \u00b7 ${formatInstantDate(request.reviewedAt, timeZone)}`}
              </p>
            </li>
          )}
        </ul>
      </Block>

      {/* Criterion 13, second half. `pto_request_decisions` is the record
          `pto_decide()` writes the audit row from, and it is what a decision
          recorded against this request looks like: the decision, the status it
          moved from and to, the actor, the reason, the override, and the
          timestamp — Requirement 10, criterion 11's list. The log itself becomes
          readable directly when `/api/attendance/audit` lands with the Audit Log
          view; nothing here would change when it does. */}
      <Block
        title="Audit entries"
        note="Every decision committed against this request, newest first."
        count={request.decisions.length}
      >
        {request.decisions.length === 0 ? (
          <Nothing>Nothing has been decided on this request yet.</Nothing>
        ) : (
          <ul className="space-y-2">
            {request.decisions.map((entry) => (
              <DecisionEntry
                key={entry.decisionId}
                entry={entry}
                actorName={nameOf(entry.actorProfileId)}
                timeZone={timeZone}
              />
            ))}
          </ul>
        )}
      </Block>

      {/* The pane's own close control lives on the screen — inline it is a heading
          button, as an overlay it is the drawer's. This one is for a reader who has
          scrolled the whole context and is done with it. */}
      <div className="flex justify-end">
        <button type="button" onClick={onClose} className={`${ui.btnGhost} text-[13px]`}>
          Close
        </button>
      </div>
    </div>
  );
}

/**
 * One committed decision, as the audit entry it produced.
 *
 * Requirements: 9.13, 10.11
 */
function DecisionEntry({
  entry,
  actorName,
  timeZone,
}: {
  entry: RequestDecisionSummary;
  actorName: string;
  timeZone: string;
}) {
  const ranges = [
    ...entry.approvedRanges.map((range) => ({ label: 'approved', range })),
    ...entry.declinedRanges.map((range) => ({ label: 'declined', range })),
    ...entry.suggestedRanges.map((range) => ({ label: 'suggested', range })),
  ];

  return (
    <li className="rounded-xl bg-slate-50 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12px] font-black text-slate-800">
          {entry.decision === null ? 'Decision' : DECISION_LABELS[entry.decision]}
        </span>
        <span className="text-[11px] font-bold text-slate-400">
          {entry.decidedAt === null
            ? NO_VALUE
            : `${formatInstantDate(entry.decidedAt, timeZone)}, ${formatTimeOfDay(entry.decidedAt, timeZone)}`}
        </span>
      </div>

      <p className="mt-0.5 text-[11px] font-semibold text-slate-600">
        {entry.previousStatus === null ? NO_VALUE : statusLabel(entry.previousStatus)} &rarr;{' '}
        {entry.newStatus === null ? NO_VALUE : statusLabel(entry.newStatus)}
      </p>

      {ranges.length > 0 && (
        <p className="text-[11px] font-semibold text-slate-500">
          {ranges
            .map(
              ({ label, range }) =>
                `${label} ${formatWorkDate(range.from)}\u2013${formatWorkDate(range.to)}`,
            )
            .join(', ')}
        </p>
      )}

      {entry.reason !== null && (
        <p className="text-[11px] font-semibold text-slate-500">{entry.reason}</p>
      )}

      {entry.overrideReason !== null && (
        <p className={`text-[11px] font-bold ${colorRoleToken('warning').text}`}>
          Override: {entry.overrideReason}
        </p>
      )}

      <p className="text-[11px] font-bold text-slate-400">
        {actorName}
        {entry.acknowledgedShortfall ? ' \u00b7 shortfall acknowledged' : ''}
      </p>
    </li>
  );
}

/**
 * The Request_Decision_Drawer as `TimeOffCoverageScreen`'s `renderDecision` seam
 * expects it: a function of the pane context returning the pane's content.
 *
 * The screen owns the heading, the close control, and the choice between a third
 * column and a full-width overlay; it does not import the pane, so a screen with
 * no decision pane simply has none. This is the adapter that plugs one in:
 *
 * ```tsx
 * <TimeOffCoverageScreen
 *   initialProfile={profile}
 *   renderCoverage={renderCoveragePane({ timeZone: policy.businessTimezone })}
 *   renderDecision={renderDecisionPane({ profile, timeZone: policy.businessTimezone })}
 * />
 * ```
 *
 * `profile` and `timeZone` are parameters rather than fields of the context
 * because neither is a fact about the selected request: one is who is signed in,
 * the other is the organisation's zone.
 *
 * Requirements: 9.1, 10.1
 */
export function renderDecisionPane(options: {
  profile: ProfileLite;
  timeZone?: string;
}): (context: DecisionPaneContext) => ReactNode {
  return function DecisionPane(context: DecisionPaneContext) {
    return <RequestDecisionDrawer {...context} {...options} />;
  };
}

export default RequestDecisionDrawer;
