// Cancellation import: the loader — the one module of the importer that performs I/O.
//
// Step 6 of `parse -> classify -> map -> preview -> confirm -> load`
// (design.md, "Cancellation_Importer — src/features/cancellations/import/"). Everything
// upstream is pure: `csv.ts` decodes, `classify.ts` decides the column set, `mapping.ts`
// confirms the mapping, `fields.ts` parses one row, `contacts.ts` builds its contact rows, and
// `preview.ts` counts the five outcomes and produces the plan. Nothing above this file reads or
// writes anything. This file is where the database appears, and it does four things:
//
//  1. **Reads the state the preview cannot.** Which case identities already exist decides create
//     versus update (Requirements 9.2, 9.3), and which contact values a case already holds decides
//     the per-case dedup and the 20-row cap for an update (Requirements 9.8, 10.1, 10.2, 10.6).
//     `fetchExistingCaseState` reads both and hands back shapes `preview.ts` accepts unchanged.
//  2. **Resolves the producer label to `assigned_to`.** `fields.ts` returns
//     `producer.normalizedLabel` and always leaves `assignedTo` null, because the comparison needs
//     the stored assignment mapping (Requirements 9.6, 9.7). That comparison happens here.
//  3. **Calls the loader RPC once.** One statement, one transaction, one import audit entry
//     (Requirements 8.7, 8.8, 9.2, 9.3, 9.8, 15.10, 15.11, 24.1).
//  4. **Runs the escalation evaluation after the RPC returns** (Requirement 20.10), in the exact
//     order `../domain/escalation` documents, because that order is what caps notifications at one
//     per (case, reason) pair.
//
// ---------------------------------------------------------------------------------------------
// THE RPC CONTRACT
// ---------------------------------------------------------------------------------------------
// `public.cancellation_import_batch(p_file_name text, p_column_set text, p_mapping jsonb,
// p_rows jsonb) returns cancellation_import_runs` (`v1.10.5-cancellation-import-batch.sql`) is
// `security definer` and gated on `public.cancellation_is_manager()`, so a non-manager gets
// `42501` with nothing written (Requirement 8.5).
//
//   p_mapping  the `ConfirmedMapping` of `mapping.ts` verbatim. Its `header` array is also the
//              source of `cancellation_cases.raw_header`, which is one value per file and
//              therefore absent from every row (Requirement 24.1). An empty header is refused by
//              the RPC, so it is refused here first, with a code a wizard can render.
//   p_rows     `{ counts: <ImportRunCounts>, rows: [ <row element> ] }`, where each row element is
//              one `preview.plan` entry with its `fields` flattened into the element — so the keys
//              are `cancellation_cases` column names, `raw_row` among them, already a JSON array in
//              source column order and in the same order as `p_mapping.header` — plus `row_number`,
//              the `assigned_to` this module resolved, and the `contacts` rows.
//
// The RPC also tolerates a bare array, flattened counts, `plan` in place of `rows`, and
// unflattened `PreviewedCaseRow` elements. `buildImportBatchPayload` sends the canonical shape.
//
// **A rejected row aborts nothing** (Requirement 8.9): a rejected row is simply not in the
// payload, and its data row number and reason travel in `counts.rejected_rows`, which the RPC
// stores on the import run. So accepted rows load whatever else the file contained, and every
// rejection is still reported. The same holds for an in-file duplicate (Requirement 9.4). A file
// whose every data row was rejected therefore still records exactly one import audit entry, with
// zero cases created — which is why an empty row array is loaded rather than refused.
//
// ---------------------------------------------------------------------------------------------
// ROW LEVEL SECURITY, AND WHY FAILURES ARE DATA HERE
// ---------------------------------------------------------------------------------------------
// RLS is enabled on all 16 `cancellation_*` tables (`v1.10.6-cancellation-rls.sql`), and the
// assignment mapping's own select policy is narrower still. A refused *read* under RLS is not an
// error: it returns zero rows. So "the mapping is empty" and "you are not allowed to see the
// mapping" are the same HTTP response, and a loader that reported an empty mapping would silently
// resolve every producer label to nobody.
//
// This module therefore returns outcomes as data rather than following `renewals/api.ts` in
// throwing on every error: `{ ok: false, failure: { code: 'unauthorized' } }` is a different value
// from a run that loaded with an empty mapping, and a caller can render the two differently.
// `loadImportBatch` establishes the role from `public.profiles` before it reads anything, so an
// Agent_Role session is told it is unauthorized instead of being handed an empty world. The
// Supabase client itself is the repo's: `getSupabase()` from `../../nhwd-shared/client`, with the
// client injectable so a server-side caller can pass a service-role client instead.
//
// Manager_Role means `manager` or `super_admin` throughout, which is what
// `public.cancellation_is_manager()` tests and what `isBroadManagerRole` names in TypeScript.

import type { SupabaseClient } from '@supabase/supabase-js';

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import { currentBusinessDate } from '@/features/renewals/derive';

import { getSupabase } from '../../nhwd-shared/client';
import type {
  CaseStatus,
  CommunicationRecord,
  CommunicationStatus,
  EscalationRecord,
  NextRequiredAction,
} from '../domain/communication-status';
import {
  planEscalations,
  type EscalationAssignee,
  type EscalationCase,
  type EscalationContact,
  type EscalationPlan,
  type EscalationRaisedEventDetail,
  type EscalationReason,
  type EscalationRecipientProfile,
  type EscalationResponseRecord,
} from '../domain/escalation';
import type { CancellationEventInsert, SuppressionChannel, SuppressionRecord } from '../domain/suppression';
import type { ExistingContactValues, ImportedContactRow } from './contacts';
import {
  normalizeProducerLabel,
  unmatchedProducerEntry,
  type CancellationCaseFields,
  type ProducerLabelEntry,
  type ProducerLabelResult,
} from './fields';
import type { ConfirmedMapping } from './mapping';
import {
  identityKey,
  toImportRunCounts,
  type ImportPreview,
  type ImportRunCounts,
  type PreviewedCaseRow,
  type StoredCaseIdentityRow,
} from './preview';

// ---------------------------------------------------------------------------
// Client, errors, and outcomes
// ---------------------------------------------------------------------------

/**
 * The Supabase client this module reads and writes through. `getSupabase()` — the cookie-aware
 * browser client the rest of the feature modules share — is the default; a server-side caller
 * passes its own client, which is how the same code runs under a service-role key.
 */
export type CancellationLoaderClient = SupabaseClient;

/** The subset of a PostgREST error this module reads. Structural, so a thrown value fits too. */
export interface PostgrestErrorLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

