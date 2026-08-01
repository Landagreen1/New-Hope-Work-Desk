// src/features/time-attendance/review/AuditLogView.tsx
// The audit trail, read: every recorded field of every entry, under four filters,
// a hundred entries at a time.
//
// Requirement 16's user story asks for a trail where every attendance change can
// be traced to a person and a reason, and criterion 3 is unusually literal about
// what that means — the view displays the recorded fields. So this table has a
// column for each of them: the affected employee, the work date, the object and
// field changed, the previous value, the new value, the action, the actor, the
// timestamp, the reason, and the payroll period covering the date. Nothing is
// summarised away, because the summary is what a reader would then have to take on
// trust.
//
// ## The values are shown as they were stored
//
// `old_value` and `new_value` are `jsonb`, written by the mutation functions as
// the shape each change had — `{"clock_out": null, "total_hours": 8}` for a punch
// correction, `{"review_status": "reviewed", ...}` for a review stamp. They are
// rendered as their keys and values rather than reshaped into prose, because a
// rendering that decided what a change "meant" would be this module's opinion
// standing where the evidence should be. A reader comparing two entries needs to
// see the same fields in both.
//
// ## Filtering happens on the server
//
// The four filters of criterion 4 travel to `/api/attendance/audit` as a query and
// the page comes back filtered, ordered, and counted. Narrowing a held page of a
// hundred would present one page of a match as the whole of it — and on an audit
// trail, "no coverage override was recorded" is precisely the conclusion a reader
// must not be allowed to draw from a filtered page.
//
// ## No polling
//
// The trail is append-only and historical. It refetches when a filter changes,
// when the page changes, and on the retry control, and not on a timer: a table
// that reordered itself under a reader mid-comparison would be worse than one a
// minute out of date.
//
// Requirements: 16.2, 16.3, 16.4, 16.7, 22.6, 22.7, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useState } from 'react';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import {
  AUDIT_ACTIONS,
  auditAction,
  auditEntityLabel,
  type AuditAction,
  type AuditQuery,
} from '../domain/audit';
import type {
  AuditEntry,
  AuditPage,
  AuditPayrollPeriod,
  AttendanceEmployee,
} from '../server/attendance-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { auditQueryUrl } from '../shared/audit-query';
import { formatInstantDate, formatTimeOfDay, formatWorkDate } from '../shared/format';
import { colorRoleToken } from '../shared/tokens';
import {
  emptyStateMessage,
  useAsyncResource,
  type ActiveFilter,
} from '../shared/useAsyncResource';
import type { ReviewViewContext } from './ReviewCenter';

/**
 * Entries per page (Requirement 16, criterion 7).
 *
 * The same figure `AUDIT_PAGE_LIMIT` caps the service at, stated here rather than
 * imported: that constant lives in `server/attendance-service.ts`, and this module
 * takes only types from the server layer. The response reports the limit it
 * actually applied and the footer displays that, so a disagreement would be
 * visible rather than silent.
 */
export const AUDIT_VIEW_PAGE_LIMIT = 100;

/** A stable empty roster, so a memo does not see a new array every render. */
const NO_EMPLOYEES: readonly AttendanceEmployee[] = [];

// ─── Filters ─────────────────────────────────────────────────────────────────

/** The four filters of Requirement 16, criterion 4. */
export interface AuditFilters {
  /** The affected employee. */
  profileId: string | null;
  /** The affected work date, inclusive lower bound. */
  from: string | null;
  /** The affected work date, inclusive upper bound. */
  to: string | null;
  action: AuditAction | null;
  /** Who performed the recorded action. */
  actorProfileId: string | null;
}

/** Nothing narrowed: the whole trail, newest first. */
export const NO_AUDIT_FILTERS: AuditFilters = {
  profileId: null,
  from: null,
  to: null,
  action: null,
  actorProfileId: null,
};

/** True when any of the four is set. */
export function hasAuditFilter(filters: AuditFilters): boolean {
  return (
    filters.profileId !== null ||
    filters.from !== null ||
    filters.to !== null ||
    filters.action !== null ||
    filters.actorProfileId !== null
  );
}

/**
 * The query one page is read under.
 *
 * Requirements: 16.4, 16.7
 */
export function auditViewQuery(filters: AuditFilters, page: number): AuditQuery {
  const query: AuditQuery = { page, limit: AUDIT_VIEW_PAGE_LIMIT };

  if (filters.from !== null) query.from = filters.from;
  if (filters.to !== null) query.to = filters.to;
  if (filters.profileId !== null) query.profileIds = [filters.profileId];
  if (filters.action !== null) query.actions = [filters.action];
  if (filters.actorProfileId !== null) query.actorProfileIds = [filters.actorProfileId];

  return query;
}

