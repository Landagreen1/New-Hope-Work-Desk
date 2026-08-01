// src/features/time-attendance/today/TeamTodayTable.tsx
// The roster: one row per employee with something recorded today.
//
// Requirement 5, criterion 7 asks for one row per employee scheduled today or
// clocked in today, and criterion 8 names the ten things each row carries. Both
// are read straight off the `DailyAttendanceRecord` the Attendance_Service
// returned — the row adds no figure and derives no status, which is what keeps
// this table and the counters above it and the Exception_Queue in the
// Review_Center from disagreeing about the same employee's day.
//
// | column                        | read from                             | criterion |
// | ----------------------------- | ------------------------------------- | --------- |
// | employee name, department     | the read's own employee list          | 8         |
// | scheduled start, scheduled end| `scheduledStart`, `scheduledEnd`      | 8         |
// | first clock-in                | `firstClockIn`                        | 8         |
// | clock-out or open indicator   | `lastClockOut`, `hasOpenSession`      | 8         |
// | derived status                | `derivedStatus`                       | 8         |
// | worked hours                  | `workedHours`                         | 8         |
// | break minutes                 | `paidBreakMinutes` + `unpaidBreak…`   | 8         |
// | exceptions                    | `exceptions`                          | 8         |
//
// ## The rows are the query's answer, not a filtered copy of the counters' rows
//
// This component renders what it is given and owns no read. The screen holds the
// `RecordQuery` — today's date, the selected counter, and the three filters below
// — and reads `/api/attendance/records` under it. So the three filters are the
// same kind of thing a counter is: they change the query, the server answers it,
// and the rows are the answer. Narrowing a held array here would produce a table
// that could not agree with a counter read a minute earlier, and would silently
// cap at whatever the previous request happened to return.
//
// ## Filter options come from the rule tables
//
// The status and exception options are `DERIVED_STATUSES` and `EXCEPTION_CODES`,
// read off the Status Rule Matrix and the exception rules, so a control cannot
// offer a value the rules do not produce or the route does not accept. The
// department options are the departments actually present in the read's employee
// list, so the control does not offer a department with nobody in it.
//
// ## The seam for the employee drawer
//
// Requirement 5, criteria 10 through 15 put an employee's timeline, raw events,
// notes, history, audit entries, and the five administrator actions in a
// right-side drawer. That drawer is task 18.3. A row is a selectable control only
// when `onSelectEmployee` is supplied, so until then the table is a table and no
// row advertises an interaction that goes nowhere.
//
// Requirements: 5.7, 5.8, 5.9, 5.10, 5.19, 5.20, 22.5, 22.6, 22.7, 22.12, 22.14,
// 22.15, 22.16

'use client';

