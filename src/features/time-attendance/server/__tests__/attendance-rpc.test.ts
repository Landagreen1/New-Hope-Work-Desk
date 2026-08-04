// src/features/time-attendance/server/__tests__/attendance-rpc.test.ts
// Which portion failed, and what a retry is answered with.
//
// Spec: .kiro/specs/attendance-queue-status-separation, task 9.4
// Requirements: 2.7, 2.10, 1.11
//
// Two route-side rules, both of them consequences of the same defect. The clock
// routes used to fire `set_my_availability` with a bare `await supabase.rpc(...)`
// and answer HTTP 200 whatever it returned, so a refusal was indistinguishable
// from a success; and they answered a retried clock-out with HTTP 400
// `Not clocked in.` for an action that had in fact happened, so a client could not
// tell "already applied" from "failed" either.
//
// Nothing here is mocked: `resolveFailedPortion`, `openedActionAnswer` and
// `closedActionAnswer` are the production functions the routes call, and they are
// pure.

import { describe, expect, it } from 'vitest';

import {
  QUEUE_PORTION_SQLSTATE,
  attendanceStatusOf,
  closedActionAnswer,
  openedActionAnswer,
  resolveFailedPortion,
  type AttendanceRpcPayload,
} from '../attendance-rpc';

describe('resolveFailedPortion (2.7)', () => {
  it('names the queue portion from the SQLSTATE the wrapper raises', () => {
    // The four attendance functions wrap every `apply_queue_status` call and
    // re-raise under this code, so the portion is carried rather than guessed.
    expect(
      resolveFailedPortion({
        code: QUEUE_PORTION_SQLSTATE,
        message: 'queue_status: Agent permission required',
      }),
    ).toBe('queue_status');
  });

  it('names the queue portion from the message prefix alone', () => {
    expect(resolveFailedPortion({ code: 'P0001', message: 'queue_status: lock timeout' })).toBe(
      'queue_status',
    );
  });

  it('names the queue portion for the raises that belong to the availability path', () => {
    for (const message of [
      'Agent permission required',
      'could not obtain lock on rotation_state',
      'availability could not be written',
      'queue status is not valid',
    ]) {
      expect(resolveFailedPortion({ code: 'P0001', message })).toBe('queue_status');
    }
  });

  it('names the queue portion for a lock or serialization failure', () => {
    // Inside these functions the only `for update` walk that contends across
    // sessions is the rotation walk: the attendance rows are locked per employee,
    // and a second request from the same employee is answered with
    // `already_applied` rather than by raising.
    for (const code of ['55P03', '40001', '40P01']) {
      expect(resolveFailedPortion({ code, message: 'canceled statement' })).toBe('queue_status');
    }
  });

  it('names the attendance portion for an attendance failure', () => {
    for (const error of [
      { code: 'P0001', message: 'Not clocked in.' },
      { code: 'P0001', message: 'Invalid break type.' },
      { code: '23505', message: 'duplicate key value violates unique constraint' },
    ]) {
      expect(resolveFailedPortion(error)).toBe('attendance');
    }
  });

  it('falls back to the attendance portion for an unmapped failure', () => {
    // The attendance change is applied first and is the only portion all four
    // functions perform, so an error carrying nothing that identifies it is
    // reported against the portion that was certainly attempted. Naming
    // `queue_status` would tell the reader their punch was recorded when it may
    // not have been.
    expect(resolveFailedPortion({ code: 'XX000', message: 'internal error' })).toBe('attendance');
    expect(resolveFailedPortion({})).toBe('attendance');
    expect(resolveFailedPortion(null)).toBe('attendance');
    expect(resolveFailedPortion(undefined)).toBe('attendance');
  });
});

describe('attendanceStatusOf', () => {
  const entry = { id: 'e1', clock_in: '2026-08-04T13:00:00Z', clock_status: 'available', break_minutes: 0 };
  const openBreak = { id: 'b1', break_start: '2026-08-04T17:00:00Z', break_type: 'lunch' };

  it('derives the three attendance states from the two rows that decide them', () => {
    expect(attendanceStatusOf(null, null)).toBe('clocked_out');
    expect(attendanceStatusOf(entry, null)).toBe('working');
    expect(attendanceStatusOf(entry, openBreak)).toBe('on_break');
  });
});

function payload(overrides: Partial<AttendanceRpcPayload> = {}): AttendanceRpcPayload {
  return {
    attendance_status: 'working',
    queue_status: 'available',
    queue_status_mode: 'attendance_assisted',
    is_agent: true,
    entry: {
      id: 'e1',
      clock_in: '2026-08-04T13:00:00Z',
      clock_out: null,
      clock_status: 'available',
      break_minutes: 0,
      total_hours: null,
    },
    break: null,
    total_hours: null,
    already_applied: false,
    already_open: false,
    changed_queue: false,
    offers_join_sales_queues: false,
    ...overrides,
  };
}