export type ImportLoadFailureCode =
  /** The session is absent, or its profile does not hold Manager_Role (Requirement 8.5). */
  | 'unauthorized'
  /** The assignment mapping could not be read, so no producer label could be resolved (Req 9.6). */
  | 'assignment_mapping_unreadable'
  /** `mapping.header` is empty, so `cancellation_cases.raw_header` has no value (Req 24.1). */
  | 'header_missing'
  /** A read the escalation evaluation or the preview needed failed. */
  | 'read_failed'
  /** The loader RPC refused the payload or failed; nothing was written. */
  | 'load_failed';

/**
 * Why a load, or a read a load needed, did not happen. `message` is manager-facing prose worded
 * the way `renewals/api.ts` words its thrown message; `cause` keeps the provider error so a caller
 * can log the code without this module having to guess what is worth logging.
 */
export interface ImportLoadFailure {
  code: ImportLoadFailureCode;
  message: string;
  cause: PostgrestErrorLike | null;
}

export type ImportLoadResult =
  | { ok: true; outcome: ImportLoadOutcome }
  | { ok: false; failure: ImportLoadFailure };

/** The `cancellation_import_runs` row the RPC returns (Requirement 8.8). */
export interface CancellationImportRunRow {
  id: string;
  file_name: string;
  column_set: string;
  imported_by: string;
  confirmed_mapping: unknown;
  rows_total: number;
  rows_created: number;
  rows_updated: number;
  rows_rejected: number;
  rows_duplicate: number;
  rejected_rows: unknown;
  duplicate_rows: unknown;
  unmatched_producer_labels: unknown;
  unmatched_customer_rows: unknown;
  invalid_contact_count: number;
  contact_overflow_count: number;
  amount_due_absent_rows: unknown;
  completed_at: string;
}

/** What one confirmed import did. */
export interface ImportLoadOutcome {
  /** The stored import audit entry, with the created/updated split as the upsert performed it. */
  run: CancellationImportRunRow;
  /** Row elements sent to the RPC: the rows that create or update a case (Req 9.2, 9.3). */
  rowsSent: number;
  /** Rows whose producer label resolved to a profile (Requirement 9.6). */
  rowsAssigned: number;
  /**
   * Every producer label that left a case unassigned, by data row number (Requirement 9.7): the
   * `(Deleted)` labels the preview already found, plus the assignment mapping misses only this
   * module can find. This is the list the RPC stored on the import run.
   */
  unmatchedProducerLabels: ProducerLabelEntry[];
  /** What the post-load escalation evaluation did (Requirement 20.10). */
  escalations: EscalationRunSummary;
}

const GENERIC_FAILURE_MESSAGE = 'The cancellation import could not be completed.';

/** PostgreSQL `insufficient_privilege`, which is what the RPC's Requirement 8.5 gate raises. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** PostgREST's own authentication and authorization codes. */
const POSTGREST_AUTH_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303']);

function errorLike(error: unknown): PostgrestErrorLike | null {
  if (error === null || error === undefined || typeof error !== 'object') return null;
  return error as PostgrestErrorLike;
}

/**
 * True for an error that means "you may not do this", as opposed to "this did not work": the
 * `42501` the RPC raises for a non-manager (Requirement 8.5), the `42501` row level security
 * raises for a refused write, and PostgREST's own auth codes.
 *
 * A refused *read* raises nothing at all — RLS filters it to zero rows — which is exactly why
 * `loadImportBatch` establishes the role up front instead of inferring it from an error.
 */
export function isUnauthorizedError(error: unknown): boolean {
  const candidate = errorLike(error);
  if (candidate === null) return false;
  if (candidate.code === INSUFFICIENT_PRIVILEGE) return true;
  if (candidate.code !== undefined && POSTGREST_AUTH_CODES.has(candidate.code)) return true;
  const message = (candidate.message ?? '').toLowerCase();
  return message.includes('permission denied') || message.includes('row-level security');
}

function failure(
  code: ImportLoadFailureCode,
  message: string,
  cause: unknown = null,
): ImportLoadFailure {
  const candidate = errorLike(cause);
  return {
    code,
    message: message.length > 0 ? message : GENERIC_FAILURE_MESSAGE,
    cause: candidate,
  };
}

function readFailure(what: string, error: unknown): ImportLoadFailure {
  if (isUnauthorizedError(error)) {
    return failure('unauthorized', `Reading ${what} requires Manager_Role.`, error);
  }
  const candidate = errorLike(error);
  return failure('read_failed', candidate?.message ?? `${what} could not be read.`, error);
}

// ---------------------------------------------------------------------------
// The importing profile (Requirement 8.5)
// ---------------------------------------------------------------------------

/** The signed-in profile as the loader reads it. */
export interface ImporterProfile {
  id: string;
  display_name: string | null;
  role: AppRole;
}

export type ImporterProfileResult =
  | { ok: true; profile: ImporterProfile }
  | { ok: false; failure: ImportLoadFailure };

/**
 * The signed-in profile, refused unless it holds Manager_Role (Requirement 8.5).
 *
 * This is the same test the RPC performs with `public.cancellation_is_manager()` — `manager` or
 * `super_admin` — run before any read so an unauthorized session is named as such rather than
 * handed the empty world row level security would give it. It is not a substitute for the RPC's
 * gate: that gate is what actually protects the write, and it runs whatever this returns.
 */
export async function readImporterProfile(
  client: CancellationLoaderClient = getSupabase(),
): Promise<ImporterProfileResult> {
  const { data: auth, error: authError } = await client.auth.getUser();
  if (authError !== null || auth?.user === null || auth?.user === undefined) {
    return {
      ok: false,
      failure: failure('unauthorized', 'Sign in to import cancellation reports.', authError),
    };
  }

  const { data, error } = await client
    .from('profiles')
    .select('id,display_name,role')
    .eq('id', auth.user.id)
    .maybeSingle();

  if (error !== null) return { ok: false, failure: readFailure('the signed-in profile', error) };

  const profile = (data as ImporterProfile | null) ?? null;
  if (profile === null) {
    return {
      ok: false,
      failure: failure('unauthorized', 'The signed-in profile could not be read.', null),
    };
  }
  if (!isBroadManagerRole(profile.role)) {
    return {
      ok: false,
      failure: failure(
        'unauthorized',
        'Confirming a cancellation import is reserved to a manager or super admin.',
        null,
      ),
    };
  }
  return { ok: true, profile };
}

// ---------------------------------------------------------------------------
// The assignment mapping (Requirements 9.6, 9.7)
// ---------------------------------------------------------------------------

/**
 * The table holding the assignment mapping Requirement 9.6 compares against:
 * `public.renewal_assignment_aliases`, the agency's one import-label-to-employee mapping, which
 * the Renewals import already resolves its own labels through. None of the eight `v1.10.x`
 * cancellation migrations creates a second one, and Requirement 9.6 says "the assignment
 * mapping", singular.
 */
