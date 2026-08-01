// src/features/time-attendance/shared/HealthRibbon.tsx
// The Health_Ribbon: seven dates from today, one state each, and any one of them
// opened out.
//
// Requirement 18 asks for the week ahead at a glance on the three operational
// screens, and for a selected date to open into the figures behind its state.
// This is that control:
//
// | asked for                                           | how                                      | criterion |
// | --------------------------------------------------- | ---------------------------------------- | --------- |
// | on Today, Schedule, and Time Off & Coverage         | mounted once, in the workspace           | 18.1      |
// | seven consecutive dates from the current date        | `RIBBON_DAYS` dates from today           | 18.2      |
// | one state per date, out of the five                  | the response's `ribbon`                  | 18.3–18.6 |
// | the state by label or icon as well as colour         | `CoverageBadge`, which renders all three | 18.7      |
// | a selected date's staffing picture                   | `RibbonDateDrawer`                       | 18.8      |
// | the exception records on the current or a past date  | one records read, for those dates only   | 18.9      |
// | the same state for a date on all three screens       | one endpoint, one derivation             | 18.10     |
// | the seven-date state set in a single request         | one `/api/coverage` read                 | 18.11     |
//
// ## It derives no state
//
// `deriveRibbonStates` in `domain/coverage.ts` decides what a date's state is,
// and the Coverage_Service runs it over the coverage it has just produced, then
// returns the result on `CoverageResponse.ribbon`. So this component reads seven
// states rather than computing them, and criteria 6 and 10 are structural: the
// ribbon cell, the Coverage_Calendar cell, and the coverage counters for one date
// are one answer rendered in three places, not three answers that happen to
// agree. A second derivation here — even through the same function — would be a
// second place for the strip to be wrong.
//
// The precedence behind those states is the domain's as well: Closed before
// No_Schedule before the coverage status, with At_Minimum presented as Warning.
// The drawer reads the uncollapsed status off `RibbonDate.coverage`, which is what
// lets it tell At_Minimum from Warning while the cell shows one of five states.
//
// ## Missing shifts and overtime risk
//
// Criterion 8 names six things a selected date shows. Four are figures the
// response already carries. The other two are readings of those figures, and each
// is stated in words beside its number so nothing is a bare figure of unclear
// provenance:
//
//   - **Missing shifts** is the shortfall against the date's minimum staffing:
//     `requiredStaff − available`, floored at zero, and unmeasurable rather than
//     zero when no minimum is configured. On the current or a past date, the
//     shifts nobody worked are shown beside it, from the records read.
//   - **Overtime risk** is what that shortfall implies for hours: work the date
//     needs covering that the staff who are there have to absorb. On the current
//     or a past date, the hours already worked beyond schedule are shown with it,
//     through `metricDefinition('overtime_hours')` — the module's one overtime
//     arithmetic — rather than a second subtraction written here.
//
// ## Two reads, and why the second is not always made
//
// The strip is one request (criterion 11). The exception records are a second,
// made only when a date is selected and only when that date is the current date or
// a past one: criterion 9 asks for them on those dates alone, and a future date has
// nothing recorded to ask about. `useAsyncResource`'s `enabled` holds that — an
// unselected or future date issues no request at all.
//
// Requirements: 18.1, 18.2, 18.3, 18.4, 18.5, 18.6, 18.7, 18.8, 18.9, 18.10,
// 18.11, 22.5, 22.6, 22.7, 22.9, 22.10, 22.11, 22.12, 22.14, 22.15, 22.16

'use client';

import { useMemo, useState, type ReactNode } from 'react';

import {
  EXCEPTION_CODES,
  filterRecords,
  metricDefinition,
  recordQueryForMetric,
  type RecordQuery,
} from '../domain/attendance';
import {
  RIBBON_DAYS,
  type CoverageInterval,
  type DepartmentProjection,
  type ProjectionFigures,
  type RibbonDate,
} from '../domain/coverage';
import { statusToken } from '../domain/presentation';
import type { DailyAttendanceRecord, DateRange } from '../domain/types';
import { addCalendarDays, workDateOf } from '../domain/work-date';
import type { RecordPage } from '../server/attendance-service';
import type {
  ComputedCoverageDate,
  CoverageAbsence,
  CoverageEmployee,
  CoverageResponse,
} from '../server/coverage-service';
import { DEPARTMENT_LABELS } from '../types';
import { attendanceJson } from './api-failure';
import { AsyncStateBlock } from './AsyncStateBlock';
import { CoverageBadge } from './CoverageBadge';
import { formatHours, formatWorkDate, formatWorkDateLong, NO_VALUE } from './format';
import { recordQueryUrl } from './record-query';
import { SideDrawer } from './SideDrawer';
import { StatusIcon } from './StatusIcon';
import { StatusPill } from './StatusPill';
import { colorRoleToken, PILL_ICON_SIZE, pillClassName, type ColorRole } from './tokens';
import { useAsyncResource } from './useAsyncResource';

