// Cancellation import: the pre-confirmation preview.
//
// Step 4 of `parse -> classify -> map -> preview -> confirm -> load`
// (design.md, "Cancellation_Importer — src/features/cancellations/import/"). Given the parsed data
// rows and the confirmed mapping, this module answers the one question Requirement 8.5 asks before
// anything is written: how many rows will create a case, how many will update one, how many are
// rejected, how many are duplicates, and which rows those are.
//
// Pure module: no React, no Supabase client, no network, no file system, no clock, no randomness.
// It writes nothing and reads nothing. Requirement 8.5 requires zero Cancellation_Case rows and
// zero Contact_Recipient rows until a manager confirms the displayed preview, so the preview cannot
// be the thing that touches the database.
//
// Nothing here re-implements a sibling module:
// - row parsing, rejection, and the row's identity come from `./fields` (`parseMappedRow`)
// - contact rows and the two contact counts come from `./contacts` (`buildCaseContactsFromRow`)
// - reading a cell through a manager override comes from `./mapping` (`ConfirmedMapping`)
// - the parsed shape comes from `./csv` (`ParsedCsv`)
//
// This module owns exactly two things the others cannot:
//
// 1. **In-file duplicate detection** (Requirement 9.4). Two rows sharing
//    (normalized policy number, cancellation effective date) collide on
//    `cancellation_cases unique (policy_number_normalized, cancellation_effective_date)`, so one of
//    them has to be dropped before any insert. `fields.ts` exposes `identity` per row for exactly
//    this. **The winner is the row with the lowest data row number**, which is the requirement's
//    own rule; every other row carrying that identity is counted as a duplicate, is excluded from
//    creation and from update, and has its row number recorded. The lowest row number wins
//    regardless of the order the rows are handed to this function, so a caller that reorders rows
//    still gets the same winner.
//
// 2. **Created versus updated** (Requirement 9.2 versus 9.3). Which identities already exist is a
//    database read, and a pure module cannot perform one, so the set of existing identities arrives
//    as a parameter (`existingIdentities`). An identity present in that set counts as an update; an
//    identity absent from it counts as a create. Omitting the parameter previews every accepted row
//    as a create, which is the correct answer for a first import of a file and an honest one for the
//    caller that has not looked the identities up yet.
//
// **Count alignment with the import run.** The five counts and the five detail arrays are named and
// shaped to land in `public.cancellation_import_runs` (`v1.10.0-cancellation-core-tables.sql`)
// unchanged, so the numbers a manager approves in the preview are the numbers the completion
// summary reads back: `rows_total`, `rows_created`, `rows_updated`, `rows_rejected`,
// `rows_duplicate`, `rejected_rows`, `duplicate_rows`, `unmatched_producer_labels`,
// `unmatched_customer_rows`, `invalid_contact_count`, `contact_overflow_count`, and
// `amount_due_absent_rows`. `toImportRunCounts` performs that rename in one place. The jsonb detail
// entries keep snake_case keys because they are stored as jsonb; `fields.ts` already emits them
// that way.
//
// **The four counts partition the data rows.** Every data row lands in exactly one bucket: a
// rejected row is rejected, an accepted row that lost a duplicate contest is a duplicate, and every
// other accepted row is either a create or an update. So
// `rows_total === rows_created + rows_updated + rows_rejected + rows_duplicate` always holds, and
// `countsPartitionRowsTotal` states it for a caller that wants to assert it.
//
// **Notices describe the rows that load.** `unmatched_producer_labels`, `unmatched_customer_rows`,
// and `amount_due_absent_rows` are collected only from the rows that will create or update a case.
// A duplicate row stores nothing — no absent amount, no producer label, no matching key — so
// reporting its notices would put numbers in the preview that the completion summary could never
// reproduce. The duplicate rows are never hidden: every one is listed in `duplicateRows` with the
// row number that beat it.

import type { ParsedCsv } from './csv';
import {
  normalizePolicyNumber,
  parseMappedRow,
  type AmountDueAbsentEntry,
  type CancellationCaseFields,
  type CancellationCaseIdentity,
  type ProducerLabelEntry,
  type ProducerLabelResult,
  type RowRejection,
  type UnmatchedCustomerEntry,
} from './fields';
import {
  buildCaseContactsFromRow,
  type CaseContactBuildResult,
  type ExistingContactValues,
} from './contacts';
import type { CancellationColumnSet, ConfirmedMapping } from './mapping';

// ---------------------------------------------------------------------------
// Case identity keys
// ---------------------------------------------------------------------------

