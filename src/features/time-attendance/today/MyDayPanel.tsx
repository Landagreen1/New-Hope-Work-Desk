// src/features/time-attendance/today/MyDayPanel.tsx
// One employee, one date, one action.
//
// Everything on this panel is read off the `DailyAttendanceRecord` the
// Attendance_Service returned for today. The panel adds nothing: not the status,
// not the worked hours, not the break split, not which button to show. That is
// the whole point of Requirement 3's single authoritative calculation — the
// screen that displays the figures is not also a place that computes them, so
// My Day and the Exception_Queue cannot disagree about what happened today.
//
// | shown                              | read from                          | criterion |
// | ---------------------------------- | ---------------------------------- | --------- |
// | scheduled start, end, hours        | `scheduledStart/End/Hours`         | 4.1       |
// | derived status                     | `derivedStatus`, `statusRuleId`    | 4.2       |
// | first clock-in                     | `firstClockIn`                     | 4.3       |
// | worked hours, refreshed each minute| `workedHours` + `useAttendancePoll`| 4.4       |
// | break minutes, paid apart from unpaid | `paidBreakMinutes`, `unpaid…`   | 4.5       |
// | expected clock-out                 | `scheduledEnd`                     | 4.6       |
// | the one primary action             | `primaryClockAction`               | 4.7–4.11  |
// | the alert list                     | `buildMyDayAlerts`                 | 4.12–4.17 |
// | the preceding fourteen dates       | `/api/attendance/records`          | 4.18–4.19 |
//
// ## The two reads
//
// `/api/attendance/day` answers today for every employee the caller may see,
// which for an employee is themselves, and it is polled through
// `useAttendancePoll` so the open session's worked hours stay current inside the
// sixty seconds criterion 4 allows. `/api/attendance/records` answers the
// preceding fortnight once; it is not polled, because a closed date does not
// change while someone watches it, and it is refetched after a clock action for
// the same reason the day read is.
//
// The alert list needs both: criterion 16 is about the seven dates *before*
// today, and `buildMyDayAlerts` filters the history it is given down to those
// seven itself.
//
// ## A clock action changes nothing until the server says so
//
// Criterion 20 asks that a failed clock action leave the displayed state
// unchanged. Nothing here is optimistic: the action posts, and only a successful
// response triggers a refetch. A failure is displayed beside the actions and the
// figures above it stay exactly as the last successful read left them.
//
// Criterion 21 asks that a second identical submission record at most one event.
// Two guards, in two places, because the browser is not the only source of a
// duplicate: `useClockAction` refuses a submission while one is in flight, and the
// clock-in and break-start routes are backed by partial unique indexes that
// answer the loser of a genuine race with the open row it lost to.
//
// Both of those live in `shared/useClockAction.ts` rather than here, because Team
// Today's header control offers the same action and must behave the same way. The
// rule for which action is primary is `primaryClockAction`, shared for the same
// reason.
//
// Requirements: 4.1–4.21, 22.1, 22.4, 22.5, 22.6, 22.7, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo } from 'react';

import type { ProfileLite } from '../../nhwd-shared/types';
import { ui } from '../../nhwd-shared/ui';
import { STATUS_RULES } from '../domain/attendance';
import {
  CLOCK_ACTION_LABELS,
  buildMyDayAlerts,
  primaryClockAction,
  secondaryClockActions,
  type MyDayAlert,
} from '../domain/presentation';
import type { DailyAttendanceRecord } from '../domain/types';
import { addCalendarDays, consecutiveDates } from '../domain/work-date';
import type { DayResponse, RecordPage } from '../server/attendance-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import {
  NO_VALUE,
  formatHours,
  formatMinutes,
  formatTimeOfDay,
  formatTimeSpan,
  formatWorkDateLong,
} from '../shared/format';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken } from '../shared/tokens';
import { useAsyncResource } from '../shared/useAsyncResource';
import { useAttendancePoll } from '../shared/useAttendancePoll';
import { useClockAction } from '../shared/useClockAction';
import { MyDayHistory } from './MyDayHistory';

/**
 * How many dates the history section lists: fourteen, the floor Requirement 4,
 * criterion 18 sets. The alert scan of criterion 16 covers the first seven of
 * them, which `buildMyDayAlerts` selects itself.
 */
export const MY_DAY_HISTORY_DAYS = 14;

