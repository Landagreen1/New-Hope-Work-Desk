//
// Feature: time-attendance-ui-redesign, task 13.2
//
// The comparison inside `scripts/verify-payroll-parity.mjs`.
//
// The harness itself can only be exercised against a database that holds a
// processed payroll period, and this project's `payroll_periods` table is empty,
// so a live run reports parity vacuously. That is an honest verdict and a poor
// test: a comparison that silently reported every field equal would produce the
// same clean report. These tests are what stop the gate from being a rubber
// stamp — they drive the comparison directly, over rows built to differ in the
// specific ways a real difference arrives.
//
// The field table is transcribed here independently, so the harness's own table
// cannot drift out of Requirement 2, criterion 4 unnoticed. The `computed` keys
// are typed `keyof PayrollInputRow`, so a renamed service field fails to compile
// rather than silently comparing `undefined` against a stored figure.
//
// Requirements: 2.4, 23.5

import { describe, expect, it } from 'vitest';

import {
  COMPARED_FIELDS,
  differingFields,
  parseArgs,
  quantise,
} from '../../../../../scripts/verify-payroll-parity.mjs';
import type { PayrollInputRow } from '../attendance-service';

/**
 * The fields the harness compares, transcribed from Requirement 2, criterion 4
 * and the `payroll_summaries` column list in `v1.2.0-time-attendance.sql`.
 *
 * `named` is true for exactly the eight figures criterion 4 names: regular
 * hours, overtime hours, break hours, total hours, PTO days, gross pay,
 * deductions total, net pay. `scale` is the stored column's decimal places.
 */
const EXPECTED_FIELDS: readonly {
  stored: string;
  computed: keyof PayrollInputRow;
  scale: number;
  named: boolean;
}[] = [
  { stored: 'regular_hours', computed: 'regularHours', scale: 2, named: true },
  { stored: 'overtime_hours', computed: 'overtimeHours', scale: 2, named: true },
  { stored: 'break_hours', computed: 'breakHours', scale: 2, named: true },
  { stored: 'total_hours', computed: 'totalHours', scale: 2, named: true },
  { stored: 'pto_days_used', computed: 'ptoDaysUsed', scale: 1, named: true },
  { stored: 'gross_pay', computed: 'grossPay', scale: 2, named: true },
  { stored: 'deductions_total', computed: 'deductionsTotal', scale: 2, named: true },
  { stored: 'net_pay', computed: 'netPay', scale: 2, named: true },
  { stored: 'pto_hours_paid', computed: 'ptoHoursPaid', scale: 2, named: false },
  { stored: 'regular_pay', computed: 'regularPay', scale: 2, named: false },
  { stored: 'overtime_pay', computed: 'overtimePay', scale: 2, named: false },
  { stored: 'pto_pay', computed: 'ptoPay', scale: 2, named: false },
  { stored: 'days_worked', computed: 'daysWorked', scale: 0, named: false },
];

/** A `payroll_summaries` row, all compared fields present, overridable. */
function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { profile_id: 'p1' };
  for (const field of EXPECTED_FIELDS) row[field.stored] = 0;
  return { ...row, ...overrides };
}

/** A `PayrollInputRow`, all compared fields present, overridable. */
function computedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const row: Record<string, unknown> = { profileId: 'p1' };
  for (const field of EXPECTED_FIELDS) row[field.computed] = 0;
  return { ...row, ...overrides };
}

describe('COMPARED_FIELDS', () => {
  it('is the transcribed field table, field for field and in order', () => {
    expect(COMPARED_FIELDS).toEqual(EXPECTED_FIELDS);
  });

  it('names the eight figures Requirement 2, criterion 4 names', () => {
    const named = COMPARED_FIELDS.filter((field) => field.named).map((field) => field.stored);
    expect(named).toEqual([
      'regular_hours',
      'overtime_hours',
      'break_hours',
      'total_hours',
      'pto_days_used',
      'gross_pay',
      'deductions_total',
      'net_pay',
    ]);
  });

  it('maps each stored column to one service field and no column twice', () => {
    const stored = COMPARED_FIELDS.map((field) => field.stored);
    const computed = COMPARED_FIELDS.map((field) => field.computed);
    expect(new Set(stored).size).toBe(stored.length);
    expect(new Set(computed).size).toBe(computed.length);
  });
});

describe('quantise', () => {
  it('reports a figure as an integer at the stored column scale', () => {
    expect(quantise(1234.56, 2)).toBe(123_456);
    expect(quantise(2.75, 1)).toBe(28);
    expect(quantise(7, 0)).toBe(7);
  });

  it('reads a numeric arriving as text, because PostgREST may send one', () => {
    expect(quantise('1234.56', 2)).toBe(123_456);
  });

  it('reads a null column as zero and anything unreadable as null', () => {
    expect(quantise(null, 2)).toBe(0);
    expect(quantise(undefined, 2)).toBe(0);
    expect(quantise('not a number', 2)).toBeNull();
    expect(quantise(Number.NaN, 2)).toBeNull();
  });
});