export const ASSIGNMENT_MAPPING_TABLE = 'renewal_assignment_aliases';

/** One entry of the assignment mapping, normalized under Requirement 9.6. */
export interface ProducerAssignmentEntry {
  /** The stored label, as a manager typed it. */
  importLabel: string;
  /** `normalizeProducerLabel(importLabel)`: trimmed, whitespace runs collapsed, upper-cased. */
  normalizedLabel: string;
  profileId: string;
}

/** Normalized label to profile id: the lookup a producer label is resolved through. */
export type ProducerAssignmentLookup = ReadonlyMap<string, string>;

export interface ProducerAssignmentMapping {
  entries: ProducerAssignmentEntry[];
  byNormalizedLabel: ProducerAssignmentLookup;
}

export type ProducerAssignmentResult =
  | { ok: true; mapping: ProducerAssignmentMapping }
  | { ok: false; failure: ImportLoadFailure };

interface AssignmentAliasRow {
  import_label: string | null;
  profile_id: string | null;
}

/**
 * The Requirement 9.6 lookup built from mapping entries.
 *
 * **Both sides pass through `normalizeProducerLabel`.** The stored `normalized_label` column is
 * *not* read: `public.renewal_normalize_assignment_label` lower-cases and replaces runs of
 * whitespace *and punctuation* with a single space, while Requirement 9.6 upper-cases and collapses
 * whitespace runs only, keeping punctuation. Those are different functions, and the requirement
 * names its own. Normalizing the stored `import_label` here with the same function the row's label
 * passed through leaves exactly one definition of the comparison, in `fields.ts`.
 *
 * Where two entries normalize to one label — possible, since the stored uniqueness is on the other
 * normalization — the first entry wins. `fetchProducerAssignmentMapping` reads them ordered by
 * `import_label`, so that winner is stable across runs rather than dependent on row order.
 */
export function buildProducerAssignmentLookup(
  entries: readonly ProducerAssignmentEntry[],
): ProducerAssignmentLookup {
  const lookup = new Map<string, string>();
  for (const entry of entries) {
    if (entry.normalizedLabel.length === 0 || entry.profileId.length === 0) continue;
    if (!lookup.has(entry.normalizedLabel)) lookup.set(entry.normalizedLabel, entry.profileId);
  }
  return lookup;
}

/**
 * Reads the assignment mapping (Requirement 9.6).
 *
 * An empty mapping is a valid answer and resolves every producer label to nobody, each recorded
 * under Requirement 9.7. It is also what a session without Manager_Role gets, because that table's
 * select policy is `public.nhwd_role() = 'manager'` and a refused read returns zero rows rather
 * than an error — so `loadImportBatch` checks the role before calling this, and a caller using this
 * function on its own should do the same.
 */
export async function fetchProducerAssignmentMapping(
  client: CancellationLoaderClient = getSupabase(),
): Promise<ProducerAssignmentResult> {
  const { data, error } = await client
    .from(ASSIGNMENT_MAPPING_TABLE)
    .select('import_label,profile_id')
    .order('import_label');

  if (error !== null) {
    if (isUnauthorizedError(error)) {
      return {
        ok: false,
        failure: failure('unauthorized', 'Reading the assignment mapping requires Manager_Role.', error),
      };
    }
    const candidate = errorLike(error);
    return {
      ok: false,
      failure: failure(
        'assignment_mapping_unreadable',
        candidate?.message ?? 'The assignment mapping could not be read.',
        error,
      ),
    };
  }

  const entries: ProducerAssignmentEntry[] = [];
  for (const row of ((data ?? []) as AssignmentAliasRow[])) {
    const importLabel = row.import_label ?? '';
    const normalizedLabel = normalizeProducerLabel(importLabel);
    const profileId = row.profile_id ?? '';
    if (normalizedLabel === null || profileId.length === 0) continue;
    entries.push({ importLabel, normalizedLabel, profileId });
  }

  return { ok: true, mapping: { entries, byNormalizedLabel: buildProducerAssignmentLookup(entries) } };
}

/** Why a row's producer label did or did not resolve to an employee (Requirements 9.6, 9.7). */
export type ProducerResolutionCode =
  /** The normalized label matched an entry of the assignment mapping. */
  | 'matched'
  /** The cell held no non-whitespace character, so there is no label to look up or to record. */
  | 'no_label'
  /** The label ends with `(Deleted)`, which is invalid without any lookup (Requirement 9.7). */
  | 'deleted_label'
  /** The normalized label matched no entry of the assignment mapping (Requirement 9.7). */
  | 'no_match';

export interface ProducerResolution {
  code: ProducerResolutionCode;
  /** The resolved profile id, or `null` — which loads the case with no import assignment. */
  assignedTo: string | null;
  /** The import audit entry for an unresolved label, or `null` (Requirement 9.7). */
  unmatched: ProducerLabelEntry | null;
}

/**
 * Resolves one row's producer reading to `cancellation_cases.assigned_to` (Requirements 9.6, 9.7).
 *
 * A `(Deleted)` suffix is invalid without consulting the mapping at all, which is the order
 * Requirement 9.7 states it in, and `fields.ts` has already built that entry. A label matching no
 * entry is equally invalid and gets its own entry here, in the same shape, through
 * `unmatchedProducerEntry`. Either way the case loads with no import assignment and every other
 * field of the row still loads; a stored assignment is never cleared by an unresolved label, which
 * is the RPC's `coalesce(excluded.assigned_to, cancellation_cases.assigned_to)` (Requirement 9.8).
 *
 * A cell holding no non-whitespace character names nothing to look up and nothing to report: the
 * `avisos` column set carries no producer column at all, so reporting it would put one audit line
 * per row on every `avisos` import.
 */
export function resolveProducerAssignment(
  producer: ProducerLabelResult,
  rowNumber: number,
  lookup: ProducerAssignmentLookup,
): ProducerResolution {
  if (producer.deleted) {
    return {
      code: 'deleted_label',
      assignedTo: null,
      unmatched: producer.unmatchedEntry ?? unmatchedProducerEntry(producer.label, rowNumber),
    };
  }
  if (producer.normalizedLabel === null) {
    return { code: 'no_label', assignedTo: null, unmatched: null };
  }
  const profileId = lookup.get(producer.normalizedLabel);
  if (profileId === undefined || profileId.length === 0) {
    return {
      code: 'no_match',
      assignedTo: null,
      unmatched: unmatchedProducerEntry(producer.label, rowNumber),
    };
  }
  return { code: 'matched', assignedTo: profileId, unmatched: null };
}

// ---------------------------------------------------------------------------
// The payload (Requirements 8.7, 8.8, 8.9, 24.1)
// ---------------------------------------------------------------------------