/**
 * A stored case identity as PostgREST returns it from `public.cancellation_cases`. Accepted
 * alongside the camelCase `CancellationCaseIdentity` so the loader can hand back the rows of
 * `select policy_number_normalized, cancellation_effective_date from cancellation_cases ...`
 * without reshaping them.
 */
export interface StoredCaseIdentityRow {
  readonly policy_number_normalized: string;
  readonly cancellation_effective_date: string;
}

/**
 * One existing case identity: a key already produced by `identityKey`, a parsed identity, or a
 * stored row. Every form resolves to the same key, so a caller may mix them.
 */
export type ExistingIdentityInput = string | CancellationCaseIdentity | StoredCaseIdentityRow;

/**
 * `YYYY-MM-DD` optionally followed by a time component, which is what a caller gets when a `date`
 * column is read through a client that widens it to a timestamp.
 */
const IDENTITY_DATE_PATTERN = /^(\d{4}-\d{2}-\d{2})(?:[T ].*)?$/;

/**
 * The calendar-date half of an identity key. `parseCancellationDate` already emits canonical
 * `YYYY-MM-DD`; this additionally tolerates a stored value that arrived carrying a time component,
 * because `cancellation_effective_date` is a `date` and a value like `2026-07-31T00:00:00+00:00`
 * names the same calendar date. Anything else passes through unchanged rather than being guessed at,
 * so a malformed existing identity simply matches nothing instead of matching the wrong case.
 */
function canonicalIdentityDate(value: string): string {
  const match = IDENTITY_DATE_PATTERN.exec(value.trim());
  return match === null ? value.trim() : match[1];
}

/**
 * The lookup key of a Cancellation_Case identity: the pair
 * (normalized policy number, cancellation effective date) of Requirement 9.1, flattened into one
 * string so it can key a `Map` and a `Set`.
 *
 * The date comes first because it is fixed-width canonical `YYYY-MM-DD`, which leaves the policy
 * number as the whole remainder of the key and makes the split unambiguous. The separator is NUL,
 * which PostgreSQL `text` cannot hold, so no stored policy number can forge a key boundary.
 *
 * The policy number passes through `normalizePolicyNumber` even when it is already normalized: that
 * function is idempotent, and running it here means a caller who hands over a raw policy number by
 * mistake still gets the key of the case it identifies rather than a key that matches nothing.
 */
export function identityKey(identity: CancellationCaseIdentity): string {
  return `${canonicalIdentityDate(identity.cancellationEffectiveDate)}\u0000${normalizePolicyNumber(identity.policyNumberNormalized)}`;
}

/** The identity key of a stored row, whichever of the accepted shapes it arrived in. */
export function existingIdentityKey(input: ExistingIdentityInput): string {
  if (typeof input === 'string') return input;
  if ('policyNumberNormalized' in input) return identityKey(input);
  return identityKey({
    policyNumberNormalized: input.policy_number_normalized,
    cancellationEffectiveDate: input.cancellation_effective_date,
  });
}

/**
 * The set of existing identity keys to hand to `buildImportPreview`, built from stored rows,
 * parsed identities, keys, or any mix of the three.
 *
 * Building the set once and reusing it across previews of the same file costs one pass; passing the
 * raw rows straight to `buildImportPreview` is equally correct and does the same pass internally.
 */
