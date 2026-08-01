// src/features/time-attendance/domain/__tests__/attendance-payroll-blocking.test.ts
// Property test for which records hold payroll.
//
// Requirement 12, criterion 8 names two conditions and no others: a missing
// clock-out, and a missing clock-in on a date carrying a published schedule.
// Unscheduled work is informational only and never blocks payroll.
// "Exactly when" is the whole content of the property — a third condition
// creeping in would hold pay for a day that should have been paid, and a missing
// one would pay a day nobody has checked.
//
// The expected value is computed from the exception codes on the record and the
// input facts the classification consults, so the rule table is not asked
// whether it agrees with itself.
//
// Feature: time-attendance-ui-redesign, Property 9: Payroll-blocking classification
// **Validates: Requirements 12.8**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildEvaluationContext, isPayrollBlocking, recordFromContext } from '../attendance';
import type { ExceptionCode } from '../types';
import { attendanceInputsArb } from './arbitraries';

describe('PBT-9: Payroll-blocking classification', () => {
  it('holds payroll exactly for a missing clock-out and a missing clock-in on a published schedule', () => {
    let blockingCases = 0;
    let nonBlockingCases = 0;

    fc.assert(
      fc.property(attendanceInputsArb, (inputs) => {
        const ctx = buildEvaluationContext(inputs);
        const record = recordFromContext(ctx);
        const codes: readonly ExceptionCode[] = record.exceptions.map(
          (exception) => exception.code,
        );

        // The input fact the classification depends on, read from the
        // inputs rather than from the context the rules were evaluated against.
        const publishedSchedule = inputs.schedule !== null && inputs.schedule.status === 'published';

        const missingClockOut = codes.includes('missing_clock_out');
        const missingClockInOnSchedule = codes.includes('missing_clock_in') && publishedSchedule;

        const expected = missingClockOut || missingClockInOnSchedule;
        expect(record.payrollBlocking).toBe(expected);

        // Per exception, the same two conditions and no others.
        for (const exception of record.exceptions) {
          const expectedForException =
            exception.code === 'missing_clock_out'
              ? true
              : exception.code === 'missing_clock_in'
                ? publishedSchedule
                : false;
          expect(exception.payrollBlocking).toBe(expectedForException);
        }

        // The record-level flag is the disjunction of the exception flags, so the
        // flag and the exceptions listed beside it cannot disagree.
        expect(isPayrollBlocking(record.exceptions)).toBe(record.payrollBlocking);

        if (record.payrollBlocking) blockingCases += 1;
        else nonBlockingCases += 1;
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: both classifications must occur.
    expect(blockingCases).toBeGreaterThan(0);
    expect(nonBlockingCases).toBeGreaterThan(0);
  });
});
