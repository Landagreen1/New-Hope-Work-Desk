// Policy Follow-up: the canonical collector file contracts.
//
// The desktop collector programs remain the data-collection layer; Work Desk does not scrape
// carrier portals. Each collector emits exactly one consolidated CSV per domain with a fixed
// header, so a manager uploads a file and confirms — there is no column-mapping step for these two
// formats (Requirements 2.1, 2.2, 2.3).
//
// This module is the parser and the previewer. It:
//   * recognizes the two canonical headers exactly, by name;
//   * reads each row into a normalized shape while preserving the raw row, file name, row number,
//     raw carrier value, raw record type, match status/method, and collector warning (Req 1.1);
//   * interprets Spanish/carrier wording through `./normalization` and never in the UI (Req 1.2);
//   * computes every preview count Requirement 2.3 asks a manager to confirm before any mutation.
//
// It performs no mutation and holds no client. The importer surface hands its output to the
// existing domain import RPCs (design 11.1, 11.2).
//
// Pure module: no React, no Supabase, no network, no file system, no clock.

import {
  foldSourceValue,
  normalizeCarrierKey,
  normalizeMatch,
  normalizePolicyNumber,
  normalizeSourceState,
  policyIdentity,
  policyReviewReasons,
  trimToNull,
  type NormalizedMatch,
  type NormalizedSourceState,
  type PolicyIdentity,
  type PolicyMatchConfidence,
  type PolicyReviewReason,
  type PolicySourceState,
} from './normalization';

// ---------------------------------------------------------------------------
// The two canonical headers (Requirements 2.1, 2.2)
// ---------------------------------------------------------------------------

/** The 26 columns of the consolidated Renewals collector CSV, in source order (Req 2.1). */
export const RENEWAL_COLLECTOR_COLUMNS = [
  'Compania',
  'Poliza',
  'PolizaNormalizada',
  'Asegurado',
  'LOB',
  'TerminoMeses',
  'FechaRenovacion',
  'FechaVencimiento',
  'FechaProcesada',
  'PrimaRenovacion',
  'PrimaAnterior',
  'TipoRegistro',
  'EstadoEnReporte',
  'ClienteID',
  'Titular',
  'Telefonos',
  'Emails',
  'EstadoHawkSoft',
  'ActivaEnHawkSoft',
  'PrimaHawkSoft',
  'Productor',
  'Cruce',
  'MetodoCruce',
  'ArchivoOrigen',
  'FilaOrigen',
  'AvisosImportacion',
] as const;

/** The 24 columns of the consolidated PendingCancellation collector CSV, in source order (Req 2.2). */
export const CANCELLATION_COLLECTOR_COLUMNS = [
  'Compania',
  'Poliza',
  'PolizaNormalizada',
  'Asegurado',
  'LOB',
  'FechaCancelacion',
  'FechaCancelacionEstimada',
  'FechaVencimientoPago',
  'MontoAdeudado',
  'TipoTransaccion',
  'EstadoCarrier',
  'TipoRegistro',
  'ClienteID',
  'Titular',
  'Telefonos',
  'Emails',
  'EstadoHawkSoft',
  'Productor',
  'Idioma',
  'Cruce',
  'MetodoCruce',
  'ArchivoOrigen',
  'FilaOrigen',
  'AvisosImportacion',
] as const;

export type CollectorDomain = 'renewal' | 'cancellation';

/**
 * The column set identifier this module hands the cancellation import RPC.
 *
 * The legacy two-file path keeps `'eficacia'` and `'avisos'`; a consolidated collector file is a
 * third source that owns *every* field it carries, contacts included, so it needs its own value
 * rather than pretending to be one of the two halves (design 11.2).
 */
export const CANCELLATION_COLLECTOR_COLUMN_SET = 'collector';

/**
 * The column set identifier this module hands the renewal import RPC.
 *
 * Requirement 11.2 and design 11.1 both forbid labelling a collector row `powerbi`: the assignment
 * and lineage answers differ, and a manager reading the record must be able to tell which importer
 * wrote it.
 */
export const RENEWAL_COLLECTOR_SOURCE_SYSTEM = 'renewal_collector';

/** What a header row must carry for one collector format to be recognized. */
interface CollectorRequirement {
  readonly domain: CollectorDomain;
  readonly requiredColumns: readonly string[];
  readonly disallowedColumns: readonly string[];
  readonly columns: readonly string[];
}

/**
 * Detection rules in evaluation order.
 *
 * Both formats are identified by columns the legacy cancellation reports do not carry —
 * `PolizaNormalizada`, `TipoRegistro`, and `Cruce` — so a collector file can never be read as
 * `eficacia` and an `eficacia` file can never be read as a collector export. The renewals format
 * additionally requires `FechaRenovacion` and forbids `FechaCancelacion`, and the cancellations
 * format the reverse, so the two collector exports cannot be confused with each other either.
 */
export const COLLECTOR_REQUIREMENTS: readonly CollectorRequirement[] = [
  {
    domain: 'renewal',
    requiredColumns: ['Poliza', 'PolizaNormalizada', 'FechaRenovacion', 'TipoRegistro', 'Cruce'],
    disallowedColumns: ['FechaCancelacion'],
    columns: RENEWAL_COLLECTOR_COLUMNS,
  },
  {
    domain: 'cancellation',
    requiredColumns: ['Poliza', 'PolizaNormalizada', 'FechaCancelacion', 'TipoRegistro', 'Cruce'],
    disallowedColumns: ['FechaRenovacion'],
    columns: CANCELLATION_COLLECTOR_COLUMNS,
  },
];