/**
 * The record for a date on which nothing was recorded.
 *
 * `getDay` produces no record for an employee with no published schedule, no
 * clock session, no approved absence, and no review on the date — an ordinary day
 * off. My Day still has two things to say on such a date. Clock In is the primary
 * action, which criterion 8 states for anyone with no open session, and a missing
 * clock-out on one of the preceding seven dates is still worth an alert, because
 * criterion 16 is about those dates rather than about today.
 *
 * Both `primaryClockAction` and `buildMyDayAlerts` take today's record, so this
 * is that record with every field expressing the absence of a value. Nothing is
 * derived here: zero hours and no punches is what a date with nothing on it
 * holds, every alert condition that reads today's own fields fails against it,
 * and the panel renders its own "nothing recorded" wording rather than this
 * record's `derivedStatus`, which is the domain's own answer for a date matching
 * no rule and is never displayed.
 *
 * Exported because Team Today's header control needs the same record for the same
 * reason: an administrator who has not clocked in today still has a primary
 * action, and it is Clock In.
 */
export function emptyDayRecord(profileId: string, workDate: string): DailyAttendanceRecord {
  return {
    profileId,
    workDate,
    scheduledStart: null,
    scheduledEnd: null,
    scheduledHours: 0,
    firstClockIn: null,
    lastClockOut: null,
    hasOpenSession: false,
    workedHours: 0,
    paidBreakMinutes: 0,
    unpaidBreakMinutes: 0,
    lateMinutes: 0,
    earlyDepartureMinutes: 0,
    derivedStatus: 'needs_review',
    statusRuleId: 'AS-12',
    exceptions: [],
    payrollBlocking: false,
    reviewedAt: null,
    sessions: [],
  };
}

/**
 * The plain-language reason behind a status, from the Status Rule Matrix entry
 * that assigned it.
 *
 * Requirement 22, criterion 7 asks for the reason as visible text rather than as
 * a tooltip, and the matrix already carries one description per rule. Looked up
 * by the `statusRuleId` the record reports, so the sentence shown is the rule
 * that actually fired.
 *
 * Requirements: 3.13, 22.7
 */
function statusReason(statusRuleId: string): string | null {
  return STATUS_RULES.find((rule) => rule.id === statusRuleId)?.description ?? null;
}

/** One figure of the shift card: a label, a value, and an optional note. */
function Figure({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string | null;
}) {
  return (
    <div className="rounded-2xl bg-slate-50 px-3.5 py-3">
      <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
        {label}
      </dt>
      <dd className="mt-1 text-xl font-black tracking-tight text-slate-900">{value}</dd>
      {note !== undefined && note !== null && note !== '' && (
        <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{note}</p>
      )}
    </div>
  );
}

/**
 * One alert, as colour, glyph, and a full sentence.
 *
 * The sentence is `buildMyDayAlerts`'s own: the wording of each condition is a
 * rule, so it lives in the domain layer and is rendered here unchanged
 * (Requirement 22, criterion 7). The role comes from the alert, and the classes
 * from the token table, so no alert picks a colour for itself.
 */