/**
 * The work-date filter in words, including the two one-sided forms.
 *
 * Either end can stand alone here, unlike a records range: "everything since the
 * period opened" is a reasonable audit question, and an unset end is left unset
 * rather than filled in with a bound nobody asked for.
 */
export function workDateFilterValue(from: string | null, to: string | null): string {
  if (from !== null && to !== null) {
    return `${formatWorkDate(from)} to ${formatWorkDate(to)}`;
  }
  if (from !== null) return `${formatWorkDate(from)} onwards`;
  if (to !== null) return `up to ${formatWorkDate(to)}`;
  return 'All dates';
}

/**
 * The active filters in the view's own words, for the empty state.
 *
 * Every filter appears whether it is set or not, so an empty result cannot be
 * mistaken for a filter the reader forgot they had applied.
 *
 * Requirements: 22.15
 */
export function auditActiveFilters(
  filters: AuditFilters,
  employeeName: (profileId: string) => string,
): ActiveFilter[] {
  return [
    {
      label: 'Employee',
      value: filters.profileId === null ? 'All employees' : employeeName(filters.profileId),
    },
    { label: 'Work dates', value: workDateFilterValue(filters.from, filters.to) },
    {
      label: 'Action',
      value:
        filters.action === null
          ? 'All actions'
          : (auditAction(filters.action)?.label ?? statusLabel(filters.action)),
    },
    {
      label: 'Actor',
      value:
        filters.actorProfileId === null ? 'Anyone' : employeeName(filters.actorProfileId),
    },
  ];
}

// ─── Rendering one value ─────────────────────────────────────────────────────

/** One field of a stored `jsonb` value, as a line of text. */
interface ValueLine {
  key: string | null;
  text: string;
}

/** A scalar as text. `null` reads as the word, not as an empty cell. */
function scalarText(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (typeof value === 'string') return value === '' ? 'empty' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'none';
}

/**
 * A stored value as the lines the cell renders.
 *
 * An object becomes one line per field, keyed, because that is how the mutation
 * functions write it and a reader comparing a previous value with a new one is
 * comparing fields. A scalar becomes a single unkeyed line. Nothing is dropped: an
 * object with ten fields renders ten lines, which is long but is what was recorded.
 *
 * Requirements: 16.3
 */
export function valueLines(value: unknown): ValueLine[] {
  if (value === null || value === undefined) return [{ key: null, text: 'none' }];

  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return [{ key: null, text: 'none' }];
    return entries.map(([key, field]) => ({
      key: statusLabel(key),
      text: scalarText(field),
    }));
  }

  if (Array.isArray(value)) {
    return value.length === 0
      ? [{ key: null, text: 'none' }]
      : value.map((item, index) => ({ key: String(index + 1), text: scalarText(item) }));
  }

  return [{ key: null, text: scalarText(value) }];
}

/** One value cell: the recorded fields, as visible text rather than a tooltip. */
function ValueCell({ value }: { value: unknown }) {
  return (
    <ul className="space-y-0.5">
      {valueLines(value).map((line, index) => (
        <li key={`${line.key ?? 'value'}-${index}`} className="break-words text-[11px] font-semibold text-slate-600">
          {line.key !== null && (
            <span className="font-black uppercase tracking-[0.08em] text-slate-400">
              {line.key}:{' '}
            </span>
          )}
          {line.text}
        </li>
      ))}
    </ul>
  );
}

// ─── Controls ────────────────────────────────────────────────────────────────

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
    <label className="block min-w-[10rem] flex-1">
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

function FilterDate({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
}) {
  return (
    <label className="block min-w-[9rem] flex-1">
      <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </span>
      <input
        type="date"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
        className={`${ui.input} mt-1 py-1.5 text-[13px]`}
      />
    </label>
  );
}

// ─── One row ─────────────────────────────────────────────────────────────────

interface RowProps {
  entry: AuditEntry;
  employees: ReadonlyMap<string, AttendanceEmployee>;
  periods: ReadonlyMap<string, AuditPayrollPeriod>;
}

/**
 * One entry, with every field Requirement 16, criterion 2 records.
 *
 * Requirements: 16.2, 16.3
 */