/**
 * One `p_rows.rows` element: the case field set flattened into the element, so every key is a
 * `cancellation_cases` column name, plus the three keys the RPC reads beside them.
 */
export type ImportBatchRow = CancellationCaseFields & {
  /** The data row number, counted from 1 for the first row after the header (Requirement 8.6). */
  row_number: number;
  /** The resolved employee, or `null` (Requirements 9.6, 9.7). */
  assigned_to: string | null;
  /** The Contact_Recipient rows of this case (Requirements 10.1–10.13). */
  contacts: ImportedContactRow[];
};

/** The canonical `p_rows` value. */
export interface ImportBatchPayload {
  counts: ImportRunCounts;
  rows: ImportBatchRow[];
}

export interface ImportBatchPayloadResult {
  payload: ImportBatchPayload;
  /** One entry per payload row, in payload order, for a caller that wants the per-row reading. */
  resolutions: ProducerResolution[];
  /** The merged Requirement 9.7 list the payload carries. */
  unmatchedProducerLabels: ProducerLabelEntry[];
  rowsAssigned: number;
}

/** One payload row from one previewed row. `fields` is flattened; `raw_row` travels inside it. */
export function buildImportBatchRow(
  entry: PreviewedCaseRow,
  lookup: ProducerAssignmentLookup,
): { row: ImportBatchRow; resolution: ProducerResolution } {
  const resolution = resolveProducerAssignment(entry.producer, entry.rowNumber, lookup);
  return {
    row: {
      ...entry.fields,
      row_number: entry.rowNumber,
      assigned_to: resolution.assignedTo,
      contacts: [...entry.contacts.rows],
    },
    resolution,
  };
}

/**
 * The whole `p_rows` value for one confirmed preview.
 *
 * `counts` is `toImportRunCounts(preview)` with one change: `unmatched_producer_labels` is the
 * union of the preview's `(Deleted)` entries and this module's assignment mapping misses, ordered
 * by data row number, because Requirement 9.7 records both on the import audit entry and only the
 * loader can know the second kind. Every other count is the manager-confirmed number, which is what
 * Requirement 8.8 records; the created/updated split is overwritten by the RPC with what the upsert
 * actually did (Requirements 9.2, 9.3).
 *
 * `rows` is `preview.plan` in data row order. Rejected and duplicate rows are absent by
 * construction — they are not in the plan — which is how one rejected row aborts nothing
 * (Requirement 8.9) while still being reported by row number and reason inside `counts`.
 */
export function buildImportBatchPayload(
  preview: ImportPreview,
  lookup: ProducerAssignmentLookup,
): ImportBatchPayloadResult {
  const rows: ImportBatchRow[] = [];
  const resolutions: ProducerResolution[] = [];
  const misses: ProducerLabelEntry[] = [];
  let rowsAssigned = 0;

  for (const entry of preview.plan) {
    const built = buildImportBatchRow(entry, lookup);
    rows.push(built.row);
    resolutions.push(built.resolution);
    if (built.resolution.assignedTo !== null) rowsAssigned += 1;
    if (built.resolution.code === 'no_match' && built.resolution.unmatched !== null) {
      misses.push(built.resolution.unmatched);
    }
  }

  const unmatchedProducerLabels = mergeProducerLabelEntries(preview.unmatchedProducerLabels, misses);

  return {
    payload: {
      counts: { ...toImportRunCounts(preview), unmatched_producer_labels: unmatchedProducerLabels },
      rows,
    },
    resolutions,
    unmatchedProducerLabels,
    rowsAssigned,
  };
}

/**
 * The preview's unresolved labels and the loader's, in data row number order, one entry per row.
 * A row cannot be both: a `(Deleted)` label never reaches the mapping lookup.
 */
function mergeProducerLabelEntries(
  fromPreview: readonly ProducerLabelEntry[],
  fromLookup: readonly ProducerLabelEntry[],
): ProducerLabelEntry[] {
  const byRowNumber = new Map<number, ProducerLabelEntry>();
  for (const entry of fromPreview) byRowNumber.set(entry.row_number, entry);
  for (const entry of fromLookup) if (!byRowNumber.has(entry.row_number)) byRowNumber.set(entry.row_number, entry);
  return [...byRowNumber.values()].sort((left, right) => left.row_number - right.row_number);
}

// ---------------------------------------------------------------------------
// Existing state the preview needs (Requirements 9.2, 9.3, 9.8, 10.6)
// ---------------------------------------------------------------------------

/** How many values one `in (...)` filter carries, so a 20,000-row file stays inside URL limits. */
const READ_CHUNK_SIZE = 200;

/** The stored state of the cases a file is about to touch. */
export interface ExistingCaseState {
  /**
   * `{ policy_number_normalized, cancellation_effective_date }` rows exactly as PostgREST returned
   * them, ready to pass to `buildImportPreview` as `existingIdentities` unchanged.
   */
  identities: StoredCaseIdentityRow[];
  /** The same identities as `identityKey` strings. */
  identityKeys: Set<string>;
  /** The contact values each existing case already holds, keyed by `identityKey` (Req 9.8, 10.6). */
  contactValues: Map<string, ExistingContactValues>;
}

export type ExistingCaseStateResult =
  | { ok: true; state: ExistingCaseState }
  | { ok: false; failure: ImportLoadFailure };

interface StoredCaseRow extends StoredCaseIdentityRow {
  id: string;
}

interface StoredContactRow {
  case_id: string;
  channel: 'phone' | 'email';
  normalized_value: string;
}

/** The normalized policy numbers a preview's plan claims, for the existing-state lookup. */
export function previewPolicyNumbers(preview: ImportPreview): string[] {
  const numbers = new Set<string>();
  for (const entry of preview.plan) numbers.add(entry.identity.policyNumberNormalized);
  return [...numbers];
}

/**
 * Reads the stored case identities and contact values for a set of normalized policy numbers.
 *
 * The preview is pure and cannot look anything up, so this is the read that lets it answer
 * Requirements 9.2 and 9.3 — an identity already stored is an update, every other accepted row is
 * a create — and the read that makes the contact counts of an update honest, because the 20-row cap
 * and the dedup key are per case and not per cell (Requirements 9.8, 10.1, 10.2, 10.6).
 *
 * The filter is the *policy number* rather than the identity pair, so a row whose policy number
 * exists under a different effective date is returned too: that row creates a second case
 * (Requirement 9.3), and seeing the sibling identity is what lets a preview say so.
 *
 * Under row level security a session that cannot read a case simply does not see it, so the preview
 * would call an update a create and the RPC's upsert would then perform an update anyway — the
 * stored counts stay right because the RPC recomputes the split from `xmax`. Call
 * `readImporterProfile` first all the same, so an unauthorized session is named rather than shown
 * a world with no cases in it.
 */
