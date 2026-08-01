// src/features/time-attendance/today/LiveCoveragePanel.tsx
// Current operational coverage, one compact row per department.
//
// Requirement 6 asks for the staffing picture as it stands right now, on the
// screen where it is still actionable: one row per department (criterion 1), the
// seven figures on each (criterion 2), the employees behind those figures a click
// away (criterion 14), the whole thing labelled as *current* coverage and kept
// apart from the projection leave decisions are made against (criterion 15), and
// refreshed inside a minute (criterion 16).
//
// | shown                     | read from                        | criterion |
// | ------------------------- | -------------------------------- | --------- |
// | required staffing         | `requiredStaff`                  | 6.2, 6.3  |
// | scheduled staffing        | `scheduled`                      | 6.2       |
// | currently working         | `working`                        | 6.2, 6.5  |
// | on break                  | `onBreak`                        | 6.2, 6.6  |
// | approved off              | `approvedOff`                    | 6.2       |
// | missing                   | `missing`                        | 6.2, 6.8  |
// | Coverage_Status           | `status`                         | 6.2, 6.9–6.12 |
// | the employees behind each | the five `…ProfileIds` lists     | 6.14      |
//
// Every one of those is a field on the `DepartmentCoverage` the Coverage_Service
// returned. This panel counts nothing, classifies nothing, and subtracts nothing.
// `liveCoverage` in `domain/coverage.ts` is the single implementation of who is at
// work, and `classifyCoverage` of what a headcount means, so the figure here, the
// coverage counter above, and the Health_Ribbon cannot disagree about the same
// department at the same instant.
//
// ## Why the read sends no date
//
// `/api/coverage` resolves an absent range to today in the business timezone,
// read from `attendance_policy`. A browser sending its own local date would ask
// about the wrong work date for the hour either side of midnight, which is the
// same reason `/api/attendance/day` is called without one. The response carries
// the date it answered for, and that is what the heading states.
//
// ## Live is not the projection, and says so
//
// Criterion 15 is the reason the panel carries a paragraph of prose rather than
// only a table. The two coverage figures in this module answer different
// questions from different sources:
//
// - **Live** — how many are on the floor now, counted from Derived_Status, which
//   is a conclusion drawn from clock data.
// - **Projected** — how many are expected on a date, counted from published
//   schedules less absences, which reads no clock data at all.
//
// A leave decision is made against the projection, on the Time Off & Coverage
// screen. Reading a live shortfall as a reason to refuse a request next Tuesday
// would be reading the wrong number, so the panel names which figure it is
// showing, names the one it is not, and says where that one lives.
//
// ## The drawer is the same drawer
//
// `SideDrawer` is the module's only drawer implementation (Requirement 22,
// criteria 10 and 11). Each department row is a real `button`, so the drawer has a
// control to return focus to when it closes, and the row is reachable by keyboard
// without this component reinventing what a button already does.
//
// Requirements: 6.1, 6.2, 6.4, 6.14, 6.15, 6.16, 22.5, 22.6, 22.7, 22.12, 22.14,
// 22.15, 22.16

'use client';

import { useMemo, useState } from 'react';

import type { DepartmentCoverage } from '../domain/coverage';
import type { CoverageEmployee, CoverageResponse } from '../server/coverage-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { CoverageBadge } from '../shared/CoverageBadge';
import { formatTimeOfDay, formatWorkDateLong } from '../shared/format';
import { SideDrawer } from '../shared/SideDrawer';
import { colorRoleToken, type ColorRole } from '../shared/tokens';
import { useAttendancePoll } from '../shared/useAttendancePoll';
import { DEPARTMENT_LABELS, type Department, type TimeSlot } from '../types';

/** The one read this panel makes: current coverage for today, every department. */
const LIVE_COVERAGE_URL = '/api/coverage?mode=live';

/** What stands in for a required figure the thresholds do not configure. */
const UNCONFIGURED = 'Not set';

