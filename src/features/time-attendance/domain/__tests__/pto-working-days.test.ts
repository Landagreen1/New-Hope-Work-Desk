// src/features/time-attendance/domain/__tests__/pto-working-days.test.ts
// Example tests for the time-off arithmetic in `domain/pto.ts`: the working-day
// count, the per-year split, the balance deltas, and the type-to-column map.
//
// Feature: time-attendance-ui-redesign, task 11.1
//
// The cases here are the ones the two inherited implementations got wrong. The
// duplicated `countWeekdays` knew about weekends and nothing else, so a closed
// date was counted as a working day; and the approval path bucketed every debit
// into the year the decision was taken, so a December approval of January leave
// debited December's balance. Both appear below as fixed dates rather than as
// generated ones, so the expected numbers can be read off a calendar.
//
// 2026-07-27 is a Monday, so 2026-08-01 and 2026-08-02 are the Saturday and
// Sunday that follow. 2025-12-29 is a Monday, which puts the 31 December
// boundary in the middle of a working week.
//
// Requirements: 10.13, 10.14, 10.15, 10.16, 11.2, 19.8

import { describe, expect, it } from 'vitest';
import type { DateRange } from '../types';
import {
  PTO_TYPE_TO_BALANCE_FIELD,
  balanceDeltas,
  countWorkingDays,
  workingDaysByYear,
} from '../pto';
import type { PTOType } from '../../types';

const MONDAY = '2026-07-27';
const WEDNESDAY = '2026-07-29';
const FRIDAY = '2026-07-31';
const SATURDAY = '2026-08-01';
const SUNDAY = '2026-08-02';
const FRIDAY_NEXT_WEEK = '2026-08-07';

/** The Monday and Friday either side of 31 December 2025. */
const STRADDLE: DateRange = { from: '2025-12-29', to: '2026-01-02' };

const NOTHING_CLOSED: ReadonlySet<string> = new Set<string>();

const range = (from: string, to: string): DateRange => ({ from, to });

const entries = (byYear: Map<number, number>): Array<[number, number]> =>
  Array.from(byYear);

describe('countWorkingDays', () => {
  it('counts a Monday-to-Friday week as five working days', () => {
    expect(countWorkingDays(MONDAY, FRIDAY, NOTHING_CLOSED)).toBe(5);
  });

  it('excludes the weekend from a full calendar week', () => {
    expect(countWorkingDays(MONDAY, SUNDAY, NOTHING_CLOSED)).toBe(5);
  });

  it('counts a single weekday as one and a single weekend day as zero', () => {
    expect(countWorkingDays(WEDNESDAY, WEDNESDAY, NOTHING_CLOSED)).toBe(1);
    expect(countWorkingDays(SATURDAY, SATURDAY, NOTHING_CLOSED)).toBe(0);
  });

  it('counts a range lying entirely inside a weekend as zero', () => {
    expect(countWorkingDays(SATURDAY, SUNDAY, NOTHING_CLOSED)).toBe(0);
  });

  it('counts an inverted range as zero rather than rejecting it', () => {
    expect(countWorkingDays(FRIDAY, MONDAY, NOTHING_CLOSED)).toBe(0);
  });

  it('spans month and year boundaries', () => {
    expect(countWorkingDays(MONDAY, FRIDAY_NEXT_WEEK, NOTHING_CLOSED)).toBe(10);
    expect(countWorkingDays(STRADDLE.from, STRADDLE.to, NOTHING_CLOSED)).toBe(5);
  });

  it('excludes a closed date that falls on a working day', () => {
    expect(countWorkingDays(MONDAY, FRIDAY, new Set([WEDNESDAY]))).toBe(4);
  });

  it('is unchanged by a closed date that falls on a weekend', () => {
    expect(countWorkingDays(MONDAY, SUNDAY, new Set([SATURDAY]))).toBe(5);
  });

  it('is unchanged by a closed date outside the range', () => {
    expect(countWorkingDays(MONDAY, FRIDAY, new Set(['2026-09-07']))).toBe(5);
  });

  it('returns zero when every working day in the range is closed', () => {
    const wholeWeek = new Set([MONDAY, '2026-07-28', WEDNESDAY, '2026-07-30', FRIDAY]);
    expect(countWorkingDays(MONDAY, SUNDAY, wholeWeek)).toBe(0);
  });

  it('gives the same count at submission and at decision time', () => {
    // No clock is read, so the only way the two calls could differ is if the
    // function had state. Requirement 11.2 relies on them being equal.
    const atSubmission = countWorkingDays(STRADDLE.from, STRADDLE.to, NOTHING_CLOSED);
    const atDecision = countWorkingDays(STRADDLE.from, STRADDLE.to, NOTHING_CLOSED);
    expect(atDecision).toBe(atSubmission);
  });

  it('never exceeds the calendar span of the range', () => {
    // Seven calendar dates, five of them working.
    expect(countWorkingDays(MONDAY, SUNDAY, NOTHING_CLOSED)).toBeLessThanOrEqual(7);
  });

  it('rejects a malformed or impossible date', () => {
    expect(() => countWorkingDays('27-07-2026', FRIDAY, NOTHING_CLOSED)).toThrow(RangeError);
    expect(() => countWorkingDays(MONDAY, '2026-2-3', NOTHING_CLOSED)).toThrow(RangeError);
    expect(() => countWorkingDays('2026-02-30', FRIDAY, NOTHING_CLOSED)).toThrow(RangeError);
  });
});