export async function fetchExistingCaseState(
  policyNumbersNormalized: Iterable<string>,
  client: CancellationLoaderClient = getSupabase(),
): Promise<ExistingCaseStateResult> {
  const policyNumbers = [...new Set(policyNumbersNormalized)].filter((value) => value.length > 0);
  const state: ExistingCaseState = {
    identities: [],
    identityKeys: new Set<string>(),
    contactValues: new Map<string, ExistingContactValues>(),
  };
  if (policyNumbers.length === 0) return { ok: true, state };

  const caseRows: StoredCaseRow[] = [];
  for (const chunk of chunked(policyNumbers, READ_CHUNK_SIZE)) {
    const { data, error } = await client
      .from('cancellation_cases')
      .select('id,policy_number_normalized,cancellation_effective_date')
      .in('policy_number_normalized', chunk);
    if (error !== null) return { ok: false, failure: readFailure('stored cancellation cases', error) };
    caseRows.push(...((data ?? []) as unknown as StoredCaseRow[]));
  }

  const keyByCaseId = new Map<string, string>();
  for (const row of caseRows) {
    const key = identityKey({
      policyNumberNormalized: row.policy_number_normalized,
      cancellationEffectiveDate: row.cancellation_effective_date,
    });
    state.identities.push({
      policy_number_normalized: row.policy_number_normalized,
      cancellation_effective_date: row.cancellation_effective_date,
    });
    state.identityKeys.add(key);
    keyByCaseId.set(row.id, key);
  }

  if (caseRows.length === 0) return { ok: true, state };

  const contactRows = await selectByCaseIds<StoredContactRow>(
    client,
    'cancellation_contacts',
    'case_id,channel,normalized_value',
    [...keyByCaseId.keys()],
    'stored contact recipients',
  );
  if (!contactRows.ok) return { ok: false, failure: contactRows.failure };

  const phoneValues = new Map<string, string[]>();
  const emailValues = new Map<string, string[]>();
  for (const row of contactRows.rows) {
    const key = keyByCaseId.get(row.case_id);
    if (key === undefined) continue;
    const bucket = row.channel === 'phone' ? phoneValues : emailValues;
    const values = bucket.get(key);
    if (values === undefined) bucket.set(key, [row.normalized_value]);
    else values.push(row.normalized_value);
  }
  for (const key of keyByCaseId.values()) {
    const phone = phoneValues.get(key);
    const email = emailValues.get(key);
    if (phone === undefined && email === undefined) continue;
    state.contactValues.set(key, { phone: phone ?? [], email: email ?? [] });
  }

  return { ok: true, state };
}

// ---------------------------------------------------------------------------
// The load
// ---------------------------------------------------------------------------

export interface ImportLoadOptions {
  /** `cancellation_import_runs.file_name` (Requirement 8.8). */
  fileName: string;
  /** The mapping the manager confirmed. Its `header` becomes `raw_header` (Req 8.4, 24.1). */
  mapping: ConfirmedMapping;
  /** The preview the manager confirmed. Its plan is the payload (Requirement 8.5). */
  preview: ImportPreview;
  client?: CancellationLoaderClient;
  /**
   * The assignment mapping, where the caller already holds it — the import wizard shows unmatched
   * labels before confirmation, so it does. Omitted, it is read here (Requirement 9.6).
   */
  assignments?: ProducerAssignmentLookup | readonly ProducerAssignmentEntry[];
  /** The escalation time. Defaults to the moment of the call (Requirement 20.8). */
  now?: Date;
  /** The business date as `YYYY-MM-DD`. Defaults to today in agency local time (Req 20.5). */
  businessDate?: string;
  /** The send channels currently usable, for Requirement 20.2. Both by default. */
  enabledChannels?: readonly SuppressionChannel[];
  /**
   * Set false to skip the post-load escalation evaluation. Requirement 20.10 runs one at load
   * completion, so the default is to run it; a caller that will run its own evaluation over a wider
   * set of cases can turn this one off rather than have both write.
   */
  evaluateEscalations?: boolean;
}

/**
 * Loads a confirmed preview: one RPC call, then the escalation evaluation (Requirements 8.7, 8.8,
 * 8.9, 9.2, 9.3, 9.8, 15.10, 15.11, 20.10).
 *
 * In order: establish Manager_Role, check the header the raw rows are stored against, resolve every
 * producer label through the assignment mapping, send one payload, then evaluate escalations for the
 * cases the run touched. The RPC is one transaction, so either the import run, every case, every new
 * contact row, and every audit event are committed, or none of them is; `15.10` and `15.11` are the
 * RPC's own doing, and neither the created case's `Imported`/`Not Scheduled` pair nor an updated
 * case's untouched Case_Status is written from here.
 *
 * The escalation evaluation runs *after* the RPC returns and is deliberately not part of its
 * transaction: it reads the cases that were just written and writes escalation rows, notifications,
 * and audit entries of its own. An evaluation that fails leaves the import loaded — the run row is
 * returned either way — and reports the failure in `outcome.escalations.failures`.
 */
export async function loadImportBatch(options: ImportLoadOptions): Promise<ImportLoadResult> {
  const client = options.client ?? getSupabase();

  const profile = await readImporterProfile(client);
  if (!profile.ok) return { ok: false, failure: profile.failure };

  if (options.mapping.header.length === 0) {
    return {
      ok: false,
      failure: failure(
        'header_missing',
        'The confirmed mapping carries no source header, so the raw imported rows have no header to be stored against.',
      ),
    };
  }

  const lookup = await resolveAssignmentLookup(client, options.assignments);
  if (!lookup.ok) return { ok: false, failure: lookup.failure };

  const built = buildImportBatchPayload(options.preview, lookup.lookup);

  const { data, error } = await client.rpc('cancellation_import_batch', {
    p_file_name: options.fileName,
    p_column_set: options.preview.columnSet,
    p_mapping: options.mapping,
    p_rows: built.payload,
  });

  if (error !== null) {
    const candidate = errorLike(error);
    return {
      ok: false,
      failure: failure(
        isUnauthorizedError(error) ? 'unauthorized' : 'load_failed',
        candidate?.message ?? GENERIC_FAILURE_MESSAGE,
        error,
      ),
    };
  }

  const run = (data as CancellationImportRunRow | null) ?? null;
  if (run === null || typeof run.id !== 'string') {
    return {
      ok: false,
      failure: failure('load_failed', 'The import completed without returning its audit entry.'),
    };
  }

  const escalations =
    options.evaluateEscalations === false
      ? skippedEscalationSummary()
      : await evaluateImportEscalations({
          client,
          importRunId: run.id,
          now: options.now,
          businessDate: options.businessDate,
          enabledChannels: options.enabledChannels,
        });

  return {
    ok: true,
    outcome: {
      run,
      rowsSent: built.payload.rows.length,
      rowsAssigned: built.rowsAssigned,
      unmatchedProducerLabels: built.unmatchedProducerLabels,
      escalations,
    },
  };
}

