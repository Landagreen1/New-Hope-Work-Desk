// Pure column-mapping helpers for the Cancellation_Importer.
//
// Step 3 of the importer flow `parse → classify → map → preview → confirm → load`
// (design.md, "Cancellation_Importer — src/features/cancellations/import/"). The module
// holds no React, no Supabase client, no I/O, and no clock read: every function is a pure
// transform over the header row emitted by `csv.ts` and the column set decided by
// `classify.ts`.
//
// Requirement 8.4 is the whole contract: propose each file header to the column of the
// classified set whose name is equal after trimming and case folding, leave a header with
// no equal column name unmapped, let a profile holding Manager_Role change every proposal
// before loading, and block mapping confirmation until the policy number column and the
// cancellation effective date column are mapped.
//
// `CancellationColumnSet` and the two column lists are declared here rather than imported
// from `./classify` so this module compiles and is testable on its own. They carry the same
// members as `classify.ts`'s `CancellationColumnSetId`, `EFICACIA_COLUMNS`, and
// `AVISOS_COLUMNS`, so values cross between the two modules without conversion.

import { headerMatchKey, matchHeaderAliases } from '../../nhwd-shared/header-matching';
import { ALIASES_BY_SET } from './aliases';

// ---------------------------------------------------------------------------
// Column sets
// ---------------------------------------------------------------------------

/** The two recognized cancellation report shapes (Req 8.2, 8.3). */
export type CancellationColumnSet = 'eficacia' | 'avisos';

/** The `eficacia` column set, in the order Requirement 8.2 lists it. */
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

/** The `avisos` column set, in the order Requirement 8.3 lists it. */
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

/** Any column a confirmed mapping may target. */
export type CancellationColumn = EficaciaColumn | AvisosColumn;

/** The accepted columns of each column set, keyed by the classification result. */
export const COLUMNS_BY_SET: Record<CancellationColumnSet, readonly CancellationColumn[]> = {
  eficacia: EFICACIA_COLUMNS,
  avisos: AVISOS_COLUMNS,
};

/**
 * The two identity columns of each column set. A Cancellation_Case is keyed by
 * (normalized policy number, cancellation effective date) (Req 9.1), so neither may be
 * left unmapped when the manager confirms (Req 8.4).
 */
export const IDENTITY_COLUMNS: Record<
  CancellationColumnSet,
  { readonly policyNumber: CancellationColumn; readonly cancellationEffectiveDate: CancellationColumn }
> = {
  eficacia: { policyNumber: 'Poliza', cancellationEffectiveDate: 'FechaCancelacion' },
  avisos: { policyNumber: 'Policy number', cancellationEffectiveDate: 'Cancellation date' },
};

// ---------------------------------------------------------------------------
// Draft, block reasons, and confirmed shapes
// ---------------------------------------------------------------------------

/**
 * One source column of the uploaded file. `headerIndex` is the position of the column in
 * the source header row, so a file carrying the same header name twice stays addressable.
 * `header` is the header text exactly as `csv.ts` decoded it, untrimmed. `column` is the
 * effective target, `null` while the header is unmapped. `proposedColumn` keeps the
 * automatic proposal so the interface can show what a manager override changed.
 */
export interface MappingAssignment {
  headerIndex: number;
  header: string;
  column: CancellationColumn | null;
  proposedColumn: CancellationColumn | null;
}

/** A mapping under review: the classified column set plus one assignment per source column. */
export interface MappingDraft {
  columnSet: CancellationColumnSet;
  header: readonly string[];
  assignments: readonly MappingAssignment[];
}

/** A manager override of one proposal. `column: null` unmaps the source column. */
export interface MappingOverride {
  headerIndex: number;
  column: CancellationColumn | null;
}

export type MappingBlockCode = 'policy_number_unmapped' | 'cancellation_effective_date_unmapped';

/**
 * Why confirmation is blocked. The reason is returned rather than only disabled so the
 * import wizard can name the column the manager still has to map.
 */
export interface MappingBlockReason {
  code: MappingBlockCode;
  /** The column of the classified set that no source column targets yet. */
  column: CancellationColumn;
  /** Sentence the import wizard can render verbatim. */
  message: string;
}

/**
 * The confirmed mapping, shaped as plain JSON-serializable data because it is persisted as
 * `cancellation_import_runs.confirmed_mapping` (jsonb) and passed to
 * `cancellation_import_batch(p_file_name, p_column_set, p_mapping jsonb, p_rows jsonb)`.
 *
 * `columnIndex` is the lookup the preview and the loader read: target column to the source
 * column position carrying it. `unmappedHeaders` records the headers with no target so the
 * import audit entry of Requirement 8.8 keeps the full picture; those values still reach
 * the database verbatim inside `raw_row` (Req 8.7).
 */
