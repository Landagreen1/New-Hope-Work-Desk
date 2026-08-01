// src/features/time-attendance/today/EmployeeDayDrawer.tsx
// One employee, one date, everything recorded about it — and the five things an
// administrator can do about it.
//
// Requirement 5, criteria 10 through 15 describe this drawer. Selecting a row in
// Team Today opens it (criterion 10), and it carries:
//
// | shown                                    | read from                     | criterion |
// | ---------------------------------------- | ----------------------------- | --------- |
// | today's scheduled shift                  | `scheduledStart/End/Hours`    | 11        |
// | the ordered attendance timeline          | the record's sessions, sorted | 11        |
// | the raw clock events                     | `sessions`                    | 11        |
// | the break events                         | `sessions[].breaks`           | 11        |
// | the Derived_Status and the rule behind it| `derivedStatus`, `statusRuleId` | 11      |
// | the exceptions, each with its rule       | `exceptions`                  | 11        |
// | the manager notes for the date           | the trend read's `notes`      | 12        |
// | the preceding 14 dates                   | the trend read's `records`    | 13        |
// | the audit entries                        | the write responses, for now  | 14        |
// | Correct Punch … Mark Reviewed            | three write endpoints         | 15        |
//
// Nothing on the left column is computed here. The status, the hours, the break
// split, the late minutes, and every exception arrive on the
// `DailyAttendanceRecord` the Attendance_Service derived, so this drawer and the
// row it opened from and the Exception_Queue on the Review screen cannot report
// different things about the same day. The one ordering this file does perform is
// the timeline, which sorts events the record already carries by the instants the
// record already carries — a reading order, not a derivation.
//
// ## Why the history comes from the trend read
//
// Criterion 12 asks for the manager notes on the employee and date, and criterion
// 13 for at least the preceding fourteen dates. `/api/attendance/trends` answers
// exactly one employee over exactly one range and returns both — the records and
// the notes — in a single request, where `/api/attendance/records` returns the
// records alone and would leave the notes with no read at all. So the drawer makes
// one read for two criteria rather than two reads for one.
//
// Today's own detail is *not* taken from that read. It comes in as the `record`
// prop, which is the row the reader selected, held by the screen. That is what
// makes criterion 18 work: a committed correction answers with the recomputed
// record, the screen replaces its held copy, and this drawer re-renders from it
// with no read of any kind.
//
// ## The audit list, and the seam under it
//
// Criterion 14 asks for the Attendance_Audit_Log entries for the employee and
// date. There is no endpoint to read them yet — `/api/attendance/audit` arrives
// with the Audit Log view (task 20.4) — and neither the day read nor the trend
// read carries audit rows. So the section states that plainly and lists the
// entries this drawer itself committed, which the write responses do carry in
// full: the action, the field, the previous and new values, the reason, the actor,
// and the audit row's own identifier. When the endpoint lands, this section reads
// it and the committed entries become a live list rather than a session-local one.
//
// ## Every write goes through the module's contract
//
// Three endpoints serve the five actions, and each one answers with the recomputed
// record (Requirement 5, criterion 18):
//
// | action                   | endpoint                       | field              |
// | ------------------------ | ------------------------------ | ------------------ |
// | Correct Punch            | `/api/attendance/corrections`  | the punch selected |
// | Add Missing Punch        | `/api/attendance/corrections`  | the absent punch, or a whole `session` |
// | Approve Unscheduled Work | `/api/attendance/corrections`  | `unscheduled_work` |
// | Add Manager Note         | `/api/attendance/notes`        | `note`             |
// | Mark Reviewed            | `/api/attendance/reviews`      | —                  |
//
// The reason of criterion 16 is required here as well as by the route and by the
// database function. This copy exists to name the control the message belongs to;
// the two below it hold for a caller that arrives another way.
//
// Nothing is optimistic. A failed write leaves every figure exactly as the last
// read left it and reports its reason beside the control that produced it.
//
// Requirements: 5.10, 5.11, 5.12, 5.13, 5.14, 5.15, 5.16, 5.18, 22.2, 22.3, 22.7,
// 22.10, 22.11, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import DateTimePicker from '../../nhwd-shared/DateTimePicker';
import { statusLabel, ui } from '../../nhwd-shared/ui';
import { STATUS_RULES } from '../domain/attendance';
import type {
  AttendanceException,
  ClockSessionInput,
  DailyAttendanceRecord,
} from '../domain/types';
import { addCalendarDays, consecutiveDates } from '../domain/work-date';
import type {
  AttendanceEmployee,
  AttendanceNote,
  CorrectionResult,
  ReviewResult,
  TrendResponse,
} from '../server/attendance-service';
import { asApiFailure, attendanceJson, jsonRequest, type ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import {
  NO_VALUE,
  formatHours,
  formatMinutes,
  formatTimeOfDay,
  formatWorkDate,
  formatWorkDateLong,
  fromDateTimePickerValue,
  toDateTimePickerValue,
} from '../shared/format';
import { newIdempotencyKey } from '../shared/idempotency';
import { SideDrawer } from '../shared/SideDrawer';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken, pillClassName } from '../shared/tokens';
import { useAsyncResource } from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS } from '../types';

/**
 * How many preceding dates the history lists: fourteen, the floor Requirement 5,
 * criterion 13 sets. The same figure My Day uses, for the same criterion in its
 * own requirement.
 */
export const EMPLOYEE_DRAWER_HISTORY_DAYS = 14;

