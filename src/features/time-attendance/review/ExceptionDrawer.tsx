// src/features/time-attendance/review/ExceptionDrawer.tsx
// One row of the Exception_Queue opened out: everything recorded about that
// employee and work date, the rule behind every exception on it, and the four
// controls that correct it.
//
// Requirement 12, criteria 10 through 16 describe this drawer.
//
// | shown                                     | read from                        | criterion |
// | ----------------------------------------- | -------------------------------- | --------- |
// | the published schedule                    | `scheduledStart/End/Hours`       | 11        |
// | the raw clock events                      | `sessions`                       | 11        |
// | the break timeline                        | `sessions[].breaks`, ordered     | 11        |
// | the calculated scheduled and worked hours  | `scheduledHours`, `workedHours`  | 11        |
// | the rule that produced each exception     | `exceptions[].ruleDescription`   | 11        |
// | the payroll impact                        | `payrollBlocking`, `exceptions`  | 11        |
// | the manager notes                         | the trend read's `notes`         | 11        |
// | the previous corrections                  | `sessions[].adjustedBy/Reason`   | 11        |
// | the audit entries                         | the write responses, for now     | 11        |
// | clock-in, clock-out, break minutes, note   | three write endpoints            | 12        |
//
// Nothing on the left column is computed here. The hours, the break split, the
// late minutes, the status, and every exception arrive on the
// `DailyAttendanceRecord` the Attendance_Service derived, so this drawer and the
// row it opened from and the employee day drawer on Today cannot report different
// things about the same day. The one ordering this file performs is the break
// timeline, which sorts events the record already carries by instants the record
// already carries — a reading order, not a derivation.
//
// ## Why the notes come from the trend read
//
// Criterion 11 asks for the manager notes on the employee and work date, and no
// record read carries them: `/api/attendance/records` returns records alone.
// `/api/attendance/trends` answers one employee over one range and returns the
// notes alongside, so a single request for `from = to = workDate` is the whole of
// what this drawer needs beyond the row it was given.
//
// Today's own detail is *not* taken from that read. It comes in as the `record`
// prop, which is the row the reader selected, held by the Review_Center. That is
// what makes criterion 14 work: a committed correction answers with the recomputed
// record, the screen replaces its held copy, and this drawer re-renders from it with
// no read of any kind.
//
// ## The four controls, and the two actions beside them
//
// Criterion 12 names four correction controls — clock-in instant, clock-out
// instant, break minutes, manager note — and they are the four in the Corrections
// group below. Criterion 7's row actions need two more: Approve Unscheduled Work,
// which is an approval rather than a correction, and Mark Reviewed, which is
// criterion 15. Those two sit in a separate group, because neither changes a stored
// figure and grouping them with the corrections would suggest they do.
//
// A row's primary action opens the drawer on the control that action names, through
// `CONTROL_FOR_ROW_ACTION`. Review Lateness opens the note control: the clock-in is
// recorded correctly on a late arrival, and what the record is missing is the
// reviewer's judgement in words.
//
// ## Every write goes through the module's contract
//
// | control                  | endpoint                      | field                          |
// | ------------------------ | ----------------------------- | ------------------------------ |
// | Clock-in instant         | `/api/attendance/corrections` | `clock_in`                     |
// | Clock-out instant        | `/api/attendance/corrections` | `clock_out`                    |
// | Break minutes            | `/api/attendance/corrections` | `duration_minutes`, `break_minutes` |
// | Manager note             | `/api/attendance/notes`       | `note`                         |
// | Approve unscheduled work | `/api/attendance/corrections` | `unscheduled_work`             |
// | Mark reviewed            | `/api/attendance/reviews`     | —                              |
//
// All three endpoints answer with the recomputed `DailyAttendanceRecord`, which is
// criterion 14: the queue replaces the affected row from the response rather than
// reloading. The reason of criterion 13 is required here as well as by the route and
// by the database function — this copy exists to name the control the message belongs
// to; the two below it hold for a caller that arrives another way.
//
// Nothing is optimistic. A failed write leaves every figure exactly as the last read
// left it and reports its reason beside the control that produced it.
//
// Requirements: 12.10, 12.11, 12.12, 12.13, 12.14, 12.15, 12.16, 22.2, 22.3, 22.7,
// 22.10, 22.11, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import DateTimePicker from '../../nhwd-shared/DateTimePicker';
import { statusLabel, ui } from '../../nhwd-shared/ui';
import { STATUS_RULES } from '../domain/attendance';
import type { RowAction } from '../domain/presentation';
import type {
  AttendanceException,
  ClockSessionInput,
  DailyAttendanceRecord,
} from '../domain/types';
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
  formatWorkDateLong,
  fromDateTimePickerValue,
  toDateTimePickerValue,
} from '../shared/format';
import { newIdempotencyKey } from '../shared/idempotency';
import { SideDrawer } from '../shared/SideDrawer';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { PILL_ICON_SIZE, colorRoleToken, pillClassName, type ColorRole } from '../shared/tokens';
import { useAsyncResource } from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS } from '../types';

