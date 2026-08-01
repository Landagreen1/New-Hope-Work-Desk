// src/features/time-attendance/today/TeamTodaySummary.tsx
// The eight counters of Requirement 5, criterion 3, and what selecting one does.
//
// A counter here is not a number with a click handler. It is a named
// `RecordQuery`, and both things the screen does with it come from that one
// query: the figure is the count of today's service-derived records the query
// matches, and selecting it hands the same query to the roster below, which
// re-reads `/api/attendance/records` under it.
//
// That is the whole reason the table is a table of *queries* rather than a table
// of numbers with filter callbacks. Requirement 5, criterion 4 ties every counter
// to the Attendance_Service and criterion 5 ties the rows to the counter that
// produced them. If the counter counted one thing and the rows were narrowed by
// another expression written a few lines further down, the two would be free to
// disagree — and would, the first time somebody adjusted one of them. Here they
// cannot: `count` and the drill-down are the same `RecordQuery`, the way
// `recordQueryForMetric` makes an Overview metric and its rows the same set.
//
// ## Why these eight are not the fourteen Overview metrics
//
// Requirement 13's metrics answer "how did the period go" and are hours, rates,
// and totals over a range. These answer "where is the team right now" and are all
// row counts over a single date. Three of them do coincide with a metric's scope
// — late arrivals, time-off days, missing clock-ins — and those reuse the same
// saved filters and predicates the metric scopes use, so a Team Today counter and
// the Review_Center figure behind it select the same records.
//
// ## The counters that read an exception rather than a status
//
// `late` selects the `late_arrival` exception, not the `late` Derived_Status. The
// status is single-valued and rule 4 of the Status Rule Matrix outranks rule 9,
// so an employee who arrived twenty minutes late and is still on the clock reads
// as `working` — which is exactly the employee an administrator wants counted at
// nine in the morning. The exception holds in both cases, so the counter covers
// the closed-shift case too. `buildMyDayAlerts` reads criterion 13 the same way,
// for the same reason.
//
// ## The coverage counter
//
// `coverage_warnings` is Requirement 6, criterion 8's missing headcount:
// scheduled today and in none of Working, On_Break, or Approved_Time_Off. That is
// the module's own definition of a scheduled employee who is not accounted for,
// and it is the figure that drives Coverage_Status down, so it is the coverage
// question that can be asked of attendance records alone — which criterion 4
// requires, since every counter here derives from the Attendance_Service. The
// threshold comparison itself belongs to the Coverage_Service and appears in the
// Live Coverage panel; this counter deliberately does not restate it.
//
// The status list is the complement of `ACCOUNTED_FOR_STATUSES`, computed from the
// matrix, so it needs no maintenance when a status is added.
//
// Requirements: 5.3, 5.4, 5.5, 5.6, 6.8, 12.3, 13.5, 22.5, 22.6, 22.12

'use client';

import { X } from 'lucide-react';

import {
  DERIVED_STATUSES,
  filterRecords,
  mergeRecordQuery,
  type RecordQuery,
  type RecordSubjectIndex,
} from '../domain/attendance';
import { ACCOUNTED_FOR_STATUSES } from '../domain/coverage';
import type { DailyAttendanceRecord, DerivedStatus } from '../domain/types';
import { colorRoleToken, type ColorRole } from '../shared/tokens';

/** The eight counters, in the order Requirement 5, criterion 3 names them. */
export type TeamTodayCounterId =
  | 'scheduled_today'
  | 'working'
  | 'late'
  | 'on_break'
  | 'approved_time_off'
  | 'not_clocked_in'
  | 'missing_punches'
  | 'coverage_warnings';

/**
 * The statuses that leave a scheduled employee unaccounted for: every status
 * except the three that place them on the floor or on approved leave.
 *
 * Requirements: 6.8
 */
const UNACCOUNTED_FOR_STATUSES: readonly DerivedStatus[] = DERIVED_STATUSES.filter(
  (status) => !ACCOUNTED_FOR_STATUSES.includes(status),
);

