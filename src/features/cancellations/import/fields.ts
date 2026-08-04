// Cancellation import: row-level field parsers.
//
// Step 3.5 of `parse -> classify -> map -> preview -> confirm -> load`. `classify.ts` decides
// which report format a file carries and where each accepted column sits; this module turns one
// row's decoded cell values into the field set of one `cancellation_cases` row, or into a
// row-level rejection carrying the source row number (Requirement 8.6).
//
// Pure module: no React, no Supabase, no network, no file system, no clock, no randomness. Every
// input arrives as a parameter, including the data row number, so nothing here has to guess where
// a row came from.
//
// Column names, the two column sets, and `CancellationColumn` are imported from `./classify`.
// `./mapping` declares its own identical copies of those lists; this file adds no third copy. The
// identity column pair is imported from `./mapping`, which is where it is already defined.
// Round-trip reading and writing come from `./csv`.
//
// What this module deliberately leaves to others:
// - `policy_number_normalized` is a generated stored column in the database
//   (`upper(regexp_replace(policy_number, '\s', '', 'g'))`), so the database owns the stored
//   normalization. `normalizePolicyNumber` reproduces that expression only for in-memory duplicate
//   detection inside one import file (Requirement 9.4); see its comment for the duplication note.
// - Splitting `Email` and `Phone` cells into Contact_Recipient rows belongs to `./contacts`.
// - Resolving a producer label to `assigned_to` needs the stored assignment mapping, so it belongs
//   to the loader. Every result here leaves the assignment unresolved (Requirement 9.7).
// - `raw_header` is one value per file, not per row, so the loader supplies it alongside `raw_row`.
//
// Storage contract this module is written against (migration `v1.10.0-cancellation-core-tables`):
// - `amount_due numeric(12,2) check (amount_due >= 0 and amount_due <= 999999999.99)`, so an
//   out-of-range, negative, or unparseable amount becomes an absent value with a recorded reason
//   rather than a value that would abort the batch (Requirement 8.15).
// - `cancellation_effective_date date not null`, so an unparseable date is a row-level rejection.
// - `raw_row jsonb not null check (jsonb_typeof(raw_row) = 'array')`, so the raw row is emitted as
//   a JSON array of decoded field values in source column order.
// - The 11 `legacy_*` columns hold passthrough values stored verbatim and excluded from derivation.

import { normalizeAcceptable, parseRow, serializeRawRow } from './csv';
import {
  columnValues,
  type CancellationColumn,
  type CancellationColumnSetId,
  type ClassifiedImportFile,
} from './classify';
import { IDENTITY_COLUMNS, resolveColumnIndex, type ConfirmedMapping } from './mapping';
import { deriveImportedStatus } from './status-mapping';

// ---------------------------------------------------------------------------
// Source column to case field, per column set
// ---------------------------------------------------------------------------

/** The `cancellation_cases` legacy passthrough columns (Requirements 8.11, 8.12). */
export type LegacyCaseColumn =
  | 'legacy_send_flag'
  | 'legacy_state'
  | 'legacy_result'
  | 'legacy_notices_sent'
  | 'legacy_first_notice'
  | 'legacy_last_notice'
  | 'legacy_days_remaining'
  | 'legacy_notice_label'
  | 'legacy_subject'
  | 'legacy_email_body'
  | 'legacy_sms_body';

/**
 * The 11 source columns stored verbatim as legacy imported values and excluded from
 * Communication_Status determination, Touchpoint scheduling, and Message_Renderer template
 * selection (Requirements 8.11, 8.12).
 *
 * Six belong to `eficacia` and five to `avisos`, so no single file carries all 11. The map is
 * declared over both sets at once because the exclusion rule is the same for every one of them.
 */
export const LEGACY_COLUMN_TARGETS: Readonly<Partial<Record<CancellationColumn, LegacyCaseColumn>>> = {
  Enviar: 'legacy_send_flag',
  Estado: 'legacy_state',
  Resultado: 'legacy_result',
  AvisosEnviados: 'legacy_notices_sent',
  PrimerAviso: 'legacy_first_notice',
  UltimoAviso: 'legacy_last_notice',
  'Days remaining': 'legacy_days_remaining',
  Aviso: 'legacy_notice_label',
  Asunto: 'legacy_subject',
  MensajeEmail: 'legacy_email_body',
  MensajeSMS: 'legacy_sms_body',
};

