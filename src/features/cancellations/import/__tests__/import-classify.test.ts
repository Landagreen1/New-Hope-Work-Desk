// src/features/cancellations/import/__tests__/import-classify.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, task 9.6 — classification and row-level
// parsing tests over the pure modules `src/features/cancellations/import/classify.ts` and
// `src/features/cancellations/import/fields.ts`.
//
// **Validates: Requirements 8.2, 8.3, 8.6, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 9.1, 9.5, 9.6,
// 9.7, 9.9, 9.11, 24.3, 25.2**
//
// Both modules are pure — no client, no clock, no I/O — so every case here is a direct call and
// no mock is used or needed. The preview counts, the duplicate contest, and the loader payload
// live in `import-preview.test.ts`; this file stops at "one file, one row".
//
// Four decisions are pinned here that a later change could reverse while the rest of the suite
// still passed:
//
//  1. **Rejection order is fixed.** A file is judged on size, then header recognition, then zero
//     rows, then the row ceiling, and only the first unmet condition is reported (Req 8.13). A row
//     is judged on its policy number, then its date, then raw-row preservation, and only the first
//     reason is recorded, because the import run stores one reason per rejected row (Req 8.6).
//  2. **An absent column is not an empty cell.** A column of the classified set that the header row
//     does not carry reads `null` for every row, and that is what makes `MontoDebido` absent and
//     *unreported* on an `avisos` file while an empty `MontoDebido` cell on an `eficacia` file is
//     absent *and* reported (Req 8.2, 8.3, 8.15).
//  3. **`nan` is the literal token, not a case-folded one.** `NAN` is unparseable instead. Either
//     way the stored amount is absent and the rest of the row loads (Req 8.15).
//  4. **A `(Deleted)` producer label is invalid before any mapping lookup**, and it never rejects
//     the row: the case loads unassigned with the label and its row number recorded (Req 9.7).

import { describe, expect, it } from 'vitest';

import {
  AVISOS_COLUMNS,
  EFICACIA_COLUMNS,
  MAX_IMPORT_DATA_ROWS,
  MAX_IMPORT_FILE_BYTES,
  classifyHeader,
  classifyImportFile,
  classifyParsedFile,
  columnValue,
  columnValues,
  requiredColumnNames,
  type AvisosColumn,
  type ClassifiedImportFile,
  type ClassifyImportFileInput,
  type EficaciaColumn,
  type ImportFileRejection,
} from '../classify';
import {
  AMOUNT_DUE_ABSENT_TOKENS,
  clientIdentifier,
  customerMatchKey,
  hasDeletedSuffix,
  normalizeCustomerName,
  normalizePolicyNumber,
  normalizeProducerLabel,
  parseAmountDue,
  parseCancellationDate,
  parseClassifiedRow,
  parseProducerLabel,
  type CancellationRowResult,
  type RowRejection,
} from '../fields';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function classifiedOrThrow(input: ClassifyImportFileInput): ClassifiedImportFile {
  const result = classifyImportFile(input);
  if (!result.ok) throw new Error(`file unexpectedly rejected: ${result.code}`);
  return result;
}

function rejectionOrThrow(input: ClassifyImportFileInput): ImportFileRejection {
  const result = classifyImportFile(input);
  if (result.ok) throw new Error(`file unexpectedly classified as ${result.columnSet}`);
  return result;
}

/** A file of one small data row, so only the condition under test can reject it. */
function oneRowFile(header: readonly string[]): ClassifyImportFileInput {
  return { header, dataRowCount: 1, byteSize: 2_048 };
}

const EFICACIA_FILE = classifiedOrThrow(oneRowFile(EFICACIA_COLUMNS));
const AVISOS_FILE = classifiedOrThrow(oneRowFile(AVISOS_COLUMNS));