describe('workingDaysByYear', () => {
  it('reports one year for a range inside one year', () => {
    expect(entries(workingDaysByYear([range(MONDAY, FRIDAY)], NOTHING_CLOSED))).toEqual([[2026, 5]]);
  });

  it('splits a range straddling 31 December across both years, ascending', () => {
    // 29, 30, 31 December 2025 and 1, 2 January 2026.
    expect(entries(workingDaysByYear([STRADDLE], NOTHING_CLOSED))).toEqual([
      [2025, 3],
      [2026, 2],
    ]);
  });

  it('counts a date shared by two ranges once', () => {
    const overlapping = [range(MONDAY, FRIDAY), range(WEDNESDAY, '2026-08-04')];
    // 27, 28, 29, 30, 31 July and 3, 4 August: seven distinct working dates.
    expect(entries(workingDaysByYear(overlapping, NOTHING_CLOSED))).toEqual([[2026, 7]]);
  });

  it('does not depend on the order the ranges arrive in', () => {
    const forwards = [range(MONDAY, FRIDAY), STRADDLE];
    const backwards = [STRADDLE, range(MONDAY, FRIDAY)];
    expect(entries(workingDaysByYear(backwards, NOTHING_CLOSED))).toEqual(
      entries(workingDaysByYear(forwards, NOTHING_CLOSED)),
    );
  });

  it('omits a year with no working days rather than reporting zero', () => {
    expect(entries(workingDaysByYear([range(SATURDAY, SUNDAY)], NOTHING_CLOSED))).toEqual([]);
    expect(entries(workingDaysByYear([], NOTHING_CLOSED))).toEqual([]);
  });

  it('agrees with countWorkingDays for a single range', () => {
    const byYear = workingDaysByYear([STRADDLE], NOTHING_CLOSED);
    const total = Array.from(byYear.values()).reduce((sum, days) => sum + days, 0);
    expect(total).toBe(countWorkingDays(STRADDLE.from, STRADDLE.to, NOTHING_CLOSED));
  });

  it('excludes closed dates from the year they fall in', () => {
    expect(entries(workingDaysByYear([STRADDLE], new Set(['2025-12-31'])))).toEqual([
      [2025, 2],
      [2026, 2],
    ]);
  });
});

describe('PTO_TYPE_TO_BALANCE_FIELD', () => {
  it('maps exactly the five request types the database constraint accepts', () => {
    expect(Object.keys(PTO_TYPE_TO_BALANCE_FIELD).sort()).toEqual([
      'bereavement',
      'personal',
      'sick',
      'unpaid',
      'vacation',
    ]);
  });

  it('maps vacation and sick to their own columns and the rest to personal', () => {
    expect(PTO_TYPE_TO_BALANCE_FIELD).toEqual({
      vacation: 'vacation_used',
      sick: 'sick_used',
      personal: 'personal_used',
      bereavement: 'personal_used',
      unpaid: 'personal_used',
    });
  });

  it('does not offer birthday, which the constraint rejects', () => {
    expect(PTO_TYPE_TO_BALANCE_FIELD).not.toHaveProperty('birthday');
  });
});