export function buildExistingIdentitySet(inputs: Iterable<ExistingIdentityInput>): Set<string> {
  const keys = new Set<string>();
  for (const input of inputs) keys.add(existingIdentityKey(input));
  return keys;
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** What a row that survives duplicate detection will do to the database (Req 9.2, 9.3). */
export type PreviewOutcome = 'create' | 'update';

/**
 * One `duplicate_rows` entry of the import run. `row_number` is the data row number Requirement 9.4
 * records; `duplicate_of_row_number` names the lower-numbered row that beat it, which the manager
 * review surface needs to explain the exclusion and which the stored jsonb keeps as an extra key.
 */
export interface DuplicateRowEntry {
  readonly row_number: number;
  readonly duplicate_of_row_number: number;
}

/**
 * One row that will load, with everything the loader needs to send it. The preview has already
 * parsed the row, resolved its identity, decided create versus update, and built its contact rows,
 * so the loader transports this rather than repeating any of that work — in particular, it does not
 * re-run duplicate detection.
 */
export interface PreviewedCaseRow {
  readonly rowNumber: number;
  readonly identity: CancellationCaseIdentity;
  /** `identityKey(identity)`, carried so a caller can index existing state without recomputing it. */
  readonly key: string;
  readonly outcome: PreviewOutcome;
  /** The insertable `cancellation_cases` field set, keyed by database column. */
  readonly fields: CancellationCaseFields;
  /** The producer reading, whose assignment the loader still has to resolve (Req 9.6, 9.7). */
  readonly producer: ProducerLabelResult;
  /** The `cancellation_contacts` rows and per-row contact counts this row contributes (Req 10). */
  readonly contacts: CaseContactBuildResult;
}

/** The preview of one confirmed mapping over one parsed file. Nothing here has been written. */
export interface ImportPreview {
  readonly columnSet: CancellationColumnSet;

  // The five counts of Requirement 8.5.
  /** Data rows in the file, the same number `classifyImportFile` validated (Req 8.1, 8.5). */
  readonly rowsTotal: number;
  readonly rowsCreated: number;
  readonly rowsUpdated: number;
  readonly rowsRejected: number;
  readonly rowsDuplicate: number;

  /** Every rejected row with its data row number, reason, and code, by row number (Req 8.6, 8.9). */
  readonly rejectedRows: readonly RowRejection[];
  /** Every row excluded as an in-file duplicate, by row number (Req 9.4). */
  readonly duplicateRows: readonly DuplicateRowEntry[];
  /** Every producer label that left a loading case unassigned, by row number (Req 9.7). */
  readonly unmatchedProducerLabels: readonly ProducerLabelEntry[];
  /** Every loading row whose customer matching key holds zero characters (Req 9.11). */
  readonly unmatchedCustomerRows: readonly UnmatchedCustomerEntry[];
  /** Every loading row whose amount due is absent, with the reason (Req 8.15). */
  readonly amountDueAbsentRows: readonly AmountDueAbsentEntry[];

  /** Retained contact rows marked invalid across every loading row (Req 10.8). */
  readonly invalidContactCount: number;
  /** Contact segments beyond the 20-row per-case per-channel cap (Req 10.1, 10.2). */
  readonly contactOverflowCount: number;
  /**
   * Contact segments discarded because an earlier segment held the same stored value (Req 10.6).
   * Reported for the wizard only: `cancellation_import_runs` carries no column for it.
   */
  readonly duplicateContactCount: number;

  /** Every row that will load, in data row order, ready for the loader. */
  readonly plan: readonly PreviewedCaseRow[];

  /** Status distribution for the eficacia status mapping (REQ-2.3). */
  readonly statusCounts: Readonly<Record<string, number>>;
}

/**
 * The `cancellation_import_runs` columns this preview determines, under their database names. The
 * loader adds the columns the preview cannot know: `file_name`, `column_set`, `imported_by`,
 * `confirmed_mapping`, and `completed_at`.
 */
export interface ImportRunCounts {
  readonly rows_total: number;
  readonly rows_created: number;
  readonly rows_updated: number;
  readonly rows_rejected: number;
  readonly rows_duplicate: number;
  readonly rejected_rows: readonly RowRejection[];
  readonly duplicate_rows: readonly DuplicateRowEntry[];
  readonly unmatched_producer_labels: readonly ProducerLabelEntry[];
  readonly unmatched_customer_rows: readonly UnmatchedCustomerEntry[];
  readonly invalid_contact_count: number;
  readonly contact_overflow_count: number;
  readonly amount_due_absent_rows: readonly AmountDueAbsentEntry[];
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ImportPreviewInput {
  /** The confirmed mapping, which also carries the classified column set (Req 8.4). */
  readonly mapping: ConfirmedMapping;
  /** The decoded data rows below the header, in source order, as `parseCsv` produced them. */
  readonly rows: readonly (readonly string[])[];
  /**
   * Data row number of the row at the same index, counted from 1 for the first row after the
   * header (Req 8.6). Defaults to `index + 1`, which is `parseCsv`'s `rowNumbers`.
   */
  readonly rowNumbers?: readonly number[];
  /**
   * Source text of the row at the same index, where the caller kept it, for the Requirement 24.8
   * pre-insert self-check. Absent entries fall back to the reread comparison `fields.ts` performs.
   */
  readonly sourceRows?: readonly (string | null)[];
  /**
   * Case identities already stored. An accepted row whose identity is in this set counts as an
   * update (Req 9.2); every other accepted row counts as a create (Req 9.3). Omit it to preview
   * every accepted row as a create.
   */
  readonly existingIdentities?: Iterable<ExistingIdentityInput>;
  /**
   * Contact values each existing case already holds, keyed by `identityKey`. They are counted
   * against the 20-row per-channel cap and deduped against, because both rules are per case
   * (Req 10.1, 10.2, 10.6). Omit it and every case is previewed as holding no contacts, which is
   * exact for a create and a lower bound on the duplicate contact count for an update.
   */
  readonly existingContactValues?: ReadonlyMap<string, ExistingContactValues>;
}

/** Optional inputs of `previewParsedFile`, which reads the rows and row numbers from the parse. */
export type PreviewParsedFileOptions = Omit<ImportPreviewInput, 'mapping' | 'rows' | 'rowNumbers'>;

// ---------------------------------------------------------------------------
// Building the preview
// ---------------------------------------------------------------------------

const NO_EXISTING_CONTACTS: ExistingContactValues = {};

interface IdentityClaim {
  readonly row: readonly string[];
  readonly rowNumber: number;
  readonly identity: CancellationCaseIdentity;
  readonly key: string;
  readonly fields: CancellationCaseFields;
  readonly producer: ProducerLabelResult;
  readonly amountDueAbsent: AmountDueAbsentEntry | null;
  readonly unmatchedProducerLabel: ProducerLabelEntry | null;
  readonly unmatchedCustomer: UnmatchedCustomerEntry | null;
}

/**
 * Previews a confirmed mapping over the parsed data rows of one file (Req 8.5, 8.6, 9.4, 9.11).
 *
 * Each row is parsed once through `parseMappedRow`. A rejected row is recorded with its data row
 * number and reason and takes no further part (Req 8.6, 8.9). An accepted row claims its case
 * identity; where two or more rows claim the same identity, the lowest data row number keeps the
 * claim and every other row is counted as a duplicate (Req 9.4). Each surviving claim is a create or
 * an update depending on whether its identity is already stored (Req 9.2, 9.3), and its contact
 * rows are built so the two contact counts of Requirement 10 can be shown before confirmation.
 *
 * Every detail list is ordered by data row number, so two previews of the same file are identical
 * values. Nothing is written and nothing is read: the only inputs are the parameters.
 */
export function buildImportPreview(input: ImportPreviewInput): ImportPreview {
  const { mapping, rows } = input;
  const existingIdentities =
    input.existingIdentities === undefined
      ? new Set<string>()
      : buildExistingIdentitySet(input.existingIdentities);
  const existingContactValues = input.existingContactValues;

  const rejectedRows: RowRejection[] = [];
  const duplicateRows: DuplicateRowEntry[] = [];
  const claims = new Map<string, IdentityClaim>();

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rowNumber = input.rowNumbers?.[index] ?? index + 1;
    const result = parseMappedRow(mapping, row, rowNumber, input.sourceRows?.[index]);

    if (!result.accepted) {
      rejectedRows.push(result.rejection);
      continue;
    }

    const key = identityKey(result.identity);
    const claim: IdentityClaim = {
      row,
      rowNumber: result.rowNumber,
      identity: result.identity,
      key,
      fields: result.fields,
      producer: result.producer,
      amountDueAbsent: result.notices.amountDueAbsent,
      unmatchedProducerLabel: result.notices.unmatchedProducerLabel,
      unmatchedCustomer: result.notices.unmatchedCustomer,
    };

    const held = claims.get(key);
    if (held === undefined) {
      claims.set(key, claim);
      continue;
    }

    // Requirement 9.4: the row with the lowest source row number loads. Comparing row numbers
    // rather than trusting arrival order means an unordered `rows` array still picks that row.
    if (claim.rowNumber < held.rowNumber) {
      claims.set(key, claim);
      duplicateRows.push({ row_number: held.rowNumber, duplicate_of_row_number: claim.rowNumber });
    } else {
      duplicateRows.push({ row_number: claim.rowNumber, duplicate_of_row_number: held.rowNumber });
    }
  }

  const unmatchedProducerLabels: ProducerLabelEntry[] = [];
  const unmatchedCustomerRows: UnmatchedCustomerEntry[] = [];
  const amountDueAbsentRows: AmountDueAbsentEntry[] = [];
  const plan: PreviewedCaseRow[] = [];
  let rowsCreated = 0;
  let rowsUpdated = 0;
  let invalidContactCount = 0;
  let contactOverflowCount = 0;
  let duplicateContactCount = 0;

  for (const claim of byRowNumber(claims.values())) {
    const outcome: PreviewOutcome = existingIdentities.has(claim.key) ? 'update' : 'create';
    if (outcome === 'update') rowsUpdated += 1;
    else rowsCreated += 1;

    const contacts = buildCaseContactsFromRow(
      mapping,
      claim.row,
      existingContactValues?.get(claim.key) ?? NO_EXISTING_CONTACTS,
    );
    invalidContactCount += contacts.invalidContactCount;
    contactOverflowCount += contacts.contactOverflowCount;
    duplicateContactCount += contacts.duplicateContactCount;

    if (claim.unmatchedProducerLabel !== null) unmatchedProducerLabels.push(claim.unmatchedProducerLabel);
    if (claim.unmatchedCustomer !== null) unmatchedCustomerRows.push(claim.unmatchedCustomer);
    if (claim.amountDueAbsent !== null) amountDueAbsentRows.push(claim.amountDueAbsent);

    plan.push({
      rowNumber: claim.rowNumber,
      identity: claim.identity,
      key: claim.key,
      outcome,
      fields: claim.fields,
      producer: claim.producer,
      contacts,
    });
  }

  // Compute status distribution from the plan rows (REQ-2.3)
  const statusCounts: Record<string, number> = {};
  for (const entry of plan) {
    const status = entry.fields.case_status ?? 'Imported';
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }

  return {
    columnSet: mapping.columnSet,
    rowsTotal: rows.length,
    rowsCreated,
    rowsUpdated,
    rowsRejected: rejectedRows.length,
    rowsDuplicate: duplicateRows.length,
    rejectedRows: sortByRowNumber(rejectedRows),
    duplicateRows: sortByRowNumber(duplicateRows),
    unmatchedProducerLabels,
    unmatchedCustomerRows,
    amountDueAbsentRows,
    invalidContactCount,
    contactOverflowCount,
    duplicateContactCount,
    plan,
    statusCounts,
  };
}

/**
 * `buildImportPreview` over a parsed file, taking the data rows and their data row numbers from
 * `parseCsv`. The mapping's own `header` is what the columns were confirmed against; `parsed.header`
 * is not reread here.
 */
export function previewParsedFile(
  mapping: ConfirmedMapping,
  parsed: ParsedCsv,
  options: PreviewParsedFileOptions = {},
): ImportPreview {
  return buildImportPreview({
    ...options,
    mapping,
    rows: parsed.rows,
    rowNumbers: parsed.rowNumbers,
  });
}

// ---------------------------------------------------------------------------
// Handing the preview to the import run
// ---------------------------------------------------------------------------

/**
 * The preview's counts and detail arrays under their `cancellation_import_runs` column names, so
 * the row the loader inserts carries exactly the numbers the manager confirmed and the completion
 * summary reads back the same five counts (Req 8.5, 8.8).
 */
export function toImportRunCounts(preview: ImportPreview): ImportRunCounts {
  return {
    rows_total: preview.rowsTotal,
    rows_created: preview.rowsCreated,
    rows_updated: preview.rowsUpdated,
    rows_rejected: preview.rowsRejected,
    rows_duplicate: preview.rowsDuplicate,
    rejected_rows: preview.rejectedRows,
    duplicate_rows: preview.duplicateRows,
    unmatched_producer_labels: preview.unmatchedProducerLabels,
    unmatched_customer_rows: preview.unmatchedCustomerRows,
    invalid_contact_count: preview.invalidContactCount,
    contact_overflow_count: preview.contactOverflowCount,
    amount_due_absent_rows: preview.amountDueAbsentRows,
  };
}

/**
 * True when the four outcome counts add up to the data row count. Every data row is rejected,
 * duplicate, created, or updated, and never two of those, so this holds for every preview; it is
 * exported so a caller can assert the partition rather than assume it.
 */
export function countsPartitionRowsTotal(preview: ImportPreview): boolean {
  return (
    preview.rowsCreated + preview.rowsUpdated + preview.rowsRejected + preview.rowsDuplicate ===
    preview.rowsTotal
  );
}

/** The `cancellation_contacts` rows of every loading row, in data row order (Req 10.1–10.13). */
export function previewContactRows(preview: ImportPreview): CaseContactBuildResult['rows'] {
  return preview.plan.flatMap((previewed) => previewed.contacts.rows);
}

// ---------------------------------------------------------------------------
// Ordering helpers
// ---------------------------------------------------------------------------

/** Claims in data row order, so the plan and every derived list read like the source file. */
function byRowNumber(claims: Iterable<IdentityClaim>): IdentityClaim[] {
  return [...claims].sort((left, right) => left.rowNumber - right.rowNumber);
}

/** Detail entries in data row order. Sorted rather than assumed, so `rows` may arrive unordered. */
function sortByRowNumber<T extends { readonly row_number: number }>(entries: T[]): T[] {
  return entries.sort((left, right) => left.row_number - right.row_number);
}