/** The legacy source columns in the order Requirements 8.11 and 8.12 name them. */
export const LEGACY_IMPORT_COLUMNS: readonly CancellationColumn[] = [
  'Enviar',
  'Estado',
  'Resultado',
  'AvisosEnviados',
  'PrimerAviso',
  'UltimoAviso',
  'Days remaining',
  'Aviso',
  'Asunto',
  'MensajeEmail',
  'MensajeSMS',
];

/** Every `legacy_*` case column, in the order `LEGACY_IMPORT_COLUMNS` lists their sources. */
export const LEGACY_CASE_COLUMNS: readonly LegacyCaseColumn[] = LEGACY_IMPORT_COLUMNS.map(
  (column) => LEGACY_COLUMN_TARGETS[column] as LegacyCaseColumn,
);

/**
 * True for a source column whose value is stored verbatim and read by nothing that derives
 * behavior. Exported so status derivation, Touchpoint scheduling, and template selection can name
 * the same exclusion set instead of restating it (Requirements 8.11, 8.12).
 */
export function isLegacyColumn(column: string): boolean {
  return LEGACY_COLUMN_TARGETS[column as CancellationColumn] !== undefined;
}

/** Where each authoritative case field is read from, per column set (design field mapping). */
interface AuthoritativeColumns {
  readonly customerName: CancellationColumn;
  readonly policyNumber: CancellationColumn;
  readonly carrier: CancellationColumn;
  readonly cancellationEffectiveDate: CancellationColumn;
  /** `null` for a column set that carries no amount column, which is `avisos`. */
  readonly amountDue: CancellationColumn | null;
  /** `null` for a column set that carries no producer column, which is `avisos`. */
  readonly producerLabel: CancellationColumn | null;
  /** `null` for a column set that carries no client identifier column, which is `avisos`. */
  readonly clientIdentifier: CancellationColumn | null;
}

export const AUTHORITATIVE_COLUMNS: Readonly<Record<CancellationColumnSetId, AuthoritativeColumns>> = {
  eficacia: {
    customerName: 'Cliente',
    policyNumber: IDENTITY_COLUMNS.eficacia.policyNumber,
    carrier: 'Compania',
    cancellationEffectiveDate: IDENTITY_COLUMNS.eficacia.cancellationEffectiveDate,
    amountDue: 'MontoDebido',
    producerLabel: 'Productor',
    clientIdentifier: 'ClienteID',
  },
  avisos: {
    customerName: 'Customer',
    policyNumber: IDENTITY_COLUMNS.avisos.policyNumber,
    carrier: 'Carrier',
    cancellationEffectiveDate: IDENTITY_COLUMNS.avisos.cancellationEffectiveDate,
    amountDue: null,
    producerLabel: null,
    clientIdentifier: null,
  },
};

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * The whitespace characters PostgreSQL `\s` removes in
 * `regexp_replace(policy_number, '\s', '', 'g')`: tab, line feed, vertical tab, form feed,
 * carriage return, and space. Written as an explicit class rather than JavaScript `\s`, which also
 * matches no-break space, line separator, and byte order mark and would therefore disagree with
 * the generated column.
 */
const POSTGRES_WHITESPACE = /[\t\n\v\f\r ]/g;

/** Runs of whitespace, for the collapse step of Requirements 9.6 and 9.9. */
const WHITESPACE_RUN = /\s+/g;