/**
 * One counter: what it is called, what it means, and the query that both counts
 * it and selects its rows.
 */
export interface TeamTodayCounter {
  id: TeamTodayCounterId;
  /** Position in Requirement 5, criterion 3, 1-based. */
  order: number;
  label: string;
  /** Plain language, shown as visible text rather than as a hover title. */
  description: string;
  /** The colour role the figure is rendered in. */
  role: ColorRole;
  /** The query fragment narrowing today's records to this counter's rows. */
  scope: RecordQuery;
}

/**
 * The counter table.
 *
 * Roles follow the same reading of Requirement 22, criterion 5 that
 * `STATUS_PRESENTATION` uses, so a counter and the status pills in the rows
 * behind it carry the same colour: working is Healthy, lateness is a shortfall
 * approaching a problem, a missing punch is payroll-blocking, and a scheduled
 * shift nobody is on is a coverage shortfall.
 *
 * Requirements: 5.3, 5.4, 5.5
 */
export const TEAM_TODAY_COUNTERS: readonly TeamTodayCounter[] = [
  {
    id: 'scheduled_today',
    order: 1,
    label: 'Scheduled today',
    description: 'Employees carrying a published shift for today.',
    role: 'neutral',
    scope: { predicates: ['scheduled_day'] },
  },
  {
    id: 'working',
    order: 2,
    label: 'Working',
    description: 'On the clock now, with no break running.',
    role: 'healthy',
    scope: { statuses: ['working'] },
  },
  {
    id: 'late',
    order: 3,
    label: 'Late',
    description:
      'Clocked in later than the scheduled start by more than the grace period, whether or not the shift has ended.',
    role: 'warning',
    scope: { savedFilter: 'late_arrivals' },
  },
  {
    id: 'on_break',
    order: 4,
    label: 'On break',
    description: 'On the clock with a break still running.',
    role: 'neutral',
    scope: { statuses: ['on_break'] },
  },
  {
    id: 'approved_time_off',
    order: 5,
    label: 'Approved time off',
    description: 'Covered by an approved time-off request, with no clock session today.',
    role: 'neutral',
    scope: { predicates: ['time_off_day'] },
  },
  {
    id: 'not_clocked_in',
    order: 6,
    label: 'Not clocked in',
    description: 'Scheduled today with no clock session recorded and no approved time off.',
    role: 'critical',
    scope: { statuses: ['missing_clock_in', 'absent'] },
  },
  {
    id: 'missing_punches',
    order: 7,
    label: 'Missing punches',
    description: 'A clock-in or a clock-out is missing, so the date cannot be paid as it stands.',
    role: 'critical',
    scope: { savedFilter: 'missing_punches' },
  },
  {
    id: 'coverage_warnings',
    order: 8,
    label: 'Coverage warnings',
    description:
      'Scheduled today and not currently working, on break, or on approved leave, so the shift is unaccounted for.',
    role: 'warning',
    scope: { predicates: ['scheduled_day'], statuses: UNACCOUNTED_FOR_STATUSES },
  },
];

const COUNTER_BY_ID: ReadonlyMap<string, TeamTodayCounter> = new Map(
  TEAM_TODAY_COUNTERS.map((counter) => [counter.id, counter]),
);

export function isTeamTodayCounterId(value: string): value is TeamTodayCounterId {
  return COUNTER_BY_ID.has(value);
}

/** One counter's definition. */
export function teamTodayCounter(id: TeamTodayCounterId): TeamTodayCounter {
  const counter = COUNTER_BY_ID.get(id);
  if (counter === undefined) {
    throw new RangeError(`team today: unknown counter "${id}"`);
  }
  return counter;
}

/**
 * The query that produced a counter, and therefore the query its rows must be
 * read under: the active query narrowed by the counter's own scope.
 *
 * `countTeamTodayRecords` counts over exactly this query, so a counter and the
 * roster behind it cannot disagree.
 *
 * Requirements: 5.4, 5.5
 */
