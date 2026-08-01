// src/features/time-attendance/review/OverviewView.tsx
// The aggregate view, and the one thing that makes it more than a dashboard:
// every figure on it opens the records it was computed over.
//
// Requirement 13's user story asks for metrics that can be explained, and
// criterion 5 says what explaining one means — selecting a metric opens the
// Exception_Queue filtered to the Daily_Attendance_Record set that produced it.
// That is not a filter this view constructs. `aggregateMetrics` computes each of
// the fourteen figures over `recordQueryForMetric`, returns that identical query
// on the metric, and this view hands it to `openExceptionQueue` untouched. A
// metric and its rows are therefore the same set by construction rather than by
// two expressions that happen to agree.
//
// ## What this view owns
//
// The question, and nothing about the answer. It holds a date preset, a custom
// range, and the six filters of criterion 2; it reads `/api/attendance/metrics`
// once for the whole metric set (criterion 7); and it renders the fourteen values
// the service returned. It computes no figure, which is criterion 4 and
// Requirement 3, criteria 14 and 15.
//
// ## The seven presets
//
// Criterion 1 names them: today, yesterday, this week, last week, current pay
// period, previous pay period, and a custom range. Five are arithmetic over
// today's date; two come from `payroll_periods`, which `ReviewCenter` has already
// read. A preset with no period behind it — no payroll calendar configured, or no
// period before the current one — is offered as unavailable with the reason
// stated, rather than silently resolving to something else. An administrator who
// selects "previous pay period" and is shown a fortnight would read the fortnight
// as the period.
//
// Today is read through `readerWorkDate`, the same function `ReviewCenter` picks
// its default range with, so the two cannot disagree about which date the presets
// are relative to. It selects a range and nothing more: which work date a clock
// instant belongs to is the service's decision, in the business timezone.
//
// ## Accessible names
//
// Criterion 6 asks each metric control to carry an accessible name stating both
// the metric label and the metric value. Each tile is a button with an explicit
// `aria-label` built from the label and the figure in words, so the name is one
// string rather than the concatenation of three nested elements — and the same
// text is visible on the tile, so the visible label is contained in the
// accessible name.
//
// Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9, 22.5,
// 22.6, 22.7, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useState } from 'react';

import type { Department } from '@/lib/permissions';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import {
  DERIVED_STATUSES,
  EXCEPTION_CODES,
  metricDefinition,
  type RecordQuery,
  type ReviewStatusFilter,
} from '../domain/attendance';
import type { DateRange, DerivedStatus, ExceptionCode } from '../domain/types';
import { addCalendarDays, zonedToInstant } from '../domain/work-date';
import type { AttendanceEmployee, MetricQuery, MetricsResponse } from '../server/attendance-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { formatMetricValue, formatWorkDate, metricValuePhrase } from '../shared/format';
import { recordQueryUrl } from '../shared/record-query';
import { colorRoleToken } from '../shared/tokens';
import {
  emptyStateMessage,
  useAsyncResource,
  type ActiveFilter,
} from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS } from '../types';
import { readerWorkDate, type ReviewPayrollPeriod, type ReviewViewContext } from './ReviewCenter';

/** A stable empty roster, so a memo does not see a new array every render. */
const NO_EMPLOYEES: readonly AttendanceEmployee[] = [];

// ─── The seven date presets ──────────────────────────────────────────────────

/** The presets of Requirement 13, criterion 1, in the order it names them. */
export type DatePresetId =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'current_pay_period'
  | 'previous_pay_period'
  | 'custom';

/** One preset: what it is called, and what range it stands for. */
export interface DatePreset {
  id: DatePresetId;
  label: string;
  description: string;
}

/**
 * The preset table.
 *
 * Requirements: 13.1
 */
export const DATE_PRESETS: readonly DatePreset[] = [
  { id: 'today', label: 'Today', description: 'The current work date.' },
  { id: 'yesterday', label: 'Yesterday', description: 'The work date before the current one.' },
  {
    id: 'this_week',
    label: 'This week',
    description: 'Monday to Sunday of the week containing today.',
  },
  {
    id: 'last_week',
    label: 'Last week',
    description: 'Monday to Sunday of the week before the one containing today.',
  },
  {
    id: 'current_pay_period',
    label: 'Current pay period',
    description: 'The payroll period covering today.',
  },
  {
    id: 'previous_pay_period',
    label: 'Previous pay period',
    description: 'The payroll period that ended before the current one began.',
  },
  { id: 'custom', label: 'Custom range', description: 'Any two dates, both ends included.' },
];

