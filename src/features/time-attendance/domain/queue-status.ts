// src/features/time-attendance/domain/queue-status.ts
// Attendance status and sales-queue status, kept apart.
//
// Spec: .kiro/specs/attendance-queue-status-separation
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.9, 2.14, 2.15, 2.16, 2.17
//
// `public.profiles.availability` used to carry two unrelated facts: whether an
// employee is at work, and whether an agent is taking sales work. The database
// now reports them as two fields, and this module holds the three rules a screen
// needs to say so:
//
//   * `statusLines` — the two separately labelled values of 2.14. The bare word
//     `Available` never stands alone, and the sales-queue line is absent
//     altogether for a non-agent, for whom queue status is meaningless.
//   * `queueStatusNotice` — which of the three sentences 2.15, 2.16 and 2.17
//     applies, and which explicit action goes with it.
//   * `decideQueueTransition` — the per-action decision table, as a pure
//     function.
//
// ## Why the decision table lives here as well as in SQL
//
// The authoritative decision is `v1.12.13-attendance-queue-status-separation.sql`
// § 8: the four `security definer` attendance functions apply it inside the
// transaction that applies the attendance change, which is the whole point of
// 2.8. This function is a transcription of that table, and it exists for two
// reasons. It is the table in a form a unit test can enumerate cell by cell —
// action × mode × queue status × pre-break status — and it is the documentation
// of the rule in one readable place. It is never the thing that decides
// production behavior. If the two ever disagree, the SQL is right and this is a
// bug.

/** Attendance status: derived from clock entries and breaks. Every employee has one. */
export type AttendanceStatusValue = 'clocked_out' | 'working' | 'on_break';

/** Sales-queue status: `public.availability_status`. Meaningful for agents only. */
export type QueueStatusValue = 'available' | 'break' | 'unavailable';

/** The per-agent opt-in gate: `public.queue_status_mode`. */
export type QueueStatusMode = 'manual' | 'attendance_assisted';

/** The four attendance actions that can reach a queue decision. */
export type AttendanceAction = 'clock_in' | 'clock_out' | 'break_start' | 'break_end';

/** The eight members of the `availability_events.source` vocabulary (2.12). */
export type AvailabilitySource =
  | 'manual_agent'
  | 'manual_manager'
  | 'attendance_clock_out'
  | 'attendance_break_start'
  | 'attendance_break_end'
  | 'daily_reset'
  | 'system_repair'
  | 'user_deactivated';

/** The two explicit actions a panel can offer beside a notice. */
export type QueueStatusAction = 'join_sales_queues' | 'set_unavailable';

/**
 * The labels the two actions carry. `Join Sales Queues` is the only path that
 * sets queue availability to Available from the attendance screens (2.1, 2.15);
 * `Set Unavailable` is the one 2.17 offers to a `manual`-mode employee who has
 * gone home while still marked Available.
 */
export const QUEUE_ACTION_LABELS: Readonly<Record<QueueStatusAction, string>> = {
  join_sales_queues: 'Join Sales Queues',
  set_unavailable: 'Set Unavailable',
};

/** The queue status each action asks for. */
export const QUEUE_ACTION_STATUS: Readonly<Record<QueueStatusAction, QueueStatusValue>> = {
  join_sales_queues: 'available',
  set_unavailable: 'unavailable',
};

/** The three sentences 2.15, 2.16 and 2.17 fix word for word. */
export const QUEUE_STATUS_MESSAGES = {
  /** 2.15 — clocked in, and not receiving sales work. */
  notReceivingSalesWork: 'You are clocked in, but you are not currently receiving sales work.',
  /** 2.16 — clocked out in `attendance_assisted` mode. */
  clockedOutAndRemoved: 'You have been clocked out and removed from the sales queues.',
  /** 2.17 — clocked out in `manual` mode, still Available. */
  clockedOutStillAvailable: 'You are clocked out but still marked Available in Sales Queues.',
} as const;

/** Attendance status in words (2.14). */
export const ATTENDANCE_STATUS_LABELS: Readonly<Record<AttendanceStatusValue, string>> = {
  clocked_out: 'Clocked Out',
  working: 'Working',
  on_break: 'On Break',
};

/** Sales-queue status in words (2.14). Never rendered without its label. */
export const QUEUE_STATUS_LABELS: Readonly<Record<QueueStatusValue, string>> = {
  available: 'Available',
  break: 'Break',
  unavailable: 'Unavailable',
};