/** Period, comma, and quotation mark, removed by the customer name normalization of Req 9.9. */
const CUSTOMER_NAME_PUNCTUATION = /[".,]/g;

/** A decoded cell value with leading and trailing whitespace removed; `null` stays `null`. */
function trimmed(value: string | null | undefined): string | null {
  return value === null || value === undefined ? null : value.trim();
}

/** The same, collapsed to `null` when nothing but whitespace was there. */
function trimmedOrNull(value: string | null | undefined): string | null {
  const text = trimmed(value);
  return text === null || text.length === 0 ? null : text;
}

/**
 * A short quotable form of a source value for a rejection message. Rejection text is
 * manager-facing prose, so it is capped; the stored value is never truncated (Requirement 24.1).
 */
function sample(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ');
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}...`;
}

// ---------------------------------------------------------------------------
// Policy number (Requirements 8.6, 9.1)
// ---------------------------------------------------------------------------

export const POLICY_NUMBER_EMPTY_REASON = 'policy number is empty';

export type PolicyNumberResult =
  | { readonly ok: true; readonly policyNumber: string; readonly normalized: string }
  | { readonly ok: false; readonly code: 'empty'; readonly reason: string };

/**
 * The Requirement 9.1 normalized policy number: every leading, trailing, and internal whitespace
 * character removed and every lower-case letter converted to upper case, with leading zeros,
 * hyphens, and every other character preserved.
 *
 * **Duplicated expression.** `cancellation_cases.policy_number_normalized` is a generated stored
 * column computed as `upper(regexp_replace(policy_number, '\s', '', 'g'))`, and the database owns
 * the stored value. This function reproduces that expression, character class included, only so
 * the importer can detect two rows of one file sharing a case identity before any insert
 * (Requirement 9.4) and so the preview can count them. It is never written to the database. If the
 * generated column expression ever changes, this function changes with it.
 *
 * `toUpperCase` rather than `toLocaleUpperCase` keeps the fold locale-invariant.
 */
export function normalizePolicyNumber(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.replace(POSTGRES_WHITESPACE, '').toUpperCase();
}

/**
 * Reads the policy number cell. The row is rejected when the value is absent or empty after
 * leading and trailing whitespace is removed (Requirement 8.6).
 *
 * `policyNumber` is the decoded value unchanged, not the trimmed one: `cancellation_cases.
 * policy_number` stores the policy number as imported, and the generated normalized column
 * removes the whitespace for identity purposes.
 */
export function parsePolicyNumber(value: string | null | undefined): PolicyNumberResult {
  if (value === null || value === undefined || value.trim().length === 0) {
    return { ok: false, code: 'empty', reason: POLICY_NUMBER_EMPTY_REASON };
  }
  return { ok: true, policyNumber: value, normalized: normalizePolicyNumber(value) };
}

// ---------------------------------------------------------------------------
// Cancellation effective date (Requirements 8.6, 8.14, 9.1)
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD`, four-digit year with two-digit month and day (Requirement 8.14). */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `M/D/YYYY`, one-digit or two-digit month and day with a four-digit year (Requirement 8.14). */
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

export type CancellationDateAbsenceCode = 'absent' | 'unparseable_format' | 'nonexistent_date';

export type CancellationDateResult =
  | {
      readonly ok: true;
      /** The calendar date as `YYYY-MM-DD`, with no time component, ready for a `date` column. */
      readonly date: string;
      readonly year: number;
      readonly month: number;
      readonly day: number;
    }
  | { readonly ok: false; readonly code: CancellationDateAbsenceCode; readonly reason: string };

/** Proleptic Gregorian leap year, the rule PostgreSQL `date` uses. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Days in a month of a given year; `0` for a month outside 1 to 12. */
function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isLeapYear(year) ? 29 : 28;
    default:
      return 0;
  }
}

/** Two-digit zero padding for the canonical `YYYY-MM-DD` output. */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/**
 * Reads a cancellation effective date cell. Only `YYYY-MM-DD` and `M/D/YYYY` are parseable; every
 * other format, and every value naming a date the calendar does not contain, rejects the row
 * (Requirements 8.6, 8.14).
 *
 * Leading and trailing whitespace is removed before the format is matched, the same way every
 * other column value in Requirements 8 and 9 is compared, so `" 2026-07-31 "` parses. Nothing
 * inside the value is altered, so `"2026-7-31"`, `"31/07/2026"`, `"July 31, 2026"`, and a value
 * carrying a time component all stay unparseable.
 *
 * Year `0000` is rejected as a non-existent calendar date: `cancellation_effective_date` is a
 * PostgreSQL `date`, whose era boundary runs 1 BC to 1 AD with no year zero, so accepting it would
 * abort the batch rather than reject one row.
 */
export function parseCancellationDate(value: string | null | undefined): CancellationDateResult {
  const text = trimmed(value);
  if (text === null || text.length === 0) {
    return { ok: false, code: 'absent', reason: 'cancellation effective date is empty' };
  }

  const iso = ISO_DATE_PATTERN.exec(text);
  const us = US_DATE_PATTERN.exec(text);
  const parts = iso !== null
    ? { year: iso[1], month: iso[2], day: iso[3] }
    : us !== null
      ? { year: us[3], month: us[1], day: us[2] }
      : null;
  if (parts === null) {
    return {
      ok: false,
      code: 'unparseable_format',
      reason: `cancellation effective date "${sample(text)}" is not expressed as YYYY-MM-DD or M/D/YYYY`,
    };
  }

  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);

  if (year === 0 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return {
      ok: false,
      code: 'nonexistent_date',
      reason: `cancellation effective date "${sample(text)}" does not name an existing calendar date`,
    };
  }

  return {
    ok: true,
    date: `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`,
    year,
    month,
    day,
  };
}

