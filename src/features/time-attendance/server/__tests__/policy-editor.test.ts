// src/features/time-attendance/server/__tests__/policy-editor.test.ts
// What the attendance-policy editor's write path decides without a database.
//
// Feature: time-attendance-ui-redesign, task 22.4
//
// `saveAttendancePolicy` is one statement against `attendance_policy`, so what is
// worth asserting here is everything around it: which columns an update assigns,
// that a field nobody sent is not assigned at all, that the break-type list a
// caller may send is exactly the list the loader reads back, and that a write
// failure reaches a screen as the failure it is. The upsert itself, and the row
// level security that reserves it to `super_admin`, are integration concerns.
//
// Nothing is mocked. The readers, the mapping, and the failure contract are the
// real ones.
//
// Requirements: 2.3, 3.10, 3.12, 21.6, 22.16

import { describe, expect, it } from 'vitest';

import { ApiRequestError, serviceFailure } from '../api-response';
import {
  KNOWN_BREAK_TYPES,
  POLICY_UNWRITABLE_MESSAGE,
  PolicyServiceError,
  policyUpdateColumns,
  toAttendancePolicy,
} from '../policy';
import { optionalChoiceList, type JsonBody } from '../request-body';

/** The `ApiRequestError` a read threw, or a failure if it did not throw. */
function rejection(read: () => unknown): ApiRequestError {
  try {
    read();
  } catch (error) {
    if (error instanceof ApiRequestError) return error;
    throw error;
  }
  throw new Error('expected the read to be rejected');
}

describe('the unpaid-break-type list a caller may send', () => {
  it('accepts the three types the loader reads back', () => {
    const body: JsonBody = { unpaid_break_types: ['lunch', 'personal'] };
    expect(optionalChoiceList(body, 'unpaid_break_types', KNOWN_BREAK_TYPES)).toEqual([
      'lunch',
      'personal',
    ]);
  });

  it('refuses a type the loader would drop, naming its position', () => {
    // A stored name the loader drops is an unpaid break type that matches no break,
    // which quietly stops deducting lunch (Requirement 3, criterion 10).
    const failure = rejection(() =>
      optionalChoiceList({ unpaid_break_types: ['lunch', 'siesta'] }, 'unpaid_break_types', KNOWN_BREAK_TYPES),
    );

    expect(failure.code).toBe('invalid_parameter');
    expect(failure.field).toBe('unpaid_break_types[1]');
    expect(failure.message).toContain('siesta');
  });

  it('keeps an empty list as every break being paid', () => {
    // Different from an absent field, which leaves the stored list alone.
    expect(optionalChoiceList({ unpaid_break_types: [] }, 'unpaid_break_types', KNOWN_BREAK_TYPES)).toEqual([]);
    expect(optionalChoiceList({}, 'unpaid_break_types', KNOWN_BREAK_TYPES)).toBeUndefined();
  });

  it('refuses a value that is not a list at all', () => {
    expect(
      rejection(() => optionalChoiceList({ unpaid_break_types: 'lunch' }, 'unpaid_break_types', KNOWN_BREAK_TYPES)).field,
    ).toBe('unpaid_break_types');
  });
});

describe('policyUpdateColumns', () => {
  it('assigns the columns the migration declares', () => {
    expect(
      policyUpdateColumns({
        gracePeriodMinutes: 7,
        earlyDepartureToleranceMinutes: 20,
        missingClockOutToleranceMinutes: 90,
        breakOverrunMinutes: 45,
        unpaidBreakTypes: ['lunch', 'short'],
      }),
    ).toEqual({
      grace_period_minutes: 7,
      early_departure_tolerance_minutes: 20,
      missing_clock_out_tolerance_minutes: 90,
      break_overrun_minutes: 45,
      unpaid_break_types: ['lunch', 'short'],
    });
  });

  it('assigns nothing for a field nobody sent', () => {
    // The upsert assigns only the columns in the payload, so an absent field is
    // what keeps a second administrator's tolerance from being overwritten.
    expect(policyUpdateColumns({ gracePeriodMinutes: 0 })).toEqual({ grace_period_minutes: 0 });
    expect(policyUpdateColumns({})).toEqual({});
  });

  it('stores zero rather than reading it as absent', () => {
    // A zero grace period is a policy: every late clock-in is late.
    expect(Object.hasOwn(policyUpdateColumns({ breakOverrunMinutes: 0 }), 'break_overrun_minutes')).toBe(true);
  });

  it('de-duplicates the break types it stores', () => {
    expect(
      policyUpdateColumns({ unpaidBreakTypes: ['lunch', 'lunch', 'short'] }).unpaid_break_types,
    ).toEqual(['lunch', 'short']);
  });

  it('stores a list the loader reads back unchanged', () => {
    // The round trip that matters: what the editor saves is what every screen then
    // derives from.
    const columns = policyUpdateColumns({
      gracePeriodMinutes: 12,
      unpaidBreakTypes: ['personal', 'lunch'],
    });

    const policy = toAttendancePolicy({
      grace_period_minutes: columns.grace_period_minutes,
      unpaid_break_types: columns.unpaid_break_types,
    });

    expect(policy.gracePeriodMinutes).toBe(12);
    expect(policy.unpaidBreakTypes).toEqual(['personal', 'lunch']);
  });
});

describe('a policy write that failed', () => {
  it('reaches the screen as a retryable failure stating nothing was changed', async () => {
    const response = serviceFailure(
      new PolicyServiceError('write_failed', POLICY_UNWRITABLE_MESSAGE),
      'write_failed',
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.code).toBe('write_failed');
    expect(body.error).toBe(POLICY_UNWRITABLE_MESSAGE);
  });

  it('reports a read failure as a read failure, not as an empty policy', () => {
    // `loadAttendancePolicy` answers a failed read with the defaults so a screen
    // can render; the editor's read must not, because its next act is a write.
    const response = serviceFailure(new PolicyServiceError('read_failed', 'unreadable'));
    expect(response.status).toBe(500);
  });
});
