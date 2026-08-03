// Pure helpers for the cancellation manager actions surface (task 16.11).
//
// `CancellationManagerActions.tsx` renders three things it cannot read straight off a stored row:
//
//   1. the five counts and the four detail lists of a *recorded* import run, whose jsonb columns
//      arrive as `unknown` from `api.ts` and therefore have to be read defensively (Req 8.5, 8.8);
//   2. the same five counts and lists for the run that just completed, taken from the run row the
//      loader returned so the completion summary reads back exactly what the manager confirmed;
//   3. one template-editing draft per stored language row, and the rejection text for a draft that
//      leaves a required field blank (Req 14.17).
//
// All of it is pure: no React, no Supabase, no clock, no randomness. Nothing here re-implements the
// import pipeline — the counts of a *pending* preview come from `ImportPreview` and are rendered
// directly; this module only reads a stored or returned run row and shapes a template draft.

import type { CancellationImportRun, CancellationTemplateVersion } from './api';
import type { CancellationImportRunRow } from './import/loader';
import type { ProducerLabelEntry, RowRejectionEntry, UnmatchedCustomerEntry } from './import/fields';
import type { DuplicateRowEntry } from './import/preview';
import type { TemplateLanguage } from './render/renderMessage';

// ---------------------------------------------------------------------------
// Reading a stored import run
// ---------------------------------------------------------------------------