// ---------------------------------------------------------------------------
// Amount due (Requirements 8.10, 8.15)
// ---------------------------------------------------------------------------

/**
 * The literal tokens Requirement 8.15 names, compared to the trimmed cell value exactly as
 * written. A value differing only in case, `NAN` for instance, is not one of these tokens and is
 * reported as unparseable instead; either way the stored amount is absent.
 */
export const AMOUNT_DUE_ABSENT_TOKENS: readonly string[] = ['nan', 'NaN', 'None', 'null', 'undefined'];

/**
 * The Requirement 8.10 grammar: an optional currency symbol, one or more digits with optional
 * comma thousands separators, and an optional decimal point followed by one or two digits. No
 * sign, so a negative value is unparseable, which keeps the `amount_due >= 0` check unreachable.
 * Comma groups must be well formed, so `1,23,456` is unparseable while `1234567` is not.
 */
const AMOUNT_DUE_PATTERN = /^[$€£¥]?(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

/** The inclusive range of Requirement 8.10, matching `check (amount_due between 0 and 999999999.99)`. */
export const MAX_AMOUNT_DUE_CENTS = 99_999_999_999;

export type AmountDueAbsenceCode =
  | 'column_absent'
  | 'empty'
  | 'whitespace_only'
  | 'absent_token'
  | 'unparseable'
  | 'out_of_range';

export type AmountDueResult =
  | {
      readonly present: true;
      /** The accepted amount with exactly two decimal places, for a `numeric(12,2)` column. */
      readonly amountDue: string;
      /** The same amount in whole cents, for comparison without floating point. */
      readonly cents: number;
    }
  | {
      readonly present: false;
      readonly amountDue: null;
      readonly code: AmountDueAbsenceCode;
      readonly reason: string;
      /**
       * Whether the import audit entry records this absence. Requirement 8.15 reports a cell that
       * held something unusable; a column the classified set does not carry is an absent value for
       * every row by Requirements 8.2 and 8.3 and is not worth one audit line per row.
       */
      readonly reported: boolean;
    };

function absentAmount(code: AmountDueAbsenceCode, reason: string): AmountDueResult {
  return { present: false, amountDue: null, code, reason, reported: code !== 'column_absent' };
}

/**
 * Reads an amount due cell. An accepted value is returned with two decimal places; empty,
 * whitespace-only, one of the Requirement 8.15 literal tokens, an unparseable value, and a value
 * outside 0.00 to 999,999,999.99 all return an absent amount with a reason, leaving every
 * remaining value of the row acceptable (Requirements 8.10, 8.15).
 *
 * `null` means the column is not carried by the classified set, or the row is shorter than that
 * position; the amount is absent and unreported.
 */
export function parseAmountDue(value: string | null | undefined): AmountDueResult {
  if (value === null || value === undefined) {
    return absentAmount('column_absent', 'amount due column is absent from the file');
  }
  if (value.length === 0) return absentAmount('empty', 'amount due is empty');

  const text = value.trim();
  if (text.length === 0) return absentAmount('whitespace_only', 'amount due contains only whitespace');
  if (AMOUNT_DUE_ABSENT_TOKENS.includes(text)) {
    return absentAmount('absent_token', `amount due is the literal token "${text}"`);
  }

  const match = AMOUNT_DUE_PATTERN.exec(text);
  if (match === null) {
    return absentAmount('unparseable', `amount due "${sample(text)}" is not a currency amount`);
  }

  const wholeDigits = match[1].split(',').join('').replace(/^0+(?=\d)/, '');
  const fractionDigits = (match[2] ?? '').padEnd(2, '0');
  if (wholeDigits.length > 9) {
    return absentAmount(
      'out_of_range',
      `amount due "${sample(text)}" is outside the range 0.00 to 999,999,999.99`,
    );
  }

  const cents = Number(`${wholeDigits}${fractionDigits}`);
  if (cents > MAX_AMOUNT_DUE_CENTS) {
    return absentAmount(
      'out_of_range',
      `amount due "${sample(text)}" is outside the range 0.00 to 999,999,999.99`,
    );
  }

  return { present: true, amountDue: `${wholeDigits}.${fractionDigits}`, cents };
}

// ---------------------------------------------------------------------------
// Client identifier, customer name, and the customer matching key
// ---------------------------------------------------------------------------

/**
 * The stored client identifier: the exact decoded characters with leading and trailing whitespace
 * removed and nothing else changed. No numeric conversion, no zero-stripping, no zero-padding, so
 * `"007"` stays `"007"` and never becomes `7` (Requirements 9.5, 24.3). `null` when the cell holds
 * no non-whitespace character.
 */
export function clientIdentifier(value: string | null | undefined): string | null {
  return trimmedOrNull(value);
}

/**
 * The Requirement 9.9 normalized customer name: leading and trailing whitespace removed, every run
 * of internal whitespace replaced with a single space, every period, comma, and quotation mark
 * removed, and every lower-case letter converted to upper case, applied in that order.
 *
 * The order is the requirement's. It is applied literally, so removing punctuation is the last
 * transformation and does not re-collapse the whitespace it leaves behind: `"Smith , John"`
 * normalizes to `"SMITH  JOHN"` with two spaces. The same input always yields the same key, which
 * is all Requirement 9.10 grouping needs.
 *
 * `null` when the result would hold no characters. The stored `customer_name` is left unchanged;
 * this is only the matching key (Requirement 9.9).
 */
export function normalizeCustomerName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value
    .trim()
    .replace(WHITESPACE_RUN, ' ')
    .replace(CUSTOMER_NAME_PUNCTUATION, '')
    .toUpperCase();
  return normalized.length === 0 ? null : normalized;
}

