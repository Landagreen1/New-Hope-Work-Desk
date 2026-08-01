// src/features/time-attendance/domain/__tests__/work-date-arithmetic.test.ts
// Example tests for the calendar-date arithmetic in `domain/work-date.ts`.
//
// Feature: time-attendance-ui-redesign, task 4.3
//
// `addCalendarDays` and `consecutiveDates` are what the Health_Ribbon steps its
// seven dates with, so the cases here are the ones a calendar strip runs into:
// month and year rollover, leap and non-leap February, a daylight-saving
// transition, and the malformed inputs that must not roll silently.
//
// Requirements: 18.2, 19.10

import { describe, expect, it } from 'vitest';
import { addCalendarDays, consecutiveDates } from '../work-date';

describe('addCalendarDays', () => {
  it('returns the date unchanged for a zero step', () => {
    expect(addCalendarDays('2026-07-27', 0)).toBe('2026-07-27');
  });

  it('steps forwards and backwards', () => {
    expect(addCalendarDays('2026-07-27', 1)).toBe('2026-07-28');
    expect(addCalendarDays('2026-07-27', -1)).toBe('2026-07-26');
  });

  it('rolls over a month boundary', () => {
    expect(addCalendarDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addCalendarDays('2026-08-01', -1)).toBe('2026-07-31');
  });

  it('rolls over a year boundary', () => {
    expect(addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCalendarDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  it('handles February in a leap year and a common year', () => {
    expect(addCalendarDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('advances one date across a daylight-saving transition', () => {
    // Adding 24 hours to an instant would land on 2026-03-08 again, at a
    // different hour. A calendar step cannot: a date carries no offset.
    expect(addCalendarDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addCalendarDays('2026-11-01', 1)).toBe('2026-11-02');
  });

  it('is additive over successive steps', () => {
    const direct = addCalendarDays('2026-07-27', 40);
    const stepped = Array.from({ length: 40 }).reduce<string>(
      (date) => addCalendarDays(date, 1),
      '2026-07-27',
    );

    expect(direct).toBe(stepped);
  });

  it('does not rewrite a year below 100', () => {
    expect(addCalendarDays('0099-12-31', 1)).toBe('0100-01-01');
  });

  it('rejects a malformed date', () => {
    expect(() => addCalendarDays('27-07-2026', 1)).toThrow(RangeError);
    expect(() => addCalendarDays('2026-7-27', 1)).toThrow(RangeError);
  });

  it('rejects a date that is not a real calendar date rather than rolling it', () => {
    expect(() => addCalendarDays('2026-02-30', 0)).toThrow(RangeError);
    expect(() => addCalendarDays('2026-13-01', 0)).toThrow(RangeError);
  });

  it('rejects a fractional step', () => {
    expect(() => addCalendarDays('2026-07-27', 1.5)).toThrow(RangeError);
    expect(() => addCalendarDays('2026-07-27', Number.NaN)).toThrow(RangeError);
  });

  it('rejects a step that leaves the four-digit year range', () => {
    expect(() => addCalendarDays('9999-12-31', 1)).toThrow(RangeError);
  });
});

describe('consecutiveDates', () => {
  it('returns the requested number of ascending dates', () => {
    expect(consecutiveDates('2026-07-30', 4)).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-01',
      '2026-08-02',
    ]);
  });

  it('returns nothing for a count of zero', () => {
    expect(consecutiveDates('2026-07-30', 0)).toEqual([]);
  });

  it('rejects a negative count', () => {
    expect(() => consecutiveDates('2026-07-30', -1)).toThrow(RangeError);
  });
});