// ─── The controls ────────────────────────────────────────────────────────────

/**
 * The four correction controls of Requirement 12, criterion 12, and the two
 * review actions criteria 7 and 15 need beside them.
 */
export type DrawerControl =
  | 'clock_in'
  | 'clock_out'
  | 'break_minutes'
  | 'note'
  | 'approve_unscheduled'
  | 'mark_reviewed';

/** Control text. The one place these are worded. */
export const CONTROL_LABELS: Record<DrawerControl, string> = {
  clock_in: 'Correct Clock-In',
  clock_out: 'Correct Clock-Out',
  break_minutes: 'Correct Break Minutes',
  note: 'Add Manager Note',
  approve_unscheduled: 'Approve Unscheduled Work',
  mark_reviewed: 'Mark Reviewed',
};

/** The four of criterion 12, in the order the criterion names them. */
export const CORRECTION_CONTROLS: readonly DrawerControl[] = [
  'clock_in',
  'clock_out',
  'break_minutes',
  'note',
];

/** The two that change no stored figure. */
export const REVIEW_CONTROLS: readonly DrawerControl[] = ['approve_unscheduled', 'mark_reviewed'];

/**
 * The control a row action opens on.
 *
 * A `Record` over `RowAction`, so an action added to Requirement 12, criterion 7's
 * set fails the build until it has a control here — the queue can never offer an
 * action the drawer has nowhere to put.
 *
 * `review_lateness` opens the note control rather than a punch control: the
 * clock-in on a late arrival is recorded correctly, and correcting it would hide
 * the lateness rather than judge it. `correct_punch` opens the clock-in control,
 * which is the punch the codes routed to it are missing or wrong about most often;
 * the clock-out control is one press away.
 *
 * Requirements: 12.7, 12.12
 */
export const CONTROL_FOR_ROW_ACTION: Record<RowAction, DrawerControl> = {
  correct_punch: 'clock_in',
  add_clock_out: 'clock_out',
  review_lateness: 'note',
  approve_unscheduled: 'approve_unscheduled',
  add_manager_note: 'note',
  mark_reviewed: 'mark_reviewed',
};

/** Stated when a correction is submitted with no reason (criterion 13). */
const REASON_REQUIRED = 'A correction carries a reason. Say what was changed and why.';

/** Stated when a note is submitted empty. */
const NOTE_REQUIRED = 'A manager note carries some text.';

/** Stated when the value the picker holds is not a wall clock this zone can read. */
const UNREADABLE_INSTANT = 'That date and time could not be read. Check both fields.';

/** Stated when the minutes field holds something that is not whole minutes. */
const UNREADABLE_MINUTES = 'Break minutes are a whole number of minutes, from 0 to 1440.';

// ─── Correction targets ──────────────────────────────────────────────────────

/** One clock instant a correction can name: which session, and what it holds now. */
interface PunchTarget {
  key: string;
  field: 'clock_in' | 'clock_out';
  entityId: string;
  label: string;
  current: string | null;
  /** What to prefill the picker with when `current` is null. */
  suggestion: string | null;
}

/**
 * The clock-in or clock-out instant of every session on the record.
 *
 * Both fields are offered whether or not the instant is recorded: the correction
 * function decides from the row as locked whether it recorded a correction or an
 * addition, which is why a missing clock-out needs no separate control.
 */
function punchTargets(
  record: DailyAttendanceRecord | null,
  field: 'clock_in' | 'clock_out',
): PunchTarget[] {
  if (record === null) return [];

  return record.sessions.map((session, index) => {
    const name = record.sessions.length === 1 ? 'Session' : `Session ${index + 1}`;
    return {
      key: session.id,
      field,
      entityId: session.id,
      label: `${name} ${field === 'clock_in' ? 'clock-in' : 'clock-out'}`,
      current: field === 'clock_in' ? session.clockIn : session.clockOut,
      suggestion:
        field === 'clock_in'
          ? (record.scheduledStart ?? session.clockIn)
          : (record.scheduledEnd ?? session.clockIn),
    };
  });
}

/** One stored minute count a correction can name. */
interface MinutesTarget {
  key: string;
  field: 'break_minutes' | 'duration_minutes';
  entityType: 'clock_entry' | 'break';
  entityId: string;
  label: string;
  current: number | null;
  note: string;
}