describe('differingFields', () => {
  it('reports nothing when every field agrees', () => {
    expect(differingFields(storedRow(), computedRow())).toEqual([]);
  });

  it('reports nothing for a whole row of matching non-zero figures', () => {
    const stored = storedRow({
      regular_hours: 80,
      overtime_hours: 4.5,
      break_hours: 5,
      total_hours: 84.5,
      pto_days_used: 1,
      pto_hours_paid: 8,
      regular_pay: 1200,
      overtime_pay: 101.25,
      pto_pay: 120,
      gross_pay: 1421.25,
      deductions_total: 142.13,
      net_pay: 1279.12,
      days_worked: 10,
    });
    const computed = computedRow({
      regularHours: 80,
      overtimeHours: 4.5,
      breakHours: 5,
      totalHours: 84.5,
      ptoDaysUsed: 1,
      ptoHoursPaid: 8,
      regularPay: 1200,
      overtimePay: 101.25,
      ptoPay: 120,
      grossPay: 1421.25,
      deductionsTotal: 142.13,
      netPay: 1279.12,
      daysWorked: 10,
    });
    expect(differingFields(stored, computed)).toEqual([]);
  });

  it('catches a one-cent difference and reports its direction', () => {
    const differences = differingFields(
      storedRow({ net_pay: 1279.12 }),
      computedRow({ netPay: 1279.13 }),
    );
    expect(differences).toEqual([
      {
        field: 'net_pay',
        named: true,
        scale: 2,
        stored: 1279.12,
        computed: 1279.13,
        delta: 0.01,
      },
    ]);
  });

  it('reports every differing field, not just the first', () => {
    const differences = differingFields(
      storedRow({ total_hours: 84.5, gross_pay: 1421.25, days_worked: 10 }),
      computedRow({ totalHours: 76.5, grossPay: 1301.25, daysWorked: 9 }),
    );
    expect(differences.map((difference) => difference.field)).toEqual([
      'total_hours',
      'gross_pay',
      'days_worked',
    ]);
    expect(differences.map((difference) => difference.delta)).toEqual([-8, -120, -1]);
  });

  it('does not report binary floating-point noise as a difference', () => {
    // The recomputed side accumulates; the stored side arrived as decimal text.
    // Comparing the doubles directly reports a difference the arithmetic never
    // made, which would block the migration stage on nothing.
    const accumulated = 0.1 + 0.2;
    expect(accumulated).not.toBe(0.3);
    expect(differingFields(storedRow({ gross_pay: 0.3 }), computedRow({ grossPay: accumulated }))).toEqual(
      [],
    );
  });

  it('compares pto_days_used at the one decimal the column stores', () => {
    // numeric(4,1) stored a computed 2.75 as 2.8. That is the database rounding,
    // not a parity failure.
    expect(
      differingFields(storedRow({ pto_days_used: 2.8 }), computedRow({ ptoDaysUsed: 2.75 })),
    ).toEqual([]);

    // A tenth of a day apart is a real difference and is reported.
    const differences = differingFields(
      storedRow({ pto_days_used: 2.8 }),
      computedRow({ ptoDaysUsed: 2.6 }),
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ field: 'pto_days_used', named: true, delta: -0.2 });
  });

  it('compares a stored numeric that arrived as text by value', () => {
    expect(differingFields(storedRow({ net_pay: '1279.12' }), computedRow({ netPay: 1279.12 }))).toEqual(
      [],
    );
  });

  it('reports an unreadable figure rather than passing it as equal', () => {
    const differences = differingFields(
      storedRow({ net_pay: 1279.12 }),
      computedRow({ netPay: Number.NaN }),
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatchObject({ field: 'net_pay', delta: null });
  });
});

describe('parseArgs', () => {
  it('verifies processed and paid periods by default', () => {
    expect(parseArgs([])).toEqual({
      json: false,
      quiet: false,
      help: false,
      periodIds: [],
      statuses: ['processed', 'paid'],
    });
  });

  it('accepts repeated period ids in both spellings', () => {
    const args = parseArgs([
      '--period',
      '11111111-2222-3333-4444-555555555555',
      '--period=66666666-7777-8888-9999-aaaaaaaaaaaa',
    ]);
    expect(args.periodIds).toEqual([
      '11111111-2222-3333-4444-555555555555',
      '66666666-7777-8888-9999-aaaaaaaaaaaa',
    ]);
  });

  it('rejects a period that is not a uuid, rather than reading zero periods as parity', () => {
    expect(() => parseArgs(['--period', 'last-fortnight'])).toThrow(/UUID/);
    expect(() => parseArgs(['--period'])).toThrow(/UUID/);
  });

  it('accepts an explicit status list and rejects an empty one', () => {
    expect(parseArgs(['--status', 'processed']).statuses).toEqual(['processed']);
    expect(parseArgs(['--status=processed, paid ,locked']).statuses).toEqual([
      'processed',
      'paid',
      'locked',
    ]);
    expect(() => parseArgs(['--status', ' , '])).toThrow(/at least one status/);
  });

  it('rejects an unrecognised flag rather than ignoring it', () => {
    expect(() => parseArgs(['--periods', 'x'])).toThrow(/Unrecognised argument/);
  });
});