/**
 * The customer matching key: the trimmed client identifier where the cell holds at least one
 * non-whitespace character, otherwise the normalized customer name, and `null` where the key would
 * hold zero characters (Requirements 9.5, 9.9, 9.11).
 *
 * A `null` key loads the case with no matched customer and excludes it from combined message
 * grouping (Requirement 9.11).
 */
export function customerMatchKey(
  clientIdentifierValue: string | null | undefined,
  customerNameValue: string | null | undefined,
): string | null {
  return clientIdentifier(clientIdentifierValue) ?? normalizeCustomerName(customerNameValue);
}

// ---------------------------------------------------------------------------
// Producer label (Requirements 9.6, 9.7)
// ---------------------------------------------------------------------------

/** `(Deleted)` at the end of a label, matched without case sensitivity (Requirement 9.7). */
const DELETED_SUFFIX_PATTERN = /\(deleted\)$/i;

/** One `unmatched_producer_labels` entry of the import run: snake_case because it is stored as jsonb. */
export interface ProducerLabelEntry {
  readonly label: string;
  readonly row_number: number;
}

export interface ProducerLabelResult {
  /** The source label with leading and trailing whitespace removed; `null` when it held nothing. */
  readonly label: string | null;
  /** The Requirement 9.6 normalized form, the value the assignment mapping is compared against. */
  readonly normalizedLabel: string | null;
  /** True when the label ends with `(Deleted)`, matched without case sensitivity (Req 9.7). */
  readonly deleted: boolean;
  /**
   * Always `null`. Resolving a label to a profile needs the stored assignment mapping, so this
   * module never derives an assignment; the loader resolves `normalizedLabel` and records its own
   * miss with `unmatchedProducerEntry` (Requirement 9.7).
   */
  readonly assignedTo: null;
  /** The audit entry for a `(Deleted)` label, `null` otherwise. */
  readonly unmatchedEntry: ProducerLabelEntry | null;
}

/**
 * The Requirement 9.6 normalized producer label: leading and trailing whitespace removed, every run
 * of internal whitespace replaced with a single space, every lower-case letter converted to upper
 * case. Both sides of an assignment mapping comparison pass through this. `null` when the label
 * holds no non-whitespace character.
 */
export function normalizeProducerLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim().replace(WHITESPACE_RUN, ' ').toUpperCase();
  return normalized.length === 0 ? null : normalized;
}

/**
 * True when the label ends with the text `(Deleted)`, matched without case sensitivity after
 * trailing whitespace is removed (Requirement 9.7).
 */
export function hasDeletedSuffix(value: string | null | undefined): boolean {
  const text = trimmedOrNull(value);
  return text !== null && DELETED_SUFFIX_PATTERN.test(text);
}

/**
 * The import audit entry naming a producer label that produced no assignment, together with its
 * source row number (Requirement 9.7). Returns `null` for a label holding no non-whitespace
 * character, which names nothing to look up. Exported so the loader reports an assignment mapping
 * miss in the same shape this module reports a `(Deleted)` label.
 */
export function unmatchedProducerEntry(
  value: string | null | undefined,
  rowNumber: number,
): ProducerLabelEntry | null {
  const label = trimmedOrNull(value);
  return label === null ? null : { label, row_number: rowNumber };
}

