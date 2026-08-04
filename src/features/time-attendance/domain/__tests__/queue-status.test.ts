// src/features/time-attendance/domain/__tests__/queue-status.test.ts
// The queue decision table, the three sentences, and the two labels.
//
// Spec: .kiro/specs/attendance-queue-status-separation, task 9.4
// Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.9, 2.14, 2.15, 2.16, 2.17
//
// `decideQueueTransition` is a transcription of the decision the four
// `security definer` attendance functions apply inside their own transaction
// (`v1.12.13-attendance-queue-status-separation.sql` § 8, step 5). The table is
// small enough to enumerate, so it is enumerated: every cell of 2.1 through 2.6
// and 2.9, including the `role <> 'agent'` cell that used to make Postgres raise
// on every non-agent break while the route answered HTTP 201.
//
// The integration suite is what proves the SQL agrees with this table against a
// real database. What these tests protect is the rule itself: that a break never
// launders a deliberate Unavailable into queue-eligible, that break end restores
// rather than assumes, and that `manual` means nothing attendance does moves the
// queue.

import { describe, expect, it } from 'vitest';

import {
  QUEUE_ACTION_LABELS,
  QUEUE_ACTION_STATUS,
  QUEUE_STATUS_MESSAGES,
  decideQueueTransition,
  queueStatusNotice,
  statusLines,
  toStatusView,
  type AttendanceAction,
  type QueueDecisionInput,
  type QueueStatusMode,
  type QueueStatusValue,
  type StatusView,
} from '../queue-status';

const QUEUE_VALUES: QueueStatusValue[] = ['available', 'break', 'unavailable'];
const PRE_BREAK_VALUES: (QueueStatusValue | null)[] = [
  'available',
  'break',
  'unavailable',
  null,
];
const ACTIONS: AttendanceAction[] = ['clock_in', 'clock_out', 'break_start', 'break_end'];
const MODES: QueueStatusMode[] = ['manual', 'attendance_assisted'];

function decide(overrides: Partial<QueueDecisionInput> = {}) {
  const input: QueueDecisionInput = {
    action: 'clock_out',
    role: 'agent',
    mode: 'attendance_assisted',
    queue: 'available',
    preBreak: null,
    ...overrides,
  };
  return decideQueueTransition(input);
}

