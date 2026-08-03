'use client';

/**
 * The two manager-only writes of task 16.11 that `./api.ts` does not carry: saving a message
 * template as a new version (Requirement 14.17) and correcting imported data on one case
 * (Requirement 22.3).
 *
 * It is a sibling of `api.ts` rather than an addition to it, and it follows the same rules:
 * `'use client'`, the shared cookie-aware browser client, a fail-closed Manager_Role check before
 * any statement so a refusal reads as prose rather than as a PostgREST object (Requirement 22.6),
 * `isBroadManagerRole` so `super_admin` holds every `manager` permission (Requirement 22.5), and
 * an `Error` carrying manager-facing wording on failure. Row level security remains the
 * authorization boundary: `cancellation_template_versions_v1106_insert` requires
 * `cancellation_is_manager()` with `created_by = auth.uid()`, and
 * `cancellation_cases_v1106_update_manager` requires the same role.
 *
 * Nothing here re-implements the importer. A corrected policy number, effective date, and amount
 * due are read through the importer's own `fields.ts` parsers, so a value typed into the correction
 * form is accepted on exactly the terms the import would have accepted it on, and the customer
 * matching key is recomputed with the importer's own `customerMatchKey` so a corrected client
 * identifier cannot leave the key naming the old customer (Requirements 9.5, 9.9, 9.11).
 */

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { getSupabase } from '../nhwd-shared/client';
import type { CancellationTemplateVersion } from './api';
import {
  customerMatchKey,
  parseAmountDue,
  parseCancellationDate,
  parsePolicyNumber,
} from './import/fields';
import type { TemplateLanguage } from './render/renderMessage';

// ---------------------------------------------------------------------------
// Shared plumbing (worded as `api.ts` words it)
// ---------------------------------------------------------------------------

interface SupabaseErrorLike {
  message?: string;
  code?: string;
}

const UNIQUE_VIOLATION = '23505';

function throwIfError(error: SupabaseErrorLike | null, context: string): void {
  if (error === null || error === undefined) return;
  if (error.code === '42501' || /permission denied|row-level security/i.test(error.message ?? '')) {
    throw new Error(`Your role does not permit ${context}. Nothing was changed.`);
  }
  const detail = error.message ?? '';
  throw new Error(detail === '' ? `${context} failed.` : `${context} failed: ${detail}`);
}

function reject(message: string): never {
  throw new Error(message);
}

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim();
}

interface ManagerActor {
  id: string;
  role: AppRole;
}

/** The signed-in profile, refused unless it holds Manager_Role (`manager` or `super_admin`). */
async function requireManager(action: string): Promise<ManagerActor> {
  const supabase = getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError !== null || auth.user === null) {
    reject(`Your session expired. Sign in again to ${action}.`);
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id,role')
    .eq('id', auth.user.id)
    .maybeSingle();
  throwIfError(error, action);
  const actor = (data as ManagerActor | null) ?? null;
  if (actor === null) reject(`Your profile could not be read. Nothing was changed.`);
  if (!isBroadManagerRole(actor.role)) {
    reject(`${action} requires a manager or super admin. Nothing was changed.`);
  }
  return actor;
}

// ---------------------------------------------------------------------------
// Template versions (Requirement 14.17)
// ---------------------------------------------------------------------------

const TEMPLATE_VERSION_COLUMNS =
  'id,template_id,version,language,subject,body,cancellation_statement,contact_request,fallback_text,created_by,created_at';

/** One language segment of a saved template change. */
export interface TemplateVersionSaveSegment {
  language: TemplateLanguage;
  subject: string;
  body: string;
  cancellationStatement: string;
  contactRequest: string;
  /** Token to fallback string; an empty string renders zero characters (Requirement 14.11). */
  fallbackText: Record<string, string>;
}

export interface TemplateVersionSaveInput {
  templateId: string;
  /** Every language segment of the new version. At least one is required. */
  segments: readonly TemplateVersionSaveSegment[];
}

export interface TemplateVersionSaveResult {
  /** The version number written: the highest stored version plus one (Requirement 14.17). */
  version: number;
  /** The version the change was based on, as this call read it. */
  previousVersion: number;
  rows: CancellationTemplateVersion[];
}

