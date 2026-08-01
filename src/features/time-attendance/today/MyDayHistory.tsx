// src/features/time-attendance/today/MyDayHistory.tsx
// The employee's own recent attendance, subordinate to today's shift.
//
// Requirement 4, criterion 18 asks for at least the preceding fourteen dates, and
// criterion 19 asks each of them to carry the date, the Derived_Status, the
// scheduled hours, the worked hours, and any Attendance_Exception. The dates and
// the records are supplied by `MyDayPanel`, which owns the read; this component
// only decides how a date and its record are spelled.
//
// ## Why dates rather than records drive the list
//
// A read of the preceding fortnight answers with records, and a record exists
// only for a date carrying a published schedule, a clock session, an approved
// absence, or a review. A weekend has none of those, so a list built from the
// records alone would silently be ten rows long and the reader would have no way
// to tell a day off from a date the read missed. The dates are therefore the
// spine of the list, and a date with no record says so in words.
//
// Every figure is read off the `DailyAttendanceRecord` the service returned.
// Nothing here adds, subtracts, or rounds.
//
// Requirements: 4.18, 4.19, 22.1, 22.6, 22.7, 22.15, 22.16

'use client';

import { statusLabel } from '../../nhwd-shared/ui';
import type { AttendanceException, DailyAttendanceRecord } from '../domain/types';
import type { ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { formatHours, formatWorkDate } from '../shared/format';
import { StatusPill } from '../shared/StatusPill';
import { pillClassName } from '../shared/tokens';
import type { AsyncResourceStatus } from '../shared/useAsyncResource';

export interface MyDayHistoryProps {
  /** The dates to list, in the order they are shown. Most recent first. */
  dates: readonly string[];
  /** The records the read returned, for the signed-in employee only. */
  records: readonly DailyAttendanceRecord[];
  /** The read's state, so the section carries its own loading and failed states. */
  status: AsyncResourceStatus;
  failure: ApiFailure | null;
  /** The empty-state sentence, naming the read's active filters. */
  emptyMessage: string;
  /** True while the read is outstanding, so a retry control reads as busy. */
  pending: boolean;
  onRetry: () => void;
}

/**
 * One exception, as a label and the rule that produced it.
 *
 * Colour follows Requirement 22, criterion 5 through the token table: a
 * payroll-blocking condition is Critical, and anything else left on the record is
 * awaiting a decision, which is Pending. The label is text, so the colour never
 * travels alone (criterion 6), and the rule description is rendered as visible
 * text rather than as a hover title (criterion 7).
 */
function ExceptionNote({ exception }: { exception: AttendanceException }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className={pillClassName(exception.payrollBlocking ? 'critical' : 'pending')}>
        {statusLabel(exception.code)}
      </span>
      <span className="text-[11px] font-semibold text-slate-500">{exception.ruleDescription}</span>
    </li>
  );
}

/** One date's row: the date, its status, its two hours figures, its exceptions. */
function HistoryRow({ date, record }: { date: string; record: DailyAttendanceRecord | undefined }) {
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[13px] font-black text-slate-800">{formatWorkDate(date)}</span>
          {record === undefined ? (
            <span className="text-[11px] font-bold text-slate-400">Nothing recorded</span>
          ) : (
            <StatusPill status={record.derivedStatus} />
          )}
        </div>

        <dl className="flex items-center gap-4 text-right">
          <div>
            <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Scheduled
            </dt>
            <dd className="text-[13px] font-black text-slate-700">
              {formatHours(record?.scheduledHours)}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] font-black uppercase tracking-wider text-slate-400">
              Worked
            </dt>
            <dd className="text-[13px] font-black text-slate-900">
              {formatHours(record?.workedHours)}
            </dd>
          </div>
        </dl>
      </div>

      {record !== undefined && record.exceptions.length > 0 && (
        <ul className="mt-2 space-y-1">
          {record.exceptions.map((exception) => (
            <ExceptionNote key={`${exception.ruleId}:${exception.code}`} exception={exception} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The recent attendance history section.
 *
 * Requirements: 4.18, 4.19
 */
export function MyDayHistory({
  dates,
  records,
  status,
  failure,
  emptyMessage,
  pending,
  onRetry,
}: MyDayHistoryProps) {
  // At most one record per employee per work date, so a date maps to one record.
  const byDate = new Map(records.map((record) => [record.workDate, record]));

  return (
    <section
      aria-labelledby="my-day-history-heading"
      className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div>
          <h3
            id="my-day-history-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Recent attendance
          </h3>
          <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
            The {dates.length} dates before today
          </p>
        </div>
        <span className="text-[11px] font-bold text-slate-400">
          {byDate.size} of {dates.length} dates recorded
        </span>
      </div>

      {(status !== 'ready' || failure !== null) && (
        <div className="px-4 pt-3 sm:px-5">
          <AsyncStateBlock
            status={status}
            failure={failure}
            pending={pending}
            onRetry={onRetry}
            subject="your recent attendance"
            message={emptyMessage}
          />
        </div>
      )}

      <ul className="divide-y divide-slate-100">
        {dates.map((date) => (
          <HistoryRow key={date} date={date} record={byDate.get(date)} />
        ))}
      </ul>
    </section>
  );
}