/** A non-negative integer, and zero for anything that is not one (Requirement 8.5). */
export function importCount(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/** The elements of a jsonb array column, or an empty list for any other stored shape. */
function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRowNumber(entry: unknown): number | null {
  if (entry === null || typeof entry !== 'object') return null;
  const numeric = Number((entry as { row_number?: unknown }).row_number);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : null;
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * `rejected_rows` as `{ row_number, reason }` entries in data row order (Requirements 8.6, 8.9).
 * An element missing a usable row number is dropped rather than rendered as row zero.
 */
export function readRejectedRows(value: unknown): RowRejectionEntry[] {
  const entries: RowRejectionEntry[] = [];
  for (const element of jsonArray(value)) {
    const rowNumber = readRowNumber(element);
    if (rowNumber === null) continue;
    const reason = readText((element as { reason?: unknown }).reason);
    entries.push({ row_number: rowNumber, reason: reason === '' ? 'no reason was recorded' : reason });
  }
  return entries.sort((left, right) => left.row_number - right.row_number);
}

/** `duplicate_rows` as `{ row_number, duplicate_of_row_number }` entries in data row order (Req 9.4). */
export function readDuplicateRows(value: unknown): DuplicateRowEntry[] {
  const entries: DuplicateRowEntry[] = [];
  for (const element of jsonArray(value)) {
    const rowNumber = readRowNumber(element);
    if (rowNumber === null) continue;
    const winner = Number((element as { duplicate_of_row_number?: unknown }).duplicate_of_row_number);
    entries.push({
      row_number: rowNumber,
      duplicate_of_row_number: Number.isFinite(winner) && winner > 0 ? Math.trunc(winner) : 0,
    });
  }
  return entries.sort((left, right) => left.row_number - right.row_number);
}

/** `unmatched_producer_labels` as `{ label, row_number }` entries in data row order (Req 9.7). */
export function readProducerLabels(value: unknown): ProducerLabelEntry[] {
  const entries: ProducerLabelEntry[] = [];
  for (const element of jsonArray(value)) {
    const rowNumber = readRowNumber(element);
    if (rowNumber === null) continue;
    entries.push({ label: readText((element as { label?: unknown }).label), row_number: rowNumber });
  }
  return entries.sort((left, right) => left.row_number - right.row_number);
}

/** `unmatched_customer_rows` as `{ row_number }` entries in data row order (Requirement 9.11). */
export function readUnmatchedCustomerRows(value: unknown): UnmatchedCustomerEntry[] {
  const entries: UnmatchedCustomerEntry[] = [];
  for (const element of jsonArray(value)) {
    const rowNumber = readRowNumber(element);
    if (rowNumber === null) continue;
    entries.push({ row_number: rowNumber });
  }
  return entries.sort((left, right) => left.row_number - right.row_number);
}

/** `amount_due_absent_rows` as `{ row_number, reason }` entries in data row order (Req 8.15). */
export function readAmountDueAbsentRows(value: unknown): RowRejectionEntry[] {
  return readRejectedRows(value);
}

/**
 * The five counts and four detail lists of one import run, whichever shape the row arrived in:
 * `CancellationImportRun` as `api.ts` read it, or `CancellationImportRunRow` as the loader RPC
 * returned it. Both carry the same columns, so one reader serves the recorded-history panel and the
 * completion summary and the two cannot drift apart.
 */
export interface ImportRunSummary {
  id: string;
  fileName: string;
  columnSet: string;
  completedAt: string;
  /** The five counts of Requirement 8.5, as stored (Requirement 8.8). */
  rowsTotal: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsRejected: number;
  rowsDuplicate: number;
  rejectedRows: RowRejectionEntry[];
  duplicateRows: DuplicateRowEntry[];
  unmatchedProducerLabels: ProducerLabelEntry[];
  unmatchedCustomerRows: UnmatchedCustomerEntry[];
  amountDueAbsentRows: RowRejectionEntry[];
  invalidContactCount: number;
  contactOverflowCount: number;
}

export function summarizeImportRun(
  run: CancellationImportRun | CancellationImportRunRow,
): ImportRunSummary {
  return {
    id: run.id,
    fileName: run.file_name,
    columnSet: run.column_set,
    completedAt: run.completed_at,
    rowsTotal: importCount(run.rows_total),
    rowsCreated: importCount(run.rows_created),
    rowsUpdated: importCount(run.rows_updated),
    rowsRejected: importCount(run.rows_rejected),
    rowsDuplicate: importCount(run.rows_duplicate),
    rejectedRows: readRejectedRows(run.rejected_rows),
    duplicateRows: readDuplicateRows(run.duplicate_rows),
    unmatchedProducerLabels: readProducerLabels(run.unmatched_producer_labels),
    unmatchedCustomerRows: readUnmatchedCustomerRows(run.unmatched_customer_rows),
    amountDueAbsentRows: readAmountDueAbsentRows(run.amount_due_absent_rows),
    invalidContactCount: importCount(run.invalid_contact_count),
    contactOverflowCount: importCount(run.contact_overflow_count),
  };
}

/**
 * Distinct producer labels of an entry list, keeping the first row number each label appeared on.
 * The review panel lists one line per label rather than one per row: a label that left forty rows
 * unassigned is one mapping to fix, and the row count is what says how much it cost.
 */
export function groupProducerLabels(
  entries: readonly ProducerLabelEntry[],
): { label: string; firstRowNumber: number; rowNumbers: number[] }[] {
  const byLabel = new Map<string, { label: string; firstRowNumber: number; rowNumbers: number[] }>();
  for (const entry of entries) {
    const key = entry.label.trim().toUpperCase();
    const held = byLabel.get(key);
    if (held === undefined) {
      byLabel.set(key, { label: entry.label, firstRowNumber: entry.row_number, rowNumbers: [entry.row_number] });
      continue;
    }
    held.rowNumbers.push(entry.row_number);
    if (entry.row_number < held.firstRowNumber) held.firstRowNumber = entry.row_number;
  }
  return [...byLabel.values()].sort((left, right) => left.firstRowNumber - right.firstRowNumber);
}

// ---------------------------------------------------------------------------
// The template editing draft (Requirement 14.17)
// ---------------------------------------------------------------------------

/** The four required text fields of one `cancellation_template_versions` row. */
export const TEMPLATE_TEXT_FIELDS = [
  { key: 'subject', label: 'Subject' },
  { key: 'body', label: 'Body' },
  { key: 'cancellationStatement', label: 'Cancellation-scheduled statement' },
  { key: 'contactRequest', label: 'Contact-request statement' },
] as const;

export type TemplateTextFieldKey = (typeof TEMPLATE_TEXT_FIELDS)[number]['key'];

/** One language segment under edit. `fallbackText` keeps the stored token order (Req 14.11). */
export interface TemplateLanguageDraft {
  language: TemplateLanguage;
  subject: string;
  body: string;
  cancellationStatement: string;
  contactRequest: string;
  /** Token to fallback string. An empty string renders zero characters (Requirement 14.11). */
  fallbackText: Record<string, string>;
  /** The stored token order, so a save writes the tokens back in the order they were read. */
  fallbackTokens: string[];
}

/** One template under edit: the version the draft came from, and one draft per stored language. */
export interface TemplateDraft {
  templateId: string;
  /** The highest stored version; a save writes `baseVersion + 1` (Requirement 14.17). */
  baseVersion: number;
  languages: TemplateLanguageDraft[];
}

function fallbackEntries(stored: Record<string, string | null> | null | undefined): {
  fallbackText: Record<string, string>;
  fallbackTokens: string[];
} {
  const fallbackText: Record<string, string> = {};
  const fallbackTokens: string[] = [];
  if (stored !== null && stored !== undefined && typeof stored === 'object') {
    for (const [token, value] of Object.entries(stored)) {
      fallbackTokens.push(token);
      fallbackText[token] = value ?? '';
    }
  }
  return { fallbackText, fallbackTokens };
}

/** The highest stored version number of a template's version rows, or 0 when it has none. */
export function highestVersion(versions: readonly CancellationTemplateVersion[]): number {
  return versions.reduce((highest, version) => Math.max(highest, importCount(version.version)), 0);
}

/**
 * The editing draft of one template: every language row of its highest stored version, in
 * `BILINGUAL_SEGMENT_ORDER` (English then Spanish), with the stored words as the starting values.
 *
 * A template carrying no version row yields a draft with no language segment, which the editor
 * renders as "this template has no stored version yet" rather than as an empty form that would
 * save blank required text.
 */
export function templateDraft(
  templateId: string,
  versions: readonly CancellationTemplateVersion[],
): TemplateDraft {
  const baseVersion = highestVersion(versions);
  const rows = versions.filter((version) => importCount(version.version) === baseVersion);
  const order: readonly TemplateLanguage[] = ['English', 'Spanish'];
  const languages: TemplateLanguageDraft[] = [];

  for (const language of order) {
    const row = rows.find((version) => version.language === language);
    if (row === undefined) continue;
    languages.push({
      language,
      subject: row.subject,
      body: row.body,
      cancellationStatement: row.cancellation_statement,
      contactRequest: row.contact_request,
      ...fallbackEntries(row.fallback_text),
    });
  }

  return { templateId, baseVersion, languages };
}

/**
 * Why a template draft cannot be saved, or `null` when it can.
 *
 * Every one of the four text fields is `not null` in the database and each carries content
 * Requirement 14 requires in the rendered output, so a blank one is refused here — before the
 * insert — with the language and the field named and every entered value left on screen.
 */
export function templateDraftRejection(draft: TemplateDraft): string | null {
  if (draft.languages.length === 0) {
    return 'This template has no stored version to base a new version on. Nothing was saved.';
  }
  for (const language of draft.languages) {
    for (const field of TEMPLATE_TEXT_FIELDS) {
      if (language[field.key].trim() === '') {
        return `The ${language.language} ${field.label.toLowerCase()} needs at least one character that is not a space. Nothing was saved.`;
      }
    }
  }
  return null;
}