/**
 * Reads a producer label cell. The assignment is always left unresolved here; a `(Deleted)` label
 * additionally carries the audit entry, because Requirement 9.7 treats it as invalid without any
 * mapping lookup. Every remaining field of the row still loads.
 */
export function parseProducerLabel(
  value: string | null | undefined,
  rowNumber: number,
): ProducerLabelResult {
  const label = trimmedOrNull(value);
  const deleted = hasDeletedSuffix(label);
  return {
    label,
    normalizedLabel: normalizeProducerLabel(label),
    deleted,
    assignedTo: null,
    unmatchedEntry: deleted ? unmatchedProducerEntry(label, rowNumber) : null,
  };
}

// ---------------------------------------------------------------------------
// Legacy passthrough (Requirements 8.11, 8.12)
// ---------------------------------------------------------------------------

/** Every `legacy_*` case column, `null` for a column the classified set does not carry. */
export type LegacyCaseValues = Readonly<Record<LegacyCaseColumn, string | null>>;

/**
 * The 11 legacy case columns read from one row's values. Each value is stored verbatim: the decoded
 * cell exactly as `csv.ts` produced it, with no trimming, no case folding, and no conversion, so an
 * embedded line break inside `MensajeEmail` survives in its source form (Requirements 8.11, 8.12,
 * 24.7).
 *
 * The returned shape carries all 11 keys for either column set, so the loader payload does not
 * change shape between an `eficacia` and an `avisos` import; the five or six columns the file does
 * not carry are `null`.
 */
export function legacyPassthrough(values: Readonly<Record<string, string | null>>): LegacyCaseValues {
  const legacy = {} as Record<LegacyCaseColumn, string | null>;
  for (const caseColumn of LEGACY_CASE_COLUMNS) legacy[caseColumn] = null;
  for (const sourceColumn of LEGACY_IMPORT_COLUMNS) {
    const caseColumn = LEGACY_COLUMN_TARGETS[sourceColumn];
    if (caseColumn === undefined) continue;
    legacy[caseColumn] = values[sourceColumn] ?? null;
  }
  return legacy;
}

// ---------------------------------------------------------------------------
// Raw row preservation self-check (Requirements 24.1, 24.2, 24.8)
// ---------------------------------------------------------------------------

/** The Requirement 24.8 rejection reason, worded as the design names it. */
export const RAW_ROW_NOT_PRESERVED_REASON = 'source row could not be preserved';

export type RawRowCheck =
  | { readonly preserved: true; readonly rawRow: string[] }
  | { readonly preserved: false; readonly reason: string };

/**
 * The pre-insert self-check of Requirement 24.8: writing the decoded field values back to a CSV row
 * must reproduce the source row, compared under the acceptable-difference set of Requirement 24
 * criterion 6.
 *
 * The comparison is `normalizeAcceptable(serializeRawRow(values)) === normalizeAcceptable(sourceRow)`,
 * built from `csv.ts` rather than restated here: `serializeRawRow` is the writer whose output
 * becomes `raw_row`, and `normalizeAcceptable` collapses exactly the four acceptable differences
 * and nothing else, so equality of the two normalized strings is equality under criterion 6.
 *
 * `sourceRow` is optional because `parseCsv` returns decoded rows rather than the source text of
 * each row. Without it the check falls back to reading the written row back with `parseRow` and
 * comparing field count, field order, and every character, which is the same guarantee criterion 2
 * states, minus any difference introduced before the values were decoded.
 *
 * A row that fails is rejected with reason `source row could not be preserved`, and no raw row and
 * no Cancellation_Case are produced for it. One real failure mode: a source row carrying an
 * unquoted line break, which reads as two records, so writing the first record back cannot
 * reproduce the source text.
 */
export function checkRawRowPreserved(
  values: readonly string[],
  sourceRow?: string | null,
): RawRowCheck {
  const rawRow = [...values];
  const written = serializeRawRow(rawRow);

  if (sourceRow !== null && sourceRow !== undefined) {
    return normalizeAcceptable(written) === normalizeAcceptable(sourceRow)
      ? { preserved: true, rawRow }
      : { preserved: false, reason: RAW_ROW_NOT_PRESERVED_REASON };
  }

  const reread = parseRow(written);
  const equal = reread.length === rawRow.length && reread.every((field, index) => field === rawRow[index]);
  return equal ? { preserved: true, rawRow } : { preserved: false, reason: RAW_ROW_NOT_PRESERVED_REASON };
}

// ---------------------------------------------------------------------------
// One row to one case field set
// ---------------------------------------------------------------------------