const EFICACIA_DEFAULTS: Record<EficaciaColumn, string> = {
  Cliente: 'Ana N\u00fa\u00f1ez',
  Poliza: 'BWG63424074',
  Compania: ' Progressive ',
  FechaCancelacion: '2026-07-31',
  MontoDebido: '1,234.50',
  Enviar: 'SI',
  Estado: 'Activo',
  Resultado: 'Pendiente',
  AvisosEnviados: '2',
  PrimerAviso: '2026-07-01',
  UltimoAviso: '2026-07-15',
  Productor: 'Maria  Lopez',
  ClienteID: '007',
};

const AVISOS_DEFAULTS: Record<AvisosColumn, string> = {
  Customer: 'Bob Smith',
  'Policy number': 'BWG63424075',
  Carrier: 'Citizens',
  'Cancellation date': '7/31/2026',
  'Days remaining': '10',
  Aviso: 'Aviso 2',
  Email: 'bob@example.com',
  Phone: '(786) 555-0199',
  Asunto: 'Asunto 2',
  MensajeEmail: 'Line one\r\nLine two',
  MensajeSMS: 'SMS 2',
};

function eficaciaRow(cells: Partial<Record<EficaciaColumn, string>> = {}): string[] {
  return EFICACIA_COLUMNS.map((column) => cells[column] ?? EFICACIA_DEFAULTS[column]);
}

function avisosRow(cells: Partial<Record<AvisosColumn, string>> = {}): string[] {
  return AVISOS_COLUMNS.map((column) => cells[column] ?? AVISOS_DEFAULTS[column]);
}

function parseEficacia(
  cells: Partial<Record<EficaciaColumn, string>> = {},
  rowNumber = 1,
): CancellationRowResult {
  return parseClassifiedRow(EFICACIA_FILE, eficaciaRow(cells), rowNumber);
}

function acceptedEficacia(
  cells: Partial<Record<EficaciaColumn, string>> = {},
  rowNumber = 1,
): Extract<CancellationRowResult, { accepted: true }> {
  const result = parseEficacia(cells, rowNumber);
  if (!result.accepted) throw new Error(`row unexpectedly rejected: ${result.rejection.reason}`);
  return result;
}

function rejectedEficacia(
  cells: Partial<Record<EficaciaColumn, string>> = {},
  rowNumber = 1,
): RowRejection {
  const result = parseEficacia(cells, rowNumber);
  if (result.accepted) throw new Error('row unexpectedly accepted');
  return result.rejection;
}

// ---------------------------------------------------------------------------
// Classification of the two recognized formats (Req 8.2, 8.3, 25.2)
// ---------------------------------------------------------------------------

describe('classifyImportFile: the eficacia column set (Req 8.2)', () => {
  it('classifies a header carrying Poliza and FechaCancelacion and accepts all 13 columns', () => {
    expect(EFICACIA_FILE.columnSet).toBe('eficacia');
    expect(EFICACIA_FILE.acceptedColumns).toEqual([
      'Cliente',
      'Poliza',
      'Compania',
      'FechaCancelacion',
      'MontoDebido',
      'Enviar',
      'Estado',
      'Resultado',
      'AvisosEnviados',
      'PrimerAviso',
      'UltimoAviso',
      'Productor',
      'ClienteID',
    ]);
    expect(EFICACIA_FILE.presentColumns).toEqual(EFICACIA_FILE.acceptedColumns);
    expect(EFICACIA_FILE.absentColumns).toEqual([]);
    expect(EFICACIA_FILE.columnIndexes).toMatchObject({ Poliza: 1, FechaCancelacion: 3, ClienteID: 12 });
  });

  it('matches header names after trimming and without case sensitivity', () => {
    const messy = [' cliente ', '\tPOLIZA', 'compania', 'fechacancelacion  ', 'MONTODEBIDO'];

    const classified = classifiedOrThrow(oneRowFile(messy));

    expect(classified.columnSet).toBe('eficacia');
    expect(classified.columnIndexes).toMatchObject({ Poliza: 1, FechaCancelacion: 3, MontoDebido: 4 });
  });

  // A column the header does not carry is an absent value for every row, which is a different
  // thing from a cell that is present and empty.
  it('treats a column absent from the header row as an absent value for every row', () => {
    const header = EFICACIA_COLUMNS.filter((column) => column !== 'MontoDebido' && column !== 'ClienteID');

    const classified = classifiedOrThrow(oneRowFile(header));
    const row = header.map((column) => EFICACIA_DEFAULTS[column as EficaciaColumn]);

    expect(classified.absentColumns).toEqual(['MontoDebido', 'ClienteID']);
    expect(classified.columnIndexes.MontoDebido).toBeNull();
    expect(columnValue(classified, row, 'MontoDebido')).toBeNull();
    expect(columnValue(classified, row, 'ClienteID')).toBeNull();
    expect(columnValue(classified, row, 'Poliza')).toBe('BWG63424074');
  });

  it('reads an absent value from a row shorter than a mapped column position', () => {
    expect(columnValue(EFICACIA_FILE, eficaciaRow().slice(0, 4), 'ClienteID')).toBeNull();
    expect(columnValues(EFICACIA_FILE, eficaciaRow().slice(0, 4)).Productor).toBeNull();
  });
});