/**
 * Saves a template change as a NEW version (Requirement 14.17).
 *
 * No stored row is updated and none is deleted: the version number written is the highest stored
 * version plus one, read inside this call rather than taken from the caller, so a draft opened
 * before another manager saved cannot overwrite that manager's version. `v1.10.1`'s
 * `before update or delete` trigger refuses both operations anyway, and the table carries no update
 * policy and no delete policy — so every existing Communication_Record keeps pointing at the exact
 * words it was sent with, whatever is saved here.
 *
 * Every segment is written in one insert, so a two-language save is one statement: a failure leaves
 * the new version absent entirely rather than half-written.
 */
export async function saveTemplateVersion(
  input: TemplateVersionSaveInput,
): Promise<TemplateVersionSaveResult> {
  const actor = await requireManager('Saving a message template');
  const supabase = getSupabase();

  if (input.segments.length === 0) {
    reject('A saved template change needs at least one language segment. Nothing was saved.');
  }
  for (const segment of input.segments) {
    const missing = (
      [
        ['subject', segment.subject],
        ['body', segment.body],
        ['cancellation-scheduled statement', segment.cancellationStatement],
        ['contact-request statement', segment.contactRequest],
      ] as const
    ).find(([, value]) => trimmed(value) === '');
    if (missing !== undefined) {
      reject(
        `The ${segment.language} ${missing[0]} needs at least one character that is not a space. Nothing was saved.`,
      );
    }
  }

  const { data: stored, error: storedError } = await supabase
    .from('cancellation_template_versions')
    .select('version')
    .eq('template_id', input.templateId)
    .order('version', { ascending: false })
    .limit(1);
  throwIfError(storedError, 'saving the message template');

  const previousVersion = (stored as { version: number }[] | null)?.[0]?.version ?? 0;
  const version = previousVersion + 1;

  const { data, error } = await supabase
    .from('cancellation_template_versions')
    .insert(
      input.segments.map((segment) => ({
        template_id: input.templateId,
        version,
        language: segment.language,
        subject: segment.subject,
        body: segment.body,
        cancellation_statement: segment.cancellationStatement,
        contact_request: segment.contactRequest,
        fallback_text: segment.fallbackText,
        created_by: actor.id,
      })),
    )
    .select(TEMPLATE_VERSION_COLUMNS);

  if (error !== null && error.code === UNIQUE_VIOLATION) {
    reject(
      `Version ${version} of this template was saved by someone else while this form was open. Reload the templates and apply the change to the newer version. Nothing was saved.`,
    );
  }
  throwIfError(error, 'saving the message template');

  return {
    version,
    previousVersion,
    rows: (data as CancellationTemplateVersion[] | null) ?? [],
  };
}

// ---------------------------------------------------------------------------
// Imported-data correction (Requirement 22.3)
// ---------------------------------------------------------------------------

/** The `cancellation_events.event_type` this module writes. */
export const IMPORTED_DATA_CORRECTED_EVENT = 'imported_data_corrected';

/** The import-sourced values a manager may correct, keyed by database column. */
export interface ImportedCaseValues {
  policy_number: string;
  cancellation_effective_date: string;
  customer_name: string | null;
  client_identifier: string | null;
  customer_match_key: string | null;
  carrier: string | null;
  cancellation_reason: string | null;
  amount_due: string | number | null;
  producer_label: string | null;
}

const IMPORTED_CASE_COLUMNS =
  'id,policy_number,cancellation_effective_date,customer_name,client_identifier,customer_match_key,carrier,cancellation_reason,amount_due,producer_label';

/** One correction as the form submits it: every value as typed, none normalized by the caller. */
export interface ImportedDataCorrectionInput {
  policyNumber: string;
  /** `YYYY-MM-DD` or `M/D/YYYY`, read through the importer's parser (Requirement 8.14). */
  cancellationEffectiveDate: string;
  customerName: string;
  clientIdentifier: string;
  carrier: string;
  cancellationReason: string;
  /** Blank clears the stored amount; any other value is read through the importer's parser. */
  amountDue: string;
  producerLabel: string;
}

export interface ImportedDataCorrectionResult {
  values: ImportedCaseValues;
  /** The columns whose stored value this correction changed, in column order. */
  changedColumns: string[];
}