/** The zone the strip's dates are read in when the caller names none. */
const FALLBACK_TIME_ZONE = 'UTC';

/** What stands in for a required figure `staffing_thresholds` does not configure. */
const UNCONFIGURED = 'Not set';

/** Weekday captions, indexed the way `Date.getUTCDay` numbers them: Sunday is 0. */
const WEEKDAY_CAPTIONS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * The two exception codes that mean a published shift was not worked.
 *
 * Both are the domain's own codes, selected here rather than defined here: the
 * conditions behind them are `EXCEPTION_RULES`' AX-01 and AX-05.
 */
const UNWORKED_SHIFT_CODES = ['missing_clock_in', 'absent'] as const;

/** The glyph each colour role carries where a reading has no status of its own. */
const RISK_ICONS: Record<ColorRole, string> = {
  neutral: 'CircleQuestionMark',
  accent: 'CircleGauge',
  healthy: 'ShieldCheck',
  warning: 'TriangleAlert',
  critical: 'OctagonAlert',
  pending: 'Hourglass',
};

/**
 * Today in a named zone, falling back to UTC for a zone this runtime cannot read.
 *
 * Through `workDateOf`, which is the module's one instant-to-work-date mapping
 * (Requirement 19, criterion 10). The zone is the organisation's rather than the
 * browser's: the strip describes the organisation's week, so a reader opening it
 * late in the evening should still see the organisation's current date first.
 */
function todayIn(timeZone: string): string {
  const now = new Date();
  try {
    return workDateOf(now, timeZone);
  } catch {
    return workDateOf(now, FALLBACK_TIME_ZONE);
  }
}

/**
 * The weekday caption of a calendar date, read at midnight UTC.
 *
 * Anchored at UTC, where every day is exactly 24 hours, so the weekday of a date
 * is a property of the calendar rather than of the zone the browser happens to be
 * in — the same reading the Coverage_Calendar's columns take.
 */
function weekdayCaption(workDate: string): string {
  const day = new Date(`${workDate}T00:00:00Z`).getUTCDay();
  return WEEKDAY_CAPTIONS[Number.isNaN(day) ? 0 : day];
}

/**
 * The one read the strip makes: projected coverage over the seven dates.
 *
 * `mode=projected` because six of the seven dates are in the future, and all
 * seven are asked for together because criterion 11 allows one request for the
 * whole state set. No department is sent: the ribbon is the organisation's week,
 * and the per-date breakdown carries the departments separately.
 *
 * Requirements: 18.2, 18.11
 */
function ribbonUrl(range: DateRange): string {
  const params = new URLSearchParams({ mode: 'projected', from: range.from, to: range.to });
  return `/api/coverage?${params.toString()}`;
}

/**
 * The exception records for one date: every record carrying at least one
 * exception, which is what naming every code asks for.
 *
 * Asked of the server rather than filtered out of a wider read, for the reason
 * `shared/record-query.ts` gives: a screen that filters asks the narrowed
 * question, so the rows it shows are the rows the query selected.
 *
 * Requirements: 18.9
 */
function exceptionsQuery(workDate: string): RecordQuery {
  return { from: workDate, to: workDate, exceptionCodes: EXCEPTION_CODES };
}

/**
 * Shifts the date is short of its minimum: `requiredStaff − available`, floored
 * at zero, and null when the slot carries no minimum.
 *
 * Null rather than zero for an unconfigured slot, for the same reason
 * `CoverageBadge` says so in words: a zero would read as a date with nothing
 * missing, when what is true is that nothing has been configured to miss
 * (Requirement 6, criterion 4).
 *
 * Requirements: 18.8
 */
export function missingShifts(figures: ProjectionFigures): number | null {
  if (figures.requiredStaff === null) return null;
  return Math.max(0, figures.requiredStaff - figures.available);
}