export function teamTodayCounterQuery(
  id: TeamTodayCounterId,
  baseQuery?: RecordQuery,
): RecordQuery {
  return mergeRecordQuery(baseQuery, teamTodayCounter(id).scope);
}

/**
 * A counter's figure: the number of service-derived records its query matches.
 *
 * The records are the ones `/api/attendance/day` returned, derived by the
 * Attendance_Service, and the predicate is the domain's own. Nothing is
 * recomputed here, which is criterion 4.
 *
 * Requirements: 5.4
 */
export function countTeamTodayRecords(
  records: readonly DailyAttendanceRecord[],
  query: RecordQuery,
  subjects?: RecordSubjectIndex,
): number {
  return filterRecords(records, query, subjects).length;
}

export interface TeamTodaySummaryProps {
  /** Today's records, as the Attendance_Service derived them. */
  records: readonly DailyAttendanceRecord[];
  /** Employee departments, so a department filter in the base query can apply. */
  subjects?: RecordSubjectIndex;
  /** The active query the counters are computed under: today's date, and the filters. */
  baseQuery: RecordQuery;
  /** The selected counter, or null when none is. */
  activeCounter: TeamTodayCounterId | null;
  onSelect: (id: TeamTodayCounterId) => void;
  onClear: () => void;
  /** True while today's read has produced nothing yet, so figures read as unknown. */
  loading?: boolean;
}

/**
 * The eight counters, each a selectable control carrying its own query.
 *
 * Requirements: 5.3, 5.4, 5.5, 5.6
 */
export function TeamTodaySummary({
  records,
  subjects,
  baseQuery,
  activeCounter,
  onSelect,
  onClear,
  loading = false,
}: TeamTodaySummaryProps) {
  const active = activeCounter === null ? null : teamTodayCounter(activeCounter);

  return (
    <section
      aria-labelledby="team-today-summary-heading"
      className="rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="team-today-summary-heading"
          className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
        >
          Today at a glance
        </h2>
        <p className="text-[11px] font-semibold text-slate-400">
          Select a counter to read the employees behind it
        </p>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {TEAM_TODAY_COUNTERS.map((counter) => {
          const query = teamTodayCounterQuery(counter.id, baseQuery);
          const value = countTeamTodayRecords(records, query, subjects);
          const token = colorRoleToken(counter.role);
          const accent = colorRoleToken('accent');
          const selected = activeCounter === counter.id;

          return (
            <li key={counter.id}>
              <button
                type="button"
                onClick={() => (selected ? onClear() : onSelect(counter.id))}
                aria-pressed={selected}
                className={[
                  'flex h-full w-full flex-col items-start gap-0.5 rounded-2xl border px-3 py-2.5 text-left transition',
                  selected
                    ? `${accent.surface} ${accent.border} ring-2 ${accent.ring}`
                    : 'border-slate-200 bg-white hover:bg-slate-50',
                ].join(' ')}
              >
                {/* The accessible name is the label and the value as text, so the
                    control announces both without an aria-label to keep in step. */}
                <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                  {counter.label}
                </span>
                <span className={`text-2xl font-black tracking-tight ${loading ? 'text-slate-300' : token.text}`}>
                  {loading ? '\u2014' : value}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {/* Criterion 6: the active filter in words, and a control that clears it. */}
      {active !== null && (
        <div
          className={`mt-3 flex flex-wrap items-start justify-between gap-2 rounded-xl border px-3.5 py-2.5 ${colorRoleToken('accent').surface} ${colorRoleToken('accent').border}`}
        >
          <div className="min-w-0">
            <p className={`text-[11px] font-black uppercase tracking-wider ${colorRoleToken('accent').text}`}>
              Filtered to {active.label}
            </p>
            <p className="mt-0.5 text-[12px] font-semibold text-slate-600">{active.description}</p>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#c9d5e9] bg-white px-2.5 py-1.5 text-[11px] font-black text-[#223f7a] transition hover:bg-[#f3f6fb]"
          >
            <X className="h-3 w-3" aria-hidden="true" />
            Clear filter
          </button>
        </div>
      )}
    </section>
  );
}
