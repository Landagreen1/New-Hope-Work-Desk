// src/features/cancellations/import/__tests__/csv-round-trip.property.test.ts
//
// Feature: policy-follow-up-renewals-cancellations, Property 1: For any CSV data row of 1 to 30 fields whose field values are arbitrary strings of 0 to 10,000 characters, storing that row as a raw row and re-serializing it produces a CSV row whose field count, field order, and decoded field values are equal character for character to the source row, where the only permitted differences are those enumerated in Requirement 24 criterion 6.
//
// **Validates: Requirements 24.1, 24.2, 24.3, 24.4, 24.7, 25.4**
//
// The invariant is
// `normalizeAcceptable(serializeRawRow(parseRow(source))) === normalizeAcceptable(source)`.
// On its own that assertion is worthless: an over-broad `normalizeAcceptable`
// that collapsed, say, letter case or embedded line breaks would satisfy it
// while the importer quietly destroyed data. So this file asserts three things,
// not one:
//
//  1. the round trip, over generated rows (the property);
//  2. field count and field order, asserted directly against the generated
//     values so a count or order difference can never be masked by
//     normalization;
//  3. the discrimination direction — every pair of rows that Requirement 24
//     criterion 6 calls *unacceptably* different must normalize to *different*
//     strings, and only the four acceptable differences may collapse.
//
// It closes with the two real source reports the requirements were written
// from, when they are reachable on this machine.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { normalizeAcceptable, parseCsv, parseRow, serializeRawRow } from '../csv';

const BOM = '\uFEFF';
const LF = '\n';
const CRLF = '\r\n';

/** Upper bound on a stored decoded field value (Requirement 24.1). */
const MAX_FIELD_LENGTH = 10_000;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Short filler so a hazardous character always has neighbours on both sides. */
const fillerArb = fc.string({ unit: 'grapheme-ascii', maxLength: 12 });

/**
 * A value that certainly contains `token`. Built by construction rather than by
 * generating freely and hoping the character turns up, so the hazardous shapes
 * are reached on close to every run.
 */
function containing(token: string): fc.Arbitrary<string> {
  return fc.tuple(fillerArb, fillerArb).map(([before, after]) => `${before}${token}${after}`);
}

/** Digit strings that keep a leading zero, the `ClienteID` shape (Req 24.3). */
const leadingZeroArb: fc.Arbitrary<string> = fc
  .tuple(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 99_999 }))
  .map(([zeros, digits]) => `${'0'.repeat(zeros)}${digits}`);

/** Accented, non-Latin, combining, and emoji values. */
const nonLatinArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'Núñez',
    'José Martínez',
    'PAINT & DRYWALL SOLUCIÓN',
    'Ольга Петрова',
    '日本語テスト',
    'Δοκιμή',
    'a\u0301bc',
    '🙂🚗 policy',
    'İstanbul',
  ),
  fc.string({ unit: 'grapheme', maxLength: 24 }),
);

/**
 * A value at the Requirement 24.1 ceiling. Built by repetition instead of by
 * generating ten thousand units, which would dominate the run time; the repeated
 * unit is itself drawn from the awkward set so the long value is not merely long.
 */
const longFieldArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: MAX_FIELD_LENGTH - 10, max: MAX_FIELD_LENGTH }),
    fc.constantFrom('a', '0', 'ñ', ' ', ',', '"', LF, CRLF),
  )
  .map(([length, unit]) => unit.repeat(length).slice(0, length));

/**
 * One decoded field value. The weights put the readers' failure modes in reach:
 * an embedded comma, an embedded quotation mark, a doubled quotation mark, an
 * embedded LF, an embedded CRLF, a lone CR, leading zeros, non-Latin text and
 * emoji, the empty string, whitespace only, and a value at the length ceiling.
 *
 * A byte order mark is deliberately absent. Criterion 6 defines the BOM as an
 * acceptable difference *at the start of the file*, which is a file-level fact;
 * a field value that itself begins with a BOM at row position 0 is inherently
 * ambiguous with that file BOM and is the criterion 24.8 rejection path, not a
 * round trip. The BOM is covered by the file-level assertions and by the
 * acceptable/unacceptable tables below instead.
 */
const fieldArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: fc.constant('') },
  { weight: 2, arbitrary: fc.constantFrom(' ', '  ', '\t', ' \t ') },
  { weight: 6, arbitrary: fc.string({ unit: 'grapheme-ascii', maxLength: 40 }) },
  { weight: 4, arbitrary: containing(',') },
  { weight: 3, arbitrary: containing('"') },
  { weight: 2, arbitrary: containing('""') },
  { weight: 3, arbitrary: containing(LF) },
  { weight: 3, arbitrary: containing(CRLF) },
  { weight: 2, arbitrary: containing('\r') },
  { weight: 3, arbitrary: leadingZeroArb },
  { weight: 3, arbitrary: nonLatinArb },
  { weight: 1, arbitrary: longFieldArb },
);

/** One field plus the choice of whether the source over-quotes it. */
interface SourceField {
  value: string;
  /**
   * True when the source wraps a value that needs no quoting in quotation
   * marks — the first acceptable difference of criterion 6.
   */
  overQuoted: boolean;
}

const sourceFieldArb: fc.Arbitrary<SourceField> = fc.record({
  value: fieldArb,
  overQuoted: fc.boolean(),
});

/** A generated data row plus the source encoding choices applied to it. */
interface SourceRow {
  fields: SourceField[];
  /** True when the source writes an empty value as `""` rather than as nothing. */
  emptyAsDoubledQuote: boolean;
  /** The record separator that ends the row, absent when it ends the file. */
  terminator: '' | typeof LF | typeof CRLF;
  /** The record separator between the header row and the data row. */
  headerSeparator: typeof LF | typeof CRLF;
  /** True when the assembled file opens with a byte order mark. */
  fileBom: boolean;
}

const sourceRowArb: fc.Arbitrary<SourceRow> = fc
  .record({
    fields: fc.array(sourceFieldArb, { minLength: 1, maxLength: 30, size: 'max' }),
    emptyAsDoubledQuote: fc.boolean(),
    terminator: fc.constantFrom<SourceRow['terminator']>('', LF, CRLF),
    headerSeparator: fc.constantFrom<SourceRow['headerSeparator']>(LF, CRLF),
    fileBom: fc.boolean(),
  })
  // See the note on `fieldArb`: a first field that itself starts with a BOM is
  // indistinguishable from a file BOM once the row is read on its own.
  .filter((row) => !row.fields[0].value.startsWith(BOM));