/** Header comparison: leading and trailing whitespace removed, case folded, accents removed. */
export function normalizeCollectorHeader(value: string): string {
  return foldSourceValue(value);
}

/** The lowest header position equal to `column`, or `null`. A repeated header keeps its first. */
function headerIndex(header: readonly string[], column: string): number | null {
  const target = normalizeCollectorHeader(column);
  for (let index = 0; index < header.length; index += 1) {
    if (normalizeCollectorHeader(header[index] ?? '') === target) return index;
  }
  return null;
}

/** The collector domain a header row identifies, or `null` when it identifies neither (Req 2.1, 2.2). */
export function classifyCollectorHeader(header: readonly string[]): CollectorDomain | null {
  for (const requirement of COLLECTOR_REQUIREMENTS) {
    const required = requirement.requiredColumns.every((column) => headerIndex(header, column) !== null);
    const disallowed = requirement.disallowedColumns.some((column) => headerIndex(header, column) !== null);
    if (required && !disallowed) return requirement.domain;
  }
  return null;
}

/** The canonical columns of a collector domain, in source order. */
export function collectorColumns(domain: CollectorDomain): readonly string[] {
  return domain === 'renewal' ? RENEWAL_COLLECTOR_COLUMNS : CANCELLATION_COLLECTOR_COLUMNS;
}

/** A recognized collector file: the domain, the header, and where each canonical column sits. */
export interface ClassifiedCollectorFile {
  readonly ok: true;
  readonly domain: CollectorDomain;
  readonly fileName: string;
  readonly header: readonly string[];
  readonly columns: readonly string[];
  /** Canonical column to header position, `null` for a canonical column the header omits. */
  readonly columnIndexes: Readonly<Record<string, number | null>>;
  readonly presentColumns: readonly string[];
  readonly absentColumns: readonly string[];
  readonly dataRowCount: number;
}

export type CollectorRejectionCode = 'unrecognized_header' | 'no_data_rows' | 'too_many_data_rows';

export interface CollectorRejection {
  readonly ok: false;
  readonly code: CollectorRejectionCode;
  readonly message: string;
  readonly header: readonly string[];
  readonly dataRowCount: number;
}

export type ClassifyCollectorResult = ClassifiedCollectorFile | CollectorRejection;

/** A collector export must carry at least this many data rows. */
export const MIN_COLLECTOR_DATA_ROWS = 1;

/**
 * A collector export may carry at most this many data rows.
 *
 * The consolidated renewals sample evaluated while this spec was written held 1,118 rows. That
 * count is deliberately *not* encoded anywhere in this module — a collector run is as large as the
 * agency's book that week — so the cap is the same 20,000 the cancellation importer already
 * applies, which is a file-sanity bound rather than a business expectation.
 */
export const MAX_COLLECTOR_DATA_ROWS = 20_000;