/**
 * The five actions of Requirement 5, criterion 15, worded as the criterion words
 * them.
 *
 * Deliberately not `ROW_ACTION_LABELS` from `domain/presentation.ts`. That table
 * is Requirement 12, criterion 7's six Exception_Queue row actions — a different
 * set for a different screen, which offers Add Clock-Out where this one offers Add
 * Missing Punch. Sharing one table would mean one of the two criteria was being
 * satisfied with the other's vocabulary.
 */
const ACTION_LABELS = {
  correct_punch: 'Correct Punch',
  add_missing_punch: 'Add Missing Punch',
  approve_unscheduled: 'Approve Unscheduled Work',
  add_manager_note: 'Add Manager Note',
  mark_reviewed: 'Mark Reviewed',
} as const;

/** Which of the five actions is open, or null when the footer shows only buttons. */
type DrawerAction = keyof typeof ACTION_LABELS;

const ACTIONS = Object.keys(ACTION_LABELS) as readonly DrawerAction[];

/** Stated when a correction is submitted with no reason (criterion 16). */
const REASON_REQUIRED = 'A correction carries a reason. Say what was changed and why.';

/** Stated when a note is submitted empty. */
const NOTE_REQUIRED = 'A manager note carries some text.';

/** Stated when the value the picker holds is not a wall clock this zone can read. */
const UNREADABLE_INSTANT = 'That date and time could not be read. Check both fields.';

/** The key of the synthetic Add Missing Punch target that inserts a whole session. */
const NEW_SESSION_KEY = 'new_session';

// ─── Punch targets ───────────────────────────────────────────────────────────

/** The four instants a correction can name on a stored row. */
type PunchField = 'clock_in' | 'clock_out' | 'break_start' | 'break_end';

/**
 * One instant a correction can name: the row it belongs to, what it is called,
 * and what it holds now.
 *
 * `current === null` is what divides the two punch actions. Correct Punch changes
 * an instant that is there; Add Missing Punch supplies one that is not. Both post
 * the same field to the same endpoint, and the function decides from the row as
 * locked whether it recorded a correction or an addition — which is why the action
 * the audit entry carries is read back rather than assumed.
 */
interface PunchTarget {
  key: string;
  field: PunchField;
  entityType: 'clock_entry' | 'break';
  entityId: string;
  label: string;
  current: string | null;
  /** The instant to prefill the picker with when `current` is null. */
  suggestion: string | null;
}

/**
 * Every instant on the record, in the order the day ran.
 *
 * Built from the sessions the record carries. A session's identifier is the
 * `time_clock_entries` row and a break's is the `time_clock_breaks` row, which is
 * what `entity_id` names on the correction body.
 */
function punchTargets(record: DailyAttendanceRecord | null): PunchTarget[] {
  if (record === null) return [];

  const targets: PunchTarget[] = [];

  record.sessions.forEach((session, index) => {
    const name = record.sessions.length === 1 ? 'Session' : `Session ${index + 1}`;

    targets.push({
      key: `${session.id}:clock_in`,
      field: 'clock_in',
      entityType: 'clock_entry',
      entityId: session.id,
      label: `${name} clock-in`,
      current: session.clockIn,
      suggestion: record.scheduledStart,
    });

    targets.push({
      key: `${session.id}:clock_out`,
      field: 'clock_out',
      entityType: 'clock_entry',
      entityId: session.id,
      label: `${name} clock-out`,
      current: session.clockOut,
      suggestion: record.scheduledEnd ?? session.clockIn,
    });

    session.breaks.forEach((brk, breakIndex) => {
      const breakName = `${name} ${statusLabel(brk.type)} break${
        session.breaks.length === 1 ? '' : ` ${breakIndex + 1}`
      }`;

      targets.push({
        key: `${brk.id}:break_start`,
        field: 'break_start',
        entityType: 'break',
        entityId: brk.id,
        label: `${breakName} start`,
        current: brk.start,
        suggestion: session.clockIn,
      });

      targets.push({
        key: `${brk.id}:break_end`,
        field: 'break_end',
        entityType: 'break',
        entityId: brk.id,
        label: `${breakName} end`,
        current: brk.end,
        suggestion: brk.start,
      });
    });
  });

  return targets;
}

// ─── Timeline ────────────────────────────────────────────────────────────────

/** One entry of the ordered timeline: an instant, what happened, and its glyph. */
interface TimelineEntry {
  key: string;
  instant: string;
  label: string;
  detail: string | null;
  icon: string;
  /** True for the two scheduled boundaries, which are expectations rather than events. */
  scheduled: boolean;
}

/**
 * Today's events in the order they happened, with the scheduled boundaries in
 * place.
 *
 * The only computation is `sort`, over instants the record carries. The scheduled
 * start and end are included because a timeline of punches without them cannot
 * show a reader that the first clock-in came after the shift began — which is the
 * fact the late-arrival exception beside it is about.
 *
 * Requirements: 5.11
 */