describe('openedActionAnswer: clock-in and break-start (3.13)', () => {
  it('answers a new clock-in 201 with both statuses', () => {
    const answer = openedActionAnswer(payload({ queue_status: 'unavailable', offers_join_sales_queues: true }), 'entry');

    expect(answer.status).toBe(201);
    expect(answer.body.already_open).toBe(false);
    expect(answer.body.attendance_status).toBe('working');
    expect(answer.body.queue_status).toBe('unavailable');
    expect(answer.body.offers_join_sales_queues).toBe(true);
    expect(answer.body.error).toBeUndefined();
  });

  it('answers the loser of a clock-in race 200 with the open entry it lost to', () => {
    const answer = openedActionAnswer(payload({ already_open: true }), 'entry');

    expect(answer.status).toBe(200);
    expect(answer.body.already_open).toBe(true);
    expect(answer.body.entry).toEqual(payload().entry);
    expect(answer.body.error).toBeUndefined();
  });

  it('answers a break start with the break row rather than the entry', () => {
    const openBreak = { id: 'b1', break_start: '2026-08-04T17:00:00Z', break_type: 'lunch' };
    const answer = openedActionAnswer(payload({ break: openBreak, attendance_status: 'on_break' }), 'break');

    expect(answer.status).toBe(201);
    expect(answer.body.break).toEqual(openBreak);
    expect(answer.body.entry).toBeUndefined();
  });

  it('reports that no queue call was made for a non-agent, rather than an unqualified success', () => {
    // 2.7, 2.8. `set_my_availability` requires `is_agent()`, so every non-agent
    // break used to raise inside Postgres while the route answered 201 with
    // nothing said about it. Now no call is made and the answer says so.
    const answer = openedActionAnswer(
      payload({ is_agent: false, queue_status: 'unavailable', changed_queue: false }),
      'break',
    );

    expect(answer.body.changed_queue).toBe(false);
    expect(answer.body.is_agent).toBe(false);
    expect(answer.body.queue_status).toBe('unavailable');
  });
});

describe('closedActionAnswer: clock-out and break-end (2.10, 1.11)', () => {
  it('answers a clock-out 200 with the figures and both statuses', () => {
    const answer = closedActionAnswer(
      payload({
        attendance_status: 'clocked_out',
        queue_status: 'unavailable',
        changed_queue: true,
        total_hours: 7.5,
      }),
      { total_hours: 7.5 },
    );

    expect(answer.status).toBe(200);
    expect(answer.body.success).toBe(true);
    expect(answer.body.total_hours).toBe(7.5);
    expect(answer.body.attendance_status).toBe('clocked_out');
    expect(answer.body.queue_status).toBe('unavailable');
    expect(answer.body.changed_queue).toBe(true);
    expect(answer.body.already_applied).toBe(false);
  });

  it('answers a retried clock-out with the committed state, not an error', () => {
    // Today's behavior before the fix: HTTP 400 `Not clocked in.` for an action
    // that had already been applied.
    const answer = closedActionAnswer(
      payload({
        attendance_status: 'clocked_out',
        queue_status: 'unavailable',
        already_applied: true,
        changed_queue: false,
      }),
      { total_hours: 7.5 },
    );

    expect(answer.status).toBe(200);
    expect(answer.body.error).toBeUndefined();
    expect(answer.body.already_applied).toBe(true);
    expect(answer.body.attendance_status).toBe('clocked_out');
    expect(answer.body.queue_status).toBe('unavailable');
    // The losing request performs no second transition and no second handoff.
    expect(answer.body.changed_queue).toBe(false);
  });

  it('answers a retried break-end with the committed state, not an error', () => {
    // Before the fix: HTTP 400 `No active break to end.`.
    const answer = closedActionAnswer(
      payload({ attendance_status: 'working', already_applied: true }),
      { duration_minutes: null },
    );

    expect(answer.status).toBe(200);
    expect(answer.body.error).toBeUndefined();
    expect(answer.body.already_applied).toBe(true);
    expect(answer.body.attendance_status).toBe('working');
    expect(answer.body.duration_minutes).toBeNull();
  });

  it('never answers a closing action with anything but 200', () => {
    for (const already_applied of [true, false]) {
      for (const attendance_status of ['clocked_out', 'working', 'on_break'] as const) {
        expect(closedActionAnswer(payload({ already_applied, attendance_status })).status).toBe(200);
      }
    }
  });
});