export interface ConfirmedMapping {
  columnSet: CancellationColumnSet;
  header: string[];
  assignments: MappingAssignment[];
  columnIndex: Partial<Record<CancellationColumn, number>>;
  unmappedHeaders: { headerIndex: number; header: string }[];
}

export type ConfirmMappingResult =
  | { confirmed: true; mapping: ConfirmedMapping }
  | { confirmed: false; blockReasons: MappingBlockReason[] };

// ---------------------------------------------------------------------------
// Matching internals
// ---------------------------------------------------------------------------

/**
 * Header and column names are compared under `headerMatchKey` (Req 8.4).
 *
 * Requirement 8.4's "ignoring case and surrounding whitespace" was originally implemented as
 * `trim().toLowerCase()`, which is the narrowest reading of it and the reason these files
 * needed manual mapping: the reports are Spanish, so the same column arrives as `Poliza`,
 * `Póliza`, `POLIZA`, and `Fecha de Cancelación` against a canonical `FechaCancelacion`, and
 * only the first of those compared equal. `headerMatchKey` widens the comparison to every
 * difference that cannot change which column is meant — a byte order mark, letter case,
 * accents, punctuation, inner and outer whitespace, CamelCase versus spaced words, and the
 * filler words `de`/`del`/`la`/`el`/`los`/`las`/`of`/`the` — and no further. A difference in
 * the actual words or their order still means a different column, so `FechaCancelacion` and
 * `FechaCancelacionEstimada` stay distinct, and so do `Poliza` and `PolizaNormalizada`.
 */
function canonicalName(value: string): string {
  return headerMatchKey(value);
}

function buildCanonicalLookup(columns: readonly CancellationColumn[]): ReadonlyMap<string, CancellationColumn> {
  const lookup = new Map<string, CancellationColumn>();
  for (const column of columns) lookup.set(canonicalName(column), column);
  return lookup;
}

const COLUMN_BY_CANONICAL_NAME: Record<CancellationColumnSet, ReadonlyMap<string, CancellationColumn>> = {
  eficacia: buildCanonicalLookup(EFICACIA_COLUMNS),
  avisos: buildCanonicalLookup(AVISOS_COLUMNS),
};

const IDENTITY_LABELS: Record<MappingBlockCode, string> = {
  policy_number_unmapped: 'policy number',
  cancellation_effective_date_unmapped: 'cancellation effective date',
};

function identityRequirements(
  columnSet: CancellationColumnSet,
): readonly { code: MappingBlockCode; column: CancellationColumn }[] {
  const identity = IDENTITY_COLUMNS[columnSet];
  return [
    { code: 'policy_number_unmapped', column: identity.policyNumber },
    { code: 'cancellation_effective_date_unmapped', column: identity.cancellationEffectiveDate },
  ];
}

/**
 * Target column to source column position. A file whose header row repeats a name maps
 * every matching position, so the lowest position wins here and the later duplicate is
 * read only through `raw_row`; a manager can unmap either position to change that.
 */
function buildColumnIndex(
  assignments: readonly MappingAssignment[],
): Partial<Record<CancellationColumn, number>> {
  const index: Partial<Record<CancellationColumn, number>> = {};
  for (const assignment of assignments) {
    if (assignment.column === null) continue;
    if (index[assignment.column] === undefined) index[assignment.column] = assignment.headerIndex;
  }
  return index;
}

// ---------------------------------------------------------------------------
// Propose, override, confirm
// ---------------------------------------------------------------------------

/**
 * Proposes a target column for every source column of the header row (Req 8.4), in two passes.
 *
 * **Pass one, by name.** Each header takes the column of `columnSet` whose name it matches
 * under `canonicalName`. This is the original rule, widened only in what counts as the same
 * name, so a header that mapped before still maps to the same column.
 *
 * **Pass two, by alias.** For each column no header claimed by name, `ALIASES_BY_SET` supplies
 * the other names the reports have used for it — `Aseguradora` for `Compania`, `MontoAdeudado`
 * for `MontoDebido`, `DiasRestantes` for `Days remaining` — and the first one present in the
 * header row takes the column. Pass one is never overridden, one source column is proposed to
 * at most one column, and the aliases are scoped to the classified set, so an eficacia name can
 * never resolve against an avisos column or the reverse.
 *
 * A header no pass reaches stays `null` and is therefore an absent value for every row, which
 * is how Requirements 8.2 and 8.3 treat a column the file does not carry. Every proposal from
 * either pass is still overridable, and `proposedColumn` records what was proposed so the
 * wizard can show a manager which columns it decided for them.
 */