/** One `rejected_rows` entry of the import run: snake_case because it is stored as jsonb. */
export interface RowRejectionEntry {
  readonly row_number: number;
  readonly reason: string;
}

/** One `amount_due_absent_rows` entry of the import run. */
export interface AmountDueAbsentEntry {
  readonly row_number: number;
  readonly reason: string;
}

/** One `unmatched_customer_rows` entry of the import run. */
export interface UnmatchedCustomerEntry {
  readonly row_number: number;
}

export type RowRejectionCode = 'policy_number_empty' | 'cancellation_date_unparseable' | 'raw_row_not_preserved';

export interface RowRejection extends RowRejectionEntry {
  readonly code: RowRejectionCode;
}

/**
 * The insertable field set of one `cancellation_cases` row, keyed by database column because it is
 * passed to `cancellation_import_batch(..., p_rows jsonb)` unchanged.
 *
 * `policy_number_normalized` is absent on purpose: the database generates it. `raw_header` is
 * absent because it is one value per file. `cancellation_reason` is absent because no source column
 * of either column set carries it, so an import never sets it.
 */
export interface CancellationCaseFields extends LegacyCaseValues {
  readonly policy_number: string;
  readonly cancellation_effective_date: string;
  readonly customer_name: string | null;
  readonly client_identifier: string | null;
  readonly customer_match_key: string | null;
  readonly carrier: string | null;
  readonly amount_due: string | null;
  readonly producer_label: string | null;
  readonly source_row_number: number;
  /** Decoded field values in source column order, stored as the `raw_row` JSON array (Req 24.1). */
  readonly raw_row: string[];
  /** Derived case status for eficacia rows (REQ-2.1); null for avisos (RPC defaults to Imported). */
  readonly case_status: string | null;
}

/** The identity a row claims, for in-file duplicate detection before any insert (Requirement 9.4). */
export interface CancellationCaseIdentity {
  readonly policyNumberNormalized: string;
  readonly cancellationEffectiveDate: string;
}

/** Everything one row contributes to the import audit entry beyond its case fields. */
export interface CancellationRowNotices {
  readonly amountDueAbsent: AmountDueAbsentEntry | null;
  readonly unmatchedProducerLabel: ProducerLabelEntry | null;
  readonly unmatchedCustomer: UnmatchedCustomerEntry | null;
}

export interface CancellationRowInput {
  readonly columnSet: CancellationColumnSetId;
  /** Data row number counted from 1 for the first row after the header, from `rowNumbers` (Req 8.6). */
  readonly rowNumber: number;
  /** Canonical column to decoded value, `null` for an absent column: `columnValues(classified, row)`. */
  readonly values: Readonly<Record<string, string | null>>;
  /** The row's decoded field values in source column order, as `parseCsv` produced them. */
  readonly rawRow: readonly string[];
  /** The row's source text, where the caller kept it, for the Requirement 24.8 self-check. */
  readonly sourceRow?: string | null;
}

export type CancellationRowResult =
  | {
      readonly accepted: true;
      readonly rowNumber: number;
      readonly identity: CancellationCaseIdentity;
      readonly fields: CancellationCaseFields;
      readonly notices: CancellationRowNotices;
      /** The producer reading, so the loader can resolve the assignment it left unresolved. */
      readonly producer: ProducerLabelResult;
    }
  | { readonly accepted: false; readonly rowNumber: number; readonly rejection: RowRejection };

function readValue(
  values: Readonly<Record<string, string | null>>,
  column: CancellationColumn | null,
): string | null {
  return column === null ? null : values[column] ?? null;
}

/**
 * Parses one data row into the field set of one Cancellation_Case, or into a rejection naming the
 * data row number and the reason.
 *
 * Rejections are evaluated in a fixed order and only the first is reported, because the import run
 * records one reason per rejected row: an empty policy number, then an unparseable or non-existent
 * cancellation effective date (Requirement 8.6), then a source row that cannot be preserved
 * (Requirement 24.8). A rejected row produces no case and no raw row, and never aborts the batch
 * (Requirement 8.9).
 *
 * An accepted row carries its notices instead: an absent amount due with its reason (Requirement
 * 8.15), a `(Deleted)` producer label with its row number (Requirement 9.7), and a zero-character
 * customer matching key (Requirement 9.11). None of the three rejects the row.
 */
