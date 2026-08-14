// Cancellation import: column-set classification and file-level validation.
//
// Step 2 of `parse -> classify -> map -> preview -> confirm -> load`. This module decides
// which of the two known cancellation report formats an uploaded file carries, resolves
// where each accepted column sits in the file header, and rejects a whole file that cannot
// be imported at all (Requirements 8.1, 8.2, 8.3, 8.13).
//
// Pure module: no React, no Supabase, no network, no file system, and no clock. Every input
// arrives as a parameter, so the caller owns reading the upload and measuring its size.
//
// Row-level validation (empty policy number, unparseable date, amount due) is not this
// module's job; it belongs to `fields.ts` and `preview.ts`.

import { headerMatchKey } from '../../nhwd-shared/header-matching';

// ---------------------------------------------------------------------------
// Column sets
// ---------------------------------------------------------------------------

/** The `eficacia` accepted columns in source order (Req 8.2). */
export const EFICACIA_COLUMNS = [
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
] as const;

/** The `avisos` accepted columns in source order (Req 8.3). */
export const AVISOS_COLUMNS = [
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
] as const;

export type EficaciaColumn = (typeof EFICACIA_COLUMNS)[number];
export type AvisosColumn = (typeof AVISOS_COLUMNS)[number];
export type CancellationColumn = EficaciaColumn | AvisosColumn;

/** The two report formats the importer recognizes. */
export type CancellationColumnSetId = 'eficacia' | 'avisos';

/** What a header row must and must not contain for one column set to be recognized. */
export interface ColumnSetRequirement {
  readonly columnSet: CancellationColumnSetId;
  /** Every one of these must appear in the header row (trimmed, case-insensitive). */
  readonly requiredColumns: readonly string[];
  /** None of these may appear in the header row. */
  readonly disallowedColumns: readonly string[];
  /** The full set of columns the importer reads once this format is classified. */
  readonly acceptedColumns: readonly string[];
}

/**
 * Detection rules in evaluation order. `eficacia` is tested first, so a header carrying
 * `Poliza` can never be read as `avisos` (Req 8.3).
 */
export const COLUMN_SET_REQUIREMENTS: readonly ColumnSetRequirement[] = [
  {
    columnSet: 'eficacia',
    requiredColumns: ['Poliza', 'FechaCancelacion'],
    // `PolizaNormalizada` belongs to the consolidated PendingCancellation collector export, which
    // also carries `Poliza` and `FechaCancelacion` and would otherwise classify here. A collector
    // file merged under eficacia field ownership would silently drop the fields only the collector
    // carries, so this path refuses it and the manager uses the collector upload instead.
    disallowedColumns: ['PolizaNormalizada'],
    acceptedColumns: EFICACIA_COLUMNS,
  },
  {
    columnSet: 'avisos',
    requiredColumns: ['Policy number', 'Cancellation date'],
    disallowedColumns: ['Poliza'],
    acceptedColumns: AVISOS_COLUMNS,
  },
];

// ---------------------------------------------------------------------------
// File-level limits (Req 8.1)
// ---------------------------------------------------------------------------

/** One megabyte, matching the repository's existing file-size convention. */
const BYTES_PER_MEGABYTE = 1_048_576;

/** An uploaded cancellation report may be no larger than 25 megabytes (Req 8.1, 8.13). */
export const MAX_IMPORT_FILE_BYTES = 25 * BYTES_PER_MEGABYTE;

/** An uploaded cancellation report must carry at least this many data rows (Req 8.1, 8.13). */
export const MIN_IMPORT_DATA_ROWS = 1;

/** An uploaded cancellation report may carry at most this many data rows (Req 8.1, 8.13). */
export const MAX_IMPORT_DATA_ROWS = 20_000;

/** The limits reported alongside every file rejection so the manager sees the boundary. */
export interface ImportFileLimits {
  readonly maxBytes: number;
  readonly minDataRows: number;
  readonly maxDataRows: number;
}

