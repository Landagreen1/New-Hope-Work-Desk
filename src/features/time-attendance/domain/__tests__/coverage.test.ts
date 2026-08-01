// src/features/time-attendance/domain/__tests__/coverage.test.ts
// Example tests for the threshold comparison and the interval partition.
//
// Feature: time-attendance-ui-redesign, task 4.1
//
// One case per row of the Requirement 6 matrix, the degenerate threshold the
// database permits, and the window shapes the partition has to survive:
// overlapping, nested, identical, and a gap between blocks. The universal
// statements — the classification matrix with severity monotonicity, and the
// partition invariants — are covered by Properties 10 and 14.
//
// Requirements: 6.4, 6.9, 6.10, 6.11, 6.12, 8.9, 8.10, 8.11

import { describe, expect, it } from 'vitest';
import {
  COVERAGE_SEVERITY,
  buildCoverageIntervals,
  classifyCoverage,
  type CoverageStatus,
  type ShiftWindow,
} from '../coverage';
import type { Threshold } from '../types';

/** 2026-07-28 is a summer weekday, so New York is UTC-4 that day. */
const WORK_DATE = '2026-07-28';

function eastern(time: string, date = WORK_DATE): Date {
  return new Date(`${date}T${time}-04:00`);
}

function shift(profileId: string, start: string, end: string): ShiftWindow {
  return { profileId, start: eastern(start), end: eastern(end) };
}

const NOBODY_ABSENT: ReadonlySet<string> = new Set<string>();

/** Interval shape the assertions read, times as Eastern wall clocks. */
function summarise(intervals: ReturnType<typeof buildCoverageIntervals>) {
  return intervals.map((interval) => ({
    start: interval.start,
    end: interval.end,
    availableStaff: interval.availableStaff,
    profileIds: interval.profileIds,
  }));
}

describe('classifyCoverage', () => {
  const threshold: Threshold = { minimumStaff: 3, warningThreshold: 5 };

  it('reports an unconfigured slot as healthy rather than critical', () => {
    expect(classifyCoverage(0, null)).toBe('healthy');
    expect(classifyCoverage(7, null)).toBe('healthy');
  });

  it('assigns critical below the minimum', () => {
    expect(classifyCoverage(0, threshold)).toBe('critical');
    expect(classifyCoverage(2, threshold)).toBe('critical');
  });

  it('assigns at_minimum exactly at the minimum', () => {
    expect(classifyCoverage(3, threshold)).toBe('at_minimum');
  });

  it('assigns warning above the minimum and at or below the warning threshold', () => {
    expect(classifyCoverage(4, threshold)).toBe('warning');
    expect(classifyCoverage(5, threshold)).toBe('warning');
  });

  it('assigns healthy above the warning threshold', () => {
    expect(classifyCoverage(6, threshold)).toBe('healthy');
  });

  it('collapses the warning band when the warning threshold is below the minimum', () => {
    const degenerate: Threshold = { minimumStaff: 5, warningThreshold: 3 };

    expect(classifyCoverage(4, degenerate)).toBe('critical');
    expect(classifyCoverage(5, degenerate)).toBe('at_minimum');
    expect(classifyCoverage(6, degenerate)).toBe('healthy');
  });

  it('never improves as available staffing falls', () => {
    const degenerate: Threshold = { minimumStaff: 5, warningThreshold: 3 };

    for (const pair of [threshold, degenerate]) {
      let previous: CoverageStatus = classifyCoverage(12, pair);
      for (let available = 11; available >= 0; available -= 1) {
        const current = classifyCoverage(available, pair);
        expect(COVERAGE_SEVERITY[current]).toBeGreaterThanOrEqual(COVERAGE_SEVERITY[previous]);
        previous = current;
      }
    }
  });

  it('orders severity critical worst, then at_minimum, then warning, then healthy', () => {
    expect(COVERAGE_SEVERITY.critical).toBeGreaterThan(COVERAGE_SEVERITY.at_minimum);
    expect(COVERAGE_SEVERITY.at_minimum).toBeGreaterThan(COVERAGE_SEVERITY.warning);
    expect(COVERAGE_SEVERITY.warning).toBeGreaterThan(COVERAGE_SEVERITY.healthy);
  });
});

