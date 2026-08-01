// src/features/time-attendance/review/ExportsView.tsx
// The six CSV exports of Requirement 15, criterion 1, as six triggers.
//
// The file itself is not built here. `/api/attendance/export` reads through the
// same service calls the screens read through with paging removed, serialises with
// `toCsv`, and names the file with `exportFileName` — so the exported rows are the
// screen's rows, quoted the one way the module quotes, under a name that says what
// the file contains. This view chooses a view identifier and a filter set, asks for
// the file, and puts it on the reader's disk.
//
// That division is the point. The export this replaced built its CSV in the
// browser with `rows.map(r => r.join(','))`, which quotes nothing: an employee
// name carrying a comma split into two columns. Nothing in this view touches a
// delimiter. `PayrollProcessor` now asks the same endpoint for `payroll_ready`
// through the same `shared/csv-download.ts` helper this view uses.
//
// ## What each trigger needs
//
// | export               | needs                                  |
// | -------------------- | -------------------------------------- |
// | `attendance_records` | the range, and the saved filter        |
// | `exception_queue`    | the range, and the saved filter        |
// | `payroll_ready`      | the range                              |
// | `time_off_activity`  | the range                              |
// | `coverage_history`   | the range, and optionally a department |
// | `employee_trends`    | the range, and one employee            |
//
// A trigger whose requirement is unmet is disabled with the reason stated as
// visible text beside it, rather than enabled and answered with a 400 the reader
// has to interpret.
//
// ## The two things the file cannot carry
//
// The route reports the row count in `X-Export-Rows` and Requirement 15, criterion
// 8's statement in `X-Export-Notice`, because a file whose first line is prose is
// not the file criterion 5 describes. Both are read back here and shown after the
// download, so an export that matched nothing says so on screen instead of arriving
// as a file the reader has to open to discover is empty.
//
// Requirements: 15.1, 15.2, 15.6, 15.8, 15.9, 22.6, 22.7, 22.12, 22.14, 22.16

'use client';

import { useCallback, useMemo, useState } from 'react';

import { Download } from 'lucide-react';

import type { Department } from '@/lib/permissions';