/** What each time slot is called where the panel states which one it read. */
const TIME_SLOT_LABELS: Record<TimeSlot, string> = {
  morning: 'morning',
  afternoon: 'afternoon',
  full_day: 'whole-day',
};

/**
 * The six headcounts of criterion 2, in the order the criterion names them, each
 * with the employee list criterion 14 shows behind it.
 *
 * A table rather than six repeated blocks, so the row and the drawer are built
 * from one description of what a figure means: a headcount whose figure and whose
 * employee list came from two places could report five working and list four.
 *
 * `requiredStaff` is not here. It is a threshold rather than a headcount, has no
 * employees behind it, and is rendered beside the status it is compared against.
 */
interface Headcount {
  key: 'scheduled' | 'working' | 'onBreak' | 'approvedOff' | 'missing';
  label: string;
  /** What the figure counts, as visible text in the drawer (criterion 22.7). */
  description: string;
  role: ColorRole;
  count: (row: DepartmentCoverage) => number;
  profileIds: (row: DepartmentCoverage) => readonly string[];
}

/**
 * The five headcounts and what each one counts.
 *
 * Roles follow Requirement 22, criterion 5 as the rest of the module reads it:
 * working is staffing present, a scheduled shift nobody is on is a shortfall, and
 * the two neutral figures are neither.
 *
 * Requirements: 6.2, 6.5, 6.6, 6.7, 6.8, 6.14
 */
const HEADCOUNTS: readonly Headcount[] = [
  {
    key: 'scheduled',
    label: 'Scheduled',
    description: 'Carrying a published shift for today.',
    role: 'neutral',
    count: (row) => row.scheduled,
    profileIds: (row) => row.scheduledProfileIds,
  },
  {
    key: 'working',
    label: 'Working',
    description: 'On the clock now, with no break running. This is the available staffing.',
    role: 'healthy',
    count: (row) => row.working,
    profileIds: (row) => row.workingProfileIds,
  },
  {
    key: 'onBreak',
    label: 'On break',
    description: 'On the clock with a break running, and so not counted as available.',
    role: 'neutral',
    count: (row) => row.onBreak,
    profileIds: (row) => row.onBreakProfileIds,
  },
  {
    key: 'approvedOff',
    label: 'Approved off',
    description: 'Covered by an approved time-off request for today.',
    role: 'neutral',
    count: (row) => row.approvedOff,
    profileIds: (row) => row.approvedOffProfileIds,
  },
  {
    key: 'missing',
    label: 'Missing',
    description:
      'Scheduled today and neither working, on break, nor on approved leave, so the shift is unaccounted for.',
    role: 'critical',
    count: (row) => row.missing,
    profileIds: (row) => row.missingProfileIds,
  },
];

/** How an employee is named in the drawer, or what stands in when they are not. */
function employeeName(employee: CoverageEmployee | undefined, profileId: string): string {
  if (employee === undefined) return 'Employee outside this roster';
  return employee.displayName ?? `Employee ${profileId.slice(0, 8)}`;
}