describe('classifyImportFile: the avisos column set (Req 8.3)', () => {
  it('classifies a header carrying Policy number and Cancellation date and accepts all 11 columns', () => {
    expect(AVISOS_FILE.columnSet).toBe('avisos');
    expect(AVISOS_FILE.acceptedColumns).toEqual([
      'Customer',
      'Policy number',
      'Carrier',
      'Cancellation date',
      'Days remaining',
      'Aviso',
      'Email',
      'Phone',
      'Asunto',
      'MensajeEmail',
      'MensajeSMS',
    ]);
    expect(AVISOS_FILE.columnIndexes).toMatchObject({ 'Policy number': 1, 'Cancellation date': 3 });
  });

  // Requirement 8.3 disallows `Poliza`, so a hybrid header can only be read as eficacia.
  it('reads a header carrying both Poliza and Policy number as eficacia', () => {
    expect(classifyHeader(['Poliza', 'FechaCancelacion', 'Policy number', 'Cancellation date'])).toBe(
      'eficacia',
    );
    expect(classifyHeader(['Policy number', 'Cancellation date'])).toBe('avisos');
  });

  it('classifies a parsed file from its data row count', () => {
    const parsed = { header: [...AVISOS_COLUMNS], rows: [avisosRow(), avisosRow()] };

    const classified = classifiedOrThrow({
      header: parsed.header,
      dataRowCount: parsed.rows.length,
      byteSize: 512,
    });

    expect(classifyParsedFile(parsed, 512)).toEqual(classified);
    expect(classified.dataRowCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Whole-file rejection (Req 8.13)
// ---------------------------------------------------------------------------

describe('classifyImportFile: whole-file rejection (Req 8.13)', () => {
  it('rejects a third header set naming neither format, reporting the unmet condition and the required columns', () => {
    const rejection = rejectionOrThrow(
      oneRowFile(['Policy', 'Insured', 'Renewal Date', 'Premium', 'Agent']),
    );

    expect(rejection.code).toBe('unrecognized_header_set');
    expect(rejection.unmetCondition).toContain('neither cancellation report format');
    expect(rejection.requiredColumnNames).toEqual([
      'Poliza',
      'FechaCancelacion',
      'Policy number',
      'Cancellation date',
    ]);
    for (const column of requiredColumnNames()) expect(rejection.message).toContain(column);
    expect(rejection.observed.header).toHaveLength(5);
  });

  it('rejects a header carrying only one half of a format', () => {
    expect(rejectionOrThrow(oneRowFile(['Poliza', 'Cliente'])).code).toBe('unrecognized_header_set');
    expect(rejectionOrThrow(oneRowFile(['Policy number', 'Customer'])).code).toBe(
      'unrecognized_header_set',
    );
  });

  it('rejects a file larger than 25 megabytes and accepts one of exactly 25 megabytes', () => {
    const rejection = rejectionOrThrow({
      header: EFICACIA_COLUMNS,
      dataRowCount: 10,
      byteSize: 30 * 1_048_576,
    });

    expect(rejection.code).toBe('file_too_large');
    expect(rejection.message).toContain('30 MB');
    expect(rejection.message).toContain('25 MB');
    expect(rejection.limits.maxBytes).toBe(MAX_IMPORT_FILE_BYTES);
    expect(rejection.observed.byteSize).toBe(30 * 1_048_576);

    expect(
      rejectionOrThrow({ header: EFICACIA_COLUMNS, dataRowCount: 10, byteSize: MAX_IMPORT_FILE_BYTES + 1 })
        .code,
    ).toBe('file_too_large');
    expect(
      classifiedOrThrow({ header: EFICACIA_COLUMNS, dataRowCount: 10, byteSize: MAX_IMPORT_FILE_BYTES })
        .columnSet,
    ).toBe('eficacia');
  });

  it('rejects a file carrying zero data rows and accepts one carrying a single row', () => {
    const rejection = rejectionOrThrow({ header: EFICACIA_COLUMNS, dataRowCount: 0, byteSize: 128 });

    expect(rejection.code).toBe('no_data_rows');
    expect(rejection.message).toContain('1 to 20,000 data rows');
    expect(classifiedOrThrow(oneRowFile(EFICACIA_COLUMNS)).dataRowCount).toBe(1);
  });

  it('rejects a file carrying more than 20,000 data rows and accepts one carrying exactly 20,000', () => {
    const rejection = rejectionOrThrow({
      header: AVISOS_COLUMNS,
      dataRowCount: MAX_IMPORT_DATA_ROWS + 1,
      byteSize: 4_096,
    });

    expect(rejection.code).toBe('too_many_data_rows');
    expect(rejection.message).toContain('20,001');
    expect(rejection.limits.maxDataRows).toBe(MAX_IMPORT_DATA_ROWS);
    expect(
      classifiedOrThrow({ header: AVISOS_COLUMNS, dataRowCount: MAX_IMPORT_DATA_ROWS, byteSize: 4_096 })
        .dataRowCount,
    ).toBe(MAX_IMPORT_DATA_ROWS);
  });

  // Size is judged before the header is read, so an oversized file with an unreadable header is
  // reported as oversized: there is no reason to parse a file that can never be accepted.
  it('reports only the first unmet condition', () => {
    expect(
      rejectionOrThrow({ header: ['Policy', 'Insured'], dataRowCount: 0, byteSize: 30 * 1_048_576 }).code,
    ).toBe('file_too_large');
    expect(rejectionOrThrow({ header: ['Policy', 'Insured'], dataRowCount: 0, byteSize: 64 }).code).toBe(
      'unrecognized_header_set',
    );
  });

  it('skips the size condition when the caller could not measure the upload', () => {
    const classified = classifiedOrThrow({ header: EFICACIA_COLUMNS, dataRowCount: 5, byteSize: null });

    expect(classified.byteSize).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Policy number (Req 8.6, 9.1)
// ---------------------------------------------------------------------------

describe('normalizePolicyNumber (Req 9.1)', () => {
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['leading and trailing whitespace', '  bwg63424074\t', 'BWG63424074'],
    ['internal whitespace', 'BWG 634 240 74', 'BWG63424074'],
    ['every whitespace character PostgreSQL removes', 'A\tB\nC\u000bD\fE\rF G', 'ABCDEFG'],
    ['leading zeros kept', '007-abc', '007-ABC'],
    ['hyphens kept', 'a-b-c', 'A-B-C'],
  ];

  it.each(CASES)('removes %s', (_name, value, expected) => {
    expect(normalizePolicyNumber(value)).toBe(expected);
  });

  it('is idempotent and empty for an absent value', () => {
    expect(normalizePolicyNumber(normalizePolicyNumber(' bwg 001 '))).toBe('BWG001');
    expect(normalizePolicyNumber(null)).toBe('');
    expect(normalizePolicyNumber(undefined)).toBe('');
  });
});

describe('parseClassifiedRow: empty policy number rejects the row (Req 8.6)', () => {
  it.each([
    ['an empty cell', ''],
    ['a whitespace-only cell', ' \t '],
  ])('rejects %s with the data row number and the reason', (_name, value) => {
    const rejection = rejectedEficacia({ Poliza: value }, 4);

    expect(rejection).toEqual({
      row_number: 4,
      reason: 'policy number is empty',
      code: 'policy_number_empty',
    });
  });

  it('stores the policy number as imported and normalizes only the identity', () => {
    const accepted = acceptedEficacia({ Poliza: ' bwg 634-240 74 ' });

    expect(accepted.fields.policy_number).toBe(' bwg 634-240 74 ');
    expect(accepted.identity.policyNumberNormalized).toBe('BWG634-24074');
  });
});

// ---------------------------------------------------------------------------
// Cancellation effective date (Req 8.6, 8.14)
// ---------------------------------------------------------------------------

describe('parseCancellationDate: the two parseable formats (Req 8.14)', () => {
  const PARSEABLE: ReadonlyArray<readonly [string, string]> = [
    ['2026-07-31', '2026-07-31'],
    ['7/31/2026', '2026-07-31'],
    ['07/31/2026', '2026-07-31'],
    ['1/5/2026', '2026-01-05'],
    [' 2026-07-31 ', '2026-07-31'],
    ['2024-02-29', '2024-02-29'],
  ];

  it.each(PARSEABLE)('parses %s as the calendar date %s with no time component', (value, expected) => {
    const result = parseCancellationDate(value);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.date).toBe(expected);
  });
});

describe('parseCancellationDate: unparseable and non-existent values (Req 8.6, 8.14)', () => {
  const UNPARSEABLE: ReadonlyArray<readonly [string, string]> = [
    ['a one-digit ISO month', '2026-7-31'],
    ['a day-first slash date', '31-07-2026'],
    ['a two-digit year', '7/31/26'],
    ['a written month', 'July 31, 2026'],
    ['a value carrying a time component', '2026-07-31T00:00:00'],
    ['free text', 'pending'],
  ];

  it.each(UNPARSEABLE)('treats %s as unparseable', (_name, value) => {
    const result = parseCancellationDate(value);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unparseable_format');
      expect(result.reason).toContain('YYYY-MM-DD or M/D/YYYY');
    }
  });

  const NONEXISTENT: ReadonlyArray<readonly [string, string]> = [
    ['a 30th of February', '2026-02-30'],
    ['a 29th of February in a common year', '2023-02-29'],
    ['a 13th month', '2026-13-01'],
    ['a day-first slash date read as month 31', '31/07/2026'],
    ['a zero day', '2026-07-00'],
    ['year zero', '0000-01-01'],
  ];

  it.each(NONEXISTENT)('treats %s as naming no existing calendar date', (_name, value) => {
    const result = parseCancellationDate(value);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('nonexistent_date');
      expect(result.reason).toContain('does not name an existing calendar date');
    }
  });

  it('rejects the row with its data row number for each of the two kinds', () => {
    expect(rejectedEficacia({ FechaCancelacion: 'July 31, 2026' }, 12)).toMatchObject({
      row_number: 12,
      code: 'cancellation_date_unparseable',
    });
    expect(rejectedEficacia({ FechaCancelacion: '2026-02-30' }, 13)).toMatchObject({
      row_number: 13,
      code: 'cancellation_date_unparseable',
    });
    expect(rejectedEficacia({ FechaCancelacion: '' }, 14).reason).toContain('empty');
  });

  // The import run stores one reason per rejected row, so the order the reasons are evaluated in
  // is part of the contract rather than an implementation detail.
  it('reports the policy number before the date when both are unusable', () => {
    expect(rejectedEficacia({ Poliza: '  ', FechaCancelacion: 'nope' }, 9)).toEqual({
      row_number: 9,
      reason: 'policy number is empty',
      code: 'policy_number_empty',
    });
  });
});

// ---------------------------------------------------------------------------
// Amount due (Req 8.10, 8.15)
// ---------------------------------------------------------------------------

describe('parseAmountDue: accepted values (Req 8.10)', () => {
  const ACCEPTED: ReadonlyArray<readonly [string, string]> = [
    ['1234', '1234.00'],
    ['1,234.5', '1234.50'],
    ['$1,234.50', '1234.50'],
    ['0', '0.00'],
    ['0.00', '0.00'],
    ['999999999.99', '999999999.99'],
    ['999,999,999.99', '999999999.99'],
    [' 250.75 ', '250.75'],
  ];

  it.each(ACCEPTED)('stores %s as %s with two decimal places', (value, expected) => {
    const result = parseAmountDue(value);

    expect(result.present).toBe(true);
    if (result.present) expect(result.amountDue).toBe(expected);
  });
});

describe('parseAmountDue: absent values with a reason (Req 8.15)', () => {
  it('reports an empty cell as absent', () => {
    expect(parseAmountDue('')).toMatchObject({
      present: false,
      amountDue: null,
      code: 'empty',
      reported: true,
    });
    expect(parseAmountDue('   ')).toMatchObject({ code: 'whitespace_only', reported: true });
  });

  it.each(AMOUNT_DUE_ABSENT_TOKENS)('reports the literal token %s as absent', (token) => {
    const result = parseAmountDue(token);

    expect(result.present).toBe(false);
    if (!result.present) {
      expect(result.code).toBe('absent_token');
      expect(result.reason).toContain(token);
      expect(result.reported).toBe(true);
    }
  });

  // Requirement 8.15 lists the tokens as literals. `NAN` is not one of them, so it falls through
  // to the unparseable branch — a different reason for the same absent amount.
  it('reports a case-folded token as unparseable rather than as a token', () => {
    expect(parseAmountDue('NAN')).toMatchObject({ present: false, code: 'unparseable' });
    expect(parseAmountDue('nan')).toMatchObject({ present: false, code: 'absent_token' });
  });

  const UNPARSEABLE = ['-5.00', '1.234', '1,23,456', 'abc', '$', '1 234.00'];

  it.each(UNPARSEABLE)('reports the unparseable value %s as absent', (value) => {
    expect(parseAmountDue(value)).toMatchObject({ present: false, code: 'unparseable', reported: true });
  });

  it('reports a value outside the accepted range as absent', () => {
    expect(parseAmountDue('1000000000')).toMatchObject({ present: false, code: 'out_of_range' });
    expect(parseAmountDue('999,999,999.99').present).toBe(true);
  });

  // An absent column is an absent value for every row (Req 8.2, 8.3), so it earns no audit line;
  // a cell that held something unusable does.
  it('does not report an amount the classified set carries no column for', () => {
    expect(parseAmountDue(null)).toMatchObject({
      present: false,
      code: 'column_absent',
      reported: false,
    });
  });
});

describe('parseClassifiedRow: an absent amount loads the rest of the row (Req 8.15)', () => {
  it.each([
    ['an empty cell', ''],
    ['the literal token nan', 'nan'],
  ])('stores no amount for %s while every other value loads', (_name, value) => {
    const accepted = acceptedEficacia({ MontoDebido: value }, 6);

    expect(accepted.fields.amount_due).toBeNull();
    expect(accepted.notices.amountDueAbsent).toEqual({
      row_number: 6,
      reason: expect.stringContaining('amount due'),
    });

    // The row is otherwise complete: identity, authoritative fields, and legacy passthrough.
    expect(accepted.fields).toMatchObject({
      policy_number: 'BWG63424074',
      cancellation_effective_date: '2026-07-31',
      customer_name: 'Ana N\u00fa\u00f1ez',
      carrier: 'Progressive',
      client_identifier: '007',
      customer_match_key: '007',
      producer_label: 'Maria  Lopez',
      source_row_number: 6,
      legacy_state: 'Activo',
    });
    expect(accepted.fields.raw_row).toEqual(eficaciaRow({ MontoDebido: value }));
  });

  it('records no amount notice for an avisos row, whose column set carries no amount column', () => {
    const result = parseClassifiedRow(AVISOS_FILE, avisosRow(), 3);

    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.fields.amount_due).toBeNull();
      expect(result.notices.amountDueAbsent).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Producer label (Req 9.6, 9.7)
// ---------------------------------------------------------------------------

describe('normalizeProducerLabel (Req 9.6)', () => {
  it('trims, collapses internal whitespace runs, and upper-cases', () => {
    expect(normalizeProducerLabel('  maria \t lopez  ')).toBe('MARIA LOPEZ');
    expect(normalizeProducerLabel('MARIA LOPEZ')).toBe('MARIA LOPEZ');
  });

  it('keeps punctuation, which the comparison is defined over', () => {
    expect(normalizeProducerLabel('lopez, maria j.')).toBe('LOPEZ, MARIA J.');
  });

  it('is null for a label holding no non-whitespace character', () => {
    expect(normalizeProducerLabel('   ')).toBeNull();
    expect(normalizeProducerLabel(null)).toBeNull();
  });
});

describe('parseProducerLabel: a (Deleted) label leaves the case unassigned (Req 9.7)', () => {
  it.each([
    ['Maria Lopez (Deleted)'],
    ['Maria Lopez (deleted)'],
    ['Maria Lopez (DELETED)'],
    ['Maria Lopez (Deleted)   '],
  ])('treats %s as invalid without any mapping lookup', (label) => {
    const result = parseProducerLabel(label, 5);

    expect(result.deleted).toBe(true);
    expect(result.assignedTo).toBeNull();
    expect(result.unmatchedEntry).toEqual({ label: label.trim(), row_number: 5 });
    expect(hasDeletedSuffix(label)).toBe(true);
  });

  it('leaves a plain label unresolved without recording it, since the loader owns the lookup', () => {
    const result = parseProducerLabel(' Maria  Lopez ', 5);

    expect(result).toEqual({
      label: 'Maria  Lopez',
      normalizedLabel: 'MARIA LOPEZ',
      deleted: false,
      assignedTo: null,
      unmatchedEntry: null,
    });
  });

  it('records nothing for a cell holding no non-whitespace character', () => {
    expect(parseProducerLabel('  ', 5)).toMatchObject({ label: null, unmatchedEntry: null });
    expect(hasDeletedSuffix('  ')).toBe(false);
    expect(hasDeletedSuffix('(Deleted) Maria')).toBe(false);
  });

  it('loads every remaining field of a row carrying a (Deleted) label', () => {
    const accepted = acceptedEficacia({ Productor: 'Maria Lopez (Deleted)' }, 8);

    expect(accepted.notices.unmatchedProducerLabel).toEqual({
      label: 'Maria Lopez (Deleted)',
      row_number: 8,
    });
    expect(accepted.producer.assignedTo).toBeNull();
    expect(accepted.fields.producer_label).toBe('Maria Lopez (Deleted)');
    expect(accepted.fields).toMatchObject({
      policy_number: 'BWG63424074',
      cancellation_effective_date: '2026-07-31',
      amount_due: '1234.50',
      client_identifier: '007',
    });
  });
});

// ---------------------------------------------------------------------------
// Client identifier, customer name, and the matching key (Req 9.5, 9.9, 9.11, 24.3)
// ---------------------------------------------------------------------------

describe('clientIdentifier (Req 9.5, 24.3)', () => {
  it('stores the exact decoded characters with trimming only', () => {
    expect(clientIdentifier(' 007 ')).toBe('007');
    expect(clientIdentifier('00123-A')).toBe('00123-A');
    expect(clientIdentifier('7')).toBe('7');
  });

  it('applies no numeric conversion, no zero-stripping, and no zero-padding', () => {
    expect(clientIdentifier('007')).not.toBe('7');
    expect(clientIdentifier('7')).not.toBe('007');
  });

  it('is null for a cell holding no non-whitespace character', () => {
    expect(clientIdentifier('   ')).toBeNull();
    expect(clientIdentifier(null)).toBeNull();
  });
});

describe('normalizeCustomerName (Req 9.9)', () => {
  it('trims, collapses whitespace runs, strips periods, commas, and quotation marks, and upper-cases', () => {
    expect(normalizeCustomerName('  ana   n\u00fa\u00f1ez  ')).toBe('ANA N\u00da\u00d1EZ');
    expect(normalizeCustomerName('Ann "Annie" Diaz')).toBe('ANN ANNIE DIAZ');
    expect(normalizeCustomerName('Smith Jr. John')).toBe('SMITH JR JOHN');
  });

  it('is null for a name holding no characters after normalization', () => {
    expect(normalizeCustomerName('  ')).toBeNull();
    expect(normalizeCustomerName('.,"')).toBeNull();
  });
});

describe('customerMatchKey (Req 9.5, 9.9, 9.11)', () => {
  it('prefers the client identifier where the cell holds a non-whitespace character', () => {
    expect(customerMatchKey(' 007 ', 'Ana N\u00fa\u00f1ez')).toBe('007');
  });

  it('falls back to the normalized customer name where the client identifier is blank', () => {
    expect(customerMatchKey('   ', '  ana   n\u00fa\u00f1ez ')).toBe('ANA N\u00da\u00d1EZ');
    expect(customerMatchKey(null, 'Ana N\u00fa\u00f1ez')).toBe('ANA N\u00da\u00d1EZ');
  });

  it('is null where both sources hold zero characters', () => {
    expect(customerMatchKey('  ', '  ')).toBeNull();
    expect(customerMatchKey(null, null)).toBeNull();
  });

  it('records the unmatched customer notice on a row whose key would hold zero characters', () => {
    const blank = acceptedEficacia({ ClienteID: '  ', Cliente: ' ' }, 11);

    expect(blank.fields.customer_match_key).toBeNull();
    expect(blank.notices.unmatchedCustomer).toEqual({ row_number: 11 });

    const keyed = acceptedEficacia({ ClienteID: '', Cliente: 'Ana N\u00fa\u00f1ez' }, 12);

    expect(keyed.fields.customer_match_key).toBe('ANA N\u00da\u00d1EZ');
    expect(keyed.fields.client_identifier).toBeNull();
    expect(keyed.notices.unmatchedCustomer).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Legacy passthrough (Req 8.11, 8.12)
// ---------------------------------------------------------------------------

describe('parseClassifiedRow: legacy imported values (Req 8.11, 8.12)', () => {
  it('stores the six eficacia legacy values verbatim and leaves the avisos-only ones absent', () => {
    const accepted = acceptedEficacia({ Enviar: ' si ', AvisosEnviados: '2' });

    expect(accepted.fields).toMatchObject({
      legacy_send_flag: ' si ',
      legacy_state: 'Activo',
      legacy_result: 'Pendiente',
      legacy_notices_sent: '2',
      legacy_first_notice: '2026-07-01',
      legacy_last_notice: '2026-07-15',
      legacy_days_remaining: null,
      legacy_notice_label: null,
      legacy_subject: null,
      legacy_email_body: null,
      legacy_sms_body: null,
    });
  });

  it('stores the five avisos legacy values verbatim, embedded line breaks included', () => {
    const result = parseClassifiedRow(AVISOS_FILE, avisosRow(), 2);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.fields).toMatchObject({
      legacy_days_remaining: '10',
      legacy_notice_label: 'Aviso 2',
      legacy_subject: 'Asunto 2',
      legacy_email_body: 'Line one\r\nLine two',
      legacy_sms_body: 'SMS 2',
      legacy_send_flag: null,
      legacy_state: null,
    });
    expect(result.fields.raw_row).toEqual(avisosRow());
  });
});