async function resolveAssignmentLookup(
  client: CancellationLoaderClient,
  assignments: ImportLoadOptions['assignments'],
): Promise<{ ok: true; lookup: ProducerAssignmentLookup } | { ok: false; failure: ImportLoadFailure }> {
  if (assignments === undefined) {
    const read = await fetchProducerAssignmentMapping(client);
    return read.ok ? { ok: true, lookup: read.mapping.byNormalizedLabel } : { ok: false, failure: read.failure };
  }
  if (Array.isArray(assignments)) {
    return { ok: true, lookup: buildProducerAssignmentLookup(assignments) };
  }
  return { ok: true, lookup: assignments as ProducerAssignmentLookup };
}

// ---------------------------------------------------------------------------
// The post-load escalation evaluation (Requirement 20.10)
// ---------------------------------------------------------------------------

/** What one case's escalation writes did. */
export interface EscalationApplyOutcome {
  caseId: string;
  /** Every reason the evaluation found, in Requirement 20 criteria order. */
  reasons: EscalationReason[];
  /** Reasons whose row this evaluation created (Requirement 20.10). */
  raised: EscalationReason[];
  /** Reasons whose cleared row this evaluation reopened; these notify nobody. */
  reopened: EscalationReason[];
  /** Reasons already stored uncleared, including one a concurrent evaluation inserted first. */
  alreadyRaised: EscalationReason[];
  /** `public.user_notifications` rows written (Requirements 20.8, 20.9). */
  notificationsWritten: number;
  /**
   * Reasons whose row was created but whose notification write was refused. `notified_at` is left
   * null on those rows, which is the marker a server-side evaluation can repair from; the audit
   * entry records no recipient, because none was notified.
   */
  notificationsBlocked: EscalationReason[];
  caseUpdated: boolean;
  failures: ImportLoadFailure[];
}

/** What the whole post-load evaluation did. */
export interface EscalationRunSummary {
  /** False when the caller turned the evaluation off. */
  ran: boolean;
  casesEvaluated: number;
  casesEscalated: number;
  reasonsRaised: number;
  reasonsReopened: number;
  reasonsAlreadyRaised: number;
  notificationsWritten: number;
  notificationsBlocked: number;
  outcomes: EscalationApplyOutcome[];
  failures: ImportLoadFailure[];
}

function skippedEscalationSummary(): EscalationRunSummary {
  return {
    ran: false,
    casesEvaluated: 0,
    casesEscalated: 0,
    reasonsRaised: 0,
    reasonsReopened: 0,
    reasonsAlreadyRaised: 0,
    notificationsWritten: 0,
    notificationsBlocked: 0,
    outcomes: [],
    failures: [],
  };
}

export interface EvaluateImportEscalationsOptions {
  client?: CancellationLoaderClient;
  /** Evaluate every case the run touched: both branches of the upsert stamp `import_run_id`. */
  importRunId?: string;
  /** Or name the cases directly, which is what a caller re-evaluating one case does. */
  caseIds?: readonly string[];
  now?: Date;
  businessDate?: string;
  enabledChannels?: readonly SuppressionChannel[];
}

interface EscalationCaseRow {
  id: string;
  case_status: CaseStatus;
  communication_status: CommunicationStatus | null;
  cancellation_effective_date: string | null;
  next_required_action: NextRequiredAction | null;
  assistance_requested: boolean | null;
  assigned_to: string | null;
  follow_up_deadline: string | null;
  policy_number: string | null;
  customer_name: string | null;
}

const ESCALATION_CASE_COLUMNS =
  'id,case_status,communication_status,cancellation_effective_date,next_required_action,' +
  'assistance_requested,assigned_to,follow_up_deadline,policy_number,customer_name';

/**
 * Runs an escalation evaluation for every case an import touched (Requirement 20.10).
 *
 * Both branches of the RPC's upsert write `import_run_id`, so `import_run_id = <run>` is exactly
 * the created and updated cases of that run and nothing else. Every row the seven reasons read
 * arrives from one read per table rather than one per case, and the evaluation itself is
 * `planEscalations` from `../domain/escalation` — this module derives no reason of its own.
 *
 * A read that fails ends the evaluation with the failure recorded; the import is already committed
 * and stays committed. A write that fails is recorded against its case and the remaining cases are
 * still evaluated, because a per-case escalation is independent of every other.
 */
export async function evaluateImportEscalations(
  options: EvaluateImportEscalationsOptions,
): Promise<EscalationRunSummary> {
  const client = options.client ?? getSupabase();
  const summary = skippedEscalationSummary();
  summary.ran = true;

  const now = options.now ?? new Date();
  const businessDate = options.businessDate ?? currentBusinessDate(now);

  const cases = await readEscalationCases(client, options);
  if (!cases.ok) {
    summary.failures.push(cases.failure);
    return summary;
  }
  if (cases.rows.length === 0) return summary;

  const caseIds = cases.rows.map((row) => row.id);

  const contacts = await selectByCaseIds<EscalationContact>(
    client,
    'cancellation_contacts',
    'id,case_id,channel,normalized_value,validation_status,authorization_status,sms_suppressed,email_suppressed',
    caseIds,
    'contact recipients',
  );
  if (!contacts.ok) {
    summary.failures.push(contacts.failure);
    return summary;
  }

  const communications = await selectByCaseIds<CommunicationRecord>(
    client,
    'cancellation_communications',
    'id,case_id,contact_id,touchpoint,channel,delivery_result,send_time',
    caseIds,
    'communication records',
  );
  if (!communications.ok) {
    summary.failures.push(communications.failure);
    return summary;
  }

  const responses = await selectByCaseIds<EscalationResponseRecord>(
    client,
    'cancellation_customer_responses',
    'id,case_id,response_type,response_time',
    caseIds,
    'customer responses',
  );
  if (!responses.ok) {
    summary.failures.push(responses.failure);
    return summary;
  }

  const escalations = await selectByCaseIds<EscalationRecord>(
    client,
    'cancellation_escalations',
    'id,case_id,reason,raised_at,cleared_at,cleared_by,notified_at',
    caseIds,
    'stored escalations',
  );
  if (!escalations.ok) {
    summary.failures.push(escalations.failure);
    return summary;
  }

  const suppressions = await readActiveSuppressions(client);
  if (!suppressions.ok) {
    summary.failures.push(suppressions.failure);
    return summary;
  }

  const managerProfiles = await readManagerProfiles(client);
  if (!managerProfiles.ok) {
    summary.failures.push(managerProfiles.failure);
    return summary;
  }

  const assignees = await readAssignees(
    client,
    cases.rows.map((row) => row.assigned_to),
  );
  if (!assignees.ok) {
    summary.failures.push(assignees.failure);
    return summary;
  }

  const contactsByCase = groupByCaseId(contacts.rows);
  const communicationsByCase = groupByCaseId(communications.rows);
  const responsesByCase = groupByCaseId(responses.rows);
  const escalationsByCase = groupByCaseId(escalations.rows);

  for (const row of cases.rows) {
    const caseRow: EscalationCase = { ...row };
    const planned = planEscalations(
      {
        case: caseRow,
        contacts: contactsByCase.get(row.id) ?? [],
        communications: communicationsByCase.get(row.id) ?? [],
        responses: responsesByCase.get(row.id) ?? [],
        escalations: escalationsByCase.get(row.id) ?? [],
        suppressions: suppressions.rows,
        businessDate,
        enabledChannels: options.enabledChannels,
      },
      {
        now,
        assignedEmployee: row.assigned_to === null ? null : assignees.byId.get(row.assigned_to) ?? null,
        managerProfiles: managerProfiles.rows,
      },
    );

    summary.casesEvaluated += 1;

    if (!planned.ok) {
      summary.failures.push(failure('read_failed', planned.rejection.message));
      continue;
    }

    const outcome = await applyEscalationPlan(planned.plan, client);
    summary.outcomes.push(outcome);
    if (outcome.reasons.length > 0) summary.casesEscalated += 1;
    summary.reasonsRaised += outcome.raised.length;
    summary.reasonsReopened += outcome.reopened.length;
    summary.reasonsAlreadyRaised += outcome.alreadyRaised.length;
    summary.notificationsWritten += outcome.notificationsWritten;
    summary.notificationsBlocked += outcome.notificationsBlocked.length;
    summary.failures.push(...outcome.failures);
  }

  return summary;
}

