// src/features/time-attendance/review/EmployeeTrendsView.tsx
// One employee over one range, with the evidence behind every figure.
//
// Requirement 14's user story is a conversation an administrator has to prepare
// for, which is why criterion 4 asks every displayed value to open the records
// that produced it and criterion 5 forbids a chart that carries neither a
// drill-down nor a stated action. Those two together rule out the shape this view
// would otherwise take — a summary card and a bar chart — and rule in the shape it
// has: every figure is a button, and the scheduled-versus-worked comparison is a
// list of dates that are each a button too.
//
// ## Nothing here is computed
//
// `/api/attendance/trends` returns the twelve values of criterion 2 in that order,
// each carrying the `RecordQuery` it was computed over, plus one entry per work
// date for the comparison of criterion 3, each carrying its own single-date query.
// Eight of the twelve are `aggregateMetrics` figures under a trend-facing name, so
// a trend figure and the Overview figure for the same employee and range are the
// same number rather than two numbers that agree today. This view renders them and
// hands their queries to `openExceptionQueue` unchanged.
//
// ## The bars are a rendering of the figures, not a second figure
//
// Each date's two bars are widths proportional to the largest hours figure on the
// visible dates. That is the only arithmetic in this module, it is presentation
// rather than derivation — the hours themselves are printed beside the bars, so a
// reader never has to measure a bar to read a value — and the row is a control
// that opens that date's record, which is what criterion 5 asks of anything
// chart-shaped.
//
// ## Why the employee list comes from a separate read
//
// The trend read is about a named employee, so it cannot supply the list of
// employees to name. `useAttendanceRoster` reads `/api/attendance/day`, which
// answers one date for everybody in scope and carries the roster whether or not
// anybody has anything recorded on it. Both reads resolve scope through
// `visibleProfileIds`, so the list this view offers is exactly the list the trend
// read would accept.
//
// Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 22.5, 22.6, 22.7, 22.12,
// 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useState } from 'react';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import type { RecordQuery } from '../domain/attendance';
import type { DateRange } from '../domain/types';
import type { AttendanceNote, TrendResponse } from '../server/attendance-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import {
  formatHours,
  formatInstantDate,
  formatMetricValue,
  formatWorkDate,
  metricValuePhrase,
} from '../shared/format';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken } from '../shared/tokens';
import {
  emptyStateMessage,
  useAsyncResource,
  type ActiveFilter,
} from '../shared/useAsyncResource';
import { useAttendanceRoster } from '../shared/useAttendanceRoster';
import type { ReviewViewContext } from './ReviewCenter';

/** The bar track's width in the comparison list, as a share of the cell. */
const BAR_TRACK_CLASS = 'h-1.5 w-full rounded-full bg-slate-100';

/**
 * A bar's width as a percentage of the widest figure on the visible dates.
 *
 * Presentation only: the figure itself is printed beside the bar, so the bar
 * never carries information the text does not. A zero peak — a range where
 * nothing was scheduled and nothing was worked — renders as no bar rather than as
 * a division by zero.
 */
function barWidth(value: number, peak: number): string {
  if (!Number.isFinite(value) || value <= 0 || peak <= 0) return '0%';
  return `${Math.min(100, (value / peak) * 100)}%`;
}

/** The active employee and range, in words, for the empty state. */
export function trendActiveFilters(
  employeeName: string | null,
  range: DateRange,
): ActiveFilter[] {
  return [
    { label: 'Employee', value: employeeName ?? 'None selected' },
    { label: 'Dates', value: `${formatWorkDate(range.from)} to ${formatWorkDate(range.to)}` },
  ];
}

/** One end of the range control. */
function RangeDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block min-w-[9rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={`${ui.input} mt-1 py-1.5 text-[13px]`}
      />
    </label>
  );
}

/** One manager note, as visible text with the date it was recorded on. */
function NoteLine({ note, timeZone }: { note: AttendanceNote; timeZone: string }) {
  return (
    <li className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
      <p className="text-[11px] font-black uppercase tracking-[0.1em] text-slate-400">
        {formatWorkDate(note.workDate)}
        {note.createdAt === '' ? '' : ` \u00b7 recorded ${formatInstantDate(note.createdAt, timeZone)}`}
      </p>
      <p className="mt-0.5 text-[13px] font-semibold text-slate-700">{note.note}</p>
    </li>
  );
}

/** Everything `ReviewCenter` hands a view. */
export type EmployeeTrendsViewProps = ReviewViewContext;

/**
 * Employee Trends: one employee, one range, twelve values, and a date-by-date
 * comparison — every one of them a drill-down.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6
 */