import type { Department } from '@/lib/permissions';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import { DERIVED_STATUSES, EXCEPTION_CODES } from '../domain/attendance';
import type {
  AttendanceException,
  DailyAttendanceRecord,
  DerivedStatus,
  ExceptionCode,
} from '../domain/types';
import type { AttendanceEmployee } from '../server/attendance-service';
import type { ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { NO_VALUE, formatHours, formatMinutes, formatTimeOfDay } from '../shared/format';
import { StatusPill } from '../shared/StatusPill';
import { pillClassName } from '../shared/tokens';
import type { AsyncResourceStatus } from '../shared/useAsyncResource';

/** The status values the filter offers: the twelve the matrix can assign. */
export const TEAM_TODAY_STATUS_OPTIONS: readonly DerivedStatus[] = DERIVED_STATUSES;

/** The exception types the filter offers: the codes the rules can produce. */
export const TEAM_TODAY_EXCEPTION_OPTIONS: readonly ExceptionCode[] = EXCEPTION_CODES;

/** The three filters of Requirement 5, criterion 9. An unset filter is null. */
export interface TeamTodayFilters {
  department: Department | null;
  status: DerivedStatus | null;
  exception: ExceptionCode | null;
}

/** No filter set. The state the table opens in. */
export const NO_TEAM_TODAY_FILTERS: TeamTodayFilters = {
  department: null,
  status: null,
  exception: null,
};

/** True when at least one of the three filters is set. */
export function hasTeamTodayFilter(filters: TeamTodayFilters): boolean {
  return filters.department !== null || filters.status !== null || filters.exception !== null;
}

/**
 * One exception, as a label and the rule that produced it.
 *
 * Colour follows Requirement 22, criterion 5 through the token table: a
 * payroll-blocking condition is Critical, anything else is awaiting a decision
 * and is Pending. The label is text, so the colour never travels alone, and the
 * rule description is visible text rather than a hover title (criterion 7).
 */
function ExceptionCell({ exceptions }: { exceptions: readonly AttendanceException[] }) {
  if (exceptions.length === 0) {
    return <span className="text-[11px] font-bold text-slate-300">None</span>;
  }

  return (
    <ul className="space-y-1">
      {exceptions.map((exception) => (
        <li key={`${exception.ruleId}:${exception.code}`}>
          <span className={pillClassName(exception.payrollBlocking ? 'critical' : 'pending')}>
            {statusLabel(exception.code)}
          </span>
          <span className="mt-0.5 block text-[11px] font-semibold text-slate-500">
            {exception.ruleDescription}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One employee's row. */
function EmployeeRow({
  record,
  employee,
  onSelect,
}: {
  record: DailyAttendanceRecord;
  employee: AttendanceEmployee | undefined;
  onSelect: ((profileId: string) => void) | undefined;
}) {
  // The instants are read in the employee's own zone, so a row for a colleague in
  // another country reads as that colleague's clock rather than the reader's.
  const timeZone = employee?.timezone ?? 'UTC';
  const selectable = onSelect !== undefined;

  return (
    <tr
      className={selectable ? ui.trHover : undefined}
      onClick={selectable ? () => onSelect(record.profileId) : undefined}
    >
      <td className={ui.td}>
        <div className="font-black text-slate-900">
          {employee?.displayName ?? 'Unknown employee'}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {employee === undefined ? NO_VALUE : statusLabel(employee.department ?? 'unassigned')}
        </div>
      </td>
      <td className={ui.td}>
        <div className="font-semibold text-slate-700">
          {formatTimeOfDay(record.scheduledStart, timeZone)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          to {formatTimeOfDay(record.scheduledEnd, timeZone)}
        </div>
      </td>
      <td className={ui.td}>
        <div className="font-semibold text-slate-700">
          {formatTimeOfDay(record.firstClockIn, timeZone)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {record.hasOpenSession
            ? 'Session open'
            : `out ${formatTimeOfDay(record.lastClockOut, timeZone)}`}
        </div>
      </td>
      <td className={ui.td}>
        <StatusPill status={record.derivedStatus} />
      </td>
      <td className={`${ui.td} text-right`}>
        <div className="font-black text-slate-900">{formatHours(record.workedHours)}</div>
        <div className="text-[11px] font-semibold text-slate-400">
          of {formatHours(record.scheduledHours)}
        </div>
      </td>
      <td className={`${ui.td} text-right`}>
        <div className="font-semibold text-slate-700">
          {formatMinutes(record.unpaidBreakMinutes + record.paidBreakMinutes)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {formatMinutes(record.unpaidBreakMinutes)} unpaid
        </div>
      </td>
      <td className={ui.td}>
        <ExceptionCell exceptions={record.exceptions} />
      </td>
    </tr>
  );
}

/** One filter control: a label above a select whose empty value clears it. */
function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: T | null;
  options: readonly T[];
  onChange: (next: T | null) => void;
  allLabel: string;
}) {
  return (
    <label className="block min-w-[10rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <select
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : (event.target.value as T))}
        className={`${ui.select} mt-1 py-1.5 text-[13px]`}
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {statusLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

export interface TeamTodayTableProps {
  /** The rows the active query returned, in the order the service listed them. */
  rows: readonly DailyAttendanceRecord[];
  /** The employees the read described, for the name and department of each row. */
  employees: readonly AttendanceEmployee[];
  /** Rows the query matched before paging, so a capped page says so. */
  total: number;
  /** True when the match ran past the page the service returned. */
  hasMore: boolean;
  filters: TeamTodayFilters;
  onFiltersChange: (next: TeamTodayFilters) => void;
  /** The read's state, so the section carries its own loading and failed states. */
  status: AsyncResourceStatus;
  failure: ApiFailure | null;
  /** The empty-state sentence, naming the active filters. */
  emptyMessage: string;
  pending: boolean;
  onRetry: () => void;
  /** Task 18.3's seam. Rows are selectable only when this is supplied. */
  onSelectEmployee?: (profileId: string) => void;
}

/**
 * The team roster for today, with the three filters that narrow it.
 *
 * Requirements: 5.7, 5.8, 5.9, 5.19, 5.20
 */
export function TeamTodayTable({
  rows,
  employees,
  total,
  hasMore,
  filters,
  onFiltersChange,
  status,
  failure,
  emptyMessage,
  pending,
  onRetry,
  onSelectEmployee,
}: TeamTodayTableProps) {
  const byProfileId = new Map(employees.map((employee) => [employee.profileId, employee]));

  // Only the departments the read actually described: a control offering a
  // department with nobody in it invites a filter that can only come back empty.
  const departments = [
    ...new Set(
      employees
        .map((employee) => employee.department)
        .filter((department): department is Department => department !== null),
    ),
  ].sort();

  return (
    <section
      aria-labelledby="team-today-table-heading"
      className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="space-y-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="team-today-table-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Team attendance
          </h2>
          <p className="text-[11px] font-semibold text-slate-400">
            {hasMore
              ? `Showing ${rows.length} of ${total} records`
              : `${total} ${total === 1 ? 'record' : 'records'}`}
          </p>
        </div>

        {/* Criterion 9. Each control sets the query the rows are read under. */}
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Department"
            value={filters.department}
            options={departments}
            allLabel="All departments"
            onChange={(department) => onFiltersChange({ ...filters, department })}
          />
          <FilterSelect
            label="Status"
            value={filters.status}
            options={TEAM_TODAY_STATUS_OPTIONS}
            allLabel="All statuses"
            onChange={(next) => onFiltersChange({ ...filters, status: next })}
          />
          <FilterSelect
            label="Exception"
            value={filters.exception}
            options={TEAM_TODAY_EXCEPTION_OPTIONS}
            allLabel="All exceptions"
            onChange={(exception) => onFiltersChange({ ...filters, exception })}
          />
          {hasTeamTodayFilter(filters) && (
            <button
              type="button"
              onClick={() => onFiltersChange(NO_TEAM_TODAY_FILTERS)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {(status !== 'ready' || failure !== null) && (
        <div className="px-4 pt-3 sm:px-5">
          <AsyncStateBlock
            status={status}
            failure={failure}
            pending={pending}
            onRetry={onRetry}
            subject="team attendance"
            message={emptyMessage}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Scheduled</th>
                <th className={ui.th}>Clock</th>
                <th className={ui.th}>Status</th>
                <th className={`${ui.th} text-right`}>Worked</th>
                <th className={`${ui.th} text-right`}>Breaks</th>
                <th className={ui.th}>Exceptions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((record) => (
                <EmployeeRow
                  key={`${record.profileId}:${record.workDate}`}
                  record={record}
                  employee={byProfileId.get(record.profileId)}
                  onSelect={onSelectEmployee}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
