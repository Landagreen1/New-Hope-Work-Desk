/**
 * Business-hours classification and the four after-hours dimensions.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 7.3, 7.5, 7.6, 7.8, 7.9, 8.1-8.6
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BUSINESS_HOURS,
  afterHoursDimensions,
  classifyInstant,
  isAfterHours,
  minutesFromClock,
  resolveBusinessDate,
} from '../definitions';
import {
  BUSINESS_HOURS_CASES,
  FIXTURE_SETTINGS,
  SUNDAY_OPEN_CASES,
  SUNDAY_OPEN_SETTINGS,
} from './business-hours.fixtures';

describe('classifyInstant', () => {
  for (const testCase of BUSINESS_HOURS_CASES) {
    it(testCase.name, () => {
      const result = classifyInstant(testCase.instant, FIXTURE_SETTINGS);
      expect({
        businessDate: result.businessDate,
        minuteOfDay: result.minuteOfDay,
        dayOfWeek: result.dayOfWeek,
        isSunday: result.isSunday,
        isWorkingDay: result.isWorkingDay,
        isBusinessHours: result.isBusinessHours,
        closureLabel: result.closureLabel,
        closureKind: result.closureKind,
      }).toEqual(testCase.expected);
    });
  }

  it('reports isAfterHours as the negation of isBusinessHours for every case', () => {
    for (const testCase of BUSINESS_HOURS_CASES) {
      const result = classifyInstant(testCase.instant, FIXTURE_SETTINGS);
      expect(result.isAfterHours).toBe(!result.isBusinessHours);
    }
  });

  it('accepts a Date and a millisecond value as well as an ISO string', () => {
    const iso = '2026-08-03T14:00:00Z';
    const fromString = classifyInstant(iso, FIXTURE_SETTINGS);
    const fromDate = classifyInstant(new Date(iso), FIXTURE_SETTINGS);
    const fromMillis = classifyInstant(new Date(iso).getTime(), FIXTURE_SETTINGS);
    expect(fromDate).toEqual(fromString);
    expect(fromMillis).toEqual(fromString);
  });

  it('refuses an invalid instant rather than classifying it silently', () => {
    expect(() => classifyInstant('not a date', FIXTURE_SETTINGS)).toThrow(
      /invalid instant/i,
    );
  });
});

describe('Sunday handling', () => {
  for (const testCase of SUNDAY_OPEN_CASES) {
    it(testCase.name, () => {
      const result = classifyInstant(testCase.instant, SUNDAY_OPEN_SETTINGS);
      expect({
        businessDate: result.businessDate,
        minuteOfDay: result.minuteOfDay,
        dayOfWeek: result.dayOfWeek,
        isSunday: result.isSunday,
        isWorkingDay: result.isWorkingDay,
        isBusinessHours: result.isBusinessHours,
        closureLabel: result.closureLabel,
        closureKind: result.closureKind,
      }).toEqual(testCase.expected);
    });
  }

  it('marks Sunday as Sunday whether or not it is a working day', () => {
    const closed = classifyInstant('2026-08-02T16:00:00Z', FIXTURE_SETTINGS);
    const open = classifyInstant('2026-08-02T16:00:00Z', SUNDAY_OPEN_SETTINGS);
    expect(closed.isSunday).toBe(true);
    expect(open.isSunday).toBe(true);
    expect(closed.isBusinessHours).toBe(false);
    expect(open.isBusinessHours).toBe(true);
  });

  it('keeps a closure after hours even when its weekday is a working day', () => {
    // 2026-09-07 is a Monday and a holiday.
    const holiday = classifyInstant('2026-09-07T16:00:00Z', SUNDAY_OPEN_SETTINGS);
    expect(holiday.dayOfWeek).toBe(1);
    expect(holiday.isWorkingDay).toBe(false);
    expect(holiday.isAfterHours).toBe(true);
  });
});

describe('seeded defaults', () => {
  it('reproduces the hard-coded window the current report uses', () => {
    // isAfterHours in work-desk-app.tsx: Mon-Sat, minutes < 510 or >= 1050.
    expect(DEFAULT_BUSINESS_HOURS.timeZone).toBe('America/New_York');
    expect(DEFAULT_BUSINESS_HOURS.sundayIsWorkingDay).toBe(false);
    expect(DEFAULT_BUSINESS_HOURS.closures).toHaveLength(0);
    for (const day of DEFAULT_BUSINESS_HOURS.days) {
      expect(minutesFromClock(day.opensAt)).toBe(510);
      expect(minutesFromClock(day.closesAt)).toBe(1050);
      expect(day.isWorkingDay).toBe(day.dayOfWeek !== 0);
    }
  });

  it('covers all seven weekdays exactly once', () => {
    const days = DEFAULT_BUSINESS_HOURS.days.map((day) => day.dayOfWeek).sort();
    expect(days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe('resolveBusinessDate', () => {
  it('returns the local calendar date, not the UTC date', () => {
    // 02:00 UTC on 4 August is 22:00 on 3 August in New York.
    expect(resolveBusinessDate('2026-08-04T02:00:00Z', 'America/New_York')).toBe(
      '2026-08-03',
    );
  });

  it('pads single-digit months and days', () => {
    expect(resolveBusinessDate('2026-01-05T17:00:00Z', 'America/New_York')).toBe(
      '2026-01-05',
    );
  });
});

describe('minutesFromClock', () => {
  it('reads an HH:MM wall clock', () => {
    expect(minutesFromClock('00:00')).toBe(0);
    expect(minutesFromClock('08:30')).toBe(510);
    expect(minutesFromClock('17:30')).toBe(1050);
    expect(minutesFromClock('23:59')).toBe(1439);
  });

  it('refuses a value that is not a wall clock', () => {
    expect(() => minutesFromClock('half past eight')).toThrow(/HH:MM/);
  });
});

describe('afterHoursDimensions', () => {
  const businessHoursInstant = '2026-08-03T14:00:00Z'; // Mon 10:00 EDT
  const afterHoursInstant = '2026-08-04T02:00:00Z'; // Mon 22:00 EDT
  const nextMorningInstant = '2026-08-04T13:30:00Z'; // Tue 09:30 EDT

  it('sets Received After Hours from the creation instant alone', () => {
    const flags = afterHoursDimensions({ createdAt: afterHoursInstant }, FIXTURE_SETTINGS);
    expect(flags.receivedAfterHours).toBe(true);
    expect(flags.workedAfterHours).toBe(false);
    expect(flags.finalizedAfterHours).toBe(false);
    expect(flags.manualEntryAfterHours).toBe(false);
  });

  it('does not treat a quote received after hours as worked after hours', () => {
    // Requirement 8.6. This is the defect in the current After Hours report: it
    // filters on creation only, so this quote is reported as after-hours activity
    // across every one of its metrics.
    const flags = afterHoursDimensions(
      { createdAt: afterHoursInstant, workEventAt: [nextMorningInstant] },
      FIXTURE_SETTINGS,
    );
    expect(flags.receivedAfterHours).toBe(true);
    expect(flags.workedAfterHours).toBe(false);
  });

  it('sets Worked After Hours when any single work event is after hours', () => {
    const flags = afterHoursDimensions(
      {
        createdAt: businessHoursInstant,
        workEventAt: [businessHoursInstant, nextMorningInstant, afterHoursInstant],
      },
      FIXTURE_SETTINGS,
    );
    expect(flags.receivedAfterHours).toBe(false);
    expect(flags.workedAfterHours).toBe(true);
  });

  it('sets Finalized After Hours independently of the other three', () => {
    const flags = afterHoursDimensions(
      {
        createdAt: businessHoursInstant,
        workEventAt: [businessHoursInstant],
        finalizedAt: afterHoursInstant,
      },
      FIXTURE_SETTINGS,
    );
    expect(flags.receivedAfterHours).toBe(false);
    expect(flags.workedAfterHours).toBe(false);
    expect(flags.finalizedAfterHours).toBe(true);
  });

  it('sets Manual Entry After Hours only for a manual record created after hours', () => {
    const manualAfter = afterHoursDimensions(
      { createdAt: afterHoursInstant, isManualEntry: true },
      FIXTURE_SETTINGS,
    );
    const manualDuring = afterHoursDimensions(
      { createdAt: businessHoursInstant, isManualEntry: true },
      FIXTURE_SETTINGS,
    );
    const queueAfter = afterHoursDimensions(
      { createdAt: afterHoursInstant, isManualEntry: false },
      FIXTURE_SETTINGS,
    );
    expect(manualAfter.manualEntryAfterHours).toBe(true);
    expect(manualDuring.manualEntryAfterHours).toBe(false);
    expect(queueAfter.manualEntryAfterHours).toBe(false);
  });

  it('leaves every dimension false for a quote wholly inside business hours', () => {
    const flags = afterHoursDimensions(
      {
        createdAt: businessHoursInstant,
        workEventAt: [businessHoursInstant],
        finalizedAt: businessHoursInstant,
        isManualEntry: true,
      },
      FIXTURE_SETTINGS,
    );
    expect(flags).toEqual({
      receivedAfterHours: false,
      workedAfterHours: false,
      finalizedAfterHours: false,
      manualEntryAfterHours: false,
    });
  });

  it('treats a holiday as after hours for all four dimensions', () => {
    const holidayMidday = '2026-09-07T16:00:00Z';
    const flags = afterHoursDimensions(
      {
        createdAt: holidayMidday,
        workEventAt: [holidayMidday],
        finalizedAt: holidayMidday,
        isManualEntry: true,
      },
      FIXTURE_SETTINGS,
    );
    expect(flags).toEqual({
      receivedAfterHours: true,
      workedAfterHours: true,
      finalizedAfterHours: true,
      manualEntryAfterHours: true,
    });
  });
});

describe('isAfterHours', () => {
  it('agrees with classifyInstant across the whole corpus', () => {
    for (const testCase of BUSINESS_HOURS_CASES) {
      expect(isAfterHours(testCase.instant, FIXTURE_SETTINGS)).toBe(
        !testCase.expected.isBusinessHours,
      );
    }
  });
});