import { ui } from '../../nhwd-shared/ui';
import { SAVED_FILTERS, type SavedFilterId } from '../domain/attendance';
import { EXPORT_VIEWS, type ExportView } from '../domain/csv';
import type { DateRange } from '../domain/types';
import { asApiFailure, isAbortError, type ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { downloadCsvExport, type CsvDownload } from '../shared/csv-download';
import { formatWorkDate } from '../shared/format';
import { colorRoleToken } from '../shared/tokens';
import { useAttendanceRoster } from '../shared/useAttendanceRoster';
import { DEPARTMENT_LABELS } from '../types';
import type { ReviewViewContext } from './ReviewCenter';

// ─── The six triggers ────────────────────────────────────────────────────────

/** What extra choice an export needs beyond the range. */
type ExportRequirement = 'none' | 'employee';

/** One trigger: which export it is, what it contains, and what it needs. */
export interface ExportTrigger {
  view: ExportView;
  label: string;
  description: string;
  requires: ExportRequirement;
  /** True when the saved-filter control narrows this export. */
  usesSavedFilter: boolean;
  /** True when the department control narrows this export. */
  usesDepartment: boolean;
}

/**
 * The six triggers, in the order Requirement 15, criterion 1 names the exports.
 *
 * `EXPORT_VIEWS` is the vocabulary; this table is what each one is called and what
 * it needs. The two are checked against each other by `EXPORT_TRIGGERS` being
 * built in `EXPORT_VIEWS` order below, so a seventh export cannot appear here
 * without appearing in the domain vocabulary first.
 *
 * Requirements: 15.1
 */
const TRIGGER_BY_VIEW: Record<ExportView, Omit<ExportTrigger, 'view'>> = {
  attendance_records: {
    label: 'Filtered attendance records',
    description:
      'One row per employee per work date: the schedule, the clock span, the hours, the status, and the exceptions.',
    requires: 'none',
    usesSavedFilter: true,
    usesDepartment: false,
  },
  exception_queue: {
    label: 'Exception queue',
    description:
      'The same records as a work queue: the exception, the rule behind it, the payroll impact, and the action each row carries.',
    requires: 'none',
    usesSavedFilter: true,
    usesDepartment: false,
  },
  payroll_ready: {
    label: 'Payroll-ready attendance',
    description:
      'The figures payroll consumes for the period, per employee. Pay rates and pay amounts are included for attendance administrators only.',
    requires: 'none',
    usesSavedFilter: false,
    usesDepartment: false,
  },
  time_off_activity: {
    label: 'Time-off activity',
    description:
      'Every time-off request overlapping the range, with its status, its working days, and its coverage risk.',
    requires: 'none',
    usesSavedFilter: false,
    usesDepartment: false,
  },
  coverage_history: {
    label: 'Coverage history',
    description:
      'Projected coverage per date: scheduled, approved absences, pending requests, required staffing, and the resulting status.',
    requires: 'none',
    usesSavedFilter: false,
    usesDepartment: true,
  },
  employee_trends: {
    label: 'Employee trends',
    description:
      'One employee over the range: the twelve trend values, each with the number of records behind it.',
    requires: 'employee',
    usesSavedFilter: false,
    usesDepartment: false,
  },
};

/** The six triggers, in `EXPORT_VIEWS` order. */
export const EXPORT_TRIGGERS: readonly ExportTrigger[] = EXPORT_VIEWS.map((view) => ({
  view,
  ...TRIGGER_BY_VIEW[view],
}));

// ─── The request ─────────────────────────────────────────────────────────────

/** The choices the six triggers draw on. */
export interface ExportSelection {
  range: DateRange;
  savedFilter: SavedFilterId;
  department: Department | null;
  profileId: string | null;
}

/**
 * The URL one trigger asks for.
 *
 * Every view names its range, because four of the six cannot be read without one
 * and the other two would otherwise fall back to the service's default fortnight —
 * an export named for a range the reader did not choose.
 *
 * Requirements: 15.1, 15.2, 15.6
 */
export function exportUrl(trigger: ExportTrigger, selection: ExportSelection): string {
  const params = new URLSearchParams({
    view: trigger.view,
    from: selection.range.from,
    to: selection.range.to,
  });

  if (trigger.usesSavedFilter) params.set('saved_filter', selection.savedFilter);
  if (trigger.usesDepartment && selection.department !== null) {
    params.set('department', selection.department);
  }
  if (trigger.requires === 'employee' && selection.profileId !== null) {
    params.set('profile_id', selection.profileId);
  }

  return `/api/attendance/export?${params.toString()}`;
}

/** Whether a trigger can be pressed, and why not when it cannot. */
export function triggerReadiness(
  trigger: ExportTrigger,
  selection: ExportSelection,
): { ready: true } | { ready: false; reason: string } {
  if (selection.range.from > selection.range.to) {
    return { ready: false, reason: 'The range starts after it ends.' };
  }
  if (trigger.requires === 'employee' && selection.profileId === null) {
    return { ready: false, reason: 'Choose an employee for this export.' };
  }
  return { ready: true };
}

// ─── The download ────────────────────────────────────────────────────────────

/** What one completed export turned out to contain, and which export it was. */
interface ExportOutcome extends CsvDownload {
  view: ExportView;
}

/**
 * Fetch one export and hand the file to the browser.
 *
 * The fetch, the headers, and the blob are `downloadCsvExport`'s, in `shared/`,
 * because `PayrollProcessor` asks the same endpoint for `payroll_ready` and two
 * download paths would be two chances to disagree about the file. What is left
 * here is which export it was.
 *
 * Requirements: 15.6, 15.8
 */
async function downloadExport(
  trigger: ExportTrigger,
  selection: ExportSelection,
): Promise<ExportOutcome> {
  const download = await downloadCsvExport(
    exportUrl(trigger, selection),
    `${trigger.view}.csv`,
  );
  return { view: trigger.view, ...download };
}

// ─── The view ────────────────────────────────────────────────────────────────

/** Everything `ReviewCenter` hands a view. */
export type ExportsViewProps = ReviewViewContext;

/**
 * Exports: the six triggers, and the choices they draw on.
 *
 * Requirements: 15.1, 15.2, 15.6, 15.8, 15.9
 */
export function ExportsView({ defaultRange }: ExportsViewProps) {
  const [range, setRange] = useState<DateRange>(defaultRange);
  const [savedFilter, setSavedFilter] = useState<SavedFilterId>('all_records');
  const [department, setDepartment] = useState<Department | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);

  const [busy, setBusy] = useState<ExportView | null>(null);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [lastAttempt, setLastAttempt] = useState<ExportView | null>(null);

  const roster = useAttendanceRoster();

  const departments = useMemo(
    () =>
      [
        ...new Set(
          roster.employees
            .map((employee) => employee.department)
            .filter((value): value is Department => value !== null),
        ),
      ].sort(),
    [roster.employees],
  );

  const selection = useMemo<ExportSelection>(
    () => ({ range, savedFilter, department, profileId }),
    [range, savedFilter, department, profileId],
  );

  const run = useCallback(
    async (trigger: ExportTrigger) => {
      setBusy(trigger.view);
      setLastAttempt(trigger.view);
      setFailure(null);
      setOutcome(null);

      try {
        setOutcome(await downloadExport(trigger, selection));
      } catch (error) {
        if (isAbortError(error)) return;
        setFailure(asApiFailure(error));
      } finally {
        setBusy(null);
      }
    },
    [selection],
  );

  const retry = useCallback(() => {
    const trigger = EXPORT_TRIGGERS.find((candidate) => candidate.view === lastAttempt);
    if (trigger !== undefined) void run(trigger);
  }, [lastAttempt, run]);

  const accent = colorRoleToken('accent');
  const atDefaultRange = range.from === defaultRange.from && range.to === defaultRange.to;

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="exports-heading"
        className="space-y-3 rounded-[22px] border border-slate-200 bg-white px-4 py-4 shadow-sm sm:px-5"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2
            id="exports-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Exports
          </h2>
          <p className="text-[11px] font-semibold text-slate-400">
            Each file is named for its range and its filters
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label className="block min-w-[9rem] flex-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              From
            </span>
            <input
              type="date"
              value={range.from}
              onChange={(event) => {
                const from = event.target.value;
                if (from === '') return;
                setRange((previous) => ({ from, to: from > previous.to ? from : previous.to }));
              }}
              className={`${ui.input} mt-1 py-1.5 text-[13px]`}
            />
          </label>
          <label className="block min-w-[9rem] flex-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              To
            </span>
            <input
              type="date"
              value={range.to}
              onChange={(event) => {
                const to = event.target.value;
                if (to === '') return;
                setRange((previous) => ({ from: to < previous.from ? to : previous.from, to }));
              }}
              className={`${ui.input} mt-1 py-1.5 text-[13px]`}
            />
          </label>
          <button
            type="button"
            disabled={atDefaultRange}
            onClick={() => setRange(defaultRange)}
            className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Default range
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
          <label className="block min-w-[11rem] flex-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              Saved filter
            </span>
            <select
              value={savedFilter}
              onChange={(event) => setSavedFilter(event.target.value as SavedFilterId)}
              className={`${ui.select} mt-1 py-1.5 text-[13px]`}
            >
              {SAVED_FILTERS.map((predicate) => (
                <option key={predicate.id} value={predicate.id}>
                  {predicate.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block min-w-[11rem] flex-1">
            <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
              Department
            </span>
            <select
              value={department ?? ''}
              onChange={(event) =>
                setDepartment(event.target.value === '' ? null : (event.target.value as Department))
              }
              className={`${ui.select} mt-1 py-1.5 text-[13px]`}
            >
              <option value="">All departments</option>
              {departments.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {DEPARTMENT_LABELS[candidate]}
                </option>
              ))}
            </select>
          </label>

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
              {roster.employees.map((employee) => (
                <option key={employee.profileId} value={employee.profileId}>
                  {employee.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <p className="text-[11px] font-semibold text-slate-500">
          The saved filter narrows the two record exports, the department narrows coverage
          history, and the employee names the subject of the trends export. Every file covers{' '}
          {formatWorkDate(range.from)} to {formatWorkDate(range.to)}.
        </p>

        <AsyncStateBlock
          status={roster.status}
          failure={roster.failure}
          pending={roster.pending}
          onRetry={roster.retry}
          subject="the employee list"
        />

        {/* The failure of the last attempt, with the retry control of Requirement
            22, criterion 16. Held here rather than per trigger, because only one
            export runs at a time. */}
        <AsyncStateBlock
          status="ready"
          failure={failure}
          pending={busy !== null}
          onRetry={retry}
          subject="the export"
        />

        {/* Criterion 8's statement, or what arrived. */}
        {outcome !== null && (
          <p
            className={`rounded-xl border px-3.5 py-2.5 text-[12px] font-semibold ${
              outcome.notice === null
                ? `${colorRoleToken('healthy').surface} ${colorRoleToken('healthy').border} ${colorRoleToken('healthy').text}`
                : `${colorRoleToken('warning').surface} ${colorRoleToken('warning').border} ${colorRoleToken('warning').text}`
            }`}
            role="status"
          >
            {outcome.notice === null
              ? `Downloaded ${outcome.rowCount} ${outcome.rowCount === 1 ? 'row' : 'rows'} as ${outcome.filename}.`
              : `${outcome.notice} The file was still downloaded as ${outcome.filename}, carrying its header row.`}
          </p>
        )}
      </section>

      {/* Criterion 1: the six exports, each one a trigger. */}
      <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {EXPORT_TRIGGERS.map((trigger) => {
          const readiness = triggerReadiness(trigger, selection);
          const running = busy === trigger.view;

          return (
            <li
              key={trigger.view}
              className="flex flex-col gap-2 rounded-[22px] border border-slate-200 bg-white px-4 py-3.5 shadow-sm"
            >
              <div className="min-w-0">
                <h3 className="text-[12px] font-black text-slate-900">{trigger.label}</h3>
                <p className="mt-0.5 text-[12px] font-semibold text-slate-500">
                  {trigger.description}
                </p>
              </div>

              {!readiness.ready && (
                <p className="text-[11px] font-black text-amber-800">{readiness.reason}</p>
              )}

              <button
                type="button"
                disabled={!readiness.ready || busy !== null}
                onClick={() => void run(trigger)}
                aria-label={`Download the ${trigger.label} export for ${formatWorkDate(range.from)} to ${formatWorkDate(range.to)}`}
                className={`inline-flex items-center justify-center gap-1.5 self-start rounded-xl px-3 py-1.5 text-[11px] font-black text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  running ? 'bg-[#17305f]' : 'bg-[#223f7a] hover:bg-[#17305f]'
                }`}
              >
                <Download className={`h-3.5 w-3.5${running ? ' animate-pulse' : ''}`} aria-hidden="true" />
                {running ? 'Preparing' : 'Download CSV'}
              </button>
            </li>
          );
        })}
      </ul>

      <p className={`rounded-xl border px-3.5 py-2.5 text-[12px] font-semibold ${accent.surface} ${accent.border} ${accent.text}`}>
        Pay-rate and pay-amount columns are included for attendance administrators only, and every
        field in every file is quoted, so a value carrying a comma or a quotation mark survives the
        round trip.
      </p>
    </div>
  );
}

export default ExportsView;