describe('decideQueueTransition: the per-action queue decision table', () => {
  // ── 2.9, and the deterministic C6 case ────────────────────────────────────
  it('gives a non-agent no queue portion at all, for every action and mode', () => {
    // Queue status is meaningless for a non-agent, and `set_my_availability`
    // requires `is_agent()`, which is `role = 'agent'` only. The old routes made
    // the call regardless: every `customer_service`, `commercial`, `manager`,
    // `super_admin` and supervisor break raised inside Postgres and returned 201.
    for (const role of ['customer_service', 'commercial', 'manager', 'super_admin', 'sales_supervisor']) {
      for (const action of ACTIONS) {
        for (const mode of MODES) {
          for (const queue of QUEUE_VALUES) {
            const decision = decide({ role, action, mode, queue });
            expect(decision.queueStatus).toBe(queue);
            expect(decision.changed).toBe(false);
            expect(decision.source).toBeNull();
            expect(decision.recordsPreBreakStatus).toBe(false);
            // Nothing to join: the notice is not offered to a non-agent either.
            expect(decision.offersJoinSalesQueues).toBe(false);
          }
        }
      }
    }
  });

  // ── 2.9: the mode gate is total over the three attendance actions ─────────
  it('changes nothing in manual mode, whatever the action and whatever the pre-state', () => {
    for (const action of ACTIONS) {
      for (const queue of QUEUE_VALUES) {
        for (const preBreak of PRE_BREAK_VALUES) {
          const decision = decide({ mode: 'manual', action, queue, preBreak });
          expect(decision.queueStatus).toBe(queue);
          expect(decision.changed).toBe(false);
          expect(decision.source).toBeNull();
          // The pre-break column stays null in manual mode, which is what makes
          // null mean "not recorded" rather than "recorded as nothing".
          expect(decision.recordsPreBreakStatus).toBe(false);
        }
      }
    }
  });

  // ── 2.1: clock-in ─────────────────────────────────────────────────────────
  it('leaves queue status alone on clock-in and offers the way in when not Available', () => {
    expect(decide({ action: 'clock_in', queue: 'available' })).toMatchObject({
      queueStatus: 'available',
      changed: false,
      source: null,
      offersJoinSalesQueues: false,
    });

    for (const queue of ['break', 'unavailable'] as QueueStatusValue[]) {
      expect(decide({ action: 'clock_in', queue })).toMatchObject({
        queueStatus: queue,
        changed: false,
        source: null,
        offersJoinSalesQueues: true,
      });
    }
  });

  // ── 2.2: clock-out, break open or not ─────────────────────────────────────
  it('sets Unavailable on clock-out from any queue status', () => {
    // The `if (onBreak)` condition is gone: a break-less clock-out used to write
    // nothing, leaving a departed agent holding live rotation turns overnight.
    for (const queue of QUEUE_VALUES) {
      const decision = decide({ action: 'clock_out', queue });
      expect(decision.queueStatus).toBe('unavailable');
      expect(decision.changed).toBe(queue !== 'unavailable');
      expect(decision.source).toBe(queue === 'unavailable' ? null : 'attendance_clock_out');
      // Never offered to someone who has gone home.
      expect(decision.offersJoinSalesQueues).toBe(false);
    }
  });

  // ── 2.3: break start from Available ───────────────────────────────────────
  it('records the pre-break status and moves to Break from Available', () => {
    expect(decide({ action: 'break_start', queue: 'available' })).toMatchObject({
      queueStatus: 'break',
      changed: true,
      source: 'attendance_break_start',
      recordsPreBreakStatus: true,
      offersJoinSalesQueues: true,
    });
  });

  // ── 2.4: break start from anything else ───────────────────────────────────
  it('records the pre-break status but leaves an ineligible agent alone', () => {
    // An agent who is not queue-eligible must never become eligible through a
    // break, and the value they held has to survive the break to be restorable.
    for (const queue of ['break', 'unavailable'] as QueueStatusValue[]) {
      expect(decide({ action: 'break_start', queue })).toMatchObject({
        queueStatus: queue,
        changed: false,
        source: null,
        recordsPreBreakStatus: true,
      });
    }
  });

  // ── 2.5: break end with a stored status ───────────────────────────────────
  it('restores exactly the stored pre-break status on break end', () => {
    // Available restores Available; Unavailable restores Unavailable. The old
    // route wrote `available` unconditionally, which is an assumption rather than
    // a restore.
    for (const preBreak of QUEUE_VALUES) {
      const decision = decide({ action: 'break_end', queue: 'break', preBreak });
      expect(decision.queueStatus).toBe(preBreak);
      expect(decision.changed).toBe(preBreak !== 'break');
      expect(decision.source).toBe(preBreak === 'break' ? null : 'attendance_break_end');
    }
  });

  // ── 2.6: break end with nothing stored ────────────────────────────────────
  it('falls back to Unavailable and offers the way in when nothing was stored', () => {
    const decision = decide({ action: 'break_end', queue: 'break', preBreak: null });
    expect(decision.queueStatus).toBe('unavailable');
    expect(decision.changed).toBe(true);
    expect(decision.source).toBe('attendance_break_end');
    expect(decision.offersJoinSalesQueues).toBe(true);
  });

  // ── 2.10, 2.12: an event belongs to a change, not to an attempt ───────────
  it('writes no event for a decision that does not move the value', () => {
    // `apply_queue_status` returns early when the profile already holds the
    // target value, which is the idempotency point a duplicate request lands on.
    for (const action of ACTIONS) {
      for (const queue of QUEUE_VALUES) {
        for (const preBreak of PRE_BREAK_VALUES) {
          const decision = decide({ action, queue, preBreak });
          expect(decision.source === null).toBe(!decision.changed);
        }
      }
    }
  });

  it('never invents a queue status outside the three the enum allows', () => {
    for (const action of ACTIONS) {
      for (const mode of MODES) {
        for (const queue of QUEUE_VALUES) {
          for (const preBreak of PRE_BREAK_VALUES) {
            expect(QUEUE_VALUES).toContain(decide({ action, mode, queue, preBreak }).queueStatus);
          }
        }
      }
    }
  });
});

function view(overrides: Partial<StatusView> = {}): StatusView {
  return {
    attendanceStatus: 'working',
    queueStatus: 'available',
    queueStatusMode: 'attendance_assisted',
    isAgent: true,
    ...overrides,
  };
}