/** The preset the view opens on: the range the Exception_Queue also opened on. */
export const DEFAULT_DATE_PRESET: DatePresetId = 'current_pay_period';

/**
 * The Monday of the week containing a date.
 *
 * The weekday is read through `zonedToInstant`, the module's one wall-clock
 * conversion, at UTC midnight — a calendar date carries no hour, so no zone
 * belongs in the answer and reading it in UTC makes the result independent of
 * where the reader is.
 */
function weekStart(date: string): string {
  const weekday = zonedToInstant(date, '00:00:00', 'UTC').getUTCDay();
  return addCalendarDays(date, -((weekday + 6) % 7));
}

/**
 * The payroll period that ended before the current one began.
 *
 * Measured against the current period's start where there is one and against
 * today where there is not, so "previous" means the same thing whether or not a
 * period covers today. The latest such period, because two periods that both
 * ended earlier are last month and the month before, and "previous" is the first
 * of those.
 *
 * Requirements: 13.1
 */
export function previousPayPeriod(
  periods: readonly ReviewPayrollPeriod[],
  current: ReviewPayrollPeriod | null,
  today: string,
): ReviewPayrollPeriod | null {
  const boundary = current === null ? today : current.from;

  let best: ReviewPayrollPeriod | null = null;
  for (const period of periods) {
    if (period.to >= boundary) continue;
    if (best === null || period.to > best.to) best = period;
  }
  return best;
}

/** A preset's range, or the reason it cannot be resolved. */
export type PresetResolution =
  | { available: true; range: DateRange }
  | { available: false; reason: string };

/**
 * The range a preset stands for.
 *
 * `custom` resolves to the range the reader typed, which the caller passes in, so
 * every preset including that one is resolved by this one function and the active
 * range is a single expression.
 *
 * Requirements: 13.1
 */
export function resolveDatePreset(
  id: DatePresetId,
  today: string,
  periods: readonly ReviewPayrollPeriod[],
  currentPayPeriod: ReviewPayrollPeriod | null,
  customRange: DateRange,
): PresetResolution {
  switch (id) {
    case 'today':
      return { available: true, range: { from: today, to: today } };

    case 'yesterday': {
      const date = addCalendarDays(today, -1);
      return { available: true, range: { from: date, to: date } };
    }

    case 'this_week': {
      const monday = weekStart(today);
      return { available: true, range: { from: monday, to: addCalendarDays(monday, 6) } };
    }

    case 'last_week': {
      const monday = addCalendarDays(weekStart(today), -7);
      return { available: true, range: { from: monday, to: addCalendarDays(monday, 6) } };
    }

    case 'current_pay_period':
      return currentPayPeriod === null
        ? {
            available: false,
            reason: 'No payroll period covers today, so there is no current period to report on.',
          }
        : { available: true, range: { from: currentPayPeriod.from, to: currentPayPeriod.to } };

    case 'previous_pay_period': {
      const previous = previousPayPeriod(periods, currentPayPeriod, today);
      return previous === null
        ? {
            available: false,
            reason: 'No payroll period ended before this one, so there is no previous period.',
          }
        : { available: true, range: { from: previous.from, to: previous.to } };
    }

    case 'custom':
      return customRange.from > customRange.to
        ? { available: false, reason: 'The custom range starts after it ends.' }
        : { available: true, range: customRange };
  }
}

// ─── The six filters ─────────────────────────────────────────────────────────

/** The filters of Requirement 13, criterion 2. */
export interface OverviewFilters {
  /** One employee, or every employee in scope. */
  profileId: string | null;
  department: Department | null;
  status: DerivedStatus | null;
  exception: ExceptionCode | null;
  reviewStatus: ReviewStatusFilter | null;
  payrollBlocking: boolean | null;
}

/** Nothing narrowed. */
export const NO_OVERVIEW_FILTERS: OverviewFilters = {
  profileId: null,
  department: null,
  status: null,
  exception: null,
  reviewStatus: null,
  payrollBlocking: null,
};

/** True when any of the six is set. */
export function hasOverviewFilter(filters: OverviewFilters): boolean {
  return (
    filters.profileId !== null ||
    filters.department !== null ||
    filters.status !== null ||
    filters.exception !== null ||
    filters.reviewStatus !== null ||
    filters.payrollBlocking !== null
  );
}

