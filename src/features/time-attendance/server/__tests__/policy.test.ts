// Example tests for the policy and staffing-threshold loaders.
//
// Feature: time-attendance-ui-redesign, task 2.3
//
// These exercise the pure mapping the loaders are built on, using row shapes as
// they actually arrive from `attendance_policy` and `staffing_thresholds`. What
// is asserted is that a well-formed row is carried through unchanged, that one
// unreadable column costs that column alone rather than the whole policy, and
// that an unconfigured staffing slot answers null so the coverage rules can
// report it as unconfigured rather than as a shortfall.
//
// Requirements: 3.7, 3.10, 3.12, 6.3, 6.4

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTENDANCE_POLICY,
  buildStaffingThresholdTable,
  toAttendancePolicy,
} from '../policy';

describe('toAttendancePolicy', () => {
  it('maps a well-formed singleton row', () => {
    expect(
      toAttendancePolicy({
        business_timezone: 'America/Guayaquil',
        grace_period_minutes: 7,
        early_departure_tolerance_minutes: 20,
        missing_clock_out_tolerance_minutes: 90,
        break_overrun_minutes: 45,
        unpaid_break_types: ['lunch', 'personal'],
      }),
    ).toEqual({
      businessTimezone: 'America/Guayaquil',
      gracePeriodMinutes: 7,
      earlyDepartureToleranceMinutes: 20,
      missingClockOutToleranceMinutes: 90,
      breakOverrunMinutes: 45,
      unpaidBreakTypes: ['lunch', 'personal'],
    });
  });

  it('returns the documented defaults when the singleton is missing', () => {
    expect(toAttendancePolicy(null)).toEqual(DEFAULT_ATTENDANCE_POLICY);
  });

  it('falls back per field, keeping the readable columns', () => {
    const policy = toAttendancePolicy({
      business_timezone: 'Mars/Olympus_Mons',
      grace_period_minutes: -5,
      early_departure_tolerance_minutes: 20,
      missing_clock_out_tolerance_minutes: 'not a number',
      break_overrun_minutes: null,
      unpaid_break_types: 'lunch',
    });

    expect(policy.businessTimezone).toBe(DEFAULT_ATTENDANCE_POLICY.businessTimezone);
    expect(policy.gracePeriodMinutes).toBe(DEFAULT_ATTENDANCE_POLICY.gracePeriodMinutes);
    expect(policy.missingClockOutToleranceMinutes).toBe(
      DEFAULT_ATTENDANCE_POLICY.missingClockOutToleranceMinutes,
    );
    expect(policy.breakOverrunMinutes).toBe(DEFAULT_ATTENDANCE_POLICY.breakOverrunMinutes);
    expect(policy.unpaidBreakTypes).toEqual(DEFAULT_ATTENDANCE_POLICY.unpaidBreakTypes);
    // The one readable column survives the four unreadable ones.
    expect(policy.earlyDepartureToleranceMinutes).toBe(20);
  });

  it('reads numeric columns delivered as strings', () => {
    // A `numeric` column or a driver quirk can deliver a count as a string, and
    // the derivation's arithmetic would turn that into NaN.
    expect(toAttendancePolicy({ grace_period_minutes: '12' }).gracePeriodMinutes).toBe(12);
  });

  it('drops unrecognised break types and de-duplicates the rest', () => {
    expect(
      toAttendancePolicy({ unpaid_break_types: ['lunch', 'siesta', 'lunch', 'short'] })
        .unpaidBreakTypes,
    ).toEqual(['lunch', 'short']);
  });

  it('honours an empty array as every break being paid', () => {
    expect(toAttendancePolicy({ unpaid_break_types: [] }).unpaidBreakTypes).toEqual([]);
  });

  it('produces a policy the derivation accepts', () => {
    // `domain/attendance.ts` throws for a malformed policy, so the loader's
    // contract is that it never produces one, even from an entirely empty row.
    const policy = toAttendancePolicy({});
    expect(policy.businessTimezone.length).toBeGreaterThan(0);
    expect(Array.isArray(policy.unpaidBreakTypes)).toBe(true);
    for (const minutes of [
      policy.gracePeriodMinutes,
      policy.earlyDepartureToleranceMinutes,
      policy.missingClockOutToleranceMinutes,
      policy.breakOverrunMinutes,
    ]) {
      expect(Number.isFinite(minutes)).toBe(true);
      expect(minutes).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildStaffingThresholdTable', () => {
  it('looks up a configured slot exactly', () => {
    const table = buildStaffingThresholdTable([
      {
        department: 'sales',
        day_of_week: 1,
        time_slot: 'morning',
        minimum_staff: 3,
        warning_threshold: 4,
      },
    ]);

    expect(table.size).toBe(1);
    expect(table.thresholdFor('sales', 1, 'morning')).toEqual({
      minimumStaff: 3,
      warningThreshold: 4,
    });
    // A different day, slot, or department is a different slot, not a fallback.
    expect(table.thresholdFor('sales', 2, 'morning')).toBeNull();
    expect(table.thresholdFor('sales', 1, 'full_day')).toBeNull();
    expect(table.thresholdFor('commercial', 1, 'morning')).toBeNull();
  });

  it('reports every slot as unconfigured when nothing is seeded', () => {
    // The current state, and the one Open Question 3 defers: no rows, so every
    // lookup answers null and coverage reports required as unconfigured.
    const table = buildStaffingThresholdTable([]);
    expect(table.size).toBe(0);
    expect(table.thresholdFor('customer_service', 0, 'full_day')).toBeNull();
    expect(buildStaffingThresholdTable(null).thresholdFor('sales', 3, 'afternoon')).toBeNull();
  });

  it('keeps a warning threshold below the minimum', () => {
    // A collapsed warning band is a configuration the ordered comparison in
    // domain/coverage.ts has to survive, so the loader must not normalise it.
    const table = buildStaffingThresholdTable([
      {
        department: 'management',
        day_of_week: 6,
        time_slot: 'full_day',
        minimum_staff: 4,
        warning_threshold: 1,
      },
    ]);

    expect(table.thresholdFor('management', 6, 'full_day')).toEqual({
      minimumStaff: 4,
      warningThreshold: 1,
    });
  });

  it('drops rows that cannot describe a slot', () => {
    const table = buildStaffingThresholdTable([
      { department: 'accounting', day_of_week: 1, time_slot: 'morning', minimum_staff: 1, warning_threshold: 2 },
      { department: 'sales', day_of_week: 7, time_slot: 'morning', minimum_staff: 1, warning_threshold: 2 },
      { department: 'sales', day_of_week: 1, time_slot: 'graveyard', minimum_staff: 1, warning_threshold: 2 },
      { department: 'sales', day_of_week: 1, time_slot: 'morning', minimum_staff: null, warning_threshold: 2 },
      { department: 'sales', day_of_week: 1, time_slot: 'afternoon', minimum_staff: 2, warning_threshold: 3 },
    ]);

    expect(table.size).toBe(1);
    expect(table.thresholdFor('sales', 1, 'afternoon')).toEqual({
      minimumStaff: 2,
      warningThreshold: 3,
    });
  });
});