describe('queueStatusNotice: which sentence applies', () => {
  // ── 2.15 ──────────────────────────────────────────────────────────────────
  it('says an employee at work is not receiving sales work, and offers the way in', () => {
    for (const attendanceStatus of ['working', 'on_break'] as const) {
      for (const queueStatus of ['break', 'unavailable'] as QueueStatusValue[]) {
        expect(queueStatusNotice(view({ attendanceStatus, queueStatus }))).toEqual({
          message: QUEUE_STATUS_MESSAGES.notReceivingSalesWork,
          action: 'join_sales_queues',
        });
      }
    }
  });

  it('says nothing to an agent who is at work and receiving sales work', () => {
    expect(queueStatusNotice(view({ attendanceStatus: 'working', queueStatus: 'available' }))).toBeNull();
  });

  // ── 2.16 ──────────────────────────────────────────────────────────────────
  it('reports the removal from the queues after a clock-out in assisted mode', () => {
    for (const queueStatus of QUEUE_VALUES) {
      expect(
        queueStatusNotice(
          view({
            attendanceStatus: 'clocked_out',
            queueStatusMode: 'attendance_assisted',
            queueStatus,
          }),
        ),
      ).toEqual({ message: QUEUE_STATUS_MESSAGES.clockedOutAndRemoved, action: null });
    }
  });

  // ── 2.17 ──────────────────────────────────────────────────────────────────
  it('reports a manual-mode employee who is clocked out but still Available, with the way out', () => {
    expect(
      queueStatusNotice(
        view({ attendanceStatus: 'clocked_out', queueStatusMode: 'manual', queueStatus: 'available' }),
      ),
    ).toEqual({
      message: QUEUE_STATUS_MESSAGES.clockedOutStillAvailable,
      action: 'set_unavailable',
    });
  });

  it('says nothing to a manual-mode employee who is clocked out and not Available', () => {
    for (const queueStatus of ['break', 'unavailable'] as QueueStatusValue[]) {
      expect(
        queueStatusNotice(
          view({ attendanceStatus: 'clocked_out', queueStatusMode: 'manual', queueStatus }),
        ),
      ).toBeNull();
    }
  });

  it('says nothing at all to a non-agent, in any state', () => {
    for (const attendanceStatus of ['clocked_out', 'working', 'on_break'] as const) {
      for (const queueStatus of QUEUE_VALUES) {
        for (const queueStatusMode of MODES) {
          expect(
            queueStatusNotice(
              view({ isAgent: false, attendanceStatus, queueStatus, queueStatusMode }),
            ),
          ).toBeNull();
        }
      }
    }
  });

  it('asks for the status its action names', () => {
    expect(QUEUE_ACTION_STATUS.join_sales_queues).toBe('available');
    expect(QUEUE_ACTION_STATUS.set_unavailable).toBe('unavailable');
    expect(QUEUE_ACTION_LABELS.join_sales_queues).toBe('Join Sales Queues');
    expect(QUEUE_ACTION_LABELS.set_unavailable).toBe('Set Unavailable');
  });
});

describe('statusLines: two separately labelled values (2.14)', () => {
  it('labels both values for an agent', () => {
    expect(statusLines(view({ attendanceStatus: 'working', queueStatus: 'unavailable' })).map((line) => line.text))
      .toEqual(['Attendance: Working', 'Sales Queues: Unavailable']);
  });

  it('never renders the bare word Available, in any combination', () => {
    for (const attendanceStatus of ['clocked_out', 'working', 'on_break'] as const) {
      for (const queueStatus of QUEUE_VALUES) {
        for (const line of statusLines(view({ attendanceStatus, queueStatus }))) {
          expect(line.text).not.toBe('Available');
          expect(line.text.startsWith(`${line.label}: `)).toBe(true);
        }
      }
    }
  });

  it('omits the sales-queue line for a non-agent', () => {
    const lines = statusLines(view({ isAgent: false, attendanceStatus: 'working' }));
    expect(lines.map((line) => line.id)).toEqual(['attendance']);
    expect(lines[0].text).toBe('Attendance: Working');
  });

  it('omits the sales-queue line when the queue status could not be read', () => {
    expect(statusLines(view({ queueStatus: null })).map((line) => line.id)).toEqual(['attendance']);
  });

  it('names all three attendance states', () => {
    expect(
      (['clocked_out', 'working', 'on_break'] as const).map(
        (attendanceStatus) => statusLines(view({ attendanceStatus }))[0].text,
      ),
    ).toEqual(['Attendance: Clocked Out', 'Attendance: Working', 'Attendance: On Break']);
  });
});

describe('toStatusView', () => {
  it('reads a server payload without claiming anything it did not report', () => {
    expect(toStatusView({})).toEqual({
      attendanceStatus: 'clocked_out',
      queueStatus: null,
      queueStatusMode: null,
      isAgent: false,
    });
  });

  it('carries every field a clock action or the active read returned', () => {
    expect(
      toStatusView({
        attendance_status: 'on_break',
        queue_status: 'break',
        queue_status_mode: 'attendance_assisted',
        is_agent: true,
      }),
    ).toEqual({
      attendanceStatus: 'on_break',
      queueStatus: 'break',
      queueStatusMode: 'attendance_assisted',
      isAgent: true,
    });
  });
});