describe('balanceDeltas', () => {
  it('debits the approved working days against the type\u2019s column', () => {
    expect(balanceDeltas('vacation', [range(MONDAY, FRIDAY)], NOTHING_CLOSED, 1)).toEqual([
      { year: 2026, balanceField: 'vacation_used', deltaDays: 5 },
    ]);
  });

  it('debits each year of a range spanning two calendar years', () => {
    expect(balanceDeltas('sick', [STRADDLE], NOTHING_CLOSED, 1)).toEqual([
      { year: 2025, balanceField: 'sick_used', deltaDays: 3 },
      { year: 2026, balanceField: 'sick_used', deltaDays: 2 },
    ]);
  });

  it('attributes January leave to January whatever month the decision is taken in', () => {
    // The function reads no clock at all, so the December-approves-January bug
    // has nowhere to come from: the only year in the result is the year of the
    // requested dates.
    const january = range('2027-01-04', '2027-01-08');
    expect(balanceDeltas('vacation', [january], NOTHING_CLOSED, 1)).toEqual([
      { year: 2027, balanceField: 'vacation_used', deltaDays: 5 },
    ]);
  });

  it('produces the reversal by negating the sign and nothing else', () => {
    const ranges = [STRADDLE, range(MONDAY, FRIDAY)];
    const debits = balanceDeltas('personal', ranges, NOTHING_CLOSED, 1);
    const credits = balanceDeltas('personal', ranges, NOTHING_CLOSED, -1);

    expect(credits).toEqual(
      debits.map((delta) => ({ ...delta, deltaDays: -delta.deltaDays })),
    );
  });

  it('nets to zero when a debit is reversed', () => {
    const ranges = [STRADDLE];
    const applied = [
      ...balanceDeltas('vacation', ranges, NOTHING_CLOSED, 1),
      ...balanceDeltas('vacation', ranges, NOTHING_CLOSED, -1),
    ];

    const net = new Map<string, number>();
    for (const delta of applied) {
      const key = `${delta.year}:${delta.balanceField}`;
      net.set(key, (net.get(key) ?? 0) + delta.deltaDays);
    }

    expect(Array.from(net.values())).toEqual([0, 0]);
  });

  it('sums to the working days of the approved ranges', () => {
    const deltas = balanceDeltas('vacation', [STRADDLE], NOTHING_CLOSED, 1);
    const total = deltas.reduce((sum, delta) => sum + delta.deltaDays, 0);
    expect(total).toBe(countWorkingDays(STRADDLE.from, STRADDLE.to, NOTHING_CLOSED));
  });

  it('excludes closed dates from the debit', () => {
    expect(balanceDeltas('vacation', [range(MONDAY, FRIDAY)], new Set([WEDNESDAY]), 1)).toEqual([
      { year: 2026, balanceField: 'vacation_used', deltaDays: 4 },
    ]);
  });

  it('produces no delta when the approved range holds no working day', () => {
    expect(balanceDeltas('vacation', [range(SATURDAY, SUNDAY)], NOTHING_CLOSED, 1)).toEqual([]);
    expect(balanceDeltas('vacation', [], NOTHING_CLOSED, -1)).toEqual([]);
  });

  it('sends bereavement and unpaid leave to the personal column', () => {
    for (const ptoType of ['bereavement', 'unpaid'] as const) {
      expect(balanceDeltas(ptoType, [range(WEDNESDAY, WEDNESDAY)], NOTHING_CLOSED, 1)).toEqual([
        { year: 2026, balanceField: 'personal_used', deltaDays: 1 },
      ]);
    }
  });

  it('rejects a sign that is neither a debit nor a credit', () => {
    const ranges = [range(MONDAY, FRIDAY)];
    expect(() => balanceDeltas('vacation', ranges, NOTHING_CLOSED, 0 as unknown as 1)).toThrow(
      RangeError,
    );
    expect(() => balanceDeltas('vacation', ranges, NOTHING_CLOSED, 2 as unknown as 1)).toThrow(
      RangeError,
    );
  });

  it('rejects a request type the database constraint does not accept', () => {
    const ranges = [range(MONDAY, FRIDAY)];
    expect(() =>
      balanceDeltas('birthday' as unknown as PTOType, ranges, NOTHING_CLOSED, 1),
    ).toThrow(RangeError);
  });
});
