// src/features/time-attendance/domain/__tests__/csv-writing.test.ts
// Example tests for the CSV writer, the pay-column filter, the export file
// name, and the empty-export statement in `domain/csv.ts`.
//
// Feature: time-attendance-ui-redesign, task 20.1
//
// The fixtures carry the characters that corrupt the export the redesign
// replaces: a comma inside a name, a quotation mark inside a header label, a
// CRLF inside a field, non-ASCII text, and a null hour count. Each of them
// splits a column, splits a row, or truncates a file when the writer quotes
// nothing, so the expected strings here are written out in full rather than
// derived — a round trip through a reader is Property 32's job (task 20.5), and
// a fixture that agreed with the writer by construction would say nothing about
// either.
//
// Requirements: 15.3, 15.4, 15.5, 15.6, 15.8, 15.9

import { describe, expect, it } from 'vitest';
import {
  CSV_RECORD_SEPARATOR,
  EXPORT_VIEWS,
  csvField,
  csvFieldText,
  exportFileName,
  fileNameToken,
  isExportView,
  noRecordsNotice,
  toCsv,
  withoutPayColumns,
  type CsvColumn,
} from '../csv';

interface ExportRow {
  employee: string;
  workedHours: number | null;
  hourlyRate: number;
  grossPay: number;
  payrollBlocking: boolean;
}

/** A column list shaped like the ones the six view shapes declare. */
const COLUMNS: readonly CsvColumn<ExportRow>[] = [
  { label: 'Employee, name', value: (row) => row.employee },
  { label: 'Worked "hours"', value: (row) => row.workedHours },
  { label: 'Hourly rate', value: (row) => row.hourlyRate, pay: true },
  { label: 'Gross pay', value: (row) => row.grossPay, pay: true },
  { label: 'Payroll blocking', value: (row) => row.payrollBlocking },
];

const ROWS: readonly ExportRow[] = [
  {
    employee: 'Doe, Jane "JD"\r\nsecond line',
    workedHours: 7.5,
    hourlyRate: 22,
    grossPay: 165,
    payrollBlocking: true,
  },
  {
    employee: 'Núñez, Renée 🙂',
    workedHours: null,
    hourlyRate: 0,
    grossPay: 0,
    payrollBlocking: false,
  },
];

const HEADER =
  '"Employee, name","Worked ""hours""","Hourly rate","Gross pay","Payroll blocking"';

const FIRST_RECORD = '"Doe, Jane ""JD""\r\nsecond line","7.5","22","165","true"';
const SECOND_RECORD = '"Núñez, Renée 🙂","","0","0","false"';

const RANGE = { from: '2026-01-01', to: '2026-01-31' };

describe('csvFieldText and csvField', () => {
  it('carries a string through unchanged and quotes it', () => {
    expect(csvFieldText('a,b')).toBe('a,b');
    expect(csvField('a,b')).toBe('"a,b"');
  });

  it('doubles an embedded quotation mark', () => {
    expect(csvField('say "yes"')).toBe('"say ""yes"""');
    expect(csvField('""')).toBe('""""""');
  });

  it('keeps both line endings inside the quoted field', () => {
    expect(csvField('one\r\ntwo\nthree\rfour')).toBe('"one\r\ntwo\nthree\rfour"');
  });

  it('renders absent and unusable values as the empty field', () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
    expect(csvField(Number.NaN)).toBe('""');
    expect(csvField(Number.POSITIVE_INFINITY)).toBe('""');
  });

  it('renders numbers and flags without inventing a format', () => {
    expect(csvField(0)).toBe('"0"');
    expect(csvField(7.5)).toBe('"7.5"');
    expect(csvField(-1.25)).toBe('"-1.25"');
    expect(csvField(true)).toBe('"true"');
    expect(csvField(false)).toBe('"false"');
  });
});

describe('toCsv', () => {
  it('emits the header from the column labels, quoted (15.5)', () => {
    expect(toCsv(ROWS, COLUMNS).startsWith(`${HEADER}${CSV_RECORD_SEPARATOR}`)).toBe(true);
  });

  it('quotes every field and doubles embedded quotes (15.4)', () => {
    expect(toCsv(ROWS, COLUMNS)).toBe(
      [HEADER, FIRST_RECORD, SECOND_RECORD].join(CSV_RECORD_SEPARATOR),
    );
  });

  it('preserves the row order it is given (15.3)', () => {
    // Not split on the separator to compare records: the first record carries a
    // CRLF of its own inside a quoted field, which is precisely why record
    // boundaries are a position rather than a character.
    expect(toCsv([ROWS[1], ROWS[0]], COLUMNS)).toBe(
      [HEADER, SECOND_RECORD, FIRST_RECORD].join(CSV_RECORD_SEPARATOR),
    );
  });

  it('emits the header alone for an empty row set (15.8)', () => {
    expect(toCsv([], COLUMNS)).toBe(HEADER);
  });

  it('refuses a column list with nothing in it', () => {
    expect(() => toCsv(ROWS, [])).toThrow(RangeError);
  });
});

