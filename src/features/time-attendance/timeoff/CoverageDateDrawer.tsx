// src/features/time-attendance/timeoff/CoverageDateDrawer.tsx
// One date of the Coverage_Calendar, opened out: who is scheduled, who is away,
// who has asked to be, and how the day partitions.
//
// Requirement 8, criterion 5 names four things a selected date has to show, and
// criterion 5 of Requirement 9 fixes how an interval is spelled. Every one of them
// is a field the Coverage_Service already put on the date:
//
// | shown                            | read from                       | criterion |
// | -------------------------------- | ------------------------------- | --------- |
// | the scheduled employees          | `scheduled`                     | 8.5       |
// | the approved absences            | `approvedAbsences`              | 8.5       |
// | the pending requests            | `pendingRequests`               | 8.5       |
// | the Coverage_Interval breakdown  | `intervals`                     | 8.5, 9.4  |
// | minimum required coverage        | `projection.requiredStaff`      | 8.2, 8.5  |
// | per-interval available, required | `availableStaff`, `requiredStaff` | 8.10, 9.5 |
// | the Coverage_Status              | `projection.status`, `status`   | 8.11      |
//
// This drawer counts nothing and classifies nothing. `projectCoverage` produced
// the figures, `buildCoverageIntervals` produced the partition, and
// `classifyCoverage` produced every status inside both, so the cell the reader
// pressed and the drawer that opened cannot disagree about the same date.
//
// ## Required coverage lives here, not in the cell
//
// Requirement 8, criterion 3 allows a date cell one status indicator and four
// numbers, and criterion 2 names six things a date carries. Two of them therefore
// have to move, and criterion 5 says which: the minimum required coverage and the
// interval breakdown belong to the date's drawer, which has the room to render
// them legibly. So the cell shows scheduled, approved off, pending, and projected;
// the requirement those figures are judged against is the first thing in here.
//
// ## Names, and where they are withheld
//
// Requirement 8, criterion 13 withholds employee names from a caller who neither
// administers attendance nor holds the shared absence calendar permission. That
// decision is the service's: it blanks `displayName` before the response leaves the
// server, and reports what it did on `employeeNamesVisible`. This drawer renders
// what it was given and states plainly when names were withheld, so a short,
// nameless list reads as a permission boundary rather than as missing data. It
// holds no rule of its own about who may see a name — a client-side test would be
// a second decision able to disagree with the first.
//
// ## A date with no projection
//
// Requirement 9, criterion 14: a date whose projection could not be computed
// carries `unavailable: { reason }` instead of figures, and the rest of the range
// keeps its own. The union has no `projection` on that branch, so this drawer
// cannot render a zero where nothing is known — it states the reason instead.
//
// Requirements: 8.2, 8.4, 8.5, 8.11, 8.13, 9.4, 9.5, 9.14, 22.2, 22.3, 22.5,
// 22.6, 22.7, 22.10, 22.11, 22.12

'use client';

import type { ReactNode } from 'react';

import type { CoverageInterval } from '../domain/coverage';
import type {
  ComputedCoverageDate,
  CoverageAbsence,
  CoverageDate,
  CoverageEmployee,
} from '../server/coverage-service';
import { CoverageBadge } from '../shared/CoverageBadge';
import { formatTimeOfDay, formatWorkDate, formatWorkDateLong } from '../shared/format';
import { SideDrawer } from '../shared/SideDrawer';
import { colorRoleToken } from '../shared/tokens';
import { DEPARTMENT_LABELS } from '../types';

/** What stands in for a required figure `staffing_thresholds` does not configure. */
export const UNCONFIGURED_REQUIREMENT = 'Not set';

/**
 * Whether a per-date result carries figures.
 *
 * The same discriminant `isComputedCoverageDate` applies on the server, written
 * again here rather than imported: `server/coverage-service.ts` reaches Supabase
 * through `attendance-service.ts`, so importing a *value* from it would pull the
 * whole server module into the browser bundle. Only its types cross that line, and
 * they are erased at compile time. The test itself is one field comparison against
 * a union the server owns, so there is no rule here to drift.
 *
 * Requirements: 9.14
 */