/** The label the attendance value is always shown under. */
export const ATTENDANCE_LINE_LABEL = 'Attendance';

/** The label the queue value is always shown under. */
export const QUEUE_LINE_LABEL = 'Sales Queues';

export function attendanceStatusLabel(status: AttendanceStatusValue): string {
  return ATTENDANCE_STATUS_LABELS[status];
}

export function queueStatusLabel(status: QueueStatusValue): string {
  return QUEUE_STATUS_LABELS[status];
}

/** One labelled value. `text` is the whole line, so no value renders on its own. */
export interface StatusLine {
  id: 'attendance' | 'queue';
  label: string;
  value: string;
  /** `Attendance: Working`, `Sales Queues: Unavailable`. */
  text: string;
}

/** What a panel knows about an employee's two statuses, from one database read. */
export interface StatusView {
  attendanceStatus: AttendanceStatusValue;
  queueStatus: QueueStatusValue | null;
  queueStatusMode: QueueStatusMode | null;
  isAgent: boolean;
}

/**
 * The two separately labelled values of 2.14.
 *
 * The queue line is omitted for a non-agent, and for an agent whose queue status
 * could not be read: a label with nothing under it says less than no label. The
 * attendance line is always present, because every employee has one.
 */
export function statusLines(view: StatusView): StatusLine[] {
  const lines: StatusLine[] = [
    {
      id: 'attendance',
      label: ATTENDANCE_LINE_LABEL,
      value: attendanceStatusLabel(view.attendanceStatus),
      text: `${ATTENDANCE_LINE_LABEL}: ${attendanceStatusLabel(view.attendanceStatus)}`,
    },
  ];

  if (view.isAgent && view.queueStatus !== null) {
    lines.push({
      id: 'queue',
      label: QUEUE_LINE_LABEL,
      value: queueStatusLabel(view.queueStatus),
      text: `${QUEUE_LINE_LABEL}: ${queueStatusLabel(view.queueStatus)}`,
    });
  }

  return lines;
}

/** A sentence and the explicit action that belongs with it, or nothing to say. */
export interface QueueStatusNotice {
  message: string;
  action: QueueStatusAction | null;
}

/**
 * Which of 2.15, 2.16 and 2.17 applies.
 *
 * Nothing is said to a non-agent: queue status does not govern anything for them,
 * and `set_my_availability` would refuse the call the notice offers. Nothing is
 * said to an agent who is at work and receiving sales work either — that is the
 * ordinary state, and the two labelled values already report it.
 */
export function queueStatusNotice(view: StatusView): QueueStatusNotice | null {
  if (!view.isAgent || view.queueStatus === null) return null;

  // 2.15 — at work, but not receiving sales work. The one path in is explicit.
  if (view.attendanceStatus !== 'clocked_out') {
    return view.queueStatus === 'available'
      ? null
      : {
          message: QUEUE_STATUS_MESSAGES.notReceivingSalesWork,
          action: 'join_sales_queues',
        };
  }

  // 2.16 — clocked out with attendance assistance on: the queues released them.
  if (view.queueStatusMode === 'attendance_assisted') {
    return { message: QUEUE_STATUS_MESSAGES.clockedOutAndRemoved, action: null };
  }

  // 2.17 — clocked out in manual mode and still Available, which is a live
  // routing problem: sales work is being sent to someone who has gone home.
  if (view.queueStatus === 'available') {
    return { message: QUEUE_STATUS_MESSAGES.clockedOutStillAvailable, action: 'set_unavailable' };
  }

  return null;
}

/** One cell of the decision table: everything the rule reads. */
export interface QueueDecisionInput {
  action: AttendanceAction;
  /** `profiles.role`. Anything other than `agent` gets no queue portion at all. */
  role: string;
  mode: QueueStatusMode;
  /** `profiles.availability` before the action. */
  queue: QueueStatusValue;
  /** `time_clock_breaks.pre_break_queue_status`; null means "not recorded". */
  preBreak: QueueStatusValue | null;
}