export function EmployeeTrendsView({ defaultRange, openExceptionQueue }: EmployeeTrendsViewProps) {
  const [profileId, setProfileId] = useState<string | null>(null);
  const [range, setRange] = useState<DateRange>(defaultRange);

  const roster = useAttendanceRoster();

  const employee = useMemo(
    () => roster.employees.find((candidate) => candidate.profileId === profileId) ?? null,
    [roster.employees, profileId],
  );

  const rangeValid = range.from <= range.to;
  const enabled = profileId !== null && rangeValid;

  const url =
    profileId === null
      ? ''
      : `/api/attendance/trends?profile_id=${encodeURIComponent(profileId)}&from=${range.from}&to=${range.to}`;

  const trends = useAsyncResource(
    (signal) => attendanceJson<TrendResponse>(url, { signal }),
    {
      deps: [url],
      enabled,
      subject: 'attendance records',
      // Criterion 3's comparison is what an empty range has none of. The twelve
      // values still come back, all zero, and reporting that as content would
      // present a wall of zeroes as a history.
      isEmpty: (response) => response.byDate.length === 0,
    },
  );

  const activeFilters = useMemo(
    () => trendActiveFilters(employee?.displayName ?? null, range),
    [employee, range],
  );

  const timeZone = employee?.timezone ?? 'UTC';

  const peakHours = useMemo(() => {
    const byDate = trends.data?.byDate ?? [];
    let peak = 0;
    for (const day of byDate) {
      peak = Math.max(peak, day.scheduledHours, day.workedHours);
    }
    return peak;
  }, [trends.data]);

  /** Criterion 4: the query the value was computed over, handed over unchanged. */
  const drillDown = useCallback(
    (query: RecordQuery) => {
      openExceptionQueue(query);
    },
    [openExceptionQueue],
  );

  const accent = colorRoleToken('accent');
  const atDefaultRange = range.from === defaultRange.from && range.to === defaultRange.to;

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="employee-trends-heading"
        className="space-y-3 rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="employee-trends-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Employee trends
          </h2>
          <p className="text-[11px] font-semibold text-slate-400">
            Select a value to open the records behind it
          </p>
        </div>

        {/* Criterion 1: one employee and one date range. */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label className="block min-w-[13rem] flex-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              Employee
            </span>
            <select
              value={profileId ?? ''}
              onChange={(event) =>
                setProfileId(event.target.value === '' ? null : event.target.value)
              }
              className={`${ui.select} mt-1 py-1.5 text-[13px]`}
            >
              <option value="">Choose an employee</option>
              {roster.employees.map((candidate) => (
                <option key={candidate.profileId} value={candidate.profileId}>
                  {candidate.displayName}
                </option>
              ))}
            </select>
          </label>

          <RangeDate
            label="From"
            value={range.from}
            onChange={(from) =>
              setRange((previous) => ({
                from: from === '' ? previous.from : from,
                to: from !== '' && from > previous.to ? from : previous.to,
              }))
            }
          />
          <RangeDate
            label="To"
            value={range.to}
            onChange={(to) =>
              setRange((previous) => ({
                from: to !== '' && to < previous.from ? to : previous.from,
                to: to === '' ? previous.to : to,
              }))
            }
          />
          <button
            type="button"
            disabled={atDefaultRange}
            onClick={() => setRange(defaultRange)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Default range
          </button>
        </div>

        {/* The roster read's own states, so a failure to load the employee list
            says so rather than presenting an empty select as an empty roster. */}
        <AsyncStateBlock
          status={roster.status}
          failure={roster.failure}
          pending={roster.pending}
          onRetry={roster.retry}
          subject="the employee list"
        />

        <AsyncStateBlock
          status={profileId === null ? 'idle' : trends.status}
          failure={trends.failure}
          pending={trends.pending}
          onRetry={trends.retry}
          subject="this employee's history"
          message={
            profileId === null
              ? 'Choose an employee to read their attendance history.'
              : emptyStateMessage('attendance records', activeFilters)
          }
        />
      </section>

      {trends.data !== null && profileId !== null && (
        <>
          {/* Criterion 2: the twelve values, in the order the criterion names
              them, each a control that opens its own records (criterion 4). */}
          <section
            aria-labelledby="trend-values-heading"
            className="rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
          >
            <h3
              id="trend-values-heading"
              className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
            >
              {employee?.displayName ?? trends.data.profileId} {'\u00b7'}{' '}
              {formatWorkDate(trends.data.range.from)} to {formatWorkDate(trends.data.range.to)}
            </h3>

            <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {trends.data.values.map((value) => (
                <li key={value.key}>
                  <button
                    type="button"
                    onClick={() => drillDown(value.query)}
                    aria-label={`${value.label}: ${metricValuePhrase(value.value, value.unit)}. Opens the ${value.recordCount} ${value.recordCount === 1 ? 'record' : 'records'} behind it.`}
                    className="flex h-full w-full flex-col items-start gap-0.5 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-[#c9d5e9] hover:bg-[#f8faff]"
                  >
                    <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                      {value.label}
                    </span>
                    <span className="text-2xl font-black tracking-tight text-slate-900">
                      {formatMetricValue(value.value, value.unit)}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-400">
                      {value.recordCount} {value.recordCount === 1 ? 'record' : 'records'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          {/* Criterion 3: scheduled against worked, per work date. Every row is
              the drill-down criterion 5 requires of anything chart-shaped. */}
          <section
            aria-labelledby="trend-comparison-heading"
            className="rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3
                id="trend-comparison-heading"
                className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
              >
                Scheduled against worked
              </h3>
              <p className="text-[11px] font-semibold text-slate-400">
                Select a date to open that day&apos;s record
              </p>
            </div>

            {trends.data.byDate.length === 0 ? (
              <p className="mt-3 text-[13px] font-semibold text-slate-500">
                No work date in this range carries a record.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {trends.data.byDate.map((day) => (
                  <li key={day.workDate}>
                    <button
                      type="button"
                      onClick={() => drillDown(day.query)}
                      aria-label={`${formatWorkDate(day.workDate)}: ${formatHours(day.scheduledHours)} scheduled, ${formatHours(day.workedHours)} worked, ${statusLabel(day.derivedStatus)}. Opens the record for that date.`}
                      className="grid w-full grid-cols-1 items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-[#c9d5e9] hover:bg-[#f8faff] sm:grid-cols-[9rem_1fr_auto]"
                    >
                      <span className="text-[12px] font-black text-slate-900">
                        {formatWorkDate(day.workDate)}
                      </span>

                      <span className="block min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="w-[4.5rem] shrink-0 text-[10px] font-black uppercase tracking-[0.1em] text-slate-400">
                            Scheduled
                          </span>
                          <span className={BAR_TRACK_CLASS}>
                            <span
                              className={`block h-1.5 rounded-full ${colorRoleToken('neutral').dot}`}
                              style={{ width: barWidth(day.scheduledHours, peakHours) }}
                            />
                          </span>
                          <span className="w-[3.5rem] shrink-0 text-right text-[12px] font-black text-slate-700">
                            {formatHours(day.scheduledHours)}
                          </span>
                        </span>
                        <span className="mt-1 flex items-center gap-2">
                          <span className="w-[4.5rem] shrink-0 text-[10px] font-black uppercase tracking-[0.1em] text-slate-400">
                            Worked
                          </span>
                          <span className={BAR_TRACK_CLASS}>
                            <span
                              className={`block h-1.5 rounded-full ${
                                day.payrollBlocking
                                  ? colorRoleToken('critical').dot
                                  : colorRoleToken('healthy').dot
                              }`}
                              style={{ width: barWidth(day.workedHours, peakHours) }}
                            />
                          </span>
                          <span className="w-[3.5rem] shrink-0 text-right text-[12px] font-black text-slate-700">
                            {formatHours(day.workedHours)}
                          </span>
                        </span>
                      </span>

                      <span className="flex items-center gap-1.5">
                        <StatusPill status={day.derivedStatus} />
                        {day.payrollBlocking && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-black ${colorRoleToken('critical').surface} ${colorRoleToken('critical').text}`}
                          >
                            Payroll blocked
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Criterion 2's twelfth value is the manager notes, and a count of
              notes is not the notes. The count above is the drill-down; this is
              what was written. */}
          <section
            aria-labelledby="trend-notes-heading"
            className="rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
          >
            <h3
              id="trend-notes-heading"
              className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
            >
              Manager notes
            </h3>

            {trends.data.notes.length === 0 ? (
              <p className="mt-2 text-[13px] font-semibold text-slate-500">
                No manager note was recorded against this employee in this range.
              </p>
            ) : (
              <ul className="mt-3 space-y-1.5">
                {trends.data.notes.map((note) => (
                  <NoteLine key={note.id} note={note} timeZone={timeZone} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {/* An inverted range is stated rather than read: the service would refuse
          it, and a refusal reads as a failure where this is a control mid-edit. */}
      {!rangeValid && (
        <p
          className={`rounded-xl border px-3.5 py-2.5 text-[12px] font-semibold ${accent.surface} ${accent.border} ${accent.text}`}
        >
          The range starts after it ends, so there is nothing to read yet.
        </p>
      )}
    </div>
  );
}

export default EmployeeTrendsView;