/**
 * Corrects the import-sourced values of one Cancellation_Case. Manager_Role only
 * (Requirement 22.3).
 *
 * A blank policy number and an unparseable effective date are refused with the reason named and
 * nothing written, exactly as the import would have rejected that row; a blank amount clears the
 * stored amount, and any other unusable amount is refused rather than silently stored as absent,
 * because a typed value loses nothing by being sent back. `customer_match_key` is recomputed from
 * the corrected client identifier and customer name, so a correction cannot leave the case matched
 * to the customer it was imported against.
 *
 * `policy_number_normalized` is a generated column and is never written; changing the policy number
 * or the effective date therefore moves the case's identity, and a collision with an existing case
 * is reported as such with nothing changed.
 *
 * One audit timeline entry records every changed column with its previous and new value, the
 * correcting profile, and the time (Requirements 22.2, 22.8). Nothing else on the case is touched:
 * no Case_Status, no Communication_Status, no assignment, no communication row, and no note.
 */
export async function correctImportedCaseData(
  caseId: string,
  correction: ImportedDataCorrectionInput,
): Promise<ImportedDataCorrectionResult> {
  const actor = await requireManager('Correcting imported cancellation data');
  const supabase = getSupabase();

  const policy = parsePolicyNumber(correction.policyNumber);
  if (!policy.ok) {
    reject('A cancellation needs a policy number with at least one character that is not a space. Nothing was changed.');
  }

  const date = parseCancellationDate(correction.cancellationEffectiveDate);
  if (!date.ok) {
    reject(
      `The cancellation effective date could not be read: ${date.reason}. Enter it as YYYY-MM-DD or M/D/YYYY. Nothing was changed.`,
    );
  }

  const typedAmount = trimmed(correction.amountDue);
  let amountDue: string | null = null;
  if (typedAmount !== '') {
    const amount = parseAmountDue(typedAmount);
    if (!amount.present) {
      reject(`The amount due could not be read: ${amount.reason}. Nothing was changed.`);
    }
    amountDue = amount.amountDue;
  }

  const customerName = trimmed(correction.customerName) === '' ? null : correction.customerName.trim();
  const clientIdentifierValue =
    trimmed(correction.clientIdentifier) === '' ? null : correction.clientIdentifier.trim();

  const next: ImportedCaseValues = {
    policy_number: policy.policyNumber,
    cancellation_effective_date: date.date,
    customer_name: customerName,
    client_identifier: clientIdentifierValue,
    customer_match_key: customerMatchKey(clientIdentifierValue, customerName),
    carrier: trimmed(correction.carrier) === '' ? null : correction.carrier.trim(),
    cancellation_reason: trimmed(correction.cancellationReason) === '' ? null : correction.cancellationReason.trim(),
    amount_due: amountDue,
    producer_label: trimmed(correction.producerLabel) === '' ? null : correction.producerLabel.trim(),
  };

  const { data: before, error: beforeError } = await supabase
    .from('cancellation_cases')
    .select(IMPORTED_CASE_COLUMNS)
    .eq('id', caseId)
    .maybeSingle();
  throwIfError(beforeError, 'correcting the imported cancellation data');
  const stored = (before as unknown as ImportedCaseValues | null) ?? null;
  if (stored === null) reject('That cancellation is no longer available to you. Nothing was changed.');

  const changedColumns = (Object.keys(next) as (keyof ImportedCaseValues)[]).filter((column) => {
    const previous = stored[column];
    const value = next[column];
    if (column === 'amount_due') {
      return (previous === null ? null : String(previous)) !== (value === null ? null : String(value));
    }
    return previous !== value;
  });

  if (changedColumns.length === 0) {
    return { values: stored, changedColumns: [] };
  }

  const correctedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from('cancellation_cases')
    .update({ ...next, updated_at: correctedAt })
    .eq('id', caseId)
    .select(IMPORTED_CASE_COLUMNS)
    .single();

  if (error !== null && error.code === UNIQUE_VIOLATION) {
    reject(
      'Another cancellation already carries that policy number and cancellation effective date. Nothing was changed.',
    );
  }
  throwIfError(error, 'correcting the imported cancellation data');

  const { error: eventError } = await supabase.from('cancellation_events').insert({
    case_id: caseId,
    actor_id: actor.id,
    event_type: IMPORTED_DATA_CORRECTED_EVENT,
    event_time: correctedAt,
    detail: {
      corrected_by: actor.id,
      corrected_at: correctedAt,
      changed_columns: changedColumns,
      previous_values: Object.fromEntries(changedColumns.map((column) => [column, stored[column]])),
      new_values: Object.fromEntries(changedColumns.map((column) => [column, next[column]])),
    },
  });
  throwIfError(eventError, 'recording the audit timeline entry');

  return {
    values: (data as unknown as ImportedCaseValues) ?? next,
    changedColumns: changedColumns as string[],
  };
}