/**
 * Writes one escalation plan (Requirements 20.8, 20.9, 20.10, 20.11).
 *
 * The order is the one `../domain/escalation` fixes, and it is the whole of Requirement 20.10's
 * one-notification-per-(case, reason) guarantee:
 *
 *  1. insert the escalation row with `on conflict (case_id, reason) do nothing`, returning the row
 *     it created — `upsert(..., { ignoreDuplicates: true }).select('id')` is that statement;
 *  2. **only when step 1 created a row**, write the notification rows, then stamp `notified_at` on
 *     the row step 1 returned;
 *  3. write the case update and the audit entries.
 *
 * A concurrent evaluation that inserted first takes the notification and this one writes none: step
 * 1 returns no row for it, so step 2 never runs. Neither evaluation has to read first, because the
 * unique key decides. A reopened row writes no notification at all — that pair has had its one.
 *
 * Where step 2's notification write is refused — `public.user_notifications` has no insert policy,
 * so a browser session cannot write one, and only a server-side caller can — `notified_at` is left
 * null and the audit entry records no recipient. The escalation row and the case update still stand,
 * so Requirement 20.11 keeps Communication_Status at Manual Follow-up Required and the case still
 * surfaces as needing a person; the unnotified row is reported for a caller that can repair it.
 *
 * The case update is written only where at least one raise took effect. Requirement 20.8 sets the
 * deadline when Communication_Status *becomes* Manual Follow-up Required, so an evaluation whose
 * every reason was already raised must not push the deadline forward.
 */
export async function applyEscalationPlan(
  plan: EscalationPlan,
  client: CancellationLoaderClient = getSupabase(),
): Promise<EscalationApplyOutcome> {
  const outcome: EscalationApplyOutcome = {
    caseId: plan.caseId,
    reasons: [...plan.reasons],
    raised: [],
    reopened: [],
    alreadyRaised: [...plan.alreadyRaised],
    notificationsWritten: 0,
    notificationsBlocked: [],
    caseUpdated: false,
    failures: [],
  };

  const events: CancellationEventInsert<EscalationRaisedEventDetail>[] = [];

  for (const raise of plan.raises) {
    if (raise.kind === 'new') {
      const { data, error } = await client
        .from('cancellation_escalations')
        .upsert(raise.insert, { onConflict: 'case_id,reason', ignoreDuplicates: true })
        .select('id');

      if (error !== null) {
        outcome.failures.push(writeFailure(`the ${raise.reason} escalation`, error));
        continue;
      }

      const created = ((data ?? []) as { id?: string }[])[0]?.id ?? null;
      if (created === null) {
        // The pair already existed: another evaluation inserted it, and it owns the notification.
        outcome.alreadyRaised.push(raise.reason);
        continue;
      }

      outcome.raised.push(raise.reason);
      let notified = raise.notifications.length === 0;

      if (raise.notifications.length > 0) {
        const { error: notifyError } = await client
          .from('user_notifications')
          .insert(raise.notifications);

        if (notifyError !== null) {
          outcome.notificationsBlocked.push(raise.reason);
          outcome.failures.push(
            writeFailure(`the ${raise.reason} follow-up notification`, notifyError),
          );
        } else {
          notified = true;
          outcome.notificationsWritten += raise.notifications.length;
          const { error: stampError } = await client
            .from('cancellation_escalations')
            .update({ notified_at: raise.notifiedAt })
            .eq('id', created);
          if (stampError !== null) {
            outcome.failures.push(writeFailure(`the ${raise.reason} notification time`, stampError));
          }
        }
      }

      events.push(notified ? raise.event : unnotifiedEvent(raise.event));
      continue;
    }

    const { data, error } = await client
      .from('cancellation_escalations')
      .update({
        raised_at: raise.reopen.raised_at,
        cleared_at: raise.reopen.cleared_at,
        cleared_by: raise.reopen.cleared_by,
      })
      .eq('case_id', raise.reopen.case_id)
      .eq('reason', raise.reopen.reason)
      .not('cleared_at', 'is', null)
      .select('id');

    if (error !== null) {
      outcome.failures.push(writeFailure(`the ${raise.reason} escalation reopen`, error));
      continue;
    }
    if (((data ?? []) as unknown[]).length === 0) {
      // Another writer reopened it first, so the row is uncleared and nothing is owed here.
      outcome.alreadyRaised.push(raise.reason);
      continue;
    }

    outcome.reopened.push(raise.reason);
    events.push(raise.event);
  }

  const effective = outcome.raised.length + outcome.reopened.length;

  if (plan.caseUpdate !== null && effective > 0) {
    const { error } = await client
      .from('cancellation_cases')
      .update({
        communication_status: plan.caseUpdate.communication_status,
        follow_up_deadline: plan.caseUpdate.follow_up_deadline,
      })
      .eq('id', plan.caseUpdate.case_id);
    if (error === null) outcome.caseUpdated = true;
    else outcome.failures.push(writeFailure('the escalated case', error));
  }

  if (events.length > 0) {
    const { error } = await client.from('cancellation_events').insert(events);
    if (error !== null) outcome.failures.push(writeFailure('the escalation audit entries', error));
  }

  return outcome;
}