/** True when RFC 4180 forces this value to be quoted. */
function mustQuote(value: string): boolean {
  return /[,"\r\n]/.test(value);
}

/**
 * Writes one field the way a source file could legitimately have written it:
 * always quoted where quoting is required, optionally quoted where it is not,
 * and an empty value optionally written as two quotation marks.
 */
function encodeField(field: SourceField, emptyAsDoubledQuote: boolean): string {
  if (mustQuote(field.value)) {
    return `"${field.value.split('"').join('""')}"`;
  }
  if (field.value === '' && emptyAsDoubledQuote) return '""';
  return field.overQuoted ? `"${field.value}"` : field.value;
}

function encodeRow(row: SourceRow): string {
  return row.fields.map((field) => encodeField(field, row.emptyAsDoubledQuote)).join(',');
}

// ---------------------------------------------------------------------------
// Property 1
// ---------------------------------------------------------------------------

describe('PBT-1: CSV raw-row round trip', () => {
  it('preserves field count, field order, and every character of every field value', () => {
    // Anti-vacuity counters: the property is only meaningful if the run actually
    // produced the shapes that break naive readers.
    const seen = {
      embeddedComma: 0,
      embeddedQuote: 0,
      doubledQuote: 0,
      embeddedLf: 0,
      embeddedCrlf: 0,
      loneCr: 0,
      leadingZero: 0,
      nonAscii: 0,
      empty: 0,
      whitespaceOnly: 0,
      atLengthCeiling: 0,
      overQuoted: 0,
      emptyWrittenAsDoubledQuote: 0,
      fileBom: 0,
      thirtyFields: 0,
    };

    fc.assert(
      fc.property(sourceRowArb, (row) => {
        const values = row.fields.map((field) => field.value);

        for (const value of values) {
          if (value.includes(',')) seen.embeddedComma += 1;
          if (value.includes('"')) seen.embeddedQuote += 1;
          if (value.includes('""')) seen.doubledQuote += 1;
          if (value.includes(CRLF)) seen.embeddedCrlf += 1;
          else if (value.includes(LF)) seen.embeddedLf += 1;
          if (/\r(?!\n)/.test(value)) seen.loneCr += 1;
          if (/^0\d/.test(value)) seen.leadingZero += 1;
          if (/[^\u0000-\u007f]/.test(value)) seen.nonAscii += 1;
          if (value === '') seen.empty += 1;
          if (value !== '' && value.trim() === '') seen.whitespaceOnly += 1;
          if (value.length >= MAX_FIELD_LENGTH - 10) seen.atLengthCeiling += 1;
        }
        if (row.fields.some((field) => field.overQuoted && !mustQuote(field.value))) {
          seen.overQuoted += 1;
        }
        if (row.emptyAsDoubledQuote && values.includes('')) seen.emptyWrittenAsDoubledQuote += 1;
        if (row.fileBom) seen.fileBom += 1;
        if (values.length === 30) seen.thirtyFields += 1;

        // -- 1. Canonical direction: what the importer writes, it reads back ---
        // Each of the three record separators criterion 6 recognizes is appended
        // in turn, because a re-serialized row is only ever read back with one
        // following it. A writer that leaves a value ambiguous against its own
        // separator — a trailing carriage return written unquoted, say — is
        // invisible without this.
        const canonical = serializeRawRow(values);
        for (const separator of ['', LF, CRLF] as const) {
          const canonicalSource = `${canonical}${separator}`;
          const canonicalRead = parseRow(canonicalSource);

          expect(canonicalRead.length).toBe(values.length);
          expect(canonicalRead).toEqual(values);
          expect(normalizeAcceptable(serializeRawRow(canonicalRead))).toBe(
            normalizeAcceptable(canonicalSource),
          );
        }

        // -- 2. Round trip over an arbitrary acceptable source encoding --------
        const sourceRowText = encodeRow(row);
        const sourceWithTerminator = `${sourceRowText}${row.terminator}`;
        const storedRow = parseRow(sourceWithTerminator);

        // Field count and field order are asserted against the generated values
        // directly, never through the normalized strings, so neither can be
        // hidden by `normalizeAcceptable`.
        expect(storedRow.length).toBe(values.length);
        values.forEach((value, index) => {
          expect(storedRow[index]).toBe(value);
        });

        // The invariant itself.
        expect(normalizeAcceptable(serializeRawRow(storedRow))).toBe(
          normalizeAcceptable(sourceWithTerminator),
        );

        // -- 3. The same row read as a file through `parseCsv` -----------------
        const headerNames = values.map((_unused, index) => `Col${index + 1}`);
        // A final line of zero characters is not a record, so the single empty
        // field needs its record separator to exist in a file at all.
        const fileTerminator =
          sourceRowText === '' && row.terminator === '' ? LF : row.terminator;
        const file = [
          row.fileBom ? BOM : '',
          serializeRawRow(headerNames),
          row.headerSeparator,
          sourceRowText,
          fileTerminator,
        ].join('');

        const parsed = parseCsv(file);

        // A leading byte order mark is stripped from the first header field and
        // nowhere else (Requirement 24.6).
        expect(parsed.header).toEqual(headerNames);
        expect(parsed.rows.length).toBe(1);
        expect(parsed.rowNumbers).toEqual([1]);
        expect(parsed.rows[0].length).toBe(values.length);
        expect(parsed.rows[0]).toEqual(values);
        expect(normalizeAcceptable(serializeRawRow(parsed.rows[0]))).toBe(
          normalizeAcceptable(sourceRowText),
        );

        // -- 4. The stored row written back into a file and read again ---------
        // The full store-then-re-serialize loop of Requirement 24.2, using only
        // the module's own writer, under both record separators.
        for (const separator of [LF, CRLF] as const) {
          const rewritten = [
            serializeRawRow(headerNames),
            CRLF,
            serializeRawRow(parsed.rows[0]),
            separator,
          ].join('');
          const reread = parseCsv(rewritten);

          expect(reread.rows.length).toBe(1);
          expect(reread.rows[0].length).toBe(values.length);
          expect(reread.rows[0]).toEqual(values);
        }
      }),
      { numRuns: 200 },
    );

    for (const [shape, count] of Object.entries(seen)) {
      expect(count, `generator never produced: ${shape}`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The discrimination direction
// ---------------------------------------------------------------------------

/**
 * Pairs whose difference criterion 6 calls unacceptable. Each must normalize to
 * a *different* string; otherwise `normalizeAcceptable` is collapsing more than
 * the criterion allows and the property above passes vacuously.
 */
const UNACCEPTABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['differing field count', 'a,b', 'a,b,c'],
  ['differing field order', 'a,b', 'b,a'],
  ['differing field content', 'a,b', 'a,c'],
  ['leading whitespace', 'a,b', ' a,b'],
  ['trailing whitespace', 'a,b', 'a ,b'],
  ['letter case', 'a,b', 'A,b'],
  ['embedded LF against embedded CRLF', '"a\nb",c', '"a\r\nb",c'],
  ['embedded break against no break', '"a\nb",c', 'ab,c'],
  ['quoted comma against two fields', '"a,b"', 'a,b'],
  ['doubled quotation mark against none', '"a""b"', 'ab'],
  ['leading zeros', '007', '7'],
  ['byte order mark mid-field', 'a,\uFEFFb', 'a,b'],
];

/** Pairs whose only difference is one of the four criterion 6 acceptable ones. */
const ACCEPTABLE: ReadonlyArray<readonly [string, string, string]> = [
  ['quoting around a value that needs none', '"a",b', 'a,b'],
  ['empty value as two quotation marks', 'a,""', 'a,'],
  ['record separator as LF', 'a,b\n', 'a,b'],
  ['record separator as CRLF', 'a,b\r\n', 'a,b'],
  ['LF against CRLF as the record separator', 'a,b\n', 'a,b\r\n'],
  ['byte order mark at the start of the file', '\uFEFFa,b', 'a,b'],
];

describe('normalizeAcceptable collapses exactly the Requirement 24.6 differences', () => {
  it.each(UNACCEPTABLE)('keeps %s distinct', (_name, left, right) => {
    expect(normalizeAcceptable(left)).not.toBe(normalizeAcceptable(right));
  });

  it.each(ACCEPTABLE)('treats %s as equal', (_name, left, right) => {
    expect(normalizeAcceptable(left)).toBe(normalizeAcceptable(right));
  });

  it('retains an embedded quotation mark in the same count and position', () => {
    const source = '"Ann ""Annie"" Diaz",BWG63424074';
    const stored = parseRow(source);

    expect(stored).toEqual(['Ann "Annie" Diaz', 'BWG63424074']);
    expect(normalizeAcceptable(serializeRawRow(stored))).toBe(normalizeAcceptable(source));
  });

  it('reads a quoted value with embedded line breaks as one field of one row', () => {
    const source = '"Dear Yailen Olazaba,\nThis is the final notice.\r\nCall us today.",4243914855';
    const stored = parseRow(source);

    expect(stored.length).toBe(2);
    expect(stored[0]).toBe('Dear Yailen Olazaba,\nThis is the final notice.\r\nCall us today.');
    expect(normalizeAcceptable(serializeRawRow(stored))).toBe(normalizeAcceptable(source));
  });
});

// ---------------------------------------------------------------------------
// The two real source reports
// ---------------------------------------------------------------------------

const FIXTURE_DIR = process.env.CANCELLATION_CSV_FIXTURE_DIR ?? path.join(homedir(), 'Downloads');
const EFICACIA = path.join(FIXTURE_DIR, 'eficacia_20260731.csv');
const AVISOS = path.join(FIXTURE_DIR, 'avisos_20260731_1535.csv');
const REAL_FILES_PRESENT = existsSync(EFICACIA) && existsSync(AVISOS);

/** Rebuilds a whole file from what the reader stored. */
function rebuild(parsed: ReturnType<typeof parseCsv>): string {
  return [parsed.header, ...parsed.rows].map(serializeRawRow).join(CRLF);
}

// The two reports the requirements were written from live outside the
// repository (they carry live customer contact data, so they are not committed).
// They are asserted when reachable; set CANCELLATION_CSV_FIXTURE_DIR to point at
// them from another machine.
describe.skipIf(!REAL_FILES_PRESENT)('round trip over the real cancellation reports', () => {
  it('preserves the eficacia report', () => {
    const source = readFileSync(EFICACIA, 'utf-8');
    const parsed = parseCsv(source);

    expect(parsed.header).toEqual([
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
    expect(parsed.rows.length).toBe(58);
    expect(parsed.rowNumbers).toEqual(Array.from({ length: 58 }, (_unused, i) => i + 1));
    expect(parsed.rows.every((row) => row.length === 13)).toBe(true);

    // The file opens with a byte order mark, which is stripped from the first
    // header field and from nowhere else.
    expect(source.startsWith(BOM)).toBe(true);
    expect(parsed.header[0]).toBe('Cliente');

    // Client identifiers keep every leading zero (Requirement 24.3).
    const clienteId = parsed.header.indexOf('ClienteID');
    expect(parsed.rows.some((row) => row[clienteId] === '00010731')).toBe(true);

    // A quoted value carrying a comma survives as one field.
    expect(parsed.rows.some((row) => row.some((value) => value.includes(',')))).toBe(true);

    // Producer labels are stored verbatim, `(Deleted)` suffix included.
    const productor = parsed.header.indexOf('Productor');
    expect(parsed.rows.some((row) => row[productor] === 'LFS - Lisandro Figueroa (Deleted)')).toBe(
      true,
    );

    expect(normalizeAcceptable(rebuild(parsed))).toBe(normalizeAcceptable(source));
  });

  it('preserves the avisos report, embedded line breaks included', () => {
    const source = readFileSync(AVISOS, 'utf-8');
    const parsed = parseCsv(source);

    expect(parsed.header).toEqual([
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
    expect(parsed.rows.length).toBe(51);
    expect(parsed.rows.every((row) => row.length === 11)).toBe(true);

    // Every MensajeEmail value carries embedded line breaks, and every one of
    // them is a bare LF even though the record separator is CRLF. Retaining that
    // difference is Requirement 24.7; collapsing it would be a criterion 6
    // unacceptable difference.
    const mensajeEmail = parsed.header.indexOf('MensajeEmail');
    const bodies = parsed.rows.map((row) => row[mensajeEmail]);
    expect(bodies.filter((body) => body.includes(LF)).length).toBe(51);
    expect(bodies.filter((body) => body.includes(CRLF)).length).toBe(0);

    // Semicolon-separated contact lists are stored as written, unsplit.
    const email = parsed.header.indexOf('Email');
    const phone = parsed.header.indexOf('Phone');
    expect(parsed.rows.filter((row) => row[email].includes(';')).length).toBe(8);
    expect(parsed.rows.filter((row) => row[phone].includes(';')).length).toBe(7);

    expect(normalizeAcceptable(rebuild(parsed))).toBe(normalizeAcceptable(source));
  });
});
