// src/features/time-attendance/domain/__tests__/attendance-status-totality.test.ts
// Property test for status assignment across a whole derived range.
//
// Four separate claims live in this one property because they are four readings
// of the same output: the range has one record per employee and date, each
// record's status is one of the twelve with the rule that assigned it named, no
// rule ahead of that one in the matrix holds, and the whole derivation is a
// function of its inputs.
//
// The twelve-value set is written out here rather than read off `STATUS_RULES`.
// Reading the set from the table under test would accept whatever the table
// happened to contain, which is the one thing this property is meant to catch.
//
// The precedence claim is why `anySessionSetArb` is the session generator:
// overlaps and inverted sessions make `hasInconsistentData` true, and each of
// rules 1 through 11 carries consistency as its first conjunct, so an
// inconsistent record fails all eleven and falls through to rule 12. That is
// how rule 12's "or the recorded data is internally inconsistent" clause is
// expressed without disturbing the matrix order, and it is exactly the case
// where a reordered implementation would break this property.
//
// Feature: time-attendance-ui-redesign, Property 1: Status totality, precedence, and determinism
// **Validates: Requirements 3.1, 3.3, 3.4, 3.5**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  STATUS_RULES,
  assignStatus,
  buildEvaluationContext,
  collapseAttendanceInputs,
  deriveRange,
  recordKey,
  recordRowKey,
} from '../attendance';
import type { DailyAttendanceRecord, DerivedStatus } from '../types';
import { attendanceInputsSetArb } from './arbitraries';

/** The twelve values Requirement 3, criterion 4 names, transcribed from it. */
const DERIVED_STATUSES = [
  'scheduled',
  'working',
  'on_break',
  'completed',
  'late',
  'absent',
  'approved_time_off',
  'clocked_in_unscheduled',
  'left_early',
  'missing_clock_in',
  'missing_clock_out',
  'needs_review',
] as const satisfies readonly DerivedStatus[];

/** The fields Requirement 3, criterion 3 requires every record to expose. */
const RECORD_FIELDS = [
  'profileId',
  'workDate',
  'scheduledStart',
  'scheduledEnd',
  'scheduledHours',
  'firstClockIn',
  'lastClockOut',
  'hasOpenSession',
  'workedHours',
  'paidBreakMinutes',
  'unpaidBreakMinutes',
  'lateMinutes',
  'earlyDepartureMinutes',
  'derivedStatus',
  'statusRuleId',
  'exceptions',
  'payrollBlocking',
  'reviewedAt',
  'sessions',
] as const satisfies readonly (keyof DailyAttendanceRecord)[];

const NUMERIC_RECORD_FIELDS = [
  'scheduledHours',
  'workedHours',
  'paidBreakMinutes',
  'unpaidBreakMinutes',
  'lateMinutes',
  'earlyDepartureMinutes',
] as const satisfies readonly (keyof DailyAttendanceRecord)[];

describe('PBT-1: Status totality, precedence, and determinism', () => {
  it('assigns exactly one of the twelve statuses per employee and date, ahead of no earlier rule, deterministically', () => {
    // The matrix is data, so its shape is part of the guarantee: twelve rows in
    // the order Requirement 3, criterion 5 states, with distinct rule ids.
    expect(STATUS_RULES).toHaveLength(12);
    expect(STATUS_RULES.map((rule) => rule.order)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(new Set(STATUS_RULES.map((rule) => rule.id)).size).toBe(12);

    const assignedStatuses = new Set<DerivedStatus>();

    fc.assert(
      fc.property(attendanceInputsSetArb, (inputs) => {
        const records = deriveRange(inputs);
        const collapsed = collapseAttendanceInputs(inputs);

        // At most one record per employee and work date (Requirement 3.1).
        expect(records).toHaveLength(collapsed.length);
        expect(new Set(records.map(recordRowKey)).size).toBe(records.length);

        records.forEach((record, index) => {
          const row = collapsed[index];
          expect(recordRowKey(record)).toBe(recordKey(row.profileId, row.workDate));

          const ctx = buildEvaluationContext(row);
          const rule = assignStatus(ctx);
          assignedStatuses.add(record.derivedStatus);

          // One status from the twelve-value set, with the rule that assigned it.
          expect(DERIVED_STATUSES).toContain(record.derivedStatus);
          expect(record.statusRuleId).toBe(rule.id);
          expect(record.derivedStatus).toBe(rule.status);

          // No rule earlier in the matrix holds for this record.
          for (const earlier of STATUS_RULES) {
            if (earlier.order >= rule.order) continue;
            expect(earlier.holds(ctx)).toBe(false);
          }

          // Every declared field is defined; null is a value, undefined is not.
          for (const field of RECORD_FIELDS) {
            expect(record[field]).toBeDefined();
          }
          for (const field of NUMERIC_RECORD_FIELDS) {
            expect(Number.isFinite(record[field])).toBe(true);
          }
          expect(Array.isArray(record.exceptions)).toBe(true);
          expect(Array.isArray(record.sessions)).toBe(true);
        });

        // The same inputs twice produce identical records.
        expect(deriveRange(inputs)).toStrictEqual(records);
      }),
      { numRuns: 100 },
    );

    // Guard against a vacuous pass: a run that only ever produced one status
    // would satisfy every clause above without testing precedence at all.
    expect(assignedStatuses.size).toBeGreaterThanOrEqual(3);
  });
});