/**
 * The query the metric set is read under: the active range and the six filters.
 *
 * No paging: a metric is computed over the whole match rather than over a page,
 * which is why `/api/attendance/metrics` reads none.
 *
 * Requirements: 13.2, 13.7
 */
export function overviewQuery(filters: OverviewFilters, range: DateRange): MetricQuery {
  const query: MetricQuery = { from: range.from, to: range.to };

  if (filters.profileId !== null) query.profileIds = [filters.profileId];
  if (filters.department !== null) query.departments = [filters.department];
  if (filters.status !== null) query.statuses = [filters.status];
  if (filters.exception !== null) query.exceptionCodes = [filters.exception];
  if (filters.reviewStatus !== null) query.reviewStatus = filters.reviewStatus;
  if (filters.payrollBlocking !== null) query.payrollBlocking = filters.payrollBlocking;

  return query;
}

/**
 * The active range and filters in the view's own words.
 *
 * Rendered beside the metrics (criterion 8) and named in the empty state
 * (criterion 9), from one list, so the two cannot describe different questions.
 * Every filter appears whether it is set or not, because "All departments" tells
 * a reader that an empty result is not a department they forgot they had
 * selected.
 *
 * Requirements: 13.8, 13.9, 22.15
 */
export function overviewActiveFilters(
  filters: OverviewFilters,
  range: DateRange,
  employeeName: (profileId: string) => string,
): ActiveFilter[] {
  return [
    { label: 'Dates', value: `${formatWorkDate(range.from)} to ${formatWorkDate(range.to)}` },
    {
      label: 'Employee',
      value: filters.profileId === null ? 'All employees' : employeeName(filters.profileId),
    },
    {
      label: 'Department',
      value:
        filters.department === null ? 'All departments' : DEPARTMENT_LABELS[filters.department],
    },
    {
      label: 'Status',
      value: filters.status === null ? 'All statuses' : statusLabel(filters.status),
    },
    {
      label: 'Exception',
      value: filters.exception === null ? 'All exceptions' : statusLabel(filters.exception),
    },
    {
      label: 'Review status',
      value:
        filters.reviewStatus === null
          ? 'Reviewed and unreviewed'
          : statusLabel(filters.reviewStatus),
    },
    {
      label: 'Payroll',
      value:
        filters.payrollBlocking === null
          ? 'Blocking and not blocking'
          : filters.payrollBlocking
            ? 'Payroll blocking only'
            : 'Not payroll blocking',
    },
  ];
}

// ─── Controls ────────────────────────────────────────────────────────────────

