// src/features/time-attendance/today/TeamTodayHeader.tsx
// The administrator's own clock, kept out of the way.
//
// Requirement 5, criterion 1 asks for the signed-in Attendance_Administrator's
// clock status and primary clock action as a compact header control, and
// criterion 2 asks that the primary content area go to team attendance instead.
// Those two together are the whole brief for this component: it must be present,
// it must work, and it must not be the thing the screen is about.
//
// So it is one row. Status, the two figures that make the status legible, the one
// primary action, and Clock Out beside it in the single state that offers it. No
// alert list, no history, no break split, no expected clock-out — an
// administrator who wants those opens My Day's own reading of their day through
// the roster below, which shows them the same record every other employee's row
// shows.
//
// ## The same rule, not a similar one
//
// Which action is primary comes from `primaryClockAction`, and Clock Out appears
// exactly when `secondaryClockActions` returns it — the same two functions My Day
// calls, over the same `DailyAttendanceRecord` the same read produced. The
// request each action sends comes from `useClockAction`, which is also what My
// Day posts through. There is no second decision here about what an
// administrator's clock does, which is what keeps Requirement 4, criteria 7
// through 11 true of this control without restating them for it.
//
// A failure is rendered beside the buttons with the figures above it untouched
// (criterion 20 of Requirement 4, which governs the action wherever it is
// offered), and the in-flight guard against a double submission lives in the hook.
//
// Requirements: 4.7, 4.8, 4.9, 4.10, 4.11, 4.20, 4.21, 5.1, 5.2, 22.4, 22.7,
// 22.12, 22.16

'use client';

import {
  CLOCK_ACTION_LABELS,
  primaryClockAction,
  secondaryClockActions,
} from '../domain/presentation';
import type { DailyAttendanceRecord } from '../domain/types';
import { formatHours, formatTimeOfDay } from '../shared/format';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken } from '../shared/tokens';
import { useClockAction } from '../shared/useClockAction';

export interface TeamTodayHeaderProps {
  /**
   * The signed-in administrator's own record for today.
   *
   * Never null: a date with nothing recorded still has a clock state and still
   * offers Clock In, so the caller supplies the empty record for that date rather
   * than leaving this undefined and making the control guess.
   */
  record: DailyAttendanceRecord;
  /** How the administrator is named, for the control's own labelling. */
  displayName: string;
  /** The zone the two instants are read in: the administrator's own. */
  timeZone: string;
  /** Called after the server accepts an action, so the screen refetches. */
  onRecorded: () => void;
}

/** One small figure in the header row: a label above a value. */
function HeaderFigure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className="text-[13px] font-black text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * The administrator's compact clock control.
 *
 * Requirements: 5.1, 5.2
 */
export function TeamTodayHeader({
  record,
  displayName,
  timeZone,
  onRecorded,
}: TeamTodayHeaderProps) {
  const clock = useClockAction(onRecorded);

  const primary = primaryClockAction(record);
  const secondary = secondaryClockActions(record);
  const critical = colorRoleToken('critical');

  return (
    <section
      aria-labelledby="team-today-own-clock-heading"
      className="rounded-[18px] border border-slate-200 bg-white px-3.5 py-3 shadow-sm sm:px-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2
              id="team-today-own-clock-heading"
              className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400"
            >
              Your clock
            </h2>
            <p className="truncate text-[13px] font-black text-slate-900">{displayName}</p>
          </div>

          <StatusPill status={record.derivedStatus} />

          <dl className="flex items-center gap-4">
            <HeaderFigure
              label="Clocked in"
              value={formatTimeOfDay(record.firstClockIn, timeZone)}
            />
            <HeaderFigure label="Worked" value={formatHours(record.workedHours)} />
          </dl>
        </div>

        {/* Criteria 7 through 11 of Requirement 4, in one compact group: the one
            primary action, and Clock Out only where the rule offers it. */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => clock.submit(primary)}
            disabled={clock.busy !== null}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#223f7a] px-3 py-1.5 text-[12px] font-black text-white transition hover:bg-[#17305f] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {clock.busy === primary
              ? `${CLOCK_ACTION_LABELS[primary]}\u2026`
              : CLOCK_ACTION_LABELS[primary]}
          </button>
          {secondary.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => clock.submit(action)}
              disabled={clock.busy !== null}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#c9d5e9] bg-white px-3 py-1.5 text-[12px] font-black text-[#223f7a] transition hover:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {clock.busy === action
                ? `${CLOCK_ACTION_LABELS[action]}\u2026`
                : CLOCK_ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      </div>

      {/* The reason, with every figure above it exactly as the last successful
          read left it. */}
      {clock.failure !== null && (
        <div
          role="alert"
          className={`mt-2.5 flex items-start gap-2 rounded-lg border px-3 py-2 ${critical.surface} ${critical.text} ${critical.border}`}
        >
          <StatusIcon name="TriangleAlert" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p className="text-[12px] font-semibold">
            {clock.failure.reason} Nothing above has changed.
          </p>
        </div>
      )}
    </section>
  );
}