function buildTimeline(record: DailyAttendanceRecord | null): TimelineEntry[] {
  if (record === null) return [];

  const entries: TimelineEntry[] = [];

  if (record.scheduledStart !== null) {
    entries.push({
      key: 'scheduled_start',
      instant: record.scheduledStart,
      label: 'Shift scheduled to start',
      detail: `${formatHours(record.scheduledHours)} scheduled`,
      icon: 'CalendarClock',
      scheduled: true,
    });
  }

  record.sessions.forEach((session, index) => {
    const name = record.sessions.length === 1 ? 'Session' : `Session ${index + 1}`;

    entries.push({
      key: `${session.id}:in`,
      instant: session.clockIn,
      label: `${name} clocked in`,
      detail: session.adjustmentReason,
      icon: 'LogIn',
      scheduled: false,
    });

    for (const brk of session.breaks) {
      entries.push({
        key: `${brk.id}:start`,
        instant: brk.start,
        label: `${statusLabel(brk.type)} break started`,
        detail:
          brk.durationMinutes === null
            ? null
            : `${formatMinutes(brk.durationMinutes)} recorded`,
        icon: 'Coffee',
        scheduled: false,
      });

      if (brk.end !== null) {
        entries.push({
          key: `${brk.id}:end`,
          instant: brk.end,
          label: `${statusLabel(brk.type)} break ended`,
          detail: null,
          icon: 'Coffee',
          scheduled: false,
        });
      }
    }

    if (session.clockOut !== null) {
      entries.push({
        key: `${session.id}:out`,
        instant: session.clockOut,
        label: `${name} clocked out`,
        detail: session.adjustmentReason,
        icon: 'LogOut',
        scheduled: false,
      });
    }
  });

  if (record.scheduledEnd !== null) {
    entries.push({
      key: 'scheduled_end',
      instant: record.scheduledEnd,
      label: 'Shift scheduled to end',
      detail: null,
      icon: 'CalendarClock',
      scheduled: true,
    });
  }

  return entries.sort((a, b) => a.instant.localeCompare(b.instant));
}

// ─── Audit entries ───────────────────────────────────────────────────────────

/**
 * One audit entry, as the write responses report it.
 *
 * The fields are Requirement 5, criterion 17's list: the employee and work date
 * (which the whole drawer is about), the field changed, the previous and new
 * values, the actor, the reason, and the timestamp.
 */
interface CommittedEntry {
  key: string;
  auditId: string | null;
  action: string;
  field: string | null;
  previousValue: unknown;
  newValue: unknown;
  reason: string | null;
  actorProfileId: string | null;
  at: string | null;
  /** False for a replay: the change was already in place and nothing moved again. */
  applied: boolean;
  /** True when the covering payroll period is already processed or paid. */
  insideSettledPayrollPeriod: boolean;
}

/** A stored value as text. Objects are shown as JSON rather than as `[object]`. */
function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return NO_VALUE;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ─── Wall-clock plumbing ─────────────────────────────────────────────────────
//
// The picker deals in wall clock and the endpoint deals in instants; the
// employee's own zone is what connects the two, so the administrator types the
// time the employee's clock showed rather than the time on their own. Both
// conversions are `shared/format.ts`'s, which routes them through
// `domain/work-date.ts` — the module's only implementation of either direction
// (Requirement 19, criteria 9 and 10) — and which the exception drawer uses for
// the same forms.

/** The picker's spelling of an instant, in the employee's own zone. */
const toPickerValue = toDateTimePickerValue;

/** The picker's wall clock as an ISO instant, or null when it cannot be read. */
const toInstant = fromDateTimePickerValue;

// ─── Presentation pieces ─────────────────────────────────────────────────────

/** The plain-language reason behind a status, from the rule that assigned it. */
function statusReason(statusRuleId: string): string | null {
  return STATUS_RULES.find((rule) => rule.id === statusRuleId)?.description ?? null;
}