describe('withoutPayColumns', () => {
  it('removes the pay-rate and pay-amount columns and keeps the rest in order (15.9)', () => {
    const restricted = withoutPayColumns(COLUMNS);
    expect(restricted.map((column) => column.label)).toEqual([
      'Employee, name',
      'Worked "hours"',
      'Payroll blocking',
    ]);
    expect(toCsv(ROWS, restricted)).toBe(
      [
        '"Employee, name","Worked ""hours""","Payroll blocking"',
        '"Doe, Jane ""JD""\r\nsecond line","7.5","true"',
        '"Núñez, Renée 🙂","","false"',
      ].join(CSV_RECORD_SEPARATOR),
    );
  });

  it('leaves a list carrying no pay column unchanged', () => {
    const restricted = withoutPayColumns(COLUMNS);
    expect(withoutPayColumns(restricted).map((column) => column.label)).toEqual(
      restricted.map((column) => column.label),
    );
  });
});

describe('the six export views', () => {
  it('names the six exports of criterion 15.1 in order', () => {
    expect(EXPORT_VIEWS).toEqual([
      'attendance_records',
      'exception_queue',
      'payroll_ready',
      'time_off_activity',
      'coverage_history',
      'employee_trends',
    ]);
  });

  it('recognises only those six', () => {
    for (const view of EXPORT_VIEWS) expect(isExportView(view)).toBe(true);
    expect(isExportView('records')).toBe(false);
    expect(isExportView('')).toBe(false);
  });
});

describe('exportFileName', () => {
  it('carries the view and both range dates (15.6)', () => {
    expect(exportFileName('payroll_ready', { from: '2026-02-01', to: '2026-02-14' })).toBe(
      'payroll-ready_2026-02-01_to_2026-02-14.csv',
    );
  });

  it('carries every active filter value beside its field name (15.6)', () => {
    expect(
      exportFileName('exception_queue', RANGE, {
        savedFilter: 'payroll_blocking',
        department: ['sales', 'customer_service'],
        payrollBlocking: true,
        page: 2,
      }),
    ).toBe(
      'exception-queue_2026-01-01_to_2026-01-31_savedFilter-payroll-blocking' +
        '_department-sales-customer-service_payrollBlocking-true_page-2.csv',
    );
  });

  it('omits a filter that is not active', () => {
    expect(
      exportFileName('attendance_records', RANGE, {
        department: undefined,
        status: null,
        exception: [],
        note: '',
      }),
    ).toBe('attendance-records_2026-01-01_to_2026-01-31.csv');
  });

  it('carries no character illegal in a file name on Windows or POSIX', () => {
    const name = exportFileName('coverage_history', RANGE, {
      'depart:ment': 'Customer Service / North*',
      note: 'a<b>c|d?e"f\\g\u0007',
      employee: 'Núñez 🙂',
    });

    expect(name).toMatch(/^[A-Za-z0-9_-]+\.csv$/);
    expect(name.endsWith('.csv')).toBe(true);
    // No trailing dot or space before or after the extension, and no run of dots.
    expect(name).not.toMatch(/[. ]\.csv$/);
    expect(name).not.toMatch(/\.\./);
    expect(name).toContain(fileNameToken('Customer Service / North*'));
  });

  it('tokenises a value the same way the name does', () => {
    expect(fileNameToken('Customer Service / North')).toBe('Customer-Service-North');
    expect(fileNameToken('payroll_blocking')).toBe('payroll-blocking');
    expect(fileNameToken(true)).toBe('true');
    expect(fileNameToken(12)).toBe('12');
    // Nothing legal survives, so the value contributes no group.
    expect(fileNameToken('🙂')).toBe('');
    expect(fileNameToken('///')).toBe('');
  });

  it('never lands on an MS-DOS device name', () => {
    const reserved = new Set([
      'CON', 'PRN', 'AUX', 'NUL',
      'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
      'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
    ]);

    for (const view of EXPORT_VIEWS) {
      const name = exportFileName(view, RANGE, { note: 'con' });
      const base = name.slice(0, name.length - '.csv'.length);
      expect(reserved.has(base.toUpperCase())).toBe(false);
    }
  });

  it('still names a file when a range control holds one date', () => {
    expect(exportFileName('employee_trends', { from: '2026-03-09', to: '' })).toBe(
      'employee-trends_2026-03-09.csv',
    );
    expect(exportFileName('employee_trends', { from: '', to: '2026-03-09' })).toBe(
      'employee-trends_2026-03-09.csv',
    );
  });
});

describe('noRecordsNotice', () => {
  it('states the range when no filter is active (15.8)', () => {
    expect(noRecordsNotice(RANGE)).toBe('No records matched 2026-01-01 to 2026-01-31.');
  });

  it('states the active filters as given (15.8)', () => {
    expect(
      noRecordsNotice(RANGE, {
        department: ['sales', 'customer_service'],
        payrollBlocking: true,
        status: undefined,
        exception: [],
      }),
    ).toBe(
      'No records matched 2026-01-01 to 2026-01-31 with ' +
        'department: sales, customer_service; payrollBlocking: true.',
    );
  });
});