/** Recognize an uploaded collector export (Requirements 2.1, 2.2). */
export function classifyCollectorFile(input: {
  fileName: string;
  header: readonly string[];
  dataRowCount: number;
}): ClassifyCollectorResult {
  const header = input.header;
  const dataRowCount = Number.isFinite(input.dataRowCount) && input.dataRowCount > 0
    ? Math.trunc(input.dataRowCount)
    : 0;

  const domain = classifyCollectorHeader(header);
  if (domain === null) {
    return {
      ok: false,
      code: 'unrecognized_header',
      message:
        'The header row names neither collector export. The Renewals export requires Poliza, '
        + 'PolizaNormalizada, FechaRenovacion, TipoRegistro, and Cruce; the Pending Cancellation '
        + 'export requires Poliza, PolizaNormalizada, FechaCancelacion, TipoRegistro, and Cruce.',
      header,
      dataRowCount,
    };
  }

  if (dataRowCount < MIN_COLLECTOR_DATA_ROWS) {
    return {
      ok: false,
      code: 'no_data_rows',
      message: 'The file carries no data rows below the header row. Nothing was imported.',
      header,
      dataRowCount,
    };
  }

  if (dataRowCount > MAX_COLLECTOR_DATA_ROWS) {
    return {
      ok: false,
      code: 'too_many_data_rows',
      message:
        `The file carries ${dataRowCount.toLocaleString('en-US')} data rows, more than the `
        + `${MAX_COLLECTOR_DATA_ROWS.toLocaleString('en-US')} row limit. Nothing was imported.`,
      header,
      dataRowCount,
    };
  }

  const columns = collectorColumns(domain);
  const columnIndexes: Record<string, number | null> = {};
  for (const column of columns) columnIndexes[column] = headerIndex(header, column);

  return {
    ok: true,
    domain,
    fileName: input.fileName,
    header,
    columns,
    columnIndexes,
    presentColumns: columns.filter((column) => columnIndexes[column] !== null),
    absentColumns: columns.filter((column) => columnIndexes[column] === null),
    dataRowCount,
  };
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;
const SLASHED_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
const AMOUNT_NOISE = /[^0-9.\-]/g;

/**
 * A source date as the canonical `YYYY-MM-DD`, or `null` when the value names no calendar date.
 *
 * Both shapes a collector run produces are accepted: an ISO date, and the `M/D/YYYY` a Windows
 * locale export writes. A two-digit year is read as 20xx, which is the same rule the renewals
 * importer already applies to its own CSV.
 */
export function parseCollectorDate(value: string | null | undefined): string | null {
  const text = trimToNull(value);
  if (text === null) return null;

  const iso = ISO_DATE.exec(text);
  if (iso !== null) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slashed = SLASHED_DATE.exec(text);
  if (slashed === null) return null;
  const month = Number(slashed[1]);
  const day = Number(slashed[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const rawYear = slashed[3];
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear.padStart(4, '0');
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** A source money value as a finite number, or `null` when the value names no amount. */
export function parseCollectorAmount(value: string | null | undefined): number | null {
  const text = trimToNull(value);
  if (text === null) return null;
  const cleaned = text.replace(AMOUNT_NOISE, '');
  if (cleaned.length === 0 || cleaned === '-' || cleaned === '.') return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A source integer as a whole number, or `null`. */
export function parseCollectorInteger(value: string | null | undefined): number | null {
  const parsed = parseCollectorAmount(value);
  return parsed === null ? null : Math.trunc(parsed);
}

const TRUE_VALUES: ReadonlySet<string> = new Set(['si', 'sí', 'yes', 'true', '1', 'y', 'activa', 'active']);
const FALSE_VALUES: ReadonlySet<string> = new Set(['no', 'false', '0', 'n', 'inactiva', 'inactive']);

/** A source boolean, or `null` where the cell is empty or names neither value. */
export function parseCollectorBoolean(value: string | null | undefined): boolean | null {
  const text = trimToNull(value);
  if (text === null) return null;
  const folded = foldSourceValue(text);
  if (TRUE_VALUES.has(folded)) return true;
  if (FALSE_VALUES.has(folded)) return false;
  return null;
}

/**
 * The multi-value contact cells split into segments.
 *
 * `Telefonos` and `Emails` carry several values in one cell, separated by whatever the collector
 * build used. Splitting is the only thing done here; validation, E.164 normalization, dedup, and
 * the per-case cap all belong to the cancellation importer's `import/contacts.ts`, which already
 * owns those rules.
 */
export function splitCollectorSegments(value: string | null | undefined): string[] {
  const text = trimToNull(value);
  if (text === null) return [];
  return text
    .split(/[;,|/\n\r]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** The value a row holds for one canonical column, `null` for an absent column or short row. */
export function collectorValue(
  classified: ClassifiedCollectorFile,
  row: readonly string[],
  column: string,
): string | null {
  const index = classified.columnIndexes[column] ?? null;
  if (index === null || index >= row.length) return null;
  return row[index] ?? null;
}

// ---------------------------------------------------------------------------
// Source lineage (Requirement 1.1)
// ---------------------------------------------------------------------------

/**
 * Everything Requirement 1.1 requires be retained for audit, per row.
 *
 * `payload` is the row as an ordered array of decoded values paired with the file header, matching
 * the `raw_row` + `raw_header` convention `cancellation_cases` already stores: a JSON object would
 * not preserve field order, and the collector's own `ArchivoOrigen`/`FilaOrigen` values point back
 * into the carrier report the collector itself read.
 */
export interface CollectorLineage {
  /** The uploaded file name. */
  fileName: string;
  /** The data row number, counted from 1 for the first row below the header. */
  rowNumber: number;
  /** The row exactly as decoded, in header order. */
  payload: readonly string[];
  /** The file header, in source order. */
  header: readonly string[];
  /** `Compania` exactly as written. */
  rawCarrier: string | null;
  /** `TipoRegistro` exactly as written. */
  rawRecordType: string | null;
  /** `EstadoEnReporte` / `EstadoCarrier` exactly as written. */
  rawCarrierStatus: string | null;
  /** `Cruce` exactly as written. */
  rawMatchStatus: string | null;
  /** `MetodoCruce` exactly as written. */
  rawMatchMethod: string | null;
  /** `ArchivoOrigen`: the carrier report the collector read, upstream of this consolidated file. */
  upstreamFileName: string | null;
  /** `FilaOrigen`: the row number inside that upstream report. */
  upstreamRowNumber: number | null;
  /** `AvisosImportacion`: the collector's own warning text. */
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Normalized rows
// ---------------------------------------------------------------------------

/** What every collector row of either domain resolves to, before domain-specific fields. */
interface CollectorRowBase {
  rowNumber: number;
  /** `null` where the row carries no carrier and no policy, so it owns no shared identity. */
  identity: PolicyIdentity | null;
  carrier: string | null;
  policyNumber: string | null;
  policyNumberNormalized: string | null;
  /** `PolizaNormalizada` as the collector computed it, retained for audit comparison. */
  collectorPolicyNormalized: string | null;
  customerName: string | null;
  namedInsured: string | null;
  lineOfBusiness: string | null;
  hawksoftClientId: string | null;
  phones: readonly string[];
  emails: readonly string[];
  producerLabel: string | null;
  sourceState: NormalizedSourceState;
  match: NormalizedMatch;
  reviewReasons: readonly PolicyReviewReason[];
  /** True where automatic customer communication is withheld (Requirements 1.4, 12.2). */
  communicationBlocked: boolean;
  lineage: CollectorLineage;
  /** Why the row cannot be imported at all, or `null`. A rejected row aborts nothing. */
  rejection: string | null;
}

export interface RenewalCollectorRow extends CollectorRowBase {
  domain: 'renewal';
  renewalDate: string | null;
  expirationDate: string | null;
  processedDate: string | null;
  termMonths: number | null;
  premiumRenewal: number | null;
  premiumPrior: number | null;
  premiumHawksoft: number | null;
  hawksoftStatus: string | null;
  activeInHawksoft: boolean | null;
}

export interface CancellationCollectorRow extends CollectorRowBase {
  domain: 'cancellation';
  /** The carrier-confirmed effective date, or `null` when only an estimate exists. */
  cancellationDate: string | null;
  /** The collector's estimated effective date. */
  estimatedCancellationDate: string | null;
  /** The date the case is scheduled against: the confirmed date, else the estimate (Req 8.3). */
  effectiveDate: string | null;
  /** True where `effectiveDate` came from the estimate (Requirement 8.3). */
  effectiveDateIsEstimated: boolean;
  paymentDueDate: string | null;
  amountDue: number | null;
  transactionType: string | null;
  carrierStatus: string | null;
  hawksoftStatus: string | null;
  language: string | null;
}

export type CollectorRow = RenewalCollectorRow | CancellationCollectorRow;

function lineageFor(
  classified: ClassifiedCollectorFile,
  row: readonly string[],
  rowNumber: number,
  carrierStatusColumn: string,
): CollectorLineage {
  return {
    fileName: classified.fileName,
    rowNumber,
    payload: classified.header.map((_, index) => row[index] ?? ''),
    header: classified.header,
    rawCarrier: trimToNull(collectorValue(classified, row, 'Compania')),
    rawRecordType: trimToNull(collectorValue(classified, row, 'TipoRegistro')),
    rawCarrierStatus: trimToNull(collectorValue(classified, row, carrierStatusColumn)),
    rawMatchStatus: trimToNull(collectorValue(classified, row, 'Cruce')),
    rawMatchMethod: trimToNull(collectorValue(classified, row, 'MetodoCruce')),
    upstreamFileName: trimToNull(collectorValue(classified, row, 'ArchivoOrigen')),
    upstreamRowNumber: parseCollectorInteger(collectorValue(classified, row, 'FilaOrigen')),
    warning: trimToNull(collectorValue(classified, row, 'AvisosImportacion')),
  };
}

/**
 * One renewal collector row (Requirement 2.1).
 *
 * `TipoRegistro` decides the source state, with `'renewal'` as the fallback for an empty cell:
 * every row of a renewals consolidated export is a renewal row, and an empty record type is the
 * ordinary case rather than an exception. A *populated* value the mapping does not recognize is
 * never treated as an ordinary renewal — it resolves to `review_required` and keeps its raw text
 * (Requirement 1.3).
 *
 * `EstadoEnReporte` is retained raw and is deliberately not allowed to override `TipoRegistro`:
 * it is free carrier prose, and Requirement 2.1 makes `TipoRegistro` the machine field.
 */
export function readRenewalCollectorRow(
  classified: ClassifiedCollectorFile,
  row: readonly string[],
  rowNumber: number,
): RenewalCollectorRow {
  const carrier = trimToNull(collectorValue(classified, row, 'Compania'));
  const policyNumber = trimToNull(collectorValue(classified, row, 'Poliza'));
  const renewalDate = parseCollectorDate(collectorValue(classified, row, 'FechaRenovacion'));
  const sourceState = normalizeSourceState(collectorValue(classified, row, 'TipoRegistro'), 'renewal');
  const match = normalizeMatch(
    collectorValue(classified, row, 'Cruce'),
    collectorValue(classified, row, 'MetodoCruce'),
  );
  const identity = policyIdentity(carrier, policyNumber);
  const reviewReasons = policyReviewReasons({
    state: sourceState.state,
    unrecognizedState: sourceState.unrecognized,
    confidence: match.confidence,
    carrierMissing: normalizeCarrierKey(carrier) === null,
  });

  const customerName = trimToNull(collectorValue(classified, row, 'Asegurado'))
    ?? trimToNull(collectorValue(classified, row, 'Titular'));

  return {
    domain: 'renewal',
    rowNumber,
    identity,
    carrier,
    policyNumber,
    policyNumberNormalized: normalizePolicyNumber(policyNumber),
    collectorPolicyNormalized: trimToNull(collectorValue(classified, row, 'PolizaNormalizada')),
    customerName,
    namedInsured: trimToNull(collectorValue(classified, row, 'Titular')),
    lineOfBusiness: trimToNull(collectorValue(classified, row, 'LOB')),
    hawksoftClientId: trimToNull(collectorValue(classified, row, 'ClienteID')),
    phones: splitCollectorSegments(collectorValue(classified, row, 'Telefonos')),
    emails: splitCollectorSegments(collectorValue(classified, row, 'Emails')),
    producerLabel: trimToNull(collectorValue(classified, row, 'Productor')),
    sourceState,
    match,
    reviewReasons,
    communicationBlocked: reviewReasons.length > 0,
    lineage: lineageFor(classified, row, rowNumber, 'EstadoEnReporte'),
    rejection: renewalRejection(policyNumber, renewalDate, customerName),
    renewalDate,
    expirationDate: parseCollectorDate(collectorValue(classified, row, 'FechaVencimiento')),
    processedDate: parseCollectorDate(collectorValue(classified, row, 'FechaProcesada')),
    termMonths: parseCollectorInteger(collectorValue(classified, row, 'TerminoMeses')),
    premiumRenewal: parseCollectorAmount(collectorValue(classified, row, 'PrimaRenovacion')),
    premiumPrior: parseCollectorAmount(collectorValue(classified, row, 'PrimaAnterior')),
    premiumHawksoft: parseCollectorAmount(collectorValue(classified, row, 'PrimaHawkSoft')),
    hawksoftStatus: trimToNull(collectorValue(classified, row, 'EstadoHawkSoft')),
    activeInHawksoft: parseCollectorBoolean(collectorValue(classified, row, 'ActivaEnHawkSoft')),
  };
}

/**
 * Why a renewal row cannot be stored at all.
 *
 * Only the three values `renewal_records` cannot do without are required. An unreliable customer
 * match, an unrecognized record type, and a missing producer are *not* rejections: Requirements
 * 1.3 and 1.4 import those rows and hold them for review.
 */
function renewalRejection(
  policyNumber: string | null,
  renewalDate: string | null,
  customerName: string | null,
): string | null {
  if (policyNumber === null) return 'The row carries no policy number.';
  if (renewalDate === null) return 'The row carries no readable renewal date.';
  if (customerName === null) return 'The row carries no named insured or account holder.';
  return null;
}

/**
 * One cancellation collector row (Requirement 2.2).
 *
 * `TipoRegistro` carries the three machine values `pending`, `paid_signal`, and `cancelled_signal`,
 * so there is no fallback: an empty or unrecognized record type is exactly the ambiguity
 * Requirement 8.4 sends to Import Review rather than guessing a signal from.
 *
 * The effective date prefers the carrier-confirmed `FechaCancelacion` and falls back to
 * `FechaCancelacionEstimada`. When the fallback is used the row is flagged estimated, which
 * Requirement 8.3 requires be shown as `Estimated` and which blocks automatic messaging.
 */
export function readCancellationCollectorRow(
  classified: ClassifiedCollectorFile,
  row: readonly string[],
  rowNumber: number,
): CancellationCollectorRow {
  const carrier = trimToNull(collectorValue(classified, row, 'Compania'));
  const policyNumber = trimToNull(collectorValue(classified, row, 'Poliza'));
  const cancellationDate = parseCollectorDate(collectorValue(classified, row, 'FechaCancelacion'));
  const estimated = parseCollectorDate(collectorValue(classified, row, 'FechaCancelacionEstimada'));
  const effectiveDate = cancellationDate ?? estimated;
  const effectiveDateIsEstimated = cancellationDate === null && estimated !== null;

  const sourceState = normalizeSourceState(collectorValue(classified, row, 'TipoRegistro'));
  const match = normalizeMatch(
    collectorValue(classified, row, 'Cruce'),
    collectorValue(classified, row, 'MetodoCruce'),
  );
  const identity = policyIdentity(carrier, policyNumber);
  const reviewReasons = policyReviewReasons({
    state: sourceState.state,
    unrecognizedState: sourceState.unrecognized,
    confidence: match.confidence,
    estimatedEffectiveDate: effectiveDateIsEstimated,
    carrierMissing: normalizeCarrierKey(carrier) === null,
  });

  const customerName = trimToNull(collectorValue(classified, row, 'Asegurado'))
    ?? trimToNull(collectorValue(classified, row, 'Titular'));

  return {
    domain: 'cancellation',
    rowNumber,
    identity,
    carrier,
    policyNumber,
    policyNumberNormalized: normalizePolicyNumber(policyNumber),
    collectorPolicyNormalized: trimToNull(collectorValue(classified, row, 'PolizaNormalizada')),
    customerName,
    namedInsured: trimToNull(collectorValue(classified, row, 'Titular')),
    lineOfBusiness: trimToNull(collectorValue(classified, row, 'LOB')),
    hawksoftClientId: trimToNull(collectorValue(classified, row, 'ClienteID')),
    phones: splitCollectorSegments(collectorValue(classified, row, 'Telefonos')),
    emails: splitCollectorSegments(collectorValue(classified, row, 'Emails')),
    producerLabel: trimToNull(collectorValue(classified, row, 'Productor')),
    sourceState,
    match,
    reviewReasons,
    communicationBlocked: reviewReasons.length > 0,
    lineage: lineageFor(classified, row, rowNumber, 'EstadoCarrier'),
    rejection: cancellationRejection(policyNumber, effectiveDate),
    cancellationDate,
    estimatedCancellationDate: estimated,
    effectiveDate,
    effectiveDateIsEstimated,
    paymentDueDate: parseCollectorDate(collectorValue(classified, row, 'FechaVencimientoPago')),
    amountDue: parseCollectorAmount(collectorValue(classified, row, 'MontoAdeudado')),
    transactionType: trimToNull(collectorValue(classified, row, 'TipoTransaccion')),
    carrierStatus: trimToNull(collectorValue(classified, row, 'EstadoCarrier')),
    hawksoftStatus: trimToNull(collectorValue(classified, row, 'EstadoHawkSoft')),
    language: trimToNull(collectorValue(classified, row, 'Idioma')),
  };
}

/** Why a cancellation row cannot be stored at all: the two halves of the case identity. */
function cancellationRejection(policyNumber: string | null, effectiveDate: string | null): string | null {
  if (policyNumber === null) return 'The row carries no policy number.';
  if (effectiveDate === null) {
    return 'The row carries neither a readable cancellation date nor a readable estimated date.';
  }
  return null;
}

/** Every data row of a classified collector file, in file order. */
export function readCollectorRows(
  classified: ClassifiedCollectorFile,
  rows: readonly (readonly string[])[],
): CollectorRow[] {
  const read = classified.domain === 'renewal' ? readRenewalCollectorRow : readCancellationCollectorRow;
  return rows.map((row, index) => read(classified, row, index + 1));
}

/**
 * The case status a cancellation collector row proposes (Requirement 8.4).
 *
 * A `paid_signal` becomes `Payment Reported`, which is what moves the case into the existing
 * verification flow rather than closing it: Requirement 8.4 is explicit that a paid signal stops
 * future reminders and hands the case to verification, and it must never silently resolve.
 *
 * A `cancelled_signal` becomes `Cancelled` only when the identity is unambiguous — an exact match
 * and a carrier-confirmed date. Anything less becomes `Import Review Required`, because resolving
 * a case wrongly is unrecoverable in a way leaving it open is not.
 */
export function proposedCancellationCaseStatus(
  row: CancellationCollectorRow,
): 'Imported' | 'Payment Reported' | 'Cancelled' | 'Import Review Required' {
  switch (row.sourceState.state) {
    case 'pending_cancellation':
      return 'Imported';
    case 'payment_signal':
      return 'Payment Reported';
    case 'cancelled_signal':
      return row.match.confidence === 'exact' && !row.effectiveDateIsEstimated
        ? 'Cancelled'
        : 'Import Review Required';
    default:
      return 'Import Review Required';
  }
}

// ---------------------------------------------------------------------------
// Import preview (Requirement 2.3)
// ---------------------------------------------------------------------------

/** Every count Requirement 2.3 requires a manager see before any database mutation. */
export interface CollectorImportPreview {
  domain: CollectorDomain;
  fileName: string;
  totalRows: number;
  /** Rows this module will send to the import RPC. */
  importableRows: number;
  rejectedRows: number;
  /** `{ rowNumber, reason }` per rejected row, in file order. */
  rejections: readonly { rowNumber: number; reason: string }[];
  /** Distinct case/policy identities appearing more than once inside this one file. */
  duplicateIdentitiesInFile: number;
  duplicateIdentityKeys: readonly string[];
  /** Rows per carrier, highest count first, then carrier key ascending. */
  carrierDistribution: readonly { carrierKey: string; carrier: string; rows: number }[];
  matchExact: number;
  matchProbable: number;
  matchNone: number;
  matchUnrecognized: number;
  missingPhone: number;
  missingEmail: number;
  missingBothContacts: number;
  /** Producer labels carried by the file, distinct, in first-seen order. */
  producerLabels: readonly string[];
  reviewRequiredRows: number;
  /** Rows whose record type normalized to `carrier_nonrenewal` (Requirements 2.3, 7.2). */
  carrierNonRenewalRows: number;
  /** Cancellation rows scheduled against the collector estimate (Requirements 2.3, 8.3). */
  estimatedCancellationDates: number;
  paidSignalRows: number;
  cancelledSignalRows: number;
  pendingCancellationRows: number;
  /** Rows carrying no shared ownership identity, so no owner can be resolved (design 4.2). */
  rowsWithoutIdentity: number;
  /** Source states seen in the file with their raw values, for the manager's own reading. */
  unrecognizedSourceValues: readonly { raw: string; rows: number }[];
}

/**
 * The whole preview of one classified collector file (Requirement 2.3).
 *
 * Nothing here reads or writes the database. The *proposed assignment* counts of Requirement 11.2
 * cannot be computed from the file alone — they depend on the current shared owners, the producer
 * mapping, and live workload — so the importer surface reports them from the import result rather
 * than pretending to predict them here.
 */
export function buildCollectorPreview(
  classified: ClassifiedCollectorFile,
  rows: readonly CollectorRow[],
): CollectorImportPreview {
  const rejections: { rowNumber: number; reason: string }[] = [];
  const identityCounts = new Map<string, number>();
  const carriers = new Map<string, { carrier: string; rows: number }>();
  const producerLabels: string[] = [];
  const producerSeen = new Set<string>();
  const unrecognized = new Map<string, number>();

  let importableRows = 0;
  let matchExact = 0;
  let matchProbable = 0;
  let matchNone = 0;
  let matchUnrecognized = 0;
  let missingPhone = 0;
  let missingEmail = 0;
  let missingBothContacts = 0;
  let reviewRequiredRows = 0;
  let carrierNonRenewalRows = 0;
  let estimatedCancellationDates = 0;
  let paidSignalRows = 0;
  let cancelledSignalRows = 0;
  let pendingCancellationRows = 0;
  let rowsWithoutIdentity = 0;

  for (const row of rows) {
    if (row.rejection !== null) {
      rejections.push({ rowNumber: row.rowNumber, reason: row.rejection });
    } else {
      importableRows += 1;
    }

    const identityKey = row.identity === null
      ? null
      : `${row.identity.carrierKey}|${row.identity.policyNumberNormalized}`;
    if (identityKey === null) rowsWithoutIdentity += 1;
    else identityCounts.set(identityKey, (identityCounts.get(identityKey) ?? 0) + 1);

    const carrierKey = row.identity?.carrierKey ?? '(no carrier)';
    const held = carriers.get(carrierKey);
    if (held === undefined) carriers.set(carrierKey, { carrier: row.carrier ?? '(no carrier)', rows: 1 });
    else held.rows += 1;

    switch (row.match.confidence) {
      case 'exact': matchExact += 1; break;
      case 'probable': matchProbable += 1; break;
      case 'no_match': matchNone += 1; break;
      default: matchUnrecognized += 1; break;
    }

    const hasPhone = row.phones.length > 0;
    const hasEmail = row.emails.length > 0;
    if (!hasPhone) missingPhone += 1;
    if (!hasEmail) missingEmail += 1;
    if (!hasPhone && !hasEmail) missingBothContacts += 1;

    if (row.producerLabel !== null) {
      const folded = foldSourceValue(row.producerLabel);
      if (!producerSeen.has(folded)) {
        producerSeen.add(folded);
        producerLabels.push(row.producerLabel);
      }
    }

    if (row.reviewReasons.length > 0) reviewRequiredRows += 1;

    if (row.sourceState.unrecognized && row.sourceState.raw !== null) {
      unrecognized.set(row.sourceState.raw, (unrecognized.get(row.sourceState.raw) ?? 0) + 1);
    }

    switch (row.sourceState.state) {
      case 'carrier_nonrenewal': carrierNonRenewalRows += 1; break;
      case 'payment_signal': paidSignalRows += 1; break;
      case 'cancelled_signal': cancelledSignalRows += 1; break;
      case 'pending_cancellation': pendingCancellationRows += 1; break;
      default: break;
    }

    if (row.domain === 'cancellation' && row.effectiveDateIsEstimated) estimatedCancellationDates += 1;
  }

  const duplicateIdentityKeys = [...identityCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();

  const carrierDistribution = [...carriers.entries()]
    .map(([carrierKey, value]) => ({ carrierKey, carrier: value.carrier, rows: value.rows }))
    .sort((left, right) => (right.rows - left.rows) || left.carrierKey.localeCompare(right.carrierKey));

  return {
    domain: classified.domain,
    fileName: classified.fileName,
    totalRows: rows.length,
    importableRows,
    rejectedRows: rejections.length,
    rejections,
    duplicateIdentitiesInFile: duplicateIdentityKeys.length,
    duplicateIdentityKeys,
    carrierDistribution,
    matchExact,
    matchProbable,
    matchNone,
    matchUnrecognized,
    missingPhone,
    missingEmail,
    missingBothContacts,
    producerLabels,
    reviewRequiredRows,
    carrierNonRenewalRows,
    estimatedCancellationDates,
    paidSignalRows,
    cancelledSignalRows,
    pendingCancellationRows,
    rowsWithoutIdentity,
    unrecognizedSourceValues: [...unrecognized.entries()]
      .map(([raw, rowCount]) => ({ raw, rows: rowCount }))
      .sort((left, right) => (right.rows - left.rows) || left.raw.localeCompare(right.raw)),
  };
}

// ---------------------------------------------------------------------------
// Import payloads
// ---------------------------------------------------------------------------

/** One row of the renewal collector import RPC payload. */
export interface RenewalCollectorPayloadRow {
  row_number: number;
  carrier: string | null;
  carrier_key: string | null;
  policy_number: string;
  policy_number_normalized: string;
  customer_name: string;
  named_insured: string | null;
  line_of_business: string | null;
  hawksoft_client_id: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  renewal_date: string;
  expiration_date: string | null;
  premium_current: number | null;
  premium_renewal: number | null;
  premium_hawksoft: number | null;
  term_months: number | null;
  producer_label: string | null;
  source_state_normalized: PolicySourceState;
  source_status_raw: string | null;
  source_record_type: string | null;
  source_match_status: PolicyMatchConfidence;
  source_match_method: string | null;
  source_match_status_raw: string | null;
  source_file_name: string;
  source_row_number: number;
  source_warning: string | null;
  source_review_required: boolean;
  source_communication_blocked: boolean;
  source_payload: Readonly<Record<string, string>>;
}

/**
 * The renewal collector rows as the import RPC payload (design 11.1).
 *
 * Rejected rows are absent by construction, which is how one unreadable row aborts nothing while
 * still being reported by row number and reason in the preview.
 *
 * `customer_phone` and `customer_email` take the first segment only. `renewal_records` holds one
 * of each, and the collector's remaining segments stay in `source_payload`, so nothing is lost and
 * no column is asked to hold a list.
 */
export function buildRenewalCollectorPayload(
  rows: readonly CollectorRow[],
): RenewalCollectorPayloadRow[] {
  const payload: RenewalCollectorPayloadRow[] = [];
  for (const row of rows) {
    if (row.domain !== 'renewal' || row.rejection !== null) continue;
    payload.push({
      row_number: row.rowNumber,
      carrier: row.carrier,
      carrier_key: row.identity?.carrierKey ?? null,
      policy_number: row.policyNumber as string,
      policy_number_normalized: row.policyNumberNormalized as string,
      customer_name: row.customerName as string,
      named_insured: row.namedInsured,
      line_of_business: row.lineOfBusiness,
      hawksoft_client_id: row.hawksoftClientId,
      customer_phone: row.phones[0] ?? null,
      customer_email: row.emails[0] ?? null,
      renewal_date: row.renewalDate as string,
      expiration_date: row.expirationDate,
      premium_current: row.premiumPrior,
      premium_renewal: row.premiumRenewal,
      premium_hawksoft: row.premiumHawksoft,
      term_months: row.termMonths,
      producer_label: row.producerLabel,
      source_state_normalized: row.sourceState.state,
      source_status_raw: row.lineage.rawCarrierStatus,
      source_record_type: row.lineage.rawRecordType,
      source_match_status: row.match.confidence,
      source_match_method: row.match.rawMethod,
      source_match_status_raw: row.match.rawStatus,
      source_file_name: row.lineage.fileName,
      source_row_number: row.rowNumber,
      source_warning: row.lineage.warning,
      source_review_required: row.reviewReasons.length > 0,
      source_communication_blocked: row.communicationBlocked,
      source_payload: sourcePayloadObject(row.lineage),
    });
  }
  return payload;
}

/** One contact row of the cancellation collector payload, in the shape the RPC already reads. */
export interface CancellationCollectorContactRow {
  channel: 'phone' | 'email';
  normalized_value: string;
  raw_segment: string;
  validation_status: 'valid' | 'invalid';
  authorization_status: 'Authorized' | 'Unknown' | 'Not Authorized';
  is_primary: boolean;
  segment_index: number;
  preferred_language: 'English' | 'Spanish' | 'Bilingual' | null;
}

/** One row of the cancellation collector import RPC payload. */
export interface CancellationCollectorPayloadRow {
  row_number: number;
  source_row_number: number;
  policy_number: string;
  cancellation_effective_date: string;
  customer_name: string | null;
  client_identifier: string | null;
  customer_match_key: string | null;
  carrier: string | null;
  amount_due: number | null;
  case_status: string;
  producer_label: string | null;
  legacy_send_flag: string | null;
  legacy_state: string | null;
  legacy_result: string | null;
  raw_row: readonly string[];
  raw_header: readonly string[];
  contacts: readonly CancellationCollectorContactRow[];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_DIGITS = /\D/g;

/**
 * The cancellation collector rows as the existing `cancellation_import_batch` payload
 * (design 11.2).
 *
 * Contact normalization stays deliberately minimal here — shape validity and E.164 for a
 * ten-digit North American number — because `import/contacts.ts` owns the agency's contact rules
 * and the RPC applies its own `unique (case_id, channel, normalized_value)` dedup. An invalid
 * segment is stored as `invalid` rather than dropped, so the segment the collector saw stays
 * visible to the manager who has to fix it.
 */
export function buildCancellationCollectorPayload(
  rows: readonly CollectorRow[],
): CancellationCollectorPayloadRow[] {
  const payload: CancellationCollectorPayloadRow[] = [];
  for (const row of rows) {
    if (row.domain !== 'cancellation' || row.rejection !== null) continue;

    const language = collectorLanguage(row.language);
    const contacts: CancellationCollectorContactRow[] = [];
    let segmentIndex = 0;

    for (const phone of row.phones) {
      const digits = phone.replace(PHONE_DIGITS, '');
      const valid = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
      contacts.push({
        channel: 'phone',
        normalized_value: valid ? `+1${digits.slice(-10)}` : phone,
        raw_segment: phone,
        validation_status: valid ? 'valid' : 'invalid',
        authorization_status: 'Unknown',
        is_primary: segmentIndex === 0,
        segment_index: segmentIndex,
        preferred_language: language,
      });
      segmentIndex += 1;
    }

    let emailIndex = 0;
    for (const email of row.emails) {
      const lowered = email.toLowerCase();
      const valid = EMAIL_SHAPE.test(lowered);
      contacts.push({
        channel: 'email',
        normalized_value: lowered,
        raw_segment: email,
        validation_status: valid ? 'valid' : 'invalid',
        authorization_status: 'Unknown',
        is_primary: emailIndex === 0,
        segment_index: emailIndex,
        preferred_language: language,
      });
      emailIndex += 1;
    }

    payload.push({
      row_number: row.rowNumber,
      source_row_number: row.rowNumber,
      policy_number: row.policyNumber as string,
      cancellation_effective_date: row.effectiveDate as string,
      customer_name: row.customerName,
      client_identifier: row.hawksoftClientId,
      customer_match_key: row.hawksoftClientId ?? customerMatchKeyFromName(row.customerName),
      carrier: row.carrier,
      amount_due: row.amountDue,
      case_status: proposedCancellationCaseStatus(row),
      producer_label: row.producerLabel,
      legacy_send_flag: row.lineage.rawRecordType,
      legacy_state: row.carrierStatus,
      legacy_result: row.transactionType,
      raw_row: row.lineage.payload,
      raw_header: row.lineage.header,
      contacts,
    });
  }
  return payload;
}

/** `Idioma` as one of the three stored preferences, or `null` when it names none. */
function collectorLanguage(value: string | null): 'English' | 'Spanish' | 'Bilingual' | null {
  const folded = foldSourceValue(value);
  if (folded === 'es' || folded === 'esp' || folded === 'espanol' || folded === 'spanish') return 'Spanish';
  if (folded === 'en' || folded === 'eng' || folded === 'ingles' || folded === 'english') return 'English';
  if (folded === 'bilingue' || folded === 'bilingual' || folded === 'both') return 'Bilingual';
  return null;
}

/** The name-derived match key: folded to the same comparison form the importer already uses. */
function customerMatchKeyFromName(customerName: string | null): string | null {
  const folded = foldSourceValue(customerName);
  return folded.length === 0 ? null : folded;
}

/**
 * The raw row as a header-keyed object for `jsonb` storage.
 *
 * Ordered array form is preserved separately in `raw_row`; this object exists so a manager
 * inspecting one record's lineage can read `AvisosImportacion` by name rather than by position
 * (Requirement 11.3).
 */
function sourcePayloadObject(lineage: CollectorLineage): Record<string, string> {
  const payload: Record<string, string> = {};
  lineage.header.forEach((column, index) => {
    payload[column] = lineage.payload[index] ?? '';
  });
  return payload;
}