export function parseCancellationRow(input: CancellationRowInput): CancellationRowResult {
  const { columnSet, rowNumber, values, rawRow, sourceRow } = input;
  const columns = AUTHORITATIVE_COLUMNS[columnSet];

  const policyNumber = parsePolicyNumber(readValue(values, columns.policyNumber));
  if (!policyNumber.ok) {
    return {
      accepted: false,
      rowNumber,
      rejection: { row_number: rowNumber, reason: policyNumber.reason, code: 'policy_number_empty' },
    };
  }

  const date = parseCancellationDate(readValue(values, columns.cancellationEffectiveDate));
  if (!date.ok) {
    return {
      accepted: false,
      rowNumber,
      rejection: { row_number: rowNumber, reason: date.reason, code: 'cancellation_date_unparseable' },
    };
  }

  const preservation = checkRawRowPreserved(rawRow, sourceRow);
  if (!preservation.preserved) {
    return {
      accepted: false,
      rowNumber,
      rejection: { row_number: rowNumber, reason: preservation.reason, code: 'raw_row_not_preserved' },
    };
  }

  const customerName = readValue(values, columns.customerName);
  const clientIdentifierValue = readValue(values, columns.clientIdentifier);
  const amountDue = parseAmountDue(readValue(values, columns.amountDue));
  const producer = parseProducerLabel(readValue(values, columns.producerLabel), rowNumber);
  const matchKey = customerMatchKey(clientIdentifierValue, customerName);

  return {
    accepted: true,
    rowNumber,
    identity: {
      policyNumberNormalized: policyNumber.normalized,
      cancellationEffectiveDate: date.date,
    },
    fields: {
      policy_number: policyNumber.policyNumber,
      cancellation_effective_date: date.date,
      customer_name: customerName,
      client_identifier: clientIdentifier(clientIdentifierValue),
      customer_match_key: matchKey,
      carrier: trimmedOrNull(readValue(values, columns.carrier)),
      amount_due: amountDue.present ? amountDue.amountDue : null,
      producer_label: producer.label,
      source_row_number: rowNumber,
      raw_row: preservation.rawRow,
      case_status: columnSet === 'eficacia'
        ? deriveImportedStatus({
            enviar: readValue(values, 'Enviar'),
            estado: readValue(values, 'Estado'),
            resultado: readValue(values, 'Resultado'),
          })
        : null,
      ...legacyPassthrough(values),
    },
    notices: {
      amountDueAbsent:
        !amountDue.present && amountDue.reported
          ? { row_number: rowNumber, reason: amountDue.reason }
          : null,
      unmatchedProducerLabel: producer.unmatchedEntry,
      unmatchedCustomer: matchKey === null ? { row_number: rowNumber } : null,
    },
    producer,
  };
}

// ---------------------------------------------------------------------------
// Reading a row through a confirmed mapping
// ---------------------------------------------------------------------------

/**
 * Canonical column to decoded value for one row, read through the confirmed mapping rather than
 * through the file header, so a manager override is honored (Requirement 8.4). `null` for a column
 * no source column targets and for a row shorter than the mapped position.
 *
 * The classification path has the same reading in `columnValues(classified, row)` from
 * `classify.ts`; this is the mapping-confirmed counterpart, for the preview and the loader.
 */
export function rowValuesFromMapping(
  mapping: ConfirmedMapping,
  row: readonly string[],
): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  for (const column of Object.keys(mapping.columnIndex) as CancellationColumn[]) {
    const index = resolveColumnIndex(mapping, column);
    values[column] = index === null || index >= row.length ? null : row[index] ?? null;
  }
  return values;
}

/**
 * `parseCancellationRow` over a confirmed mapping: reads the row's values through the mapping and
 * carries the full decoded row through as `raw_row`, so every column reaches the database verbatim
 * whether or not it was mapped (Requirement 8.7).
 */
export function parseMappedRow(
  mapping: ConfirmedMapping,
  row: readonly string[],
  rowNumber: number,
  sourceRow?: string | null,
): CancellationRowResult {
  return parseCancellationRow({
    columnSet: mapping.columnSet,
    rowNumber,
    values: rowValuesFromMapping(mapping, row),
    rawRow: row,
    sourceRow,
  });
}

/**
 * `parseCancellationRow` over a classified file, reading the row's values with
 * `columnValues(classified, row)` from `classify.ts`. Used before a mapping is confirmed, which is
 * what the preview counts run on.
 */
export function parseClassifiedRow(
  classified: ClassifiedImportFile,
  row: readonly string[],
  rowNumber: number,
  sourceRow?: string | null,
): CancellationRowResult {
  return parseCancellationRow({
    columnSet: classified.columnSet,
    rowNumber,
    values: columnValues(classified, row),
    rawRow: row,
    sourceRow,
  });
}