function AuditRow({ entry, employees, periods }: RowProps) {
  const subject = entry.profileId === null ? undefined : employees.get(entry.profileId);
  const actor = employees.get(entry.actorProfileId);
  const period = entry.payrollPeriodId === null ? undefined : periods.get(entry.payrollPeriodId);

  // The instant is read in the affected employee's own zone, so an entry about a
  // colleague in another country reads as that colleague's clock — the same rule
  // every other row in the module follows.
  const timeZone = subject?.timezone ?? actor?.timezone ?? 'UTC';

  const definition = auditAction(entry.action);
  const entity = auditEntityLabel(entry.entityType);

  return (
    <tr className="border-b border-slate-100 align-top">
      {/* Timestamp. */}
      <td className="px-3 py-2">
        <div className="text-[12px] font-black text-slate-900">
          {formatInstantDate(entry.createdAt, timeZone)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {formatTimeOfDay(entry.createdAt, timeZone)}
        </div>
      </td>

      {/* Affected employee and work date. */}
      <td className="px-3 py-2">
        <div className="text-[12px] font-black text-slate-900">
          {subject?.displayName ?? (entry.profileId === null ? 'No employee' : entry.profileId)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {entry.workDate === null ? 'No work date' : formatWorkDate(entry.workDate)}
        </div>
      </td>

      {/* Action. The label and the description, as text rather than colour alone. */}
      <td className="px-3 py-2">
        <div className="text-[12px] font-black text-slate-900">
          {definition?.label ?? statusLabel(entry.action)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {definition?.description ?? 'Recorded by a path outside the module\u2019s vocabulary.'}
        </div>
      </td>

      {/* The object and field changed. */}
      <td className="px-3 py-2">
        <div className="text-[12px] font-black text-slate-900">{entity ?? 'Not recorded'}</div>
        <div className="text-[11px] font-semibold text-slate-400">
          {entry.field === null ? 'No single field' : statusLabel(entry.field)}
        </div>
      </td>

      {/* Previous and new value. */}
      <td className="px-3 py-2">
        <ValueCell value={entry.previousValue} />
      </td>
      <td className="px-3 py-2">
        <ValueCell value={entry.newValue} />
      </td>

      {/* Actor. */}
      <td className="px-3 py-2">
        <div className="text-[12px] font-black text-slate-900">
          {actor?.displayName ?? (entry.actorProfileId === '' ? 'Not recorded' : entry.actorProfileId)}
        </div>
        <div className="text-[11px] font-semibold text-slate-400">
          {actor === undefined ? '\u00a0' : statusLabel(actor.role)}
        </div>
      </td>

      {/* Reason. */}
      <td className="px-3 py-2">
        <div className="break-words text-[12px] font-semibold text-slate-700">
          {entry.reason === null || entry.reason.trim() === '' ? 'None recorded' : entry.reason}
        </div>
      </td>

      {/* The payroll period covering the work date. */}
      <td className="px-3 py-2">
        {period === undefined ? (
          <div className="text-[11px] font-semibold text-slate-400">
            {entry.payrollPeriodId === null ? 'No period covers this date' : entry.payrollPeriodId}
          </div>
        ) : (
          <>
            <div className="text-[12px] font-black text-slate-900">
              {formatWorkDate(period.from)} to {formatWorkDate(period.to)}
            </div>
            <div className="text-[11px] font-semibold text-slate-400">
              {period.status === null ? 'Status not recorded' : statusLabel(period.status)}
            </div>
          </>
        )}
      </td>
    </tr>
  );
}

// ─── The view ────────────────────────────────────────────────────────────────

/** Everything `ReviewCenter` hands a view. */
export type AuditLogViewProps = ReviewViewContext;

/**
 * The Audit Log: the recorded fields, the four filters, and pages of a hundred.
 *
 * Requirements: 16.3, 16.4, 16.7
 */
export function AuditLogView({ defaultRange }: AuditLogViewProps) {
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  const [page, setPage] = useState(1);

  const query = useMemo(() => auditViewQuery(filters, page), [filters, page]);
  const read = useMemo(() => auditQueryUrl('/api/attendance/audit', query), [query]);

  const entries = useAsyncResource(
    (signal) => attendanceJson<AuditPage>(read.url, { signal }),
    {
      deps: [read.url],
      enabled: !read.unsatisfiable,
      subject: 'audit entries',
      isEmpty: (response) => response.rows.length === 0,
    },
  );

  // Memoised rather than defaulted inline, so the index and the two employee
  // selects do not see a new array on every render.
  const employees = useMemo<readonly AttendanceEmployee[]>(
    () => entries.data?.employees ?? NO_EMPLOYEES,
    [entries.data],
  );

  const byProfileId = useMemo(
    () => new Map(employees.map((employee) => [employee.profileId, employee])),
    [employees],
  );

  const byPeriodId = useMemo(
    () => new Map((entries.data?.payrollPeriods ?? []).map((period) => [period.id, period])),
    [entries.data],
  );

  const employeeName = useCallback(
    (profileId: string) => byProfileId.get(profileId)?.displayName ?? profileId,
    [byProfileId],
  );

  const activeFilters = useMemo(
    () => auditActiveFilters(filters, employeeName),
    [filters, employeeName],
  );

  const changeFilters = useCallback((next: AuditFilters) => {
    setFilters(next);
    setPage(1);
  }, []);

  const rows = entries.data?.rows ?? [];
  const total = entries.data?.total ?? 0;
  const limit = entries.data?.limit ?? AUDIT_VIEW_PAGE_LIMIT;
  const appliedPage = entries.data?.page ?? page;
  const hasMore = entries.data?.hasMore ?? false;

  const firstRow = (appliedPage - 1) * limit + 1;
  const lastRow = (appliedPage - 1) * limit + rows.length;

  const accent = colorRoleToken('accent');

  return (
    <section
      aria-labelledby="audit-log-heading"
      className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="space-y-3 border-b border-slate-100 px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="audit-log-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Audit log
          </h2>
          <p className="text-[11px] font-semibold text-slate-400">
            {rows.length === 0
              ? `${total} ${total === 1 ? 'entry' : 'entries'}`
              : `${firstRow}\u2013${lastRow} of ${total}`}
          </p>
        </div>

        {/* Criterion 4: employee, work date range, action, and actor. */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <FilterSelect
            label="Employee"
            value={filters.profileId}
            options={employees.map((employee) => employee.profileId)}
            optionLabel={employeeName}
            allLabel="All employees"
            onChange={(profileId) => changeFilters({ ...filters, profileId })}
          />
          <FilterDate
            label="Work date from"
            value={filters.from}
            onChange={(from) => changeFilters({ ...filters, from })}
          />
          <FilterDate
            label="Work date to"
            value={filters.to}
            onChange={(to) => changeFilters({ ...filters, to })}
          />
          <FilterSelect
            label="Action"
            value={filters.action}
            options={AUDIT_ACTIONS.map((action) => action.id)}
            optionLabel={(action) => auditAction(action)?.label ?? statusLabel(action)}
            allLabel="All actions"
            onChange={(action) => changeFilters({ ...filters, action })}
          />
          <FilterSelect
            label="Actor"
            value={filters.actorProfileId}
            options={employees.map((employee) => employee.profileId)}
            optionLabel={employeeName}
            allLabel="Anyone"
            onChange={(actorProfileId) => changeFilters({ ...filters, actorProfileId })}
          />
          {hasAuditFilter(filters) && (
            <button
              type="button"
              onClick={() => changeFilters(NO_AUDIT_FILTERS)}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* The active filter for the selected action, as visible text, and one
            sentence on what an unfiltered trail covers. */}
        <p className="text-[11px] font-semibold text-slate-500">
          {filters.action === null
            ? `Newest first. The whole trail is readable, so a work-date filter narrows it rather than a default window. The current pay period runs ${formatWorkDate(defaultRange.from)} to ${formatWorkDate(defaultRange.to)}.`
            : (auditAction(filters.action)?.description ?? '')}
        </p>

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
      </div>

      {(entries.status !== 'ready' || entries.failure !== null) && (
        <div className="px-4 pt-3 sm:px-5">
          <AsyncStateBlock
            status={read.unsatisfiable ? 'empty' : entries.status}
            failure={read.unsatisfiable ? null : entries.failure}
            pending={entries.pending}
            onRetry={entries.retry}
            subject="the audit trail"
            message={emptyStateMessage('audit entries', activeFilters)}
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[86rem] table-fixed text-left text-sm">
            <colgroup>
              <col style={{ width: '8%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '13%' }} />
              <col style={{ width: '10%' }} />
              <col style={{ width: '11%' }} />
              <col style={{ width: '10%' }} />
            </colgroup>
            <thead>
              <tr>
                <th className={ui.th}>Recorded</th>
                <th className={ui.th}>Employee</th>
                <th className={ui.th}>Action</th>
                <th className={ui.th}>Changed</th>
                <th className={ui.th}>Previous value</th>
                <th className={ui.th}>New value</th>
                <th className={ui.th}>Actor</th>
                <th className={ui.th}>Reason</th>
                <th className={ui.th}>Payroll period</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  employees={byProfileId}
                  periods={byPeriodId}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Criterion 7: pages of at most a hundred. */}
      {(appliedPage > 1 || hasMore) && (
        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-4 py-3 sm:px-5">
          <button
            type="button"
            onClick={() => setPage(appliedPage - 1)}
            disabled={appliedPage <= 1 || entries.pending}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <span className={`text-[11px] font-semibold ${accent.text}`}>
            Page {appliedPage} {'\u00b7'} {limit} per page
          </span>
          <button
            type="button"
            onClick={() => setPage(appliedPage + 1)}
            disabled={!hasMore || entries.pending}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </section>
  );
}

export default AuditLogView;