describe('buildCoverageIntervals', () => {
  it('returns no intervals for no shifts', () => {
    expect(buildCoverageIntervals([], NOBODY_ABSENT)).toEqual([]);
  });

  it('returns one interval spanning a single shift', () => {
    const intervals = buildCoverageIntervals([shift('a', '09:00', '17:00')], NOBODY_ABSENT);

    expect(summarise(intervals)).toEqual([
      {
        start: eastern('09:00').toISOString(),
        end: eastern('17:00').toISOString(),
        availableStaff: 1,
        profileIds: ['a'],
      },
    ]);
  });

  it('splits overlapping shifts at every distinct boundary', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '09:00', '15:00'), shift('b', '12:00', '17:00')],
      NOBODY_ABSENT,
    );

    expect(summarise(intervals)).toEqual([
      { start: eastern('09:00').toISOString(), end: eastern('12:00').toISOString(), availableStaff: 1, profileIds: ['a'] },
      { start: eastern('12:00').toISOString(), end: eastern('15:00').toISOString(), availableStaff: 2, profileIds: ['a', 'b'] },
      { start: eastern('15:00').toISOString(), end: eastern('17:00').toISOString(), availableStaff: 1, profileIds: ['b'] },
    ]);
  });

  it('splits a nested shift into three intervals', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '08:00', '18:00'), shift('b', '12:00', '13:00')],
      NOBODY_ABSENT,
    );

    expect(intervals.map((i) => [i.start, i.end, i.availableStaff])).toEqual([
      [eastern('08:00').toISOString(), eastern('12:00').toISOString(), 1],
      [eastern('12:00').toISOString(), eastern('13:00').toISOString(), 2],
      [eastern('13:00').toISOString(), eastern('18:00').toISOString(), 1],
    ]);
  });

  it('counts identical shifts in one interval', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '09:00', '17:00'), shift('b', '09:00', '17:00')],
      NOBODY_ABSENT,
    );

    expect(summarise(intervals)).toEqual([
      {
        start: eastern('09:00').toISOString(),
        end: eastern('17:00').toISOString(),
        availableStaff: 2,
        profileIds: ['a', 'b'],
      },
    ]);
  });

  it('drops the gap between two blocks of activity', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '08:00', '11:00'), shift('b', '14:00', '17:00')],
      NOBODY_ABSENT,
    );

    expect(summarise(intervals)).toEqual([
      { start: eastern('08:00').toISOString(), end: eastern('11:00').toISOString(), availableStaff: 1, profileIds: ['a'] },
      { start: eastern('14:00').toISOString(), end: eastern('17:00').toISOString(), availableStaff: 1, profileIds: ['b'] },
    ]);
  });

  it('counts a split shift for the same employee once', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '09:00', '14:00'), shift('a', '12:00', '17:00')],
      NOBODY_ABSENT,
    );

    expect(intervals.map((i) => i.availableStaff)).toEqual([1, 1, 1]);
    expect(intervals.every((i) => i.profileIds.length === i.availableStaff)).toBe(true);
  });

  it('excludes an absent employee from the counts while keeping their boundaries', () => {
    const shifts = [shift('a', '08:00', '18:00'), shift('b', '12:00', '13:00')];

    const present = buildCoverageIntervals(shifts, NOBODY_ABSENT);
    const withAbsence = buildCoverageIntervals(shifts, new Set(['b']));

    expect(withAbsence.map((i) => [i.start, i.end])).toEqual(present.map((i) => [i.start, i.end]));
    expect(withAbsence.map((i) => i.availableStaff)).toEqual([1, 1, 1]);
    expect(withAbsence.every((i) => !i.profileIds.includes('b'))).toBe(true);
  });

  it('returns no intervals when every scheduled employee is absent', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '09:00', '17:00'), shift('b', '10:00', '16:00')],
      new Set(['a', 'b']),
    );

    expect(intervals).toEqual([]);
  });

  it('ignores a shift that covers no time', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '09:00', '17:00'), shift('b', '13:00', '13:00')],
      NOBODY_ABSENT,
    );

    expect(summarise(intervals)).toEqual([
      {
        start: eastern('09:00').toISOString(),
        end: eastern('17:00').toISOString(),
        availableStaff: 1,
        profileIds: ['a'],
      },
    ]);
  });

  it('reports required staffing as unconfigured and healthy without a threshold', () => {
    const intervals = buildCoverageIntervals([shift('a', '09:00', '17:00')], NOBODY_ABSENT);

    expect(intervals[0].requiredStaff).toBeNull();
    expect(intervals[0].status).toBe('healthy');
  });

  it('classifies each interval against the threshold it is given', () => {
    const intervals = buildCoverageIntervals(
      [shift('a', '09:00', '15:00'), shift('b', '12:00', '17:00')],
      NOBODY_ABSENT,
      { minimumStaff: 2, warningThreshold: 3 },
    );

    expect(intervals.map((i) => [i.requiredStaff, i.status])).toEqual([
      [2, 'critical'],
      [2, 'at_minimum'],
      [2, 'critical'],
    ]);
  });

  it('rejects a shift carrying an invalid instant', () => {
    const invalid: ShiftWindow = {
      profileId: 'a',
      start: new Date('not a date'),
      end: eastern('17:00'),
    };

    expect(() => buildCoverageIntervals([invalid], NOBODY_ABSENT)).toThrow(RangeError);
  });
});