export function hasCoverageFigures(date: CoverageDate): date is ComputedCoverageDate {
  return date.unavailable === undefined;
}

/**
 * How an employee is named, or what stands in when the name was withheld.
 *
 * `displayName` is null in two cases and the fallback covers both: an employee
 * outside the roster the response described, and an employee whose name
 * Requirement 8, criterion 13 withholds. The identifier fragment is enough to tell
 * two anonymous rows apart, which a coverage reader legitimately needs — three
 * absences is three people — without naming either of them.
 */
function employeeLabel(employee: CoverageEmployee): string {
  return employee.displayName ?? `Employee ${employee.profileId.slice(0, 8)}`;
}

/** The department under a name, or the absence of one, in words. */
function departmentLabel(employee: CoverageEmployee): string {
  return employee.department === null ? 'No department' : DEPARTMENT_LABELS[employee.department];
}

/** One labelled figure: a small caption over the value. */
function Figure({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-[5rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className={`text-lg font-black tracking-tight ${muted ? 'text-slate-300' : 'text-slate-800'}`}>
        {value}
      </dd>
    </div>
  );
}

/** A titled block with a count in its corner, and its content underneath. */
function Section({
  title,
  count,
  description,
  children,
}: {
  title: string;
  count: number;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</h3>
        <span
          className={`text-lg font-black tracking-tight ${count === 0 ? 'text-slate-300' : 'text-slate-800'}`}
        >
          {count}
        </span>
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
 * The projection, and the requirement it is judged against.
 *
 * Requirement 8, criterion 5 puts the minimum required coverage in here rather
 * than in the cell, so it is the first thing the drawer states after the status.
 * `rawAvailable` is the same arithmetic unfloored, and it is negative exactly when
 * absences outnumber published shifts — a fact `available` cannot express once the
 * floor has taken it to zero, and the one figure a reader needs in order to know
 * how far past empty a date has gone.
 *
 * Requirements: 8.2, 8.4, 8.5, 8.6, 8.11
 */
function ProjectionSummary({ date }: { date: ComputedCoverageDate }) {
  const { projection } = date;
  const overdrawn = projection.rawAvailable < 0 ? -projection.rawAvailable : 0;

  return (
    <div className="rounded-2xl bg-slate-50 px-3.5 py-3">
      <CoverageBadge
        status={projection.status}
        available={projection.available}
        requiredStaff={projection.requiredStaff}
        size="md"
      />

      <dl className="mt-2.5 flex flex-wrap gap-x-5 gap-y-2">
        <Figure
          label="Required"
          value={
            projection.requiredStaff === null
              ? UNCONFIGURED_REQUIREMENT
              : String(projection.requiredStaff)
          }
          muted={projection.requiredStaff === null}
        />
        <Figure label="Projected available" value={String(projection.available)} />
        <Figure label="Scheduled" value={String(projection.scheduled)} />
        <Figure
          label="Approved off"
          value={String(projection.approvedAbsences)}
          muted={projection.approvedAbsences === 0}
        />
        {projection.proposedAbsences > 0 && (
          <Figure label="Proposed off" value={String(projection.proposedAbsences)} />
        )}
      </dl>

      <p className="mt-2 text-[12px] font-semibold text-slate-600">
        Projected coverage is the employees carrying a published shift on this date, less those with
        an approved absence covering it. It reads no clock data, so it is the figure a leave
        decision is made against rather than a count of who is on the floor.
      </p>

      {projection.requiredStaff === null && (
        <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
          No minimum staffing is configured for this date, so the status is healthy whatever the
          projection.
        </p>
      )}

      {overdrawn > 0 && (
        <p className={`mt-1.5 text-[12px] font-bold ${colorRoleToken('critical').text}`}>
          {overdrawn} more {overdrawn === 1 ? 'absence' : 'absences'} than published shifts on this
          date, so the projection is reported as zero rather than as a negative figure.
        </p>
      )}
    </div>
  );
}

/**
 * The employees carrying a published shift on this date.
 *
 * Requirements: 8.5, 8.13
 */
function ScheduledList({ employees }: { employees: readonly CoverageEmployee[] }) {
  return (
    <Section
      title="Scheduled"
      count={employees.length}
      description="Carrying a published shift on this date."
    >
      {employees.length === 0 ? (
        <Nothing>Nobody is scheduled on this date.</Nothing>
      ) : (
        <ul className="space-y-1">
          {employees.map((employee) => (
            <li key={employee.profileId} className="text-[13px] font-semibold text-slate-700">
              {employeeLabel(employee)}
              <span className="ml-1.5 text-[11px] font-bold text-slate-400">
                {departmentLabel(employee)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * One absence: who, and — where it reaches past this date — over which dates.
 *
 * The stored bounds are shown only when they extend beyond the date being read.
 * On a single-date request they would repeat the drawer's own heading, and a figure
 * repeated twice is a figure a reader has to check against itself.
 */
function AbsenceItem({ absence }: { absence: CoverageAbsence }) {
  const spans = absence.startDate !== absence.endDate;

  return (
    <li className="text-[13px] font-semibold text-slate-700">
      {employeeLabel(absence.employee)}
      <span className="ml-1.5 text-[11px] font-bold text-slate-400">
        {departmentLabel(absence.employee)}
        {spans
          ? ` \u00b7 ${formatWorkDate(absence.startDate)} \u2013 ${formatWorkDate(absence.endDate)}`
          : ''}
      </span>
    </li>
  );
}

/**
 * The approved absences and the pending requests covering this date.
 *
 * Two lists rather than one, because they mean different things to a decision: an
 * approved absence has already been subtracted from the projection above, and a
 * pending request has not been subtracted from anything yet. Collapsing them would
 * make the projection unreadable — a reader could not tell which of the absences
 * the figure already accounts for.
 *
 * Requirements: 8.2, 8.5
 */
function AbsenceLists({ date }: { date: ComputedCoverageDate }) {
  return (
    <>
      <Section
        title="Approved off"
        count={date.approvedAbsences.length}
        description="Approved time off covering this date. Already subtracted from the projection."
      >
        {date.approvedAbsences.length === 0 ? (
          <Nothing>No approved absences on this date.</Nothing>
        ) : (
          <ul className="space-y-1">
            {date.approvedAbsences.map((absence) => (
              <AbsenceItem key={absence.requestId} absence={absence} />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Pending requests"
        count={date.pendingRequests.length}
        description="Requested and not yet decided. Not subtracted from the projection above."
      >
        {date.pendingRequests.length === 0 ? (
          <Nothing>No requests are awaiting a decision on this date.</Nothing>
        ) : (
          <ul className="space-y-1">
            {date.pendingRequests.map((absence) => (
              <AbsenceItem key={absence.requestId} absence={absence} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/**
 * One Coverage_Interval: a start time, an end time, an available count, and a
 * required count, which is exactly the four fields Requirement 9, criterion 5 asks
 * for, with the status those two counts produced.
 *
 * The bounds are ISO instants and are read in the business timezone through
 * `formatTimeOfDay`, which goes to `domain/work-date.ts` — the module's single
 * zone conversion (Requirement 19, criteria 9 and 10). An overnight shift's end
 * therefore lands on the following date's wall clock, which is what makes an
 * interval running to 02:00 read as 2:00 AM rather than as an impossible hour.
 */
function IntervalRow({ interval, timeZone }: { interval: CoverageInterval; timeZone: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-slate-100 bg-slate-50/60 px-2.5 py-2">
      <span className="text-[13px] font-bold text-slate-800">
        {formatTimeOfDay(interval.start, timeZone)} {'\u2013'}{' '}
        {formatTimeOfDay(interval.end, timeZone)}
      </span>
      <CoverageBadge
        status={interval.status}
        available={interval.availableStaff}
        requiredStaff={interval.requiredStaff}
      />
    </li>
  );
}

/**
 * The interval breakdown for the date.
 *
 * The date is partitioned at every distinct scheduled start and end instant, so a
 * date with one common shift has one interval and a date with staggered shifts has
 * one per distinct boundary (Requirement 8, criteria 9 and 10). A date nobody is
 * scheduled on has none: there is no stretch of it over which anybody is working,
 * and an interval spanning midnight to midnight with nobody in it would claim a
 * shift that does not exist.
 *
 * Requirements: 8.5, 8.9, 8.10, 8.11, 9.4, 9.5
 */
function IntervalBreakdown({
  intervals,
  timeZone,
}: {
  intervals: readonly CoverageInterval[];
  timeZone: string;
}) {
  return (
    <Section
      title="Interval breakdown"
      count={intervals.length}
      description="The date split at every distinct shift start and end, with the staffing over each stretch."
    >
      {intervals.length === 0 ? (
        <Nothing>No published shifts, so the date has no intervals to break down.</Nothing>
      ) : (
        <ul className="space-y-1.5">
          {intervals.map((interval) => (
            <IntervalRow key={`${interval.start}-${interval.end}`} interval={interval} timeZone={timeZone} />
          ))}
        </ul>
      )}
    </Section>
  );
}

export interface CoverageDateDrawerProps {
  /**
   * The date to describe, or null when the drawer is closed. The whole date as
   * `/api/coverage` returned it, so the drawer reads figures rather than deriving
   * them.
   */
  date: CoverageDate | null;
  /**
   * Whether the response carried employee names, as `employeeNamesVisible`
   * reported. Wording only: the withholding itself already happened on the server
   * (Requirement 8, criterion 13).
   */
  employeeNamesVisible: boolean;
  /**
   * The zone the interval bounds are read in: the business timezone, since the
   * intervals describe the organisation's working day rather than any one reader's
   * clock.
   */
  timeZone: string;
  onClose: () => void;
}

/**
 * One date's coverage, in the module's one drawer.
 *
 * Requirements: 8.5, 8.13, 9.4, 9.5, 9.14, 22.10, 22.11
 */
export function CoverageDateDrawer({
  date,
  employeeNamesVisible,
  timeZone,
  onClose,
}: CoverageDateDrawerProps) {
  const computed = date !== null && hasCoverageFigures(date) ? date : null;

  const subtitle =
    date === null
      ? undefined
      : computed !== null && computed.closed
        ? `Projected coverage \u00b7 closed: ${computed.closedLabel ?? 'Closed'}`
        : 'Projected coverage';

  return (
    <SideDrawer
      open={date !== null}
      onClose={onClose}
      title={date === null ? 'Projected coverage' : formatWorkDateLong(date.workDate)}
      subtitle={subtitle}
    >
      {/* The branch narrows the per-date union itself rather than testing a
          separate flag, so the unavailable branch has no `projection` in scope to
          render a zero from and the computed branch cannot reach a reason that does
          not exist (Requirement 9, criterion 14). */}
      {date === null ? null : hasCoverageFigures(date) ? (
        <div className="space-y-3">
          <ProjectionSummary date={date} />

          {date.closed && (
            <p className="text-[12px] font-semibold text-slate-500">
              The organisation is closed on this date
              {date.closedLabel === null ? '' : ` (${date.closedLabel})`}, so a shortfall against a
              staffing requirement is not a staffing gap.
            </p>
          )}

          <ScheduledList employees={date.scheduled} />
          <AbsenceLists date={date} />
          <IntervalBreakdown intervals={date.intervals} timeZone={timeZone} />

          {!employeeNamesVisible && (
            <p className="text-[11px] font-semibold text-slate-400">
              Employee names are withheld from this response. Absences and shifts are counted in
              full; only the names are held back.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm font-black text-slate-900">No projection for this date</p>
          <p className="text-[13px] font-semibold text-slate-600">{date.unavailable.reason}</p>
          <p className="text-[12px] font-semibold text-slate-400">
            Every other date in the displayed range keeps its own figures.
          </p>
        </div>
      )}
    </SideDrawer>
  );
}

export default CoverageDateDrawer;