/** The intervals of a date whose available staffing is under the requirement. */
function shortIntervals(intervals: readonly CoverageInterval[]): CoverageInterval[] {
  return intervals.filter(
    (interval) =>
      interval.requiredStaff !== null && interval.availableStaff < interval.requiredStaff,
  );
}

/** How the overtime-risk reading renders, and why it reads that way. */
export interface OvertimeRisk {
  role: ColorRole;
  label: string;
  /** The reasoning, rendered as visible text (Requirement 22, criterion 7). */
  reason: string;
}

/**
 * The overtime risk a projected date carries.
 *
 * A reading of the coverage figures rather than a new figure: work a date needs
 * covering and has nobody spare for has to be absorbed by the staff who are
 * there, and that is where overtime comes from. So the shortfall decides it, the
 * date's own Coverage_Status decides the middle band — At_Minimum is no slack,
 * which is a warning and not yet a shortfall — and an unconfigured minimum makes
 * it unmeasurable rather than absent.
 *
 * A closed date is answered before any of that, and a date with no coverage right
 * after it. The organisation is not open, or nothing is published: either way a
 * shortfall against a staffing requirement is not a reason to expect extra hours.
 * That is the same precedence `deriveRibbonStates` applies to the state itself,
 * which is why this reads the state rather than the figures first.
 *
 * Requirements: 18.8
 */
export function overtimeRisk(date: RibbonDate, shortIntervalCount: number): OvertimeRisk {
  if (date.state === 'closed') {
    return {
      role: 'neutral',
      label: 'None',
      reason: 'The organisation is closed on this date, so no shift is expected to run long.',
    };
  }

  if (date.coverage === null) {
    return {
      role: 'neutral',
      label: 'Not measurable',
      reason:
        'No published schedule covers this date, so there is no expected staffing to measure a shortfall against.',
    };
  }

  const short = missingShifts(date.coverage);

  if (short === null) {
    return {
      role: 'neutral',
      label: 'Not measurable',
      reason:
        'No minimum staffing is configured for this date, so no shortfall can be measured and neither can the hours it would cost.',
    };
  }

  const intervals =
    shortIntervalCount === 0
      ? ''
      : ` ${shortIntervalCount} ${shortIntervalCount === 1 ? 'stretch' : 'stretches'} of the day ${
          shortIntervalCount === 1 ? 'sits' : 'sit'
        } under the requirement.`;

  if (short > 0) {
    return {
      role: 'critical',
      label: 'High',
      reason:
        `${short} ${short === 1 ? 'shift' : 'shifts'} short of the minimum, so the work has to be ` +
        `absorbed by the ${date.coverage.available} available rather than by anyone extra.${intervals}`,
    };
  }

  if (date.coverage.status === 'at_minimum' || date.coverage.status === 'warning') {
    return {
      role: 'warning',
      label: 'Some',
      reason:
        'Staffing is at or near the minimum, so one absence or late arrival on the day has to be covered by the staff already scheduled.' +
        intervals,
    };
  }

  return {
    role: 'healthy',
    label: 'Low',
    reason:
      'Projected staffing is above the minimum, so an uncovered stretch does not have to become extra hours.' +
      intervals,
  };
}

/**
 * What one ribbon cell's control is called, in full words.
 *
 * The cell is abbreviated to fit seven across, so its accessible name is written
 * out: the date, the state, and the figures behind it, in the order the cell
 * renders them (Requirement 22, criterion 12).
 *
 * Requirements: 22.12
 */
export function ribbonCellName(date: RibbonDate, isToday: boolean): string {
  const long = formatWorkDateLong(date.workDate);
  const when = isToday ? `Today, ${long}` : long;
  const state = statusToken(date.state).label;

  if (date.coverage === null) return `${when}. ${state}.`;

  const required =
    date.coverage.requiredStaff === null
      ? 'no minimum staffing configured'
      : `${date.coverage.requiredStaff} required`;

  return (
    `${when}. ${state}. ${date.coverage.available} projected available of ${required}, ` +
    `${date.coverage.scheduled} scheduled, ${date.coverage.approvedAbsences} approved off.`
  );
}