const IMPORT_FILE_LIMITS: ImportFileLimits = {
  maxBytes: MAX_IMPORT_FILE_BYTES,
  minDataRows: MIN_IMPORT_DATA_ROWS,
  maxDataRows: MAX_IMPORT_DATA_ROWS,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/**
 * The shape `parseCsv` in `csv.ts` returns, declared structurally so this module stays
 * independent of that file. `{ header: string[]; rows: string[][]; rowNumbers: number[] }`
 * is assignable to it.
 */
export interface ParsedCancellationCsv {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ClassifyImportFileInput {
  /** The header row exactly as parsed, values untrimmed. */
  readonly header: readonly string[];
  /** The count of rows below the header row. */
  readonly dataRowCount: number;
  /** The uploaded file size in bytes, or `null` when the caller could not measure it. */
  readonly byteSize: number | null;
}

/** A file that passed every file-level condition and was classified. */
export interface ClassifiedImportFile {
  readonly ok: true;
  readonly columnSet: CancellationColumnSetId;
  /** The file header row, unchanged. */
  readonly header: readonly string[];
  /** Every column of the classified set, in canonical order. */
  readonly acceptedColumns: readonly string[];
  /**
   * Canonical column name to its position in the file header, `null` for a column of the
   * classified set that the header does not carry. A `null` index yields an absent value
   * for every row (Req 8.2, 8.3).
   */
  readonly columnIndexes: Readonly<Record<string, number | null>>;
  /** Columns of the classified set found in the header, in canonical order. */
  readonly presentColumns: readonly string[];
  /** Columns of the classified set missing from the header, in canonical order. */
  readonly absentColumns: readonly string[];
  readonly dataRowCount: number;
  readonly byteSize: number | null;
}

/** Which file-level condition of Requirement 8.13 was not met. */
export type ImportFileRejectionCode =
  | 'unrecognized_header_set'
  | 'file_too_large'
  | 'no_data_rows'
  | 'too_many_data_rows';

/**
 * A whole-file rejection. Structured rather than a bare string so the manager import wizard
 * can render the unmet condition, the required column names, the limit, and what the file
 * actually carried (Req 8.13).
 */
export interface ImportFileRejection {
  readonly ok: false;
  readonly code: ImportFileRejectionCode;
  /** The condition the file failed to meet, in one manager-facing sentence. */
  readonly unmetCondition: string;
  /** The detection requirement of both formats, including each full accepted column set. */
  readonly requiredColumnSets: readonly ColumnSetRequirement[];
  /** Every required column name across both formats, de-duplicated, for a flat list. */
  readonly requiredColumnNames: readonly string[];
  readonly limits: ImportFileLimits;
  /** What the file carried, so the manager can compare it with the limit. */
  readonly observed: {
    readonly byteSize: number | null;
    readonly dataRowCount: number;
    readonly header: readonly string[];
  };
  /** The unmet condition followed by the required column names, ready to display. */
  readonly message: string;
}

export type ClassifyImportFileResult = ClassifiedImportFile | ImportFileRejection;

// ---------------------------------------------------------------------------
// Header matching
// ---------------------------------------------------------------------------

/**
 * Header comparison key. Every column match in Requirements 8.2, 8.3, and 8.4 is defined this
 * way, and `mapping.ts` uses the same key for its proposals.
 *
 * Delegates to `headerMatchKey`, which folds away a byte order mark, letter case, accents,
 * punctuation, inner and outer whitespace, CamelCase versus spaced words, and the filler words
 * `de`/`del`/`la`/`el`/`los`/`las`/`of`/`the`. That is what lets these Spanish reports classify
 * without a manager renaming columns first: `Póliza`, `POLIZA`, and `Poliza` are one name, and
 * so are `FechaCancelacion`, `Fecha Cancelación`, and `Fecha de Cancelacion`.
 *
 * **Classification reads names, never aliases.** `mapping.ts` additionally accepts a table of
 * different words for the same column (`Aseguradora` for `Compania`, and each set's names in
 * the other language), and that table is deliberately not consulted here. The two formats are
 * told apart by `Poliza` versus `Policy number`; treating those as equivalent would classify an
 * avisos file as eficacia, and the source-aware merge in `cancellation_import_batch` would then
 * give avisos data eficacia field ownership and overwrite columns avisos never carried. A file
 * whose identity columns are named something neither format uses is refused as unrecognized,
 * which is recoverable, rather than merged under the wrong ownership, which is not.
 */
export function normalizeHeaderName(value: string): string {
  return headerMatchKey(value);
}

/** True when the header row carries a cell equal to `columnName` under `normalizeHeaderName`. */
export function headerHasColumn(header: readonly string[], columnName: string): boolean {
  return findHeaderIndex(header, columnName) !== null;
}

/** The lowest header position equal to `columnName`, or `null`. A repeated header keeps its first position. */
function findHeaderIndex(header: readonly string[], columnName: string): number | null {
  const target = normalizeHeaderName(columnName);
  for (let index = 0; index < header.length; index += 1) {
    if (normalizeHeaderName(header[index] ?? '') === target) return index;
  }
  return null;
}

/**
 * The column set a header row identifies, or `null` when it identifies neither (Req 8.2, 8.3).
 * `Poliza` with `FechaCancelacion` is `eficacia`; `Policy number` with `Cancellation date` and
 * no `Poliza` is `avisos`.
 */
export function classifyHeader(header: readonly string[]): CancellationColumnSetId | null {
  for (const requirement of COLUMN_SET_REQUIREMENTS) {
    const required = requirement.requiredColumns.every((column) => headerHasColumn(header, column));
    const disallowed = requirement.disallowedColumns.some((column) => headerHasColumn(header, column));
    if (required && !disallowed) return requirement.columnSet;
  }
  return null;
}

/** The accepted columns of a column set, in canonical order. */
export function acceptedColumnsOf(columnSet: CancellationColumnSetId): readonly string[] {
  return columnSet === 'eficacia' ? EFICACIA_COLUMNS : AVISOS_COLUMNS;
}

/**
 * Canonical column to header position for a column set, `null` for a column the header does
 * not carry (Req 8.2, 8.3).
 */
export function resolveColumnIndexes(
  header: readonly string[],
  columnSet: CancellationColumnSetId,
): Record<string, number | null> {
  const indexes: Record<string, number | null> = {};
  for (const column of acceptedColumnsOf(columnSet)) {
    indexes[column] = findHeaderIndex(header, column);
  }
  return indexes;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify an uploaded cancellation report and apply every file-level condition of
 * Requirements 8.1 and 8.13.
 *
 * Conditions are evaluated in this order, and the first unmet one is reported: file size,
 * then header recognition, then zero data rows, then too many data rows. Size comes first
 * because an oversized file need never be parsed; header recognition comes before the row
 * counts because an empty file's real problem is that it names no format.
 *
 * A `null` `byteSize` means the caller could not measure the upload, so the size condition is
 * not evaluated and `observed.byteSize` stays `null`. A negative or non-finite
 * `dataRowCount` counts as zero rows.
 */
export function classifyImportFile(input: ClassifyImportFileInput): ClassifyImportFileResult {
  const header = input.header;
  const rawByteSize = input.byteSize;
  const byteSize = typeof rawByteSize === 'number' && Number.isFinite(rawByteSize) && rawByteSize >= 0
    ? rawByteSize
    : null;
  const dataRowCount = Number.isFinite(input.dataRowCount) && input.dataRowCount > 0
    ? Math.trunc(input.dataRowCount)
    : 0;

  if (byteSize !== null && byteSize > MAX_IMPORT_FILE_BYTES) {
    return reject(
      'file_too_large',
      `The file is ${megabytes(byteSize)}, larger than the ${megabytes(MAX_IMPORT_FILE_BYTES)} limit for a cancellation report.`,
      { byteSize, dataRowCount, header },
    );
  }

  const columnSet = classifyHeader(header);
  if (columnSet === null) {
    return reject(
      'unrecognized_header_set',
      'The header row names neither cancellation report format.',
      { byteSize, dataRowCount, header },
    );
  }

  if (dataRowCount < MIN_IMPORT_DATA_ROWS) {
    return reject(
      'no_data_rows',
      `The file carries no data rows below the header row. A cancellation report must carry ${MIN_IMPORT_DATA_ROWS} to ${formatCount(MAX_IMPORT_DATA_ROWS)} data rows.`,
      { byteSize, dataRowCount, header },
    );
  }

  if (dataRowCount > MAX_IMPORT_DATA_ROWS) {
    return reject(
      'too_many_data_rows',
      `The file carries ${formatCount(dataRowCount)} data rows, more than the ${formatCount(MAX_IMPORT_DATA_ROWS)} row limit for a cancellation report.`,
      { byteSize, dataRowCount, header },
    );
  }

  const acceptedColumns = acceptedColumnsOf(columnSet);
  const columnIndexes = resolveColumnIndexes(header, columnSet);

  return {
    ok: true,
    columnSet,
    header,
    acceptedColumns,
    columnIndexes,
    presentColumns: acceptedColumns.filter((column) => columnIndexes[column] !== null),
    absentColumns: acceptedColumns.filter((column) => columnIndexes[column] === null),
    dataRowCount,
    byteSize,
  };
}

/** `classifyImportFile` over a parsed file, taking the data row count from the parsed rows. */
export function classifyParsedFile(
  parsed: ParsedCancellationCsv,
  byteSize: number | null,
): ClassifyImportFileResult {
  return classifyImportFile({
    header: parsed.header,
    dataRowCount: parsed.rows.length,
    byteSize,
  });
}

// ---------------------------------------------------------------------------
// Reading a classified row
// ---------------------------------------------------------------------------

/** The header position of a canonical column, `null` when the header does not carry it. */
export function columnIndex(classified: ClassifiedImportFile, column: string): number | null {
  return classified.columnIndexes[column] ?? null;
}

/**
 * The value a row holds for a canonical column of the classified set.
 *
 * Returns `null`, an absent value, when the column is missing from the header row (Req 8.2,
 * 8.3), when the row carries fewer fields than that position, or when the name is not a
 * column of the classified set. An empty string is a present value, not an absent one; the
 * row-level parsers decide what an empty cell means.
 */
export function columnValue(
  classified: ClassifiedImportFile,
  row: readonly string[],
  column: string,
): string | null {
  const index = columnIndex(classified, column);
  if (index === null || index >= row.length) return null;
  return row[index] ?? null;
}

/** Every canonical column of the classified set mapped to that row's value, absent columns `null`. */
export function columnValues(
  classified: ClassifiedImportFile,
  row: readonly string[],
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const column of classified.acceptedColumns) {
    values[column] = columnValue(classified, row, column);
  }
  return values;
}

// ---------------------------------------------------------------------------
// Rejection construction
// ---------------------------------------------------------------------------

/** Every required column name across both formats, de-duplicated, in detection order. */
export function requiredColumnNames(): readonly string[] {
  const names: string[] = [];
  for (const requirement of COLUMN_SET_REQUIREMENTS) {
    for (const column of requirement.requiredColumns) {
      if (!names.includes(column)) names.push(column);
    }
  }
  return names;
}

/** "Required columns: ..." naming what each format must carry, appended to every rejection (Req 8.13). */
export function requiredColumnsSentence(): string {
  const clauses = COLUMN_SET_REQUIREMENTS.map(
    (requirement) => `the ${requirement.columnSet} format requires ${joinList(requirement.requiredColumns)}`,
  );
  return `Required columns: ${clauses.join('; ')}.`;
}

function reject(
  code: ImportFileRejectionCode,
  unmetCondition: string,
  observed: { byteSize: number | null; dataRowCount: number; header: readonly string[] },
): ImportFileRejection {
  return {
    ok: false,
    code,
    unmetCondition,
    requiredColumnSets: COLUMN_SET_REQUIREMENTS,
    requiredColumnNames: requiredColumnNames(),
    limits: IMPORT_FILE_LIMITS,
    observed,
    message: `${unmetCondition} ${requiredColumnsSentence()}`,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** A byte count in megabytes to one decimal place, trailing `.0` dropped. */
function megabytes(bytes: number): string {
  const value = bytes / BYTES_PER_MEGABYTE;
  const text = value.toFixed(1);
  return `${text.endsWith('.0') ? text.slice(0, -2) : text} MB`;
}

/** A row count with comma thousands separators. */
function formatCount(count: number): string {
  return count.toLocaleString('en-US');
}

/** `a`, `a and b`, `a, b, and c`. */
function joinList(values: readonly string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(', ')}, and ${values[values.length - 1]}`;
}