function AlertRow({ alert }: { alert: MyDayAlert }) {
  const token = colorRoleToken(alert.role);

  return (
    <li
      className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 ${token.surface} ${token.text} ${token.border}`}
    >
      <StatusIcon name={alert.icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <p className="text-[13px] font-semibold">{alert.message}</p>
    </li>
  );
}

export interface MyDayPanelProps {
  /** The signed-in user. My Day always shows this employee and no other. */
  profile: ProfileLite;
}

/**
 * The employee-facing content of the Today screen.
 *
 * Requirements: 4.1–4.21, 5.21
 */
export function MyDayPanel({ profile }: MyDayPanelProps) {
  // The date is deliberately not sent: the route resolves today in the business
  // timezone, where a browser sending its own local date would file the hour
  // either side of midnight against the wrong work date.
  const day = useAttendancePoll(
    (signal) => attendanceJson<DayResponse>('/api/attendance/day', { signal }),
    { subject: 'today', isEmpty: () => false },
  );

  const today = day.data?.date ?? null;

  // The fourteen dates before today, most recent first, with the range the read
  // covers. Computed from the date the server resolved, so the list and the read
  // cannot describe different windows.
  const history = useMemo(() => {
    if (today === null) return null;
    try {
      const from = addCalendarDays(today, -MY_DAY_HISTORY_DAYS);
      const to = addCalendarDays(today, -1);
      const dates = consecutiveDates(from, MY_DAY_HISTORY_DAYS).reverse();
      return { from, to, dates };
    } catch {
      // The date came from the service already validated, so this is unreachable
      // short of a contract change. The history section is dropped rather than
      // taking the whole panel down with it.
      console.error('[time-attendance] my day: unusable work date', today);
      return null;
    }
  }, [today]);

  const historyUrl =
    history === null
      ? ''
      : `/api/attendance/records?${new URLSearchParams({
          from: history.from,
          to: history.to,
          profile_id: profile.id,
        }).toString()}`;

  const historyPage = useAsyncResource(
    (signal) => attendanceJson<RecordPage>(historyUrl, { signal }),
    {
      deps: [historyUrl],
      enabled: historyUrl !== '',
      subject: 'attendance records',
      filters:
        history === null
          ? []
          : [{ label: 'Dates', value: `${history.from} to ${history.to}` }],
      isEmpty: (page) => page.rows.length === 0,
    },
  );

  // Both reads answer for every employee in scope, which for an employee is
  // themselves and for an administrator would be the team. Filtering by the
  // signed-in profile keeps My Day about one person whoever opens it.
  const todayRecord = useMemo(
    () => day.data?.records.find((record) => record.profileId === profile.id) ?? null,
    [day.data, profile.id],
  );

  const historyRecords = useMemo(
    () => (historyPage.data?.rows ?? []).filter((record) => record.profileId === profile.id),
    [historyPage.data, profile.id],
  );

  const timeZone =
    day.data?.employees.find((employee) => employee.profileId === profile.id)?.timezone ??
    day.data?.policy.businessTimezone ??
    'UTC';

  // A day with nothing recorded still has a primary action and still reports a
  // missing clock-out on a preceding date, so the two rules are given the empty
  // record rather than being skipped.
  const record = useMemo(
    () => todayRecord ?? (today === null ? null : emptyDayRecord(profile.id, today)),
    [todayRecord, today, profile.id],
  );

  const alerts = useMemo<MyDayAlert[]>(() => {
    if (record === null || day.data === null) return [];
    try {
      return buildMyDayAlerts(record, historyRecords, day.data.policy, day.data.evaluatedAt);
    } catch (error) {
      // Both arguments the function validates are server-produced, so a throw
      // here is a contract fault rather than attendance data. The panel keeps its
      // figures instead of failing to render.
      console.error('[time-attendance] my day: alerts could not be derived', error);
      return [];
    }
  }, [record, historyRecords, day.data]);

  const refreshAll = day.refresh;
  const refreshHistory = historyPage.refresh;

  // Criteria 20 and 21 — one action at a time, and the displayed state moves only
  // on a success — live in `useClockAction`, which Team Today's header control
  // posts through as well, so there is one implementation of a clock action.
  const onRecorded = useCallback(() => {
    refreshAll();
    refreshHistory();
  }, [refreshAll, refreshHistory]);

  const clock = useClockAction(onRecorded);

  const primary = record === null ? null : primaryClockAction(record);
  const secondary = record === null ? [] : secondaryClockActions(record);
  const reason = record === null ? null : statusReason(record.statusRuleId);
  const scheduledSpan =
    record === null ? null : formatTimeSpan(record.scheduledStart, record.scheduledEnd, timeZone);

  return (
    <div className="space-y-4">
      <section
        aria-labelledby="my-day-heading"
        className="rounded-[26px] border border-slate-200 bg-white shadow-sm"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 id="my-day-heading" className="text-lg font-black tracking-tight text-slate-950">
              My Day
            </h2>
            <p className="mt-0.5 text-xs font-semibold text-slate-500">
              {today === null ? 'Today' : formatWorkDateLong(today)}
            </p>
          </div>
          <div className="text-right">
            {todayRecord === null ? (
              <span className="text-[11px] font-bold text-slate-400">Nothing recorded today</span>
            ) : (
              <StatusPill status={todayRecord.derivedStatus} size="md" />
            )}
            {day.data !== null && (
              <p className="mt-1 text-[11px] font-semibold text-slate-400">
                {day.paused
                  ? 'Paused while this tab is hidden'
                  : `As at ${formatTimeOfDay(day.data.evaluatedAt, timeZone)}`}
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4 px-4 py-4 sm:px-6">
          <AsyncStateBlock
            status={day.status}
            failure={day.failure}
            pending={day.pending}
            onRetry={day.retry}
            subject={'today\u2019s shift'}
          />

          {record !== null && (
            <>
              {/* Criterion 2, with the reason as visible text rather than a tooltip. */}
              {reason !== null && todayRecord !== null && (
                <p className="text-[13px] font-semibold text-slate-500">{reason}</p>
              )}

              {/* Criteria 1, 3, 4, 5, and 6, every figure read off the record. */}
              <dl className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                <Figure
                  label="Scheduled shift"
                  value={scheduledSpan ?? 'No shift scheduled'}
                  note={
                    scheduledSpan === null
                      ? 'Today carries no published schedule.'
                      : `${formatHours(record.scheduledHours)} scheduled`
                  }
                />
                <Figure
                  label="Worked today"
                  value={formatHours(record.workedHours)}
                  note={
                    record.hasOpenSession
                      ? 'A session is open, so this figure keeps rising.'
                      : 'All of today\u2019s sessions are closed.'
                  }
                />
                <Figure
                  label="First clock-in"
                  value={formatTimeOfDay(record.firstClockIn, timeZone)}
                  note={
                    record.firstClockIn === null
                      ? 'No clock session has started today.'
                      : record.lastClockOut === null
                        ? 'No clock-out recorded yet.'
                        : `Last clock-out ${formatTimeOfDay(record.lastClockOut, timeZone)}`
                  }
                />
                {/* Criterion 5 asks for the total and for the two kinds kept
                    apart. Which minutes are unpaid is decided once, by the
                    policy's break types inside the derivation; the total is the
                    two reported figures added for display, not a second reading
                    of that rule. */}
                <Figure
                  label="Breaks today"
                  value={formatMinutes(record.unpaidBreakMinutes + record.paidBreakMinutes)}
                  note={`${formatMinutes(record.unpaidBreakMinutes)} unpaid, deducted from worked hours \u00b7 ${formatMinutes(record.paidBreakMinutes)} paid, not deducted`}
                />
                <Figure
                  label="Expected clock-out"
                  value={
                    record.scheduledEnd === null
                      ? NO_VALUE
                      : formatTimeOfDay(record.scheduledEnd, timeZone)
                  }
                  note={
                    record.scheduledEnd === null
                      ? 'Set by the scheduled shift end, and none is published for today.'
                      : 'From the scheduled shift end.'
                  }
                />
              </dl>

              {/* Criteria 7 through 11: one primary action, Clock Out beside it in
                  the one state that offers it. */}
              {primary !== null && (
                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    onClick={() => clock.submit(primary)}
                    disabled={clock.busy !== null}
                    className={`${ui.btnPrimary} min-w-[9rem]`}
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
                      className={ui.btnSecondary}
                    >
                      {clock.busy === action
                        ? `${CLOCK_ACTION_LABELS[action]}\u2026`
                        : CLOCK_ACTION_LABELS[action]}
                    </button>
                  ))}
                </div>
              )}

              {/* Criterion 20: the reason, with every figure above it unchanged. */}
              {clock.failure !== null && (
                <div
                  role="alert"
                  className={`flex items-start gap-2.5 rounded-xl border px-3.5 py-3 ${colorRoleToken('critical').surface} ${colorRoleToken('critical').text} ${colorRoleToken('critical').border}`}
                >
                  <StatusIcon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-black uppercase tracking-wider">
                      Clock action not recorded
                    </p>
                    <p className="mt-0.5 text-[13px] font-semibold">{clock.failure.reason}</p>
                    <p className="mt-0.5 text-[11px] font-semibold opacity-80">
                      Nothing above has changed.
                    </p>
                  </div>
                </div>
              )}

              {/* Criteria 12 through 17, each sentence built in the domain layer. */}
              {alerts.length > 0 && (
                <div>
                  <h3 className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">
                    Alerts
                  </h3>
                  <ul className="mt-2 space-y-2">
                    {alerts.map((alert) => (
                      <AlertRow key={`${alert.kind}:${alert.workDate}`} alert={alert} />
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Criteria 18 and 19: subordinate to today's shift, and after it. */}
      {history !== null && (
        <MyDayHistory
          dates={history.dates}
          records={historyRecords}
          status={historyPage.status}
          failure={historyPage.failure}
          emptyMessage={historyPage.emptyMessage}
          pending={historyPage.pending}
          onRetry={historyPage.retry}
        />
      )}
    </div>
  );
}