/**
 * Every break figure on the record that a correction can name.
 *
 * Two kinds, and the difference matters. `duration_minutes` is the figure on the
 * break row that the derivation prefers over the break's own bounds, so correcting
 * it moves worked hours and therefore the status. `break_minutes` is the
 * accumulated column on the clock entry that the inherited payroll path reads as
 * break hours, so correcting it moves the payroll-visible figure and nothing else.
 * Both are offered, named for what they move, because a break recorded in the wrong
 * place is corrected in the place it was recorded.
 */
function minutesTargets(record: DailyAttendanceRecord | null): MinutesTarget[] {
  if (record === null) return [];

  const targets: MinutesTarget[] = [];

  record.sessions.forEach((session, index) => {
    const name = record.sessions.length === 1 ? 'Session' : `Session ${index + 1}`;

    session.breaks.forEach((brk, breakIndex) => {
      targets.push({
        key: brk.id,
        field: 'duration_minutes',
        entityType: 'break',
        entityId: brk.id,
        label: `${name} ${statusLabel(brk.type)} break${session.breaks.length === 1 ? '' : ` ${breakIndex + 1}`} duration`,
        current: brk.durationMinutes,
        note: 'Moves the worked hours the status is derived from.',
      });
    });

    targets.push({
      key: session.id,
      field: 'break_minutes',
      entityType: 'clock_entry',
      entityId: session.id,
      label: `${name} recorded break minutes`,
      current: null,
      note: 'The accumulated figure the payroll path reads as break hours.',
    });
  });

  return targets;
}

// ─── Form seeding ────────────────────────────────────────────────────────────

/** The form fields a control opens with. */
interface ControlSeed {
  targetKey: string;
  pickerValue: string;
  minutesValue: string;
}

const EMPTY_SEED: ControlSeed = { targetKey: '', pickerValue: '', minutesValue: '' };

/**
 * The target and the prefill a control opens on.
 *
 * One function for both ways a control is opened — pressing it in the footer, and
 * arriving with a row action that names it — because a form seeded one way and not
 * the other is a select with no selection and a submission that refuses itself.
 */
function seedForControl(
  record: DailyAttendanceRecord | null,
  control: DrawerControl | null,
  timeZone: string,
): ControlSeed {
  if (control === 'clock_in' || control === 'clock_out') {
    const first = punchTargets(record, control)[0];
    if (first === undefined) return EMPTY_SEED;
    return {
      targetKey: first.key,
      pickerValue: toDateTimePickerValue(first.current ?? first.suggestion, timeZone),
      minutesValue: '',
    };
  }

  if (control === 'break_minutes') {
    const first = minutesTargets(record)[0];
    if (first === undefined) return EMPTY_SEED;
    return {
      targetKey: first.key,
      pickerValue: '',
      minutesValue: first.current === null ? '' : String(first.current),
    };
  }

  return EMPTY_SEED;
}

// ─── Break timeline ──────────────────────────────────────────────────────────

/** One break, with the session it belongs to. */
interface BreakEntry {
  key: string;
  sessionLabel: string;
  type: string;
  start: string;
  end: string | null;
  durationMinutes: number | null;
}

/**
 * Every break on the record, in the order they started.
 *
 * The only computation is `sort`, over instants the record carries.
 *
 * Requirements: 12.11
 */
function buildBreakTimeline(record: DailyAttendanceRecord | null): BreakEntry[] {
  if (record === null) return [];

  const entries: BreakEntry[] = [];

  record.sessions.forEach((session, index) => {
    const sessionLabel = record.sessions.length === 1 ? 'Session' : `Session ${index + 1}`;
    for (const brk of session.breaks) {
      entries.push({
        key: brk.id,
        sessionLabel,
        type: statusLabel(brk.type),
        start: brk.start,
        end: brk.end,
        durationMinutes: brk.durationMinutes,
      });
    }
  });

  return entries.sort((a, b) => a.start.localeCompare(b.start));
}

// ─── Audit entries ───────────────────────────────────────────────────────────

/** One audit entry, as the write responses report it. */
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

/** A pill for a property that is not one of the four status families. */
function TokenPill({ role, icon, label }: { role: ColorRole; icon: string; label: string }) {
  return (
    <span className={pillClassName(role, 'md')}>
      <StatusIcon name={icon} className={PILL_ICON_SIZE.md} />
      {label}
    </span>
  );
}