export function proposeMapping(columnSet: CancellationColumnSet, header: readonly string[]): MappingDraft {
  const lookup = COLUMN_BY_CANONICAL_NAME[columnSet];
  const assignments: MappingAssignment[] = header.map((value, headerIndex) => {
    const proposedColumn = lookup.get(canonicalName(value)) ?? null;
    return { headerIndex, header: value, column: proposedColumn, proposedColumn };
  });

  const claimedByName = new Set(
    assignments.map((assignment) => assignment.column).filter((column): column is CancellationColumn => column !== null),
  );
  const openTargets = ALIASES_BY_SET[columnSet].filter((entry) => !claimedByName.has(entry.target));
  const byAlias = matchHeaderAliases(header, openTargets, (headerIndex) => assignments[headerIndex].column === null);

  for (const [column, headerIndex] of byAlias) {
    assignments[headerIndex] = { ...assignments[headerIndex], column, proposedColumn: column };
  }

  return { columnSet, header: [...header], assignments };
}

/**
 * Returns a new draft with one proposal replaced by a manager's choice; every proposal is
 * overridable, including one that matched automatically (Req 8.4). Passing `null` unmaps
 * the source column. The input draft is left untouched.
 *
 * Throws `RangeError` when `headerIndex` names no source column of the draft and
 * `TypeError` when `column` is outside the classified column set.
 */
export function applyOverride(
  draft: MappingDraft,
  headerIndex: number,
  column: CancellationColumn | null,
): MappingDraft {
  if (!Number.isInteger(headerIndex) || headerIndex < 0 || headerIndex >= draft.assignments.length) {
    throw new RangeError(
      `headerIndex ${headerIndex} is outside the ${draft.assignments.length} source columns of the uploaded file`,
    );
  }
  if (column !== null && !COLUMN_BY_CANONICAL_NAME[draft.columnSet].has(canonicalName(column))) {
    throw new TypeError(`"${column}" is not a column of the ${draft.columnSet} column set`);
  }
  const assignments = draft.assignments.map((assignment) =>
    assignment.headerIndex === headerIndex ? { ...assignment, column } : { ...assignment },
  );
  return { columnSet: draft.columnSet, header: [...draft.header], assignments };
}

/** Applies a batch of overrides left to right, each under the rules of `applyOverride`. */
export function applyOverrides(draft: MappingDraft, overrides: readonly MappingOverride[]): MappingDraft {
  return overrides.reduce<MappingDraft>(
    (current, override) => applyOverride(current, override.headerIndex, override.column),
    draft,
  );
}

/**
 * The reasons confirmation is still blocked, in a fixed order: the policy number column
 * first, then the cancellation effective date column. An empty array means the draft is
 * confirmable (Req 8.4).
 */
export function mappingBlockReasons(draft: MappingDraft): MappingBlockReason[] {
  const index = buildColumnIndex(draft.assignments);
  return identityRequirements(draft.columnSet)
    .filter((requirement) => index[requirement.column] === undefined)
    .map((requirement) => ({
      code: requirement.code,
      column: requirement.column,
      message:
        `Map a source column to "${requirement.column}" before confirming. ` +
        `The ${IDENTITY_LABELS[requirement.code]} column identifies the cancellation case ` +
        `and cannot be left unmapped.`,
    }));
}

/** True only while both identity columns are mapped (Req 8.4). */
export function canConfirmMapping(draft: MappingDraft): boolean {
  return mappingBlockReasons(draft).length === 0;
}

/**
 * Confirms a draft, producing the JSON-serializable mapping the preview, the loader, and
 * the import audit entry all read. Returns the block reasons instead when either identity
 * column is unmapped, so confirmation cannot proceed past Requirement 8.4.
 */
export function confirmMapping(draft: MappingDraft): ConfirmMappingResult {
  const blockReasons = mappingBlockReasons(draft);
  if (blockReasons.length > 0) return { confirmed: false, blockReasons };
  return {
    confirmed: true,
    mapping: {
      columnSet: draft.columnSet,
      header: [...draft.header],
      assignments: draft.assignments.map((assignment) => ({ ...assignment })),
      columnIndex: buildColumnIndex(draft.assignments),
      unmappedHeaders: draft.assignments
        .filter((assignment) => assignment.column === null)
        .map((assignment) => ({ headerIndex: assignment.headerIndex, header: assignment.header })),
    },
  };
}

/**
 * The source column position a confirmed mapping reads `column` from, or `null` when the
 * column is unmapped and therefore absent for every row (Req 8.2, 8.3).
 */
export function resolveColumnIndex(mapping: ConfirmedMapping, column: CancellationColumn): number | null {
  const index = mapping.columnIndex[column];
  return index === undefined ? null : index;
}