/** A titled block inside the drawer. */
function Block({
  title,
  note,
  children,
}: {
  title: string;
  note?: string | null;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
      <h3 className="text-xs font-black uppercase tracking-[0.14em] text-slate-500">{title}</h3>
      {note !== undefined && note !== null && note !== '' && (
        <p className="mt-0.5 text-[11px] font-semibold text-slate-400">{note}</p>
      )}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** One label-and-value pair. */
function Field({ label, value, note }: { label: string; value: string; note?: string | null }) {
  return (
    <div>
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
        {label}
      </dt>
      <dd className="text-[13px] font-black text-slate-900">{value}</dd>
      {note !== undefined && note !== null && note !== '' && (
        <p className="text-[11px] font-semibold text-slate-500">{note}</p>
      )}
    </div>
  );
}

/** One exception, with the rule that produced it as visible text. */
function ExceptionRow({ exception }: { exception: AttendanceException }) {
  return (
    <li>
      <span className={pillClassName(exception.payrollBlocking ? 'critical' : 'pending')}>
        {statusLabel(exception.code)}
      </span>
      <p className="mt-0.5 text-[12px] font-semibold text-slate-600">
        {exception.ruleDescription}
      </p>
      <p className="text-[11px] font-bold text-slate-400">
        Rule {exception.ruleId}
        {exception.payrollBlocking ? ' \u00b7 payroll-blocking' : ''}
      </p>
    </li>
  );
}

/** The raw clock and break events for one session. */
function SessionRow({
  session,
  index,
  total,
  timeZone,
}: {
  session: ClockSessionInput;
  index: number;
  total: number;
  timeZone: string;
}) {
  return (
    <li className="rounded-xl bg-slate-50 px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12px] font-black text-slate-800">
          {total === 1 ? 'Session' : `Session ${index + 1}`}
        </span>
        <span className="text-[12px] font-semibold text-slate-600">
          {formatTimeOfDay(session.clockIn, timeZone)} to{' '}
          {session.clockOut === null ? 'open' : formatTimeOfDay(session.clockOut, timeZone)}
        </span>
      </div>

      {session.adjustedBy !== null && (
        <p className="mt-0.5 text-[11px] font-semibold text-amber-800">
          Adjusted{session.adjustmentReason === null ? '' : `: ${session.adjustmentReason}`}
        </p>
      )}

      {session.breaks.length === 0 ? (
        <p className="mt-1 text-[11px] font-bold text-slate-400">No breaks recorded.</p>
      ) : (
        <ul className="mt-1 space-y-0.5">
          {session.breaks.map((brk) => (
            <li key={brk.id} className="text-[11px] font-semibold text-slate-600">
              {statusLabel(brk.type)} {formatTimeOfDay(brk.start, timeZone)} to{' '}
              {brk.end === null ? 'still running' : formatTimeOfDay(brk.end, timeZone)}
              {brk.durationMinutes === null
                ? ''
                : ` \u00b7 ${formatMinutes(brk.durationMinutes)} recorded`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Everything criterion 11 asks for about the selected date.
 *
 * Every figure is read off the record. The one thing assembled here is the order
 * of the timeline, which the caller has already built.
 *
 * Requirements: 5.11
 */
function RecordDetail({
  record,
  timeline,
  timeZone,
}: {
  record: DailyAttendanceRecord;
  timeline: readonly TimelineEntry[];
  timeZone: string;
}) {
  return (
    <>
      {/* The shift, the status, and the rule that assigned it. */}
      <Block title="Today" note={statusReason(record.statusRuleId)}>
        <StatusPill status={record.derivedStatus} size="md" />
        <dl className="mt-2 grid grid-cols-2 gap-2.5">
          <Field
            label="Scheduled"
            value={
              record.scheduledStart === null && record.scheduledEnd === null
                ? 'No shift'
                : `${formatTimeOfDay(record.scheduledStart, timeZone)} \u2013 ${formatTimeOfDay(record.scheduledEnd, timeZone)}`
            }
            note={`${formatHours(record.scheduledHours)} scheduled`}
          />
          <Field
            label="Worked"
            value={formatHours(record.workedHours)}
            note={record.hasOpenSession ? 'A session is open.' : 'All sessions closed.'}
          />
          <Field
            label="Clock"
            value={formatTimeOfDay(record.firstClockIn, timeZone)}
            note={
              record.hasOpenSession
                ? 'No clock-out yet.'
                : `out ${formatTimeOfDay(record.lastClockOut, timeZone)}`
            }
          />
          <Field
            label="Breaks"
            value={formatMinutes(record.unpaidBreakMinutes + record.paidBreakMinutes)}
            note={`${formatMinutes(record.unpaidBreakMinutes)} unpaid \u00b7 ${formatMinutes(record.paidBreakMinutes)} paid`}
          />
          <Field label="Late" value={formatMinutes(record.lateMinutes)} />
          <Field label="Left early" value={formatMinutes(record.earlyDepartureMinutes)} />
        </dl>
        {record.reviewedAt !== null && (
          <p className="mt-2 text-[11px] font-bold text-slate-400">
            Reviewed {formatTimeOfDay(record.reviewedAt, timeZone)}
          </p>
        )}
      </Block>

      {/* The ordered attendance timeline. */}
      <Block title="Timeline" note="Every event on this date, in the order it happened.">
        {timeline.length === 0 ? (
          <p className="text-[12px] font-bold text-slate-400">Nothing recorded.</p>
        ) : (
          <ol className="space-y-1.5">
            {timeline.map((entry) => (
              <li key={entry.key} className="flex items-start gap-2">
                <StatusIcon
                  name={entry.icon}
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${entry.scheduled ? 'text-slate-300' : 'text-slate-500'}`}
                />
                <span className="w-[4.75rem] shrink-0 text-[12px] font-black text-slate-800">
                  {formatTimeOfDay(entry.instant, timeZone)}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={`block text-[12px] font-semibold ${entry.scheduled ? 'text-slate-500' : 'text-slate-800'}`}
                  >
                    {entry.label}
                  </span>
                  {entry.detail !== null && entry.detail !== '' && (
                    <span className="block text-[11px] font-semibold text-slate-400">
                      {entry.detail}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Block>

      {/* The raw clock events and the break events. */}
      <Block
        title="Clock and break events"
        note="The stored rows, as they are, before any figure is derived from them."
      >
        {record.sessions.length === 0 ? (
          <p className="text-[12px] font-bold text-slate-400">No clock session recorded.</p>
        ) : (
          <ul className="space-y-2">
            {record.sessions.map((session, index) => (
              <SessionRow
                key={session.id}
                session={session}
                index={index}
                total={record.sessions.length}
                timeZone={timeZone}
              />
            ))}
          </ul>
        )}
      </Block>

      {/* The exceptions, each with the rule that produced it. */}
      <Block title="Exceptions">
        {record.exceptions.length === 0 ? (
          <p className="text-[12px] font-bold text-slate-400">No exception on this date.</p>
        ) : (
          <ul className="space-y-2">
            {record.exceptions.map((exception) => (
              <ExceptionRow key={`${exception.ruleId}:${exception.code}`} exception={exception} />
            ))}
          </ul>
        )}
      </Block>
    </>
  );
}

// ─── The drawer ──────────────────────────────────────────────────────────────

export interface EmployeeDayDrawerProps {
  /** The employee the drawer is about, or null when nothing is selected. */
  profileId: string | null;
  /** The work date the drawer is about. */
  workDate: string | null;
  /** The employee, for the name, the department, and the zone the clocks are read in. */
  employee: AttendanceEmployee | undefined;
  /**
   * The row the reader selected, held by the screen.
   *
   * Not read by this component from anywhere: the screen replaces its held copy
   * from a write's response, and this drawer re-renders from the new one, which is
   * Requirement 5, criterion 18 without a read.
   */
  record: DailyAttendanceRecord | null;
  /** Every employee in scope, so a note's author can be named. */
  employees?: readonly AttendanceEmployee[];
  /** The zone to fall back to when the employee carries none. */
  fallbackTimeZone?: string;
  /**
   * Whether the five actions are offered (Requirement 5, criterion 15's WHERE).
   *
   * Defaults to false, so a caller that has not established the permission gets
   * the read-only drawer rather than controls that would be refused.
   */
  canAdminister?: boolean;
  onClose: () => void;
  /**
   * A committed write, with the recomputed record where the response carried one.
   *
   * Null means the employee and date carry no record at all, which a manager note
   * alone does not create. The screen refreshes in that case rather than replacing
   * a row it does not have.
   *
   * Requirements: 5.18
   */
  onCommitted: (record: DailyAttendanceRecord | null) => void;
}

/**
 * The employee day drawer.
 *
 * A shell over the component below, whose only job is the `key`. The drawer holds
 * an in-progress correction form and the entries it has committed, all of which
 * belong to one employee on one date; keying the subtree on that pair is how React
 * discards them when the subject changes, and it means the reset is a fact about
 * the tree rather than an effect that has to remember every field it added.
 *
 * Requirements: 5.10–5.16, 5.18
 */
export function EmployeeDayDrawer(props: EmployeeDayDrawerProps) {
  const { profileId, workDate } = props;

  // Nothing selected: no panel, and no state waiting for the next selection.
  if (profileId === null || workDate === null) return null;

  return (
    <EmployeeDaySubject
      key={`${profileId}\u0000${workDate}`}
      {...props}
      profileId={profileId}
      workDate={workDate}
    />
  );
}

/** The drawer with its subject established, which is what the state belongs to. */
interface EmployeeDaySubjectProps extends Omit<EmployeeDayDrawerProps, 'profileId' | 'workDate'> {
  profileId: string;
  workDate: string;
}

/**
 * One employee on one date: the record detail, the history, and the five actions.
 *
 * Requirements: 5.11–5.16, 5.18
 */
function EmployeeDaySubject({
  profileId,
  workDate,
  employee,
  record,
  employees = [],
  fallbackTimeZone = 'UTC',
  canAdminister = false,
  onClose,
  onCommitted,
}: EmployeeDaySubjectProps) {
  const timeZone = employee?.timezone ?? fallbackTimeZone;

  const [action, setAction] = useState<DrawerAction | null>(null);
  const [targetKey, setTargetKey] = useState<string>('');
  const [pickerValue, setPickerValue] = useState('');
  const [pickerValueTo, setPickerValueTo] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<CommittedEntry[]>([]);

  // One key per opened form, cleared on success. A resubmission after a failure
  // reuses it, which is exactly the replay the correction endpoint is built for:
  // it applies once if the first attempt never landed, and answers `applied:
  // false` with the prior result if it did.
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey());

  // The fourteen dates before the selected one, most recent first, and the range
  // the read covers. Both derived from the same date, so the list and the read
  // cannot describe different windows.
  const history = useMemo(() => {
    try {
      const from = addCalendarDays(workDate, -EMPLOYEE_DRAWER_HISTORY_DAYS);
      const to = addCalendarDays(workDate, -1);
      return {
        from,
        to,
        dates: consecutiveDates(from, EMPLOYEE_DRAWER_HISTORY_DAYS).reverse(),
      };
    } catch {
      // The date came from the service already validated, so this is unreachable
      // short of a contract change. The history section is dropped rather than
      // taking the drawer down with it.
      console.error('[time-attendance] employee drawer: unusable work date', workDate);
      return null;
    }
  }, [workDate]);

  // One read for two criteria: the preceding fourteen dates (criterion 13) and
  // the manager notes (criterion 12). The range runs to the selected date so the
  // notes on that date are included.
  const trendUrl =
    history === null
      ? ''
      : `/api/attendance/trends?${new URLSearchParams({
          profile_id: profileId,
          from: history.from,
          to: workDate,
        }).toString()}`;

  const trend = useAsyncResource(
    (signal) => attendanceJson<TrendResponse>(trendUrl, { signal }),
    {
      deps: [trendUrl],
      enabled: trendUrl !== '',
      subject: 'attendance history',
      filters:
        history === null ? [] : [{ label: 'Dates', value: `${history.from} to ${workDate}` }],
      isEmpty: () => false,
    },
  );

  const targets = useMemo(() => punchTargets(record), [record]);
  const timeline = useMemo(() => buildTimeline(record), [record]);

  const correctable = useMemo(
    () => targets.filter((target) => target.current !== null),
    [targets],
  );
  const addable = useMemo(() => targets.filter((target) => target.current === null), [targets]);

  const notesByDate = useMemo<AttendanceNote[]>(
    () => (trend.data?.notes ?? []).filter((entry) => entry.workDate === workDate),
    [trend.data, workDate],
  );

  const historyRecords = useMemo(
    () => new Map((trend.data?.records ?? []).map((row) => [row.workDate, row])),
    [trend.data],
  );

  const employeeNames = useMemo(
    () => new Map(employees.map((row) => [row.profileId, row.displayName])),
    [employees],
  );

  const selectedTarget =
    targetKey === NEW_SESSION_KEY
      ? null
      : (targets.find((target) => target.key === targetKey) ?? null);

  /** Opening an action resets the form and picks a sensible target and prefill. */
  const openAction = useCallback(
    (next: DrawerAction) => {
      setFailure(null);
      setFieldError(null);
      setReason('');
      setNote('');
      idempotencyKeyRef.current = newIdempotencyKey();

      if (next === 'correct_punch') {
        const first = correctable[0] ?? null;
        setTargetKey(first?.key ?? '');
        setPickerValue(first === null ? '' : toPickerValue(first.current, timeZone));
        setPickerValueTo('');
      } else if (next === 'add_missing_punch') {
        const first = addable[0] ?? null;
        setTargetKey(first?.key ?? NEW_SESSION_KEY);
        setPickerValue(
          first === null
            ? toPickerValue(record?.scheduledStart ?? null, timeZone)
            : toPickerValue(first.suggestion, timeZone),
        );
        setPickerValueTo(
          first === null ? toPickerValue(record?.scheduledEnd ?? null, timeZone) : '',
        );
      } else {
        setTargetKey('');
        setPickerValue('');
        setPickerValueTo('');
      }

      setAction((current) => (current === next ? null : next));
    },
    [addable, correctable, record, timeZone],
  );

  /** Switching target inside a punch form re-prefills from that target. */
  const selectTarget = useCallback(
    (key: string) => {
      setTargetKey(key);
      setFieldError(null);

      if (key === NEW_SESSION_KEY) {
        setPickerValue(toPickerValue(record?.scheduledStart ?? null, timeZone));
        setPickerValueTo(toPickerValue(record?.scheduledEnd ?? null, timeZone));
        return;
      }

      const target = targets.find((candidate) => candidate.key === key) ?? null;
      setPickerValue(
        target === null ? '' : toPickerValue(target.current ?? target.suggestion, timeZone),
      );
      setPickerValueTo('');
    },
    [record, targets, timeZone],
  );

  /** Record what a write reported, for the audit section. */
  const recordCommitted = useCallback((entry: CommittedEntry) => {
    setCommitted((previous) => [entry, ...previous]);
  }, []);

  // Pulled out of the resource object, which is rebuilt each render: `refresh` is
  // stable, so `submit` keeps its identity between renders.
  const refreshTrend = trend.refresh;

  /**
   * Submit the open action.
   *
   * The one place any of the five writes is issued. Nothing is applied locally:
   * the response carries the recomputed record, and the screen replaces its held
   * copy from that, so a failure leaves every figure exactly as it was.
   */
  const submit = useCallback(() => {
    if (action === null || busy) return;

    const trimmedReason = reason.trim();
    const trimmedNote = note.trim();

    // Criterion 16, stated where the reader can see which control it is about.
    if (action !== 'mark_reviewed' && action !== 'add_manager_note' && trimmedReason === '') {
      setFieldError(REASON_REQUIRED);
      return;
    }
    if (action === 'add_manager_note' && trimmedNote === '') {
      setFieldError(NOTE_REQUIRED);
      return;
    }

    let url: string;
    let init: RequestInit;

    if (action === 'mark_reviewed') {
      url = '/api/attendance/reviews';
      init = jsonRequest('POST', { profile_id: profileId, work_date: workDate });
    } else if (action === 'add_manager_note') {
      url = '/api/attendance/notes';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        note: trimmedNote,
        idempotency_key: idempotencyKeyRef.current,
      });
    } else if (action === 'approve_unscheduled') {
      url = '/api/attendance/corrections';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        field: 'unscheduled_work',
        reason: trimmedReason,
        idempotency_key: idempotencyKeyRef.current,
        // The clock entry the approval refers to, when the date carries one. The
        // function validates it against the date rather than taking it on trust.
        ...(record !== null && record.sessions.length > 0
          ? { entity_id: record.sessions[0].id, entity_type: 'clock_entry' }
          : {}),
      });
    } else if (targetKey === NEW_SESSION_KEY) {
      const clockIn = toInstant(pickerValue, timeZone);
      if (clockIn === null) {
        setFieldError(UNREADABLE_INSTANT);
        return;
      }
      const clockOut = pickerValueTo === '' ? null : toInstant(pickerValueTo, timeZone);
      if (pickerValueTo !== '' && clockOut === null) {
        setFieldError(UNREADABLE_INSTANT);
        return;
      }

      url = '/api/attendance/corrections';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        field: 'session',
        value: { clock_in: clockIn, ...(clockOut === null ? {} : { clock_out: clockOut }) },
        reason: trimmedReason,
        idempotency_key: idempotencyKeyRef.current,
      });
    } else {
      if (selectedTarget === null) {
        setFieldError('Choose the punch to change.');
        return;
      }
      const instant = toInstant(pickerValue, timeZone);
      if (instant === null) {
        setFieldError(UNREADABLE_INSTANT);
        return;
      }

      url = '/api/attendance/corrections';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        field: selectedTarget.field,
        entity_id: selectedTarget.entityId,
        entity_type: selectedTarget.entityType,
        value: instant,
        reason: trimmedReason,
        idempotency_key: idempotencyKeyRef.current,
      });
    }

    setBusy(true);
    setFailure(null);
    setFieldError(null);

    const submitted = action;

    void (async () => {
      try {
        if (submitted === 'mark_reviewed') {
          const result = await attendanceJson<ReviewResult>(url, init);
          recordCommitted({
            // The audit row's own identifier where there is one. A repeat writes
            // no audit entry, so it falls back to a fresh local key: two repeats
            // are two things that happened and must not collapse into one row.
            key: result.auditId ?? newIdempotencyKey(),
            auditId: result.auditId,
            action: ACTION_LABELS.mark_reviewed,
            field: 'review status',
            previousValue: result.applied ? null : 'reviewed',
            newValue: 'reviewed',
            reason: null,
            actorProfileId: result.reviewedBy,
            at: result.reviewedAt,
            applied: result.applied,
            insideSettledPayrollPeriod: false,
          });
          onCommitted(result.record);
        } else {
          const result = await attendanceJson<CorrectionResult>(url, init);
          recordCommitted({
            key: result.auditId ?? result.replayAuditId ?? newIdempotencyKey(),
            auditId: result.auditId ?? result.replayAuditId,
            // What the function recorded, not what was asked for: giving a
            // clock-out to an entry that had none is an addition rather than a
            // correction, and it decides that under the lock.
            action:
              result.action === null ? ACTION_LABELS[submitted] : statusLabel(result.action),
            field: result.field,
            previousValue: result.previousValue,
            newValue: result.newValue,
            reason: result.reason,
            actorProfileId: result.actorProfileId,
            at: result.appliedAt,
            applied: result.applied,
            insideSettledPayrollPeriod: result.insideSettledPayrollPeriod,
          });
          onCommitted(result.record);
        }

        // The change is in place, so the next submission is a new change.
        idempotencyKeyRef.current = newIdempotencyKey();
        setAction(null);
        setReason('');
        setNote('');
        // The notes and the history came from a read, not from the response, so
        // they are asked again. Today's own figures did not: they arrived on the
        // response and the screen has already replaced them.
        refreshTrend();
      } catch (error) {
        setFailure(asApiFailure(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    action,
    busy,
    note,
    onCommitted,
    pickerValue,
    pickerValueTo,
    profileId,
    reason,
    record,
    recordCommitted,
    refreshTrend,
    selectedTarget,
    targetKey,
    timeZone,
    workDate,
  ]);

  const critical = colorRoleToken('critical');
  const accent = colorRoleToken('accent');

  const department = employee?.department ?? null;
  const subtitle =
    department === null
      ? formatWorkDateLong(workDate)
      : `${formatWorkDateLong(workDate)} \u00b7 ${DEPARTMENT_LABELS[department]}`;

  // Criterion 16's reason, for the three actions that override a derived value. A
  // note is its own stated reason, and marking a day reviewed overrides nothing.
  const reasonRequired =
    action !== null && action !== 'mark_reviewed' && action !== 'add_manager_note';

  const punchForm = action === 'correct_punch' || action === 'add_missing_punch';
  // Correct Punch offers the instants that are there; Add Missing Punch the ones
  // that are not, plus the whole session the select adds below.
  const formTargets = action === 'correct_punch' ? correctable : addable;

  return (
    <SideDrawer
      open
      onClose={onClose}
      title={employee?.displayName ?? 'Employee'}
      subtitle={subtitle}
      footer={
        canAdminister ? (
          <div className="space-y-2.5">
            {/* Criterion 15: the five actions. */}
            <div className="flex flex-wrap gap-2">
              {ACTIONS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  onClick={() => openAction(candidate)}
                  aria-expanded={action === candidate}
                  disabled={busy}
                  className={[
                    'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] font-black transition disabled:cursor-not-allowed disabled:opacity-40',
                    action === candidate
                      ? `${accent.surface} ${accent.border} ${accent.text}`
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                  ].join(' ')}
                >
                  {ACTION_LABELS[candidate]}
                </button>
              ))}
            </div>

            {action !== null && (
              <div className="space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                  {ACTION_LABELS[action]}
                </p>

                {punchForm && (
                  <>
                    <label className="block">
                      <span className={ui.label}>Punch</span>
                      <select
                        value={targetKey}
                        onChange={(event) => selectTarget(event.target.value)}
                        className={`${ui.select} mt-1 py-1.5 text-[13px]`}
                      >
                        {formTargets.map((target) => (
                          <option key={target.key} value={target.key}>
                            {target.label}
                            {target.current === null
                              ? ' (not recorded)'
                              : ` (${formatTimeOfDay(target.current, timeZone)})`}
                          </option>
                        ))}
                        {action === 'add_missing_punch' && (
                          <option value={NEW_SESSION_KEY}>
                            A whole session the employee never recorded
                          </option>
                        )}
                      </select>
                    </label>

                    {action === 'correct_punch' && correctable.length === 0 && (
                      <p className="text-[12px] font-semibold text-slate-500">
                        This date carries no recorded punch to correct. Add Missing Punch supplies
                        one.
                      </p>
                    )}

                    <div>
                      <span className={ui.label}>
                        {targetKey === NEW_SESSION_KEY ? 'Clock-in' : 'Corrected time'}
                      </span>
                      <DateTimePicker
                        value={pickerValue}
                        onChange={setPickerValue}
                        disabled={busy}
                        className="mt-1"
                      />
                      <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                        Read as {employee?.displayName ?? 'the employee'}&rsquo;s own clock in{' '}
                        {timeZone}.
                      </p>
                    </div>

                    {targetKey === NEW_SESSION_KEY && (
                      <div>
                        <span className={ui.label}>Clock-out (optional)</span>
                        <DateTimePicker
                          value={pickerValueTo}
                          onChange={setPickerValueTo}
                          disabled={busy}
                          className="mt-1"
                        />
                        <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                          Leave both fields empty to add a session that is still open.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {action === 'approve_unscheduled' && (
                  <p className="text-[12px] font-semibold text-slate-600">
                    Approving the unscheduled work recorded on this date marks it as reviewed.
                    The approval is the audit entry; there is no un-approve.
                  </p>
                )}

                {action === 'mark_reviewed' && (
                  <p className="text-[12px] font-semibold text-slate-600">
                    Records that this date was reviewed, with the reviewer and the timestamp. A
                    second review keeps the first reviewer.
                  </p>
                )}

                {action === 'add_manager_note' && (
                  <label className="block">
                    <span className={ui.label}>Note</span>
                    <textarea
                      value={note}
                      onChange={(event) => setNote(event.target.value)}
                      rows={3}
                      disabled={busy}
                      className={`${ui.textarea} mt-1 py-1.5 text-[13px]`}
                      placeholder="What happened, in words the next reader will need."
                    />
                  </label>
                )}

                {reasonRequired && (
                  <label className="block">
                    <span className={ui.label}>Reason</span>
                    <input
                      type="text"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      disabled={busy}
                      className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                      placeholder="Stored on the change and on the audit entry."
                    />
                  </label>
                )}

                {fieldError !== null && (
                  <p role="alert" className={`text-[12px] font-bold ${critical.text}`}>
                    {fieldError}
                  </p>
                )}

                {failure !== null && (
                  <div
                    role="alert"
                    className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${critical.surface} ${critical.text} ${critical.border}`}
                  >
                    <StatusIcon name="TriangleAlert" className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-[11px] font-black uppercase tracking-wider">
                        Not recorded
                      </p>
                      <p className="mt-0.5 text-[12px] font-semibold">{failure.reason}</p>
                      <p className="mt-0.5 text-[11px] font-semibold opacity-80">
                        Nothing above has changed.
                      </p>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={submit}
                    disabled={busy}
                    className={`${ui.btnPrimary} px-3 py-1.5 text-[13px]`}
                  >
                    {busy ? 'Submitting\u2026' : ACTION_LABELS[action]}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAction(null)}
                    disabled={busy}
                    className={`${ui.btnSecondary} px-3 py-1.5 text-[13px]`}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : undefined
      }
    >
      <div className="space-y-3">
        {record === null ? (
          <p className="rounded-2xl border border-slate-200 bg-slate-50 px-3.5 py-3 text-[13px] font-semibold text-slate-500">
            This date carries no schedule, no clock session, no approved absence, and no review, so
            there is no attendance record to describe. The notes, the history, and the actions
            below still apply.
          </p>
        ) : (
          <RecordDetail record={record} timeline={timeline} timeZone={timeZone} />
        )}

        {/* The read behind criteria 12 and 13, with its own states. */}
        <AsyncStateBlock
          status={trend.status}
          failure={trend.failure}
          pending={trend.pending}
          onRetry={trend.retry}
          subject={'this employee\u2019s history'}
          message={trend.emptyMessage}
        />

        {/* Criterion 12: the notes on this employee and date. */}
        <Block title="Manager notes">
          {notesByDate.length === 0 ? (
            <p className="text-[12px] font-bold text-slate-400">
              No note recorded against this date.
            </p>
          ) : (
            <ul className="space-y-2">
              {notesByDate.map((entry) => (
                <li key={entry.id} className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-[12px] font-semibold text-slate-700">{entry.note}</p>
                  <p className="mt-0.5 text-[11px] font-bold text-slate-400">
                    {employeeNames.get(entry.authorProfileId) ?? 'Administrator'}
                    {entry.createdAt === ''
                      ? ''
                      : ` \u00b7 ${formatTimeOfDay(entry.createdAt, timeZone)}`}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Block>

        {/* Criterion 13: at least the preceding fourteen dates. */}
        {history !== null && (
          <Block
            title="Preceding 14 dates"
            note="A date with nothing recorded carries no schedule, session, absence, or review."
          >
            <ul className="space-y-1">
              {history.dates.map((date) => {
                const row = historyRecords.get(date);
                return (
                  <li
                    key={date}
                    className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="text-[12px] font-black text-slate-800">
                        {formatWorkDate(date)}
                      </span>
                      {row === undefined ? (
                        <span className="text-[11px] font-bold text-slate-400">
                          Nothing recorded
                        </span>
                      ) : (
                        <StatusPill status={row.derivedStatus} />
                      )}
                    </span>
                    {row !== undefined && (
                      <span className="text-[11px] font-bold text-slate-500">
                        {formatHours(row.workedHours)} of {formatHours(row.scheduledHours)}
                        {row.exceptions.length === 0
                          ? ''
                          : ` \u00b7 ${row.exceptions.length} exception${row.exceptions.length === 1 ? '' : 's'}`}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </Block>
        )}

        {/* Criterion 14. The seam is documented in this file's header comment:
            `/api/attendance/audit` arrives with the Audit Log view, and until then
            the only audit rows readable here are the ones this drawer's own writes
            reported. */}
        <Block
          title="Audit entries"
          note="The complete log for this employee and date becomes readable when the audit endpoint lands. These are the entries recorded from this drawer."
        >
          {committed.length === 0 ? (
            <p className="text-[12px] font-bold text-slate-400">
              Nothing has been changed from this drawer.
            </p>
          ) : (
            <ul className="space-y-2">
              {committed.map((entry) => (
                <li key={entry.key} className="rounded-xl bg-slate-50 px-3 py-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[12px] font-black text-slate-800">{entry.action}</span>
                    <span className="text-[11px] font-bold text-slate-400">
                      {entry.at === null ? NO_VALUE : formatTimeOfDay(entry.at, timeZone)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] font-semibold text-slate-600">
                    {entry.field ?? NO_VALUE}: {describeValue(entry.previousValue)} &rarr;{' '}
                    {describeValue(entry.newValue)}
                  </p>
                  {entry.reason !== null && (
                    <p className="text-[11px] font-semibold text-slate-500">{entry.reason}</p>
                  )}
                  <p className="text-[11px] font-bold text-slate-400">
                    {employeeNames.get(entry.actorProfileId ?? '') ?? 'You'}
                    {entry.applied ? '' : ' \u00b7 already applied, nothing moved again'}
                  </p>
                  {entry.insideSettledPayrollPeriod && (
                    <p className="mt-0.5 text-[11px] font-bold text-amber-800">
                      The payroll period covering this date is already processed or paid. No stored
                      payroll summary was recomputed.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Block>
      </div>
    </SideDrawer>
  );
}

export default EmployeeDayDrawer;