/** One select filter, whose empty value clears it. */
function FilterSelect<T extends string>({
  label,
  value,
  options,
  optionLabel,
  onChange,
  allLabel,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  optionLabel: (option: T) => string;
  onChange: (next: T | null) => void;
  allLabel: string;
}) {
  return (
    <label className="block min-w-[9.5rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.target.value === '' ? null : (event.target.value as T))
        }
        className={`${ui.select} mt-1 py-1.5 text-[13px]`}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

/** One end of the custom range. */
function FilterDate({
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

// ─── The view ────────────────────────────────────────────────────────────────

/** Everything `ReviewCenter` hands a view. */
export type OverviewViewProps = ReviewViewContext;

/**
 * The Overview: the seven presets, the six filters, and the fourteen metrics as
 * selectable controls.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 13.7, 13.8, 13.9
 */
export function OverviewView({
  payPeriods,
  currentPayPeriod,
  defaultRange,
  openExceptionQueue,
}: OverviewViewProps) {
  // Read once, on the first render, so a screen left open past midnight does not
  // move the presets under the reader.
  const [today] = useState(readerWorkDate);
  const [preset, setPreset] = useState<DatePresetId>(DEFAULT_DATE_PRESET);
  const [customRange, setCustomRange] = useState<DateRange>(defaultRange);
  const [filters, setFilters] = useState<OverviewFilters>(NO_OVERVIEW_FILTERS);

  const resolution = useMemo(
    () => resolveDatePreset(preset, today, payPeriods, currentPayPeriod, customRange),
    [preset, today, payPeriods, currentPayPeriod, customRange],
  );

  // An unavailable preset falls back to the range the screen opened on for the
  // read, and says so above the metrics. Reading nothing at all would leave the
  // view blank with no figures to explain the notice against.
  const range = resolution.available ? resolution.range : defaultRange;

  const query = useMemo(() => overviewQuery(filters, range), [filters, range]);
  const read = useMemo(() => recordQueryUrl('/api/attendance/metrics', query), [query]);

  const metrics = useAsyncResource(
    (signal) => attendanceJson<MetricsResponse>(read.url, { signal }),
    {
      deps: [read.url],
      enabled: !read.unsatisfiable,
      subject: 'attendance records',
      // Criterion 9: no matched record is an empty state, not a wall of zeroes.
      isEmpty: (response) => response.recordCount === 0,
    },
  );

  // Memoised rather than defaulted inline, so the filter controls and the two
  // derived lists below do not see a new array on every render.
  const employees = useMemo<readonly AttendanceEmployee[]>(
    () => metrics.data?.employees ?? NO_EMPLOYEES,
    [metrics.data],
  );

  const employeeName = useCallback(
    (profileId: string) =>
      employees.find((employee) => employee.profileId === profileId)?.displayName ??
      'Selected employee',
    [employees],
  );

  const departments = useMemo(
    () =>
      [
        ...new Set(
          employees
            .map((employee) => employee.department)
            .filter((department): department is Department => department !== null),
        ),
      ].sort(),
    [employees],
  );

  const activeFilters = useMemo(
    () => overviewActiveFilters(filters, range, employeeName),
    [filters, range, employeeName],
  );

  const accent = colorRoleToken('accent');
  const activePreset = DATE_PRESETS.find((candidate) => candidate.id === preset) ?? DATE_PRESETS[0];

  /** Criterion 5: the query the figure was computed over, handed over unchanged. */
  const drillDown = useCallback(
    (metricQuery: RecordQuery) => {
      openExceptionQueue(metricQuery);
    },
    [openExceptionQueue],
  );

  return (
    <section
      aria-labelledby="overview-heading"
      className="space-y-4 rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="overview-heading"
          className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
        >
          Overview
        </h2>
        <p className="text-[11px] font-semibold text-slate-400">
          Select a metric to open the records behind it
        </p>
      </div>

      {/* Criterion 1: the seven presets. */}
      <div>
        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
          Date range
        </span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {DATE_PRESETS.map((candidate) => {
            const active = candidate.id === preset;
            const candidateRange = resolveDatePreset(
              candidate.id,
              today,
              payPeriods,
              currentPayPeriod,
              customRange,
            );

            return (
              <button
                key={candidate.id}
                type="button"
                aria-pressed={active}
                onClick={() => setPreset(candidate.id)}
                className={[
                  'rounded-full border px-2.5 py-1 text-[11px] font-black transition',
                  active
                    ? `${accent.surface} ${accent.border} ${accent.text}`
                    : candidateRange.available
                      ? 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      : 'border-dashed border-slate-200 bg-white text-slate-400 hover:bg-slate-50',
                ].join(' ')}
              >
                {candidate.label}
                {!candidateRange.available && ' \u00b7 unavailable'}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] font-semibold text-slate-500">
          {activePreset.description}
        </p>
      </div>

      {/* The custom range's own controls, shown only where they mean something. */}
      {preset === 'custom' && (
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <FilterDate
            label="From"
            value={customRange.from}
            onChange={(from) =>
              setCustomRange((previous) => ({
                from: from === '' ? previous.from : from,
                to: from !== '' && from > previous.to ? from : previous.to,
              }))
            }
          />
          <FilterDate
            label="To"
            value={customRange.to}
            onChange={(to) =>
              setCustomRange((previous) => ({
                from: to !== '' && to < previous.from ? to : previous.from,
                to: to === '' ? previous.to : to,
              }))
            }
          />
        </div>
      )}

      {/* An unavailable preset states its reason as visible text, and the range
          that was read instead, so the figures below are never unexplained. */}
      {!resolution.available && (
        <p
          className={`rounded-xl border px-3.5 py-2.5 text-[12px] font-semibold ${colorRoleToken('warning').surface} ${colorRoleToken('warning').border} ${colorRoleToken('warning').text}`}
        >
          {resolution.reason} Showing {formatWorkDate(defaultRange.from)} to{' '}
          {formatWorkDate(defaultRange.to)} instead.
        </p>
      )}

      {/* Criterion 2: the six filters. */}
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <FilterSelect
          label="Employee"
          value={filters.profileId}
          options={employees.map((employee) => employee.profileId)}
          optionLabel={employeeName}
          allLabel="All employees"
          onChange={(profileId) => setFilters({ ...filters, profileId })}
        />
        <FilterSelect
          label="Department"
          value={filters.department}
          options={departments}
          optionLabel={(department) => DEPARTMENT_LABELS[department]}
          allLabel="All departments"
          onChange={(department) => setFilters({ ...filters, department })}
        />
        <FilterSelect
          label="Status"
          value={filters.status}
          options={DERIVED_STATUSES}
          optionLabel={statusLabel}
          allLabel="All statuses"
          onChange={(status) => setFilters({ ...filters, status })}
        />
        <FilterSelect
          label="Exception"
          value={filters.exception}
          options={EXCEPTION_CODES}
          optionLabel={statusLabel}
          allLabel="All exceptions"
          onChange={(exception) => setFilters({ ...filters, exception })}
        />
        <FilterSelect
          label="Review status"
          value={filters.reviewStatus}
          options={['unreviewed', 'reviewed'] as const}
          optionLabel={statusLabel}
          allLabel="Reviewed and unreviewed"
          onChange={(reviewStatus) => setFilters({ ...filters, reviewStatus })}
        />
        <FilterSelect
          label="Payroll"
          value={
            filters.payrollBlocking === null
              ? null
              : filters.payrollBlocking
                ? 'blocking'
                : 'clear'
          }
          options={['blocking', 'clear'] as const}
          optionLabel={(option) =>
            option === 'blocking' ? 'Payroll blocking only' : 'Not payroll blocking'
          }
          allLabel="Blocking and not blocking"
          onChange={(option) =>
            setFilters({
              ...filters,
              payrollBlocking: option === null ? null : option === 'blocking',
            })
          }
        />
        {hasOverviewFilter(filters) && (
          <button
            type="button"
            onClick={() => setFilters(NO_OVERVIEW_FILTERS)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Criterion 8: the active range and filters, beside the metrics. */}
      <ul className="flex flex-wrap gap-1.5">
        {activeFilters.map((filter) => (
          <li
            key={filter.label}
            className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-600"
          >
            <span className="font-black uppercase tracking-[0.1em] text-slate-400">
              {filter.label}
            </span>{' '}
            {filter.value}
          </li>
        ))}
      </ul>

      <AsyncStateBlock
        status={read.unsatisfiable ? 'empty' : metrics.status}
        failure={read.unsatisfiable ? null : metrics.failure}
        pending={metrics.pending}
        onRetry={metrics.retry}
        subject="the attendance metrics"
        message={emptyStateMessage('attendance records', activeFilters)}
      />

      {/* Criterion 3: the fourteen metrics, in the order the criterion names
          them, each one a control (criterion 6) carrying the query that produced
          it (criterion 5). */}
      {metrics.status === 'ready' && metrics.data !== null && (
        <>
          <p className="text-[11px] font-semibold text-slate-400">
            {metrics.data.recordCount}{' '}
            {metrics.data.recordCount === 1 ? 'record' : 'records'} match the active filters.
          </p>

          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {metrics.data.metrics.map((metric) => {
              const definition = metricDefinition(metric.key);
              const valueText = formatMetricValue(metric.value, metric.unit);
              const phrase = metricValuePhrase(metric.value, metric.unit);

              return (
                <li key={metric.key}>
                  <button
                    type="button"
                    onClick={() => drillDown(metric.query)}
                    aria-label={`${metric.label}: ${phrase}. Opens the ${metric.recordCount} ${metric.recordCount === 1 ? 'record' : 'records'} behind it.`}
                    className="flex h-full w-full flex-col items-start gap-0.5 rounded-2xl border border-slate-200 bg-white px-3 py-2.5 text-left transition hover:border-[#c9d5e9] hover:bg-[#f8faff]"
                  >
                    <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
                      {metric.label}
                    </span>
                    <span className="text-2xl font-black tracking-tight text-slate-900">
                      {valueText}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-400">
                      {metric.recordCount} {metric.recordCount === 1 ? 'record' : 'records'}
                    </span>
                    <span className="text-[11px] font-semibold text-slate-500">
                      {definition.description}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

export default OverviewView;