/** One exception, with the rule that produced it as visible text. */
function ExceptionItem({ exception }: { exception: AttendanceException }) {
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

/** The raw clock and break events for one session, as stored. */
function SessionItem({
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

      {session.breaks.length === 0 ? (
        <p className="mt-1 text-[11px] font-bold text-slate-400">No break rows recorded.</p>
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

// ─── The drawer ──────────────────────────────────────────────────────────────

export interface ExceptionDrawerProps {
  /** The employee the drawer is about, or null when no row is selected. */
  profileId: string | null;
  /** The work date the drawer is about. */
  workDate: string | null;
  /** The employee, for the name, the department, and the zone clocks are read in. */
  employee: AttendanceEmployee | undefined;
  /**
   * The row the reader selected, held by the Review_Center.
   *
   * Not read by this component from anywhere: the screen replaces its held copy
   * from a write's response and this drawer re-renders from the new one, which is
   * Requirement 12, criterion 14 without a read.
   */
  record: DailyAttendanceRecord | null;
  /** Every employee in scope, so a note's author and an actor can be named. */
  employees?: readonly AttendanceEmployee[];
  /** The zone to fall back to when the employee carries none. */
  fallbackTimeZone?: string;
  /**
   * Whether the six controls are offered.
   *
   * Defaults to false, so a caller that has not established the permission gets
   * the read-only drawer rather than controls that would be refused.
   */
  canAdminister?: boolean;
  /** The row action that opened the drawer, so its control opens with it. */
  initialAction?: RowAction | null;
  onClose: () => void;
  /**
   * A committed write, with the recomputed record where the response carried one.
   *
   * Null means the employee and date carry no record at all, which a manager note
   * alone does not create. The queue refreshes in that case rather than replacing
   * a row it does not have.
   *
   * Requirements: 12.14
   */
  onCommitted: (record: DailyAttendanceRecord | null) => void;
}

/**
 * The exception drawer.
 *
 * A shell over the component below, whose only job is the `key`. The drawer holds
 * an in-progress correction form and the entries it has committed, all of which
 * belong to one employee on one date; keying the subtree on that pair is how React
 * discards them when the subject changes, and it means the reset is a fact about
 * the tree rather than an effect that has to remember every field it added.
 *
 * Requirements: 12.10–12.16
 */
export function ExceptionDrawer(props: ExceptionDrawerProps) {
  const { profileId, workDate } = props;

  // No row selected: no panel, and no state waiting for the next selection.
  if (profileId === null || workDate === null) return null;

  return (
    <ExceptionSubject
      key={`${profileId}\u0000${workDate}`}
      {...props}
      profileId={profileId}
      workDate={workDate}
    />
  );
}

interface ExceptionSubjectProps extends Omit<ExceptionDrawerProps, 'profileId' | 'workDate'> {
  profileId: string;
  workDate: string;
}

/**
 * One employee on one work date: the record detail, the notes, and the six controls.
 *
 * Requirements: 12.11–12.16
 */
function ExceptionSubject({
  profileId,
  workDate,
  employee,
  record,
  employees = [],
  fallbackTimeZone = 'UTC',
  canAdminister = false,
  initialAction = null,
  onClose,
  onCommitted,
}: ExceptionSubjectProps) {
  const timeZone = employee?.timezone ?? fallbackTimeZone;

  // The control the row's action names, open from the first paint with its target
  // chosen and its field prefilled — so pressing Add Clock-Out on a row lands on a
  // form that is ready to submit rather than on an unselected select.
  const initialControl = initialAction === null ? null : CONTROL_FOR_ROW_ACTION[initialAction];
  const [seed] = useState(() => seedForControl(record, initialControl, timeZone));

  const [control, setControl] = useState<DrawerControl | null>(initialControl);
  const [targetKey, setTargetKey] = useState(seed.targetKey);
  const [pickerValue, setPickerValue] = useState(seed.pickerValue);
  const [minutesValue, setMinutesValue] = useState(seed.minutesValue);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<CommittedEntry[]>([]);

  // One key per opened form, replaced once the change is in place. A resubmission
  // after a failure reuses it, which is exactly the replay the correction endpoint
  // is built for: it applies once if the first attempt never landed, and answers
  // `applied: false` with the prior result if it did.
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey());

  // Criterion 11's manager notes. One request for exactly the date in question:
  // the record read carries no notes, and the trend read is the one that does.
  const trendUrl = `/api/attendance/trends?${new URLSearchParams({
    profile_id: profileId,
    from: workDate,
    to: workDate,
  }).toString()}`;

  const trend = useAsyncResource(
    (signal) => attendanceJson<TrendResponse>(trendUrl, { signal }),
    {
      deps: [trendUrl],
      subject: 'the notes for this date',
      filters: [{ label: 'Date', value: workDate }],
      isEmpty: () => false,
    },
  );

  const notes = useMemo<AttendanceNote[]>(
    () => (trend.data?.notes ?? []).filter((entry) => entry.workDate === workDate),
    [trend.data, workDate],
  );

  const employeeNames = useMemo(
    () => new Map(employees.map((row) => [row.profileId, row.displayName])),
    [employees],
  );

  const breakTimeline = useMemo(() => buildBreakTimeline(record), [record]);

  const clockInTargets = useMemo(() => punchTargets(record, 'clock_in'), [record]);
  const clockOutTargets = useMemo(() => punchTargets(record, 'clock_out'), [record]);
  const breakTargets = useMemo(() => minutesTargets(record), [record]);

  // The corrections already stored against this date, which is what criterion 11
  // means by previous corrections: the adjustment stamp the correction function
  // wrote onto the row it changed.
  const previousCorrections = useMemo(
    () =>
      (record?.sessions ?? []).filter(
        (session) =>
          session.adjustedBy !== null ||
          (typeof session.adjustmentReason === 'string' && session.adjustmentReason.trim() !== ''),
      ),
    [record],
  );

  const blockingExceptions = useMemo(
    () => (record?.exceptions ?? []).filter((exception) => exception.payrollBlocking),
    [record],
  );

  /**
   * Opening a control resets the form and seeds it, through the same function that
   * seeded the control the row action opened.
   */
  const openControl = useCallback(
    (next: DrawerControl) => {
      setFailure(null);
      setFieldError(null);
      setReason('');
      setNote('');
      idempotencyKeyRef.current = newIdempotencyKey();

      const opened = seedForControl(record, next, timeZone);
      setTargetKey(opened.targetKey);
      setPickerValue(opened.pickerValue);
      setMinutesValue(opened.minutesValue);

      setControl((current) => (current === next ? null : next));
    },
    [record, timeZone],
  );

  /** Switching target inside a form re-prefills from that target. */
  const selectTarget = useCallback(
    (key: string) => {
      setTargetKey(key);
      setFieldError(null);

      if (control === 'clock_in' || control === 'clock_out') {
        const targets = control === 'clock_in' ? clockInTargets : clockOutTargets;
        const target = targets.find((candidate) => candidate.key === key) ?? null;
        setPickerValue(
          target === null ? '' : toDateTimePickerValue(target.current ?? target.suggestion, timeZone),
        );
        return;
      }

      if (control === 'break_minutes') {
        const target = breakTargets.find((candidate) => candidate.key === key) ?? null;
        setMinutesValue(target?.current === null || target === null ? '' : String(target.current));
      }
    },
    [breakTargets, clockInTargets, clockOutTargets, control, timeZone],
  );

  const recordCommitted = useCallback((entry: CommittedEntry) => {
    setCommitted((previous) => [entry, ...previous]);
  }, []);

  // Pulled out of the resource object, which is rebuilt each render: `refresh` is
  // stable, so `submit` keeps its identity between renders.
  const refreshTrend = trend.refresh;

  /**
   * Submit the open control.
   *
   * The one place any of the six writes is issued. Nothing is applied locally: the
   * response carries the recomputed record, and the screen replaces its held copy
   * from that, so a failure leaves every figure exactly as it was.
   *
   * Requirements: 12.13, 12.14, 12.15
   */
  const submit = useCallback(() => {
    if (control === null || busy) return;

    const trimmedReason = reason.trim();
    const trimmedNote = note.trim();

    // Criterion 13, stated where the reader can see which control it is about.
    if (control !== 'mark_reviewed' && control !== 'note' && trimmedReason === '') {
      setFieldError(REASON_REQUIRED);
      return;
    }
    if (control === 'note' && trimmedNote === '') {
      setFieldError(NOTE_REQUIRED);
      return;
    }

    let url: string;
    let init: RequestInit;

    if (control === 'mark_reviewed') {
      url = '/api/attendance/reviews';
      init = jsonRequest('POST', { profile_id: profileId, work_date: workDate });
    } else if (control === 'note') {
      url = '/api/attendance/notes';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        note: trimmedNote,
        idempotency_key: idempotencyKeyRef.current,
      });
    } else if (control === 'approve_unscheduled') {
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
    } else if (control === 'break_minutes') {
      const target = breakTargets.find((candidate) => candidate.key === targetKey) ?? null;
      if (target === null) {
        setFieldError('Choose the break figure to change.');
        return;
      }
      const minutes = Number(minutesValue.trim());
      if (
        minutesValue.trim() === '' ||
        !Number.isInteger(minutes) ||
        minutes < 0 ||
        minutes > 1440
      ) {
        setFieldError(UNREADABLE_MINUTES);
        return;
      }

      url = '/api/attendance/corrections';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        field: target.field,
        entity_id: target.entityId,
        entity_type: target.entityType,
        value: minutes,
        reason: trimmedReason,
        idempotency_key: idempotencyKeyRef.current,
      });
    } else {
      const targets = control === 'clock_in' ? clockInTargets : clockOutTargets;
      const target = targets.find((candidate) => candidate.key === targetKey) ?? null;
      if (target === null) {
        setFieldError('Choose the session to change.');
        return;
      }
      const instant = fromDateTimePickerValue(pickerValue, timeZone);
      if (instant === null) {
        setFieldError(UNREADABLE_INSTANT);
        return;
      }

      url = '/api/attendance/corrections';
      init = jsonRequest('POST', {
        profile_id: profileId,
        work_date: workDate,
        field: target.field,
        entity_id: target.entityId,
        entity_type: 'clock_entry',
        value: instant,
        reason: trimmedReason,
        idempotency_key: idempotencyKeyRef.current,
      });
    }

    setBusy(true);
    setFailure(null);
    setFieldError(null);

    const submitted = control;

    void (async () => {
      try {
        if (submitted === 'mark_reviewed') {
          const result = await attendanceJson<ReviewResult>(url, init);
          recordCommitted({
            // The audit row's own identifier where there is one. A repeat writes no
            // audit entry, so it falls back to a fresh local key: two repeats are
            // two things that happened and must not collapse into one row.
            key: result.auditId ?? newIdempotencyKey(),
            auditId: result.auditId,
            action: CONTROL_LABELS.mark_reviewed,
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
              result.action === null ? CONTROL_LABELS[submitted] : statusLabel(result.action),
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
        setControl(null);
        setReason('');
        setNote('');
        // The notes came from a read, so they are asked again. The record's own
        // figures did not: they arrived on the response and the screen has already
        // replaced them.
        refreshTrend();
      } catch (error) {
        setFailure(asApiFailure(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    breakTargets,
    busy,
    clockInTargets,
    clockOutTargets,
    control,
    minutesValue,
    note,
    onCommitted,
    pickerValue,
    profileId,
    reason,
    record,
    recordCommitted,
    refreshTrend,
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

  // Criterion 13's reason, for the controls that override a stored value. A note is
  // its own stated reason, and marking a date reviewed overrides nothing.
  const reasonRequired = control !== null && control !== 'mark_reviewed' && control !== 'note';

  const punchForm = control === 'clock_in' || control === 'clock_out';
  const formTargets = control === 'clock_in' ? clockInTargets : clockOutTargets;

  return (
    <SideDrawer
      open
      onClose={onClose}
      title={employee?.displayName ?? 'Employee'}
      subtitle={subtitle}
      footer={
        canAdminister ? (
          <div className="space-y-2.5">
            {/* Criterion 12: the four correction controls. */}
            <div>
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                Corrections
              </span>
              <div className="mt-1 flex flex-wrap gap-2">
                {CORRECTION_CONTROLS.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => openControl(candidate)}
                    aria-expanded={control === candidate}
                    disabled={busy}
                    className={[
                      'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] font-black transition disabled:cursor-not-allowed disabled:opacity-40',
                      control === candidate
                        ? `${accent.surface} ${accent.border} ${accent.text}`
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                    ].join(' ')}
                  >
                    {CONTROL_LABELS[candidate]}
                  </button>
                ))}
              </div>
            </div>

            {/* Criteria 7 and 15: the two actions that change no stored figure. */}
            <div>
              <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
                Review
              </span>
              <div className="mt-1 flex flex-wrap gap-2">
                {REVIEW_CONTROLS.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    onClick={() => openControl(candidate)}
                    aria-expanded={control === candidate}
                    disabled={busy}
                    className={[
                      'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5 text-[12px] font-black transition disabled:cursor-not-allowed disabled:opacity-40',
                      control === candidate
                        ? `${accent.surface} ${accent.border} ${accent.text}`
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
                    ].join(' ')}
                  >
                    {CONTROL_LABELS[candidate]}
                  </button>
                ))}
              </div>
            </div>

            {control !== null && (
              <div className="space-y-2.5 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3">
                <p className="text-[11px] font-black uppercase tracking-wider text-slate-500">
                  {CONTROL_LABELS[control]}
                </p>

                {punchForm && (
                  <>
                    {formTargets.length === 0 ? (
                      <p className="text-[12px] font-semibold text-slate-500">
                        This date carries no clock session, so there is no{' '}
                        {control === 'clock_in' ? 'clock-in' : 'clock-out'} to correct. Add the
                        session from the Today screen&rsquo;s employee drawer first.
                      </p>
                    ) : (
                      <>
                        <label className="block">
                          <span className={ui.label}>Session</span>
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
                          </select>
                        </label>

                        <div>
                          <span className={ui.label}>Corrected time</span>
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
                      </>
                    )}
                  </>
                )}

                {control === 'break_minutes' && (
                  <>
                    {breakTargets.length === 0 ? (
                      <p className="text-[12px] font-semibold text-slate-500">
                        This date carries no clock session, so there is no break figure to
                        correct.
                      </p>
                    ) : (
                      <>
                        <label className="block">
                          <span className={ui.label}>Break figure</span>
                          <select
                            value={targetKey}
                            onChange={(event) => selectTarget(event.target.value)}
                            className={`${ui.select} mt-1 py-1.5 text-[13px]`}
                          >
                            {breakTargets.map((target) => (
                              <option key={`${target.field}:${target.key}`} value={target.key}>
                                {target.label}
                                {target.current === null
                                  ? ''
                                  : ` (${formatMinutes(target.current)})`}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="block">
                          <span className={ui.label}>Minutes</span>
                          <input
                            type="number"
                            min={0}
                            max={1440}
                            step={1}
                            value={minutesValue}
                            onChange={(event) => setMinutesValue(event.target.value)}
                            disabled={busy}
                            className={`${ui.input} mt-1 py-1.5 text-[13px]`}
                          />
                          <p className="mt-0.5 text-[11px] font-semibold text-slate-400">
                            {breakTargets.find((target) => target.key === targetKey)?.note ??
                              'Whole minutes, from 0 to 1440.'}
                          </p>
                        </label>
                      </>
                    )}
                  </>
                )}

                {control === 'note' && (
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

                {control === 'approve_unscheduled' && (
                  <p className="text-[12px] font-semibold text-slate-600">
                    Approving the unscheduled work recorded on this date clears the
                    payroll-blocking exception. The approval is the audit entry; there is no
                    un-approve.
                  </p>
                )}

                {control === 'mark_reviewed' && (
                  <p className="text-[12px] font-semibold text-slate-600">
                    Records that this date was reviewed, with the reviewer and the timestamp. A
                    second review keeps the first reviewer.
                  </p>
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
                    {busy ? 'Submitting\u2026' : CONTROL_LABELS[control]}
                  </button>
                  <button
                    type="button"
                    onClick={() => setControl(null)}
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
            there is no attendance record to describe. The notes and the controls below still
            apply.
          </p>
        ) : (
          <>
            {/* The published schedule, the status, and the rule that assigned it. */}
            <Block title="Published schedule" note={statusReason(record.statusRuleId)}>
              <StatusPill status={record.derivedStatus} size="md" />
              <dl className="mt-2 grid grid-cols-2 gap-2.5">
                <Field
                  label="Scheduled"
                  value={
                    record.scheduledStart === null && record.scheduledEnd === null
                      ? 'No published shift'
                      : `${formatTimeOfDay(record.scheduledStart, timeZone)} \u2013 ${formatTimeOfDay(record.scheduledEnd, timeZone)}`
                  }
                  note={`${formatHours(record.scheduledHours)} scheduled`}
                />
                <Field
                  label="Clock"
                  value={
                    record.firstClockIn === null
                      ? 'No clock session'
                      : `${formatTimeOfDay(record.firstClockIn, timeZone)} \u2013 ${record.hasOpenSession ? 'open' : formatTimeOfDay(record.lastClockOut, timeZone)}`
                  }
                  note={record.hasOpenSession ? 'A session is still open.' : 'All sessions closed.'}
                />
              </dl>
            </Block>

            {/* The calculated figures, as the Attendance_Service derived them. */}
            <Block
              title="Calculated hours"
              note="Derived once by the Attendance_Service. Nothing on this panel is recomputed here."
            >
              <dl className="grid grid-cols-2 gap-2.5">
                <Field label="Scheduled hours" value={formatHours(record.scheduledHours)} />
                <Field label="Worked hours" value={formatHours(record.workedHours)} />
                <Field
                  label="Unpaid breaks"
                  value={formatMinutes(record.unpaidBreakMinutes)}
                  note="Subtracted from worked hours."
                />
                <Field
                  label="Paid breaks"
                  value={formatMinutes(record.paidBreakMinutes)}
                  note="Reported, never subtracted."
                />
                <Field label="Late" value={formatMinutes(record.lateMinutes)} />
                <Field label="Left early" value={formatMinutes(record.earlyDepartureMinutes)} />
              </dl>
            </Block>

            {/* The payroll impact, with the reason it is what it is. */}
            <Block title="Payroll impact">
              {record.payrollBlocking ? (
                <TokenPill role="critical" icon="OctagonAlert" label="Payroll blocked" />
              ) : (
                <TokenPill role="healthy" icon="ShieldCheck" label="Payable" />
              )}
              {blockingExceptions.length === 0 ? (
                <p className="mt-1.5 text-[12px] font-semibold text-slate-600">
                  No exception on this date holds payroll. {formatHours(record.workedHours)} of
                  worked time is payable, with {formatMinutes(record.unpaidBreakMinutes)} of unpaid
                  break already deducted.
                </p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {blockingExceptions.map((exception) => (
                    <li
                      key={`${exception.ruleId}:${exception.code}`}
                      className="text-[12px] font-semibold text-slate-600"
                    >
                      <span className="font-black text-slate-800">
                        {statusLabel(exception.code)}
                      </span>
                      {' \u2014 '}
                      {exception.ruleDescription}
                    </li>
                  ))}
                </ul>
              )}
            </Block>

            {/* The raw clock events, before any figure is derived from them. */}
            <Block
              title="Raw clock events"
              note="The stored rows, as they are, before any figure is derived from them."
            >
              {record.sessions.length === 0 ? (
                <p className="text-[12px] font-bold text-slate-400">No clock session recorded.</p>
              ) : (
                <ul className="space-y-2">
                  {record.sessions.map((session, index) => (
                    <SessionItem
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

            {/* The break timeline, in the order the breaks started. */}
            <Block title="Break timeline">
              {breakTimeline.length === 0 ? (
                <p className="text-[12px] font-bold text-slate-400">
                  No break was recorded on this date.
                </p>
              ) : (
                <ol className="space-y-1.5">
                  {breakTimeline.map((entry) => (
                    <li key={entry.key} className="flex items-start gap-2">
                      <StatusIcon
                        name="Coffee"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500"
                      />
                      <span className="w-[4.75rem] shrink-0 text-[12px] font-black text-slate-800">
                        {formatTimeOfDay(entry.start, timeZone)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[12px] font-semibold text-slate-800">
                          {entry.type} break {entry.end === null ? 'started, still running' : `to ${formatTimeOfDay(entry.end, timeZone)}`}
                        </span>
                        <span className="block text-[11px] font-semibold text-slate-400">
                          {entry.sessionLabel}
                          {entry.durationMinutes === null
                            ? ''
                            : ` \u00b7 ${formatMinutes(entry.durationMinutes)} recorded`}
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </Block>

            {/* Every exception, each with the rule that produced it (criterion 11). */}
            <Block title="Exceptions">
              {record.exceptions.length === 0 ? (
                <p className="text-[12px] font-bold text-slate-400">
                  No exception on this date.
                </p>
              ) : (
                <ul className="space-y-2">
                  {record.exceptions.map((exception) => (
                    <ExceptionItem
                      key={`${exception.ruleId}:${exception.code}`}
                      exception={exception}
                    />
                  ))}
                </ul>
              )}
            </Block>
          </>
        )}

        {/* The read behind the notes, with its own states. */}
        <AsyncStateBlock
          status={trend.status}
          failure={trend.failure}
          pending={trend.pending}
          onRetry={trend.retry}
          subject="the notes for this date"
          message={trend.emptyMessage}
        />

        {/* Criterion 11: the manager notes on this employee and date. */}
        <Block title="Manager notes">
          {notes.length === 0 ? (
            <p className="text-[12px] font-bold text-slate-400">
              No note recorded against this date.
            </p>
          ) : (
            <ul className="space-y-2">
              {notes.map((entry) => (
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

        {/* Criterion 11: the corrections already stored against this date. */}
        <Block
          title="Previous corrections"
          note="The adjustment stamp a correction writes onto the row it changed."
        >
          {previousCorrections.length === 0 ? (
            <p className="text-[12px] font-bold text-slate-400">
              No clock row on this date carries a correction.
            </p>
          ) : (
            <ul className="space-y-2">
              {previousCorrections.map((session) => (
                <li key={session.id} className="rounded-xl bg-slate-50 px-3 py-2">
                  <p className="text-[12px] font-black text-slate-800">
                    {formatTimeOfDay(session.clockIn, timeZone)} to{' '}
                    {session.clockOut === null
                      ? 'open'
                      : formatTimeOfDay(session.clockOut, timeZone)}
                  </p>
                  {session.adjustmentReason !== null && session.adjustmentReason !== '' && (
                    <p className="mt-0.5 text-[11px] font-semibold text-slate-600">
                      {session.adjustmentReason}
                    </p>
                  )}
                  <p className="text-[11px] font-bold text-slate-400">
                    Adjusted by{' '}
                    {employeeNames.get(session.adjustedBy ?? '') ?? 'an administrator'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Block>

        {/* Criterion 11's audit entries. The seam is documented in this file's
            header comment: `/api/attendance/audit` arrives with the Audit Log view,
            and until then the only audit rows readable here are the ones this
            drawer's own writes reported. */}
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

export default ExceptionDrawer;