/** What the rule decides. */
export interface QueueDecision {
  /** Queue status after the action. */
  queueStatus: QueueStatusValue;
  /** Whether the transition writes anything. A zero-delta decision does not. */
  changed: boolean;
  /**
   * The source the one availability event carries, or null when no event is
   * written — which is every case where the value does not move, because
   * `apply_queue_status` returns early when the profile already holds the target
   * value. That early return is the idempotency point of 2.10.
   */
  source: AvailabilitySource | null;
  /** Whether the break row records the pre-break queue status (2.3, 2.4). */
  recordsPreBreakStatus: boolean;
  /** Whether the response offers the explicit way in (2.1, 2.6, 2.15). */
  offersJoinSalesQueues: boolean;
}

/**
 * The per-action queue decision, as a pure function.
 *
 * A transcription of `v1.12.13-attendance-queue-status-separation.sql` § 8, step
 * 5. See the module header for why it exists in two places and which one wins.
 */
export function decideQueueTransition(input: QueueDecisionInput): QueueDecision {
  const isAgent = input.role === 'agent';
  // Clock-out is the one action that leaves the employee not at work, and the
  // explicit way in is never offered to someone who has gone home.
  const atWork = input.action !== 'clock_out';

  const unchanged = (recordsPreBreakStatus = false): QueueDecision => ({
    queueStatus: input.queue,
    changed: false,
    source: null,
    recordsPreBreakStatus,
    offersJoinSalesQueues: isAgent && atWork && input.queue !== 'available',
  });

  // No queue portion for a non-agent: queue status is meaningless for them and
  // `set_my_availability` requires `is_agent()`, which is `role = 'agent'` only.
  // The old routes made the call anyway, Postgres raised, and the route answered
  // HTTP 201 — the deterministic C6 case, fixed by not making the call.
  if (!isAgent) return unchanged();

  // The opt-in gate. `manual` is the migration default, so applying the fix takes
  // attendance-driven queue changes away from everyone (2.9, 2.11).
  if (input.mode === 'manual') return unchanged();

  const decided = (next: QueueStatusValue, source: AvailabilitySource, recordsPreBreakStatus = false): QueueDecision => ({
    queueStatus: next,
    changed: next !== input.queue,
    source: next === input.queue ? null : source,
    recordsPreBreakStatus,
    offersJoinSalesQueues: atWork && next !== 'available',
  });

  switch (input.action) {
    // 2.1 — clock-in never changes queue status. The fix is disclosure.
    case 'clock_in':
      return unchanged();

    // 2.2 — whether or not a break was open. The `if (onBreak)` condition is gone.
    case 'clock_out':
      return decided('unavailable', 'attendance_clock_out');

    // 2.3, 2.4 — record the pre-break status either way; move to Break only from
    // Available, so an agent who is not queue-eligible never becomes eligible
    // through a break.
    case 'break_start':
      return input.queue === 'available'
        ? decided('break', 'attendance_break_start', true)
        : unchanged(true);

    // 2.5, 2.6 — restore exactly what was recorded; nothing recorded falls back
    // to Unavailable with the explicit way in offered.
    case 'break_end':
      return decided(input.preBreak ?? 'unavailable', 'attendance_break_end');
  }
}

/**
 * The payload `/api/time-clock/active` answers with.
 *
 * `clocked_in`, `entry` and `active_break` are the read's original shape; the four
 * status fields are what this fix added, so a panel renders two labelled values
 * from a database read (2.14, 2.18).
 */
export interface ActiveClockResponse {
  clocked_in: boolean;
  entry: { id: string; clock_in: string; clock_status: string; break_minutes: number } | null;
  active_break: { id: string; break_start: string; break_type: string } | null;
  attendance_status: AttendanceStatusValue;
  queue_status: QueueStatusValue | null;
  queue_status_mode: QueueStatusMode | null;
  is_agent: boolean;
}

/**
 * A server payload as the view the two display rules read.
 *
 * Takes either the `/api/time-clock/active` read or a clock action's response,
 * because both carry the same four status fields — which is what lets a panel
 * render the action's own answer and then the next read without two code paths.
 * A missing field is read as its safest value: not at work, no queue status, not
 * an agent, so nothing is claimed that was not reported.
 */
export function toStatusView(payload: {
  attendance_status?: AttendanceStatusValue;
  queue_status?: QueueStatusValue | null;
  queue_status_mode?: QueueStatusMode | null;
  is_agent?: boolean;
}): StatusView {
  return {
    attendanceStatus: payload.attendance_status ?? 'clocked_out',
    queueStatus: payload.queue_status ?? null,
    queueStatusMode: payload.queue_status_mode ?? null,
    isAgent: payload.is_agent ?? false,
  };
}