/**
 * The raise audit entry for a raise whose notification could not be written: same entry, no
 * recipients. An audit line claiming a notified profile that holds no notification row would be
 * false, and Requirement 20.10's guarantee is about rows, not intentions.
 */
function unnotifiedEvent(
  event: CancellationEventInsert<EscalationRaisedEventDetail>,
): CancellationEventInsert<EscalationRaisedEventDetail> {
  return { ...event, detail: { ...event.detail, recipients: null, notified_profile_ids: [] } };
}

function writeFailure(what: string, error: unknown): ImportLoadFailure {
  if (isUnauthorizedError(error)) {
    return failure('unauthorized', `Writing ${what} was refused.`, error);
  }
  const candidate = errorLike(error);
  return failure('load_failed', candidate?.message ?? `${what} could not be written.`, error);
}

// ---------------------------------------------------------------------------
// Reads behind the evaluation
// ---------------------------------------------------------------------------

async function readEscalationCases(
  client: CancellationLoaderClient,
  options: EvaluateImportEscalationsOptions,
): Promise<{ ok: true; rows: EscalationCaseRow[] } | { ok: false; failure: ImportLoadFailure }> {
  if (options.caseIds !== undefined) {
    const ids = [...new Set(options.caseIds)].filter((id) => id.length > 0);
    if (ids.length === 0) return { ok: true, rows: [] };
    const rows: EscalationCaseRow[] = [];
    for (const chunk of chunked(ids, READ_CHUNK_SIZE)) {
      const { data, error } = await client
        .from('cancellation_cases')
        .select(ESCALATION_CASE_COLUMNS)
        .in('id', chunk);
      if (error !== null) return { ok: false, failure: readFailure('the imported cases', error) };
      rows.push(...((data ?? []) as unknown as EscalationCaseRow[]));
    }
    return { ok: true, rows };
  }

  if (options.importRunId === undefined || options.importRunId.length === 0) {
    return { ok: true, rows: [] };
  }

  const { data, error } = await client
    .from('cancellation_cases')
    .select(ESCALATION_CASE_COLUMNS)
    .eq('import_run_id', options.importRunId);
  if (error !== null) return { ok: false, failure: readFailure('the imported cases', error) };
  return { ok: true, rows: (data ?? []) as unknown as EscalationCaseRow[] };
}

/**
 * The active `cancellation_suppressions` rows. Requirements 20.2 and 20.3 read suppression by
 * normalized value rather than by the per-contact flags alone, and a cleared row is history.
 */
async function readActiveSuppressions(
  client: CancellationLoaderClient,
): Promise<{ ok: true; rows: SuppressionRecord[] } | { ok: false; failure: ImportLoadFailure }> {
  const { data, error } = await client
    .from('cancellation_suppressions')
    .select('id,channel,normalized_value,cleared_at')
    .is('cleared_at', null);
  if (error !== null) return { ok: false, failure: readFailure('active suppressions', error) };
  return { ok: true, rows: (data ?? []) as unknown as SuppressionRecord[] };
}

/**
 * Every Manager_Role profile, for the Requirement 20.9 fan-out. Criterion 9 says "each profile
 * holding Manager_Role" with none of criterion 8's activity qualifier, and
 * `../domain/escalation` reading 8 leaves that filter to this query, so no activity filter is
 * applied. `planEscalations` deduplicates by id and drops any role outside Manager_Role.
 */
async function readManagerProfiles(
  client: CancellationLoaderClient,
): Promise<{ ok: true; rows: EscalationRecipientProfile[] } | { ok: false; failure: ImportLoadFailure }> {
  const { data, error } = await client
    .from('profiles')
    .select('id,role')
    .in('role', ['manager', 'super_admin'])
    .order('id');
  if (error !== null) return { ok: false, failure: readFailure('manager profiles', error) };
  return { ok: true, rows: (data ?? []) as unknown as EscalationRecipientProfile[] };
}

/**
 * The assigned employees of the evaluated cases, as Requirement 20.8 tests them.
 * `public.profiles` carries no `is_deleted` column, so the deleted test is left unset and
 * `followUpAssignee` reads it as not deleted; `is_active` is stored and is read.
 */
async function readAssignees(
  client: CancellationLoaderClient,
  assignedTo: readonly (string | null)[],
): Promise<
  { ok: true; byId: Map<string, EscalationAssignee> } | { ok: false; failure: ImportLoadFailure }
> {
  const ids = [...new Set(assignedTo.filter((id): id is string => id !== null && id.length > 0))];
  const byId = new Map<string, EscalationAssignee>();
  if (ids.length === 0) return { ok: true, byId };

  for (const chunk of chunked(ids, READ_CHUNK_SIZE)) {
    const { data, error } = await client
      .from('profiles')
      .select('id,display_name,is_active')
      .in('id', chunk);
    if (error !== null) return { ok: false, failure: readFailure('assigned employees', error) };
    for (const row of ((data ?? []) as unknown as EscalationAssignee[])) byId.set(row.id, row);
  }
  return { ok: true, byId };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * One `select ... where case_id in (...)` per chunk of case ids, concatenated. Chunked because a
 * file may carry up to 20,000 rows and a `GET` filter list has a length limit.
 */
async function selectByCaseIds<TRow>(
  client: CancellationLoaderClient,
  table: string,
  columns: string,
  caseIds: readonly string[],
  what: string,
): Promise<{ ok: true; rows: TRow[] } | { ok: false; failure: ImportLoadFailure }> {
  const rows: TRow[] = [];
  for (const chunk of chunked(caseIds, READ_CHUNK_SIZE)) {
    const { data, error } = await client.from(table).select(columns).in('case_id', chunk);
    if (error !== null) return { ok: false, failure: readFailure(what, error) };
    rows.push(...((data ?? []) as unknown as TRow[]));
  }
  return { ok: true, rows };
}

/** Rows grouped by `case_id`, so each case is evaluated from one read rather than one per case. */
function groupByCaseId<TRow extends { case_id?: string | null }>(
  rows: readonly TRow[],
): Map<string, TRow[]> {
  const grouped = new Map<string, TRow[]>();
  for (const row of rows) {
    const caseId = row.case_id ?? null;
    if (caseId === null) continue;
    const bucket = grouped.get(caseId);
    if (bucket === undefined) grouped.set(caseId, [row]);
    else bucket.push(row);
  }
  return grouped;
}

/** `values` in slices of at most `size`, in order. */
function chunked<TValue>(values: readonly TValue[], size: number): TValue[][] {
  const chunks: TValue[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