/** One figure of a department row: a small label over the number. */
function Figure({
  label,
  value,
  role,
  muted = false,
}: {
  label: string;
  value: string;
  role: ColorRole;
  muted?: boolean;
}) {
  return (
    <div className="min-w-[4.5rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </dt>
      <dd
        className={`text-lg font-black tracking-tight ${muted ? 'text-slate-300' : colorRoleToken(role).text}`}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * One department's row: the seven figures of criterion 2, as one control.
 *
 * A `button` wrapping the whole row rather than a link in the first cell: the
 * whole row is the target, criterion 14 gives it one behaviour, and every figure
 * inside it is text, so the control's accessible name already states the
 * department and all seven values (Requirement 22, criterion 12).
 */
function DepartmentRow({
  row,
  selected,
  onSelect,
}: {
  row: DepartmentCoverage;
  selected: boolean;
  onSelect: () => void;
}) {
  const accent = colorRoleToken('accent');

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-haspopup="dialog"
        aria-expanded={selected}
        className={[
          'flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border px-3.5 py-2.5 text-left transition',
          selected
            ? `${accent.surface} ${accent.border} ring-2 ${accent.ring}`
            : 'border-slate-200 bg-white hover:bg-slate-50',
        ].join(' ')}
      >
        <div className="min-w-[9rem] flex-1">
          <span className="block text-[13px] font-black text-slate-900">
            {DEPARTMENT_LABELS[row.department]}
          </span>
          <CoverageBadge
            status={row.status}
            available={row.available}
            requiredStaff={row.requiredStaff}
            className="mt-1"
          />
        </div>

        <dl className="flex flex-wrap items-baseline gap-x-4 gap-y-2 text-right">
          <Figure
            label="Required"
            value={row.requiredStaff === null ? UNCONFIGURED : String(row.requiredStaff)}
            role="neutral"
            muted={row.requiredStaff === null}
          />
          {HEADCOUNTS.map((headcount) => (
            <Figure
              key={headcount.key}
              label={headcount.label}
              value={String(headcount.count(row))}
              role={headcount.count(row) === 0 ? 'neutral' : headcount.role}
              muted={headcount.count(row) === 0}
            />
          ))}
        </dl>
      </button>
    </li>
  );
}

/**
 * One headcount inside the drawer: the figure, what it counts, and the employees.
 *
 * The list is the figure. `liveCoverage` reports each headcount as the length of
 * the identifiers it returns, so a section showing four names under a five cannot
 * happen — there is one answer, rendered twice.
 *
 * Requirements: 6.14, 22.7
 */
function HeadcountSection({
  headcount,
  row,
  employees,
}: {
  headcount: Headcount;
  row: DepartmentCoverage;
  employees: ReadonlyMap<string, CoverageEmployee>;
}) {
  const profileIds = headcount.profileIds(row);
  const token = colorRoleToken(profileIds.length === 0 ? 'neutral' : headcount.role);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">
          {headcount.label}
        </h3>
        <span className={`text-lg font-black tracking-tight ${token.text}`}>
          {headcount.count(row)}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{headcount.description}</p>

      {profileIds.length === 0 ? (
        <p className="mt-2 text-[12px] font-bold text-slate-400">Nobody in this count.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {profileIds.map((profileId) => (
            <li key={profileId} className="text-[13px] font-semibold text-slate-700">
              {employeeName(employees.get(profileId), profileId)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface LiveCoveragePanelProps {
  /**
   * The zone the "as at" instant is read in.
   *
   * The business timezone, which the screen already holds on the day read's
   * policy: these figures describe the organisation's own working day rather than
   * any one reader's clock, and the time slot the required figures were compared
   * against was resolved in that zone too.
   */
  timeZone?: string;
  /**
   * Where the projection leave decisions are made against lives, in the reader's
   * own words. Named by the caller rather than hardcoded, because it is a
   * navigation fact and this panel does not own the navigation vocabulary.
   *
   * Requirements: 6.15
   */
  projectionLocation?: string;
}

/**
 * Current operational coverage per department, refreshed each minute.
 *
 * Requirements: 6.1, 6.2, 6.4, 6.14, 6.15, 6.16
 */
export function LiveCoveragePanel({
  timeZone = 'UTC',
  projectionLocation = 'Time Off & Coverage',
}: LiveCoveragePanelProps) {
  const [openDepartment, setOpenDepartment] = useState<Department | null>(null);

  const coverage = useAttendancePoll(
    (signal) => attendanceJson<CoverageResponse>(LIVE_COVERAGE_URL, { signal }),
    {
      subject: 'live coverage',
      filters: [{ label: 'Coverage', value: 'Current, today' }],
      isEmpty: (response) => response.live.length === 0,
    },
  );

  const rows = coverage.data?.live ?? [];

  const employees = useMemo<ReadonlyMap<string, CoverageEmployee>>(
    () => new Map((coverage.data?.employees ?? []).map((employee) => [employee.profileId, employee])),
    [coverage.data],
  );

  const selected = rows.find((row) => row.department === openDepartment) ?? null;

  // Criterion 3: required staffing is per department, day of week, and time slot,
  // and the service resolved the slot from the evaluation instant. Naming it is
  // what stops a reader comparing a nine o'clock headcount against a figure they
  // assume covers the whole day.
  const timeSlot = coverage.data?.liveTimeSlot ?? null;

  return (
    <>
      <section
        aria-labelledby="live-coverage-heading"
        className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
      >
        <div className="space-y-2 border-b border-slate-100 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2
              id="live-coverage-heading"
              className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
            >
              Live coverage, right now
            </h2>
            {coverage.data !== null && (
              <p className="text-[11px] font-semibold text-slate-400">
                {coverage.paused
                  ? 'Paused while this tab is hidden'
                  : `As at ${formatTimeOfDay(coverage.data.evaluatedAt, timeZone)}`}
              </p>
            )}
          </div>

          {/* Criterion 15: what this is, and what it is not. */}
          <p className="text-[12px] font-semibold text-slate-500">
            Current operational coverage
            {coverage.data === null ? '' : ` for ${formatWorkDateLong(coverage.data.range.from)}`},
            counted from who is clocked in at this moment. It is not the projected coverage that
            leave decisions are made against — that projection reads published schedules and
            absences rather than clock state, and it lives on {projectionLocation}.
          </p>

          {coverage.data !== null && !coverage.data.thresholdsConfigured ? (
            <p className="text-[11px] font-semibold text-slate-400">
              No minimum staffing is configured yet, so every department reports its required
              staffing as {UNCONFIGURED.toLowerCase()} and a healthy status.
            </p>
          ) : (
            timeSlot !== null && (
              <p className="text-[11px] font-semibold text-slate-400">
                Required staffing is the {TIME_SLOT_LABELS[timeSlot]} figure for this day of the
                week.
              </p>
            )
          )}
        </div>

        <div className="space-y-2 px-4 py-4 sm:px-5">
          <AsyncStateBlock
            status={coverage.status}
            failure={coverage.failure}
            pending={coverage.pending}
            onRetry={coverage.retry}
            subject="live coverage"
            message={coverage.emptyMessage}
          />

          {/* Criterion 1: one compact row per department, each one a control. */}
          {rows.length > 0 && (
            <ul className="space-y-2">
              {rows.map((row) => (
                <DepartmentRow
                  key={row.department}
                  row={row}
                  selected={row.department === openDepartment}
                  onSelect={() =>
                    setOpenDepartment((current) =>
                      current === row.department ? null : row.department,
                    )
                  }
                />
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* Criterion 14: the employees counted in each headcount for the department. */}
      <SideDrawer
        open={selected !== null}
        onClose={() => setOpenDepartment(null)}
        title={selected === null ? 'Department coverage' : DEPARTMENT_LABELS[selected.department]}
        subtitle={
          selected === null
            ? undefined
            : `Current coverage \u00b7 ${formatWorkDateLong(selected.workDate)}`
        }
      >
        {selected !== null && (
          <div className="space-y-3">
            <div className="rounded-2xl bg-slate-50 px-3.5 py-3">
              <CoverageBadge
                status={selected.status}
                available={selected.available}
                requiredStaff={selected.requiredStaff}
                size="md"
              />
              <p className="mt-1.5 text-[12px] font-semibold text-slate-600">
                {selected.requiredStaff === null
                  ? 'No minimum staffing is configured for this department and time slot, so the status is healthy whatever the headcount.'
                  : `Available staffing is the working headcount, compared against a minimum of ${selected.requiredStaff}. Employees on break are not counted as available.`}
              </p>
            </div>

            {HEADCOUNTS.map((headcount) => (
              <HeadcountSection
                key={headcount.key}
                headcount={headcount}
                row={selected}
                employees={employees}
              />
            ))}

            {coverage.data !== null && !coverage.data.employeeNamesVisible && (
              <p className="text-[11px] font-semibold text-slate-400">
                Employee names are withheld from this response.
              </p>
            )}
          </div>
        )}
      </SideDrawer>
    </>
  );
}

export default LiveCoveragePanel;