/**
 * One date of the strip: the weekday, the date, and its state.
 *
 * A real `button`, so the drawer has a control to return focus to when it closes
 * and the strip is reachable by keyboard without reinventing what a button
 * already does (Requirement 22, criteria 9, 10, and 11). The state is a
 * `CoverageBadge`, which carries the label and the icon as well as the colour —
 * criterion 7 in one component rather than in seven cells.
 *
 * Requirements: 18.3, 18.7, 22.9, 22.12
 */
function RibbonCell({
  date,
  isToday,
  selected,
  onSelect,
}: {
  date: RibbonDate;
  isToday: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const accent = colorRoleToken('accent');

  return (
    <li className="min-w-0">
      <button
        type="button"
        onClick={onSelect}
        aria-haspopup="dialog"
        aria-expanded={selected}
        aria-label={ribbonCellName(date, isToday)}
        className={[
          'flex h-full w-full flex-col items-start gap-1 rounded-xl border px-2 py-2 text-left transition',
          selected
            ? `${accent.surface} ${accent.border} ring-2 ${accent.ring}`
            : 'border-slate-200 bg-white hover:bg-slate-50',
        ].join(' ')}
      >
        <span className="flex w-full items-baseline justify-between gap-1">
          <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
            {weekdayCaption(date.workDate)}
          </span>
          <span
            className={
              isToday
                ? `rounded-md px-1.5 text-[13px] font-black ${accent.surface} ${accent.text}`
                : 'text-[13px] font-black text-slate-900'
            }
          >
            {Number(date.workDate.slice(8, 10))}
          </span>
        </span>

        {/* Without counts: the badge stands for the date rather than for a figure,
            and the two numbers under it are the projection the state came from. */}
        <CoverageBadge status={date.state} />

        <span className="text-[10px] font-bold leading-tight text-slate-500">
          {date.coverage === null
            ? NO_VALUE
            : `${date.coverage.available} of ${
                date.coverage.requiredStaff === null ? NO_VALUE : date.coverage.requiredStaff
              }`}
        </span>
      </button>
    </li>
  );
}

/** One labelled figure: a small caption over the value. */
function Figure({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-[5rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd
        className={`text-lg font-black tracking-tight ${muted ? 'text-slate-300' : 'text-slate-800'}`}
      >
        {value}
      </dd>
    </div>
  );
}

/** A titled block with an optional count in its corner, and its content under it. */
function Block({
  title,
  count,
  description,
  children,
}: {
  title: string;
  count?: number;
  description: string;
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
      <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{description}</p>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Said in place of a list with nothing in it. */
function Nothing({ children }: { children: ReactNode }) {
  return <p className="text-[12px] font-bold text-slate-400">{children}</p>;
}

/**
 * How an employee is named, or what stands in when the name was withheld.
 *
 * `displayName` is null for an employee outside the roster the response described
 * and for one whose name Requirement 8, criterion 13 withholds. The identifier
 * fragment tells two anonymous rows apart — three absences is three people —
 * without naming either.
 */
function coverageEmployeeLabel(employee: CoverageEmployee): string {
  return employee.displayName ?? `Employee ${employee.profileId.slice(0, 8)}`;
}

/** One employee list: the names behind a figure, or the absence of them. */
function EmployeeList({
  title,
  description,
  employees,
  empty,
}: {
  title: string;
  description: string;
  employees: readonly CoverageEmployee[];
  empty: string;
}) {
  return (
    <Block title={title} count={employees.length} description={description}>
      {employees.length === 0 ? (
        <Nothing>{empty}</Nothing>
      ) : (
        <ul className="space-y-1">
          {employees.map((employee) => (
            <li key={employee.profileId} className="text-[13px] font-semibold text-slate-700">
              {coverageEmployeeLabel(employee)}
              <span className="ml-1.5 text-[11px] font-bold text-slate-400">
                {employee.department === null
                  ? 'No department'
                  : DEPARTMENT_LABELS[employee.department]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

/** One absence list: the requests behind a figure, keyed by request. */
function AbsenceList({
  title,
  description,
  absences,
  empty,
}: {
  title: string;
  description: string;
  absences: readonly CoverageAbsence[];
  empty: string;
}) {
  return (
    <Block title={title} count={absences.length} description={description}>
      {absences.length === 0 ? (
        <Nothing>{empty}</Nothing>
      ) : (
        <ul className="space-y-1">
          {absences.map((absence) => (
            <li key={absence.requestId} className="text-[13px] font-semibold text-slate-700">
              {coverageEmployeeLabel(absence.employee)}
              <span className="ml-1.5 text-[11px] font-bold text-slate-400">
                {absence.startDate === absence.endDate
                  ? formatWorkDate(absence.startDate)
                  : `${formatWorkDate(absence.startDate)} \u2013 ${formatWorkDate(absence.endDate)}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

/**
 * The projection, and the two readings of it criterion 8 adds to the figures.
 *
 * Requirements: 18.8
 */
function DateFigures({
  date,
  coverage,
  records,
}: {
  date: RibbonDate;
  coverage: ComputedCoverageDate | null;
  /** The date's exception records, or empty for a date none were read for. */
  records: readonly DailyAttendanceRecord[];
}) {
  const figures = date.coverage;
  const short = figures === null ? null : missingShifts(figures);
  const shortIntervalCount = shortIntervals(coverage?.intervals ?? []).length;
  const risk = overtimeRisk(date, shortIntervalCount);

  // The two record-backed readings, both through the domain: the shifts nobody
  // worked, and the module's one overtime arithmetic. Empty on a future date,
  // because no records were read for one.
  const unworked = filterRecords(records, { exceptionCodes: [...UNWORKED_SHIFT_CODES] });
  const overtime = metricDefinition('overtime_hours');
  const overtimeRecords = filterRecords(records, recordQueryForMetric('overtime_hours'));
  const overtimeHours = overtime.aggregate(overtimeRecords);

  return (
    <>
      <div className="rounded-2xl bg-slate-50 px-3.5 py-3">
        <CoverageBadge
          status={date.state}
          available={figures?.available}
          requiredStaff={figures?.requiredStaff}
          size="md"
        />

        <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
          <Figure
            label="Required"
            value={
              figures === null || figures.requiredStaff === null
                ? UNCONFIGURED
                : String(figures.requiredStaff)
            }
            muted={figures === null || figures.requiredStaff === null}
          />
          <Figure
            label="Projected available"
            value={figures === null ? NO_VALUE : String(figures.available)}
          />
          <Figure
            label="Scheduled"
            value={figures === null ? NO_VALUE : String(figures.scheduled)}
          />
          <Figure
            label="Approved off"
            value={figures === null ? NO_VALUE : String(figures.approvedAbsences)}
            muted={figures !== null && figures.approvedAbsences === 0}
          />
          <Figure
            label="Pending requests"
            value={coverage === null ? NO_VALUE : String(coverage.pendingRequests.length)}
            muted={coverage !== null && coverage.pendingRequests.length === 0}
          />
        </dl>

        <p className="mt-2 text-[12px] font-semibold text-slate-600">
          Projected coverage is the employees carrying a published shift on this date, less those
          with an approved absence covering it. It reads no clock data, so it is the figure a leave
          decision is made against rather than a count of who is on the floor.
        </p>

        {/* The uncollapsed status, which a cell has no room for: the strip has five
            states and At_Minimum presents as Warning, so a reader who needs the
            difference reads it here (criteria 6 and 10). */}
        {figures !== null && (
          <p className="mt-1.5 text-[12px] font-semibold text-slate-500">
            The Coverage_Service reports this date as{' '}
            {statusToken(figures.status).label.toLowerCase()}.
          </p>
        )}

        {coverage !== null && coverage.closed && (
          <p className="mt-1.5 text-[12px] font-semibold text-slate-500">
            The organisation is closed on this date
            {coverage.closedLabel === null ? '' : ` (${coverage.closedLabel})`}, so a shortfall
            against a staffing requirement is not a staffing gap.
          </p>
        )}
      </div>

      <Block
        title="Missing shifts"
        count={short ?? undefined}
        description="Shifts the date is short of its minimum staffing: the requirement, less the projected available."
      >
        {short === null ? (
          <Nothing>
            No minimum staffing is configured for this date, so there is no shortfall to measure.
          </Nothing>
        ) : (
          <p className="text-[12px] font-semibold text-slate-600">
            {short === 0
              ? 'Projected staffing meets the minimum for this date.'
              : `${short} more ${short === 1 ? 'person' : 'people'} would be needed to meet the minimum.`}
            {shortIntervalCount > 0 &&
              ` ${shortIntervalCount} ${shortIntervalCount === 1 ? 'interval' : 'intervals'} of the day ${
                shortIntervalCount === 1 ? 'sits' : 'sit'
              } under the requirement.`}
          </p>
        )}

        {unworked.length > 0 && (
          <p className="mt-1.5 text-[12px] font-bold text-slate-600">
            {unworked.length} published {unworked.length === 1 ? 'shift was' : 'shifts were'} not
            worked on this date: no clock-in was recorded against{' '}
            {unworked.length === 1 ? 'it' : 'them'} and no approved absence covers{' '}
            {unworked.length === 1 ? 'it' : 'them'}.
          </p>
        )}
      </Block>

      <Block
        title="Overtime risk"
        description="Whether the date leaves work that the staff who are there have to absorb as extra hours."
      >
        <span className={pillClassName(risk.role, 'md')}>
          <StatusIcon name={RISK_ICONS[risk.role]} className={PILL_ICON_SIZE.md} />
          {risk.label}
        </span>
        <p className="mt-1.5 text-[12px] font-semibold text-slate-600">{risk.reason}</p>

        {overtimeRecords.length > 0 && (
          <p className="mt-1.5 text-[12px] font-bold text-slate-600">
            {overtimeRecords.length}{' '}
            {overtimeRecords.length === 1 ? 'employee has' : 'employees have'} already worked beyond
            their schedule on this date, {formatHours(overtimeHours)} over in total.
          </p>
        )}

        {records.length > 0 && (
          <p className="mt-1 text-[11px] font-semibold text-slate-400">{overtime.description}</p>
        )}
      </Block>
    </>
  );
}

/**
 * Coverage by department for the date, from the projection's own breakdown.
 *
 * The rows are `projectCoverage`'s, computed by the same expression as the
 * whole-organisation figure over a smaller roster (Requirement 8, criterion 8),
 * so a department row and the summary above it cannot be computed differently.
 *
 * Requirements: 18.8
 */
function DepartmentBreakdown({ departments }: { departments: readonly DepartmentProjection[] }) {
  return (
    <Block
      title="Coverage by department"
      count={departments.length}
      description="The same projection over each department's own roster, against that department's own minimum staffing."
    >
      {departments.length === 0 ? (
        <Nothing>No department carries a roster or a staffing requirement on this date.</Nothing>
      ) : (
        <ul className="space-y-1.5">
          {departments.map((row) => {
            const short = missingShifts(row);

            return (
              <li
                key={row.department}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-slate-100 bg-slate-50/60 px-2.5 py-2"
              >
                <span className="text-[13px] font-bold text-slate-800">
                  {DEPARTMENT_LABELS[row.department]}
                </span>
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="text-[11px] font-bold text-slate-500">
                    {row.scheduled} scheduled {'\u00b7'} {row.approvedAbsences} off {'\u00b7'}{' '}
                    {short === null ? 'no minimum' : `${short} short`}
                  </span>
                  <CoverageBadge
                    status={row.status}
                    available={row.available}
                    requiredStaff={row.requiredStaff}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Block>
  );
}

/**
 * The Attendance_Exception records for the current or a past date.
 *
 * One row per employee per work date however many exceptions that row carries,
 * which is the shape `/api/attendance/records` returns (Requirement 12, criterion
 * 20). Each exception is shown with the plain-language description of the rule
 * that produced it, so a reader does not have to know the codes, and the
 * payroll-blocking ones carry a label and an icon rather than only a colour.
 *
 * Requirements: 18.9, 22.6, 22.7
 */
function ExceptionRecords({ page }: { page: RecordPage }) {
  const names = new Map(page.employees.map((employee) => [employee.profileId, employee.displayName]));

  return (
    <Block
      title="Exception records"
      count={page.total}
      description="Records on this date carrying at least one exception. Shown for the current date and past dates only."
    >
      {page.rows.length === 0 ? (
        <Nothing>No exceptions on this date.</Nothing>
      ) : (
        <ul className="space-y-1.5">
          {page.rows.map((record) => (
            <li
              key={`${record.profileId}:${record.workDate}`}
              className="rounded-xl border border-slate-100 bg-slate-50/60 px-2.5 py-2"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-slate-800">
                  {names.get(record.profileId) ?? `Employee ${record.profileId.slice(0, 8)}`}
                </span>
                <StatusPill status={record.derivedStatus} />
                {record.payrollBlocking && (
                  <span className={pillClassName('critical')}>
                    <StatusIcon name="OctagonAlert" className={PILL_ICON_SIZE.sm} />
                    Payroll blocking
                  </span>
                )}
              </span>

              <ul className="mt-1 space-y-0.5">
                {record.exceptions.map((exception) => (
                  <li
                    key={exception.ruleId}
                    className="text-[11px] font-semibold text-slate-600"
                  >
                    <span className="font-black text-slate-700">{exception.ruleId}</span>{' '}
                    {exception.ruleDescription}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      {page.total > page.rows.length && (
        <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
          Showing {page.rows.length} of {page.total}. The Review Center lists the rest.
        </p>
      )}
    </Block>
  );
}

interface RibbonDateDrawerProps {
  /** The date to describe, or null when the drawer is closed. */
  date: RibbonDate | null;
  /** The same date as `/api/coverage` returned it, for the lists and intervals. */
  coverage: ComputedCoverageDate | null;
  /** Whether the coverage response carried employee names (Requirement 8.13). */
  employeeNamesVisible: boolean;
  /** Whether this date is the current date or a past one (criterion 9). */
  showsExceptions: boolean;
  /** The exception records read, rendered by the caller with its own async states. */
  exceptions: ReactNode;
  /** Those records' rows, for the two record-backed readings. */
  records: readonly DailyAttendanceRecord[];
  onClose: () => void;
}

/**
 * One ribbon date, opened out.
 *
 * Requirements: 18.8, 18.9, 22.10, 22.11
 */
function RibbonDateDrawer({
  date,
  coverage,
  employeeNamesVisible,
  showsExceptions,
  exceptions,
  records,
  onClose,
}: RibbonDateDrawerProps) {
  return (
    <SideDrawer
      open={date !== null}
      onClose={onClose}
      title={date === null ? 'Workforce health' : formatWorkDateLong(date.workDate)}
      subtitle={
        date === null ? undefined : `Workforce health \u00b7 ${statusToken(date.state).label}`
      }
    >
      {date === null ? null : (
        <div className="space-y-3">
          <DateFigures date={date} coverage={coverage} records={records} />

          <DepartmentBreakdown departments={date.coverage?.departments ?? []} />

          <EmployeeList
            title="Scheduled"
            description="Carrying a published shift on this date."
            employees={coverage?.scheduled ?? []}
            empty="Nobody is scheduled on this date."
          />

          <AbsenceList
            title="Approved off"
            description="Approved time off covering this date. Already subtracted from the projection."
            absences={coverage?.approvedAbsences ?? []}
            empty="No approved absences on this date."
          />

          <AbsenceList
            title="Pending requests"
            description="Requested and not yet decided. Not subtracted from the projection above."
            absences={coverage?.pendingRequests ?? []}
            empty="No requests are awaiting a decision on this date."
          />

          {/* Criterion 9: for the current date and past dates only, because a
              future date has nothing recorded to report. */}
          {showsExceptions ? (
            exceptions
          ) : (
            <p className="text-[11px] font-semibold text-slate-400">
              This date is in the future, so no attendance records exist for it yet.
            </p>
          )}

          {!employeeNamesVisible && (
            <p className="text-[11px] font-semibold text-slate-400">
              Employee names are withheld from the coverage response. Shifts and absences are
              counted in full; only the names are held back.
            </p>
          )}
        </div>
      )}
    </SideDrawer>
  );
}

export interface HealthRibbonProps {
  /**
   * The zone the seven dates are read in: the business timezone, since the strip
   * describes the organisation's week rather than any one reader's.
   *
   * Optional because the workspace mounts this control above the section switch
   * and holds no policy read of its own. It falls back to UTC, which is the
   * default the Coverage_Calendar and the Live_Coverage_Panel take.
   */
  timeZone?: string;
  className?: string;
}

/**
 * The seven-day workforce health strip.
 *
 * Requirements: 18.1, 18.2, 18.3, 18.7, 18.8, 18.9, 18.10, 18.11
 */
export function HealthRibbon({ timeZone = FALLBACK_TIME_ZONE, className }: HealthRibbonProps) {
  const today = useMemo(() => todayIn(timeZone), [timeZone]);
  const range = useMemo<DateRange>(
    () => ({ from: today, to: addCalendarDays(today, RIBBON_DAYS - 1) }),
    [today],
  );

  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const url = useMemo(() => ribbonUrl(range), [range]);

  // Criterion 11: the whole seven-date state set in one request. No poll — a
  // projection moves when a schedule or a decision moves, not with the clock.
  const coverage = useAsyncResource(
    (signal) => attendanceJson<CoverageResponse>(url, { signal }),
    {
      deps: [url],
      subject: 'the seven-day health strip',
      filters: [
        { label: 'Dates', value: `${formatWorkDate(range.from)} to ${formatWorkDate(range.to)}` },
      ],
      isEmpty: (response) => response.ribbon.length === 0,
    },
  );

  const ribbon = coverage.data?.ribbon ?? [];
  const selected = ribbon.find((date) => date.workDate === selectedDate) ?? null;

  // Criterion 9 in one condition: the records read is made for the current date
  // and past dates, and for nothing else.
  const showsExceptions = selectedDate !== null && selectedDate <= today;
  const exceptionsRead = useMemo(
    () => recordQueryUrl('/api/attendance/records', exceptionsQuery(selectedDate ?? today)),
    [selectedDate, today],
  );

  const exceptions = useAsyncResource(
    (signal) => attendanceJson<RecordPage>(exceptionsRead.url, { signal }),
    {
      deps: [exceptionsRead.url],
      enabled: showsExceptions && !exceptionsRead.unsatisfiable,
      subject: 'exception records',
      filters: [
        { label: 'Date', value: formatWorkDate(selectedDate ?? today) },
        { label: 'Exceptions', value: 'Any' },
      ],
      isEmpty: (page) => page.rows.length === 0,
    },
  );

  // The per-date entries the drawer's lists and intervals come from. Only the
  // computed ones: a date carrying `unavailable` has no figures to read, and the
  // ribbon already answers it with No_Schedule.
  const computed = useMemo<ReadonlyMap<string, ComputedCoverageDate>>(() => {
    const entries = new Map<string, ComputedCoverageDate>();
    for (const date of coverage.data?.dates ?? []) {
      if (date.unavailable === undefined) entries.set(date.workDate, date);
    }
    return entries;
  }, [coverage.data]);

  return (
    <section
      aria-labelledby="health-ribbon-heading"
      className={[
        'rounded-[22px] border border-slate-200 bg-white px-4 py-3 shadow-sm sm:px-5',
        className ?? '',
      ]
        .filter((part) => part !== '')
        .join(' ')}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="health-ribbon-heading"
          className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
        >
          Next seven days
        </h2>
        <p className="text-[11px] font-semibold text-slate-400">
          {formatWorkDate(range.from)} {'\u2013'} {formatWorkDate(range.to)}
        </p>
      </div>

      <p className="mt-0.5 text-[12px] font-semibold text-slate-500">
        Projected coverage per date, from published schedules and approved absences. Select a date
        for the staffing behind its state.
      </p>

      <div className="mt-2 space-y-2">
        <AsyncStateBlock
          status={coverage.status}
          failure={coverage.failure}
          pending={coverage.pending}
          onRetry={coverage.retry}
          subject="the seven-day health strip"
          message={coverage.emptyMessage}
        />

        {/* Seven cells across, and a horizontal scroll rather than a crush on a
            narrow viewport: each cell carries a status pill, and a pill with no
            room for its label would lose criterion 7. */}
        {ribbon.length > 0 && (
          <div className="overflow-x-auto">
            <ul className="grid min-w-[38rem] auto-rows-fr grid-cols-7 gap-1">
              {ribbon.map((date) => (
                <RibbonCell
                  key={date.workDate}
                  date={date}
                  isToday={date.workDate === today}
                  selected={date.workDate === selectedDate}
                  onSelect={() =>
                    setSelectedDate((current) => (current === date.workDate ? null : date.workDate))
                  }
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      <RibbonDateDrawer
        date={selected}
        coverage={selectedDate === null ? null : (computed.get(selectedDate) ?? null)}
        employeeNamesVisible={coverage.data?.employeeNamesVisible ?? false}
        showsExceptions={showsExceptions}
        records={showsExceptions ? (exceptions.data?.rows ?? []) : []}
        exceptions={
          <div className="space-y-2">
            <AsyncStateBlock
              status={exceptions.status}
              failure={exceptions.failure}
              pending={exceptions.pending}
              onRetry={exceptions.retry}
              subject="exception records"
              message={exceptions.emptyMessage}
            />
            {exceptions.data !== null && <ExceptionRecords page={exceptions.data} />}
          </div>
        }
        onClose={() => setSelectedDate(null)}
      />
    </section>
  );
}

export default HealthRibbon;
