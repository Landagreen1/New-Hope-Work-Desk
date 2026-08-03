'use client';

/**
 * The single data-access module for the Cancellations tab (task 16.1).
 *
 * Every Supabase call the Cancellations UI makes lives here. The components of tasks 16.4
 * through 16.12 import from this module only — no `getSupabase()` call and no `.rpc(...)` call
 * belongs in a component, the same rule Phase 1 applies to `renewals/api.ts`.
 *
 * Shape and conventions follow `src/features/renewals/api.ts`:
 *   * `'use client'`, the shared cookie-aware browser client from `nhwd-shared/client`;
 *   * reads return plain arrays or `null`, writes return `void` or the stored row;
 *   * a failure throws an `Error` carrying manager-facing prose, never a bare PostgREST object.
 *
 * Three things this module deliberately does NOT do:
 *
 *   1. It does not re-implement row level security. The 38 policies of `v1.10.6` are the
 *      authorization boundary and they are evaluated on every statement below. The role checks
 *      that appear here are there to FAIL CLOSED with a readable message before a write is
 *      attempted — a refused read under row level security returns zero rows rather than an
 *      error, so naming the role up front is the only way the UI can say why (Requirement 22.6).
 *      `super_admin` holds every `manager` permission, so every check goes through
 *      `isBroadManagerRole` (Requirement 22.5).
 *   2. It reads no provider credential and returns none. Messaging and email credentials are
 *      read only in route handlers and `src/lib/*`; nothing selected here is a credential, and
 *      evidence leaves storage as a short-lived signed URL, never a public URL
 *      (Requirements 22.7, and the private `cancellation-evidence` bucket of `v1.10.8`).
 *   3. It derives nothing. Row cells, saved-filter matching, the sort comparator, and the
 *      primary action belong to `derive.ts` (task 16.2) and the domain modules under
 *      `domain/`; the types below are shaped so a row read here satisfies those functions
 *      structurally, with no conversion step in the page container.
 */

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { getSupabase } from '../nhwd-shared/client';
import type {
  CaseStatus,
  CommunicationStatus,
  DeliveryResult,
  NextRequiredAction,
} from './domain/communication-status';
import { CASE_STATUSES } from './domain/communication-status';
import type { EscalationReason } from './domain/escalation';
import {
  clearSuppression,
  normalizeSuppressionValue,
  suppressChannel,
  type CancellationEventInsert,
  type ClearSuppressionPlan,
  type SuppressChannelPlan,
  type SuppressionChannel,
  type SuppressionContact,
  type SuppressionRecord,
} from './domain/suppression';
import {
  normalizeEmailSegment,
  normalizePhoneSegment,
  type ContactAuthorizationStatus,
  type ContactChannel,
  type ContactPreferredLanguage,
  type ContactValidationStatus,
} from './import/contacts';
import type { TemplateLanguage, Touchpoint } from './render/renderMessage';

// ---------------------------------------------------------------------------
// Row types the UI consumes
// ---------------------------------------------------------------------------

/**
 * One `public.cancellation_cases` row.
 *
 * Structurally satisfies `CommunicationStatusCase` (`domain/communication-status`) and
 * `RenderCase` (`render/renderMessage`), so a row read here goes straight into a derivation.
 * `amount_due` is `numeric(12,2)`, which PostgREST delivers as a string; it is typed as
 * `string | number | null` for that reason and is never parsed here.
 */
export interface CancellationCase {
  id: string;
  policy_number: string;
  policy_number_normalized: string | null;
  cancellation_effective_date: string;
  customer_name: string | null;
  client_identifier: string | null;
  customer_match_key: string | null;
  carrier: string | null;
  cancellation_reason: string | null;
  amount_due: string | number | null;
  case_status: CaseStatus;
  communication_status: CommunicationStatus;
  next_required_action: NextRequiredAction | null;
  assigned_to: string | null;
  assignment_source: 'import' | 'manager' | null;
  producer_label: string | null;
  follow_up_deadline: string | null;
  assistance_requested: boolean;
  import_run_id: string | null;
  source_row_number: number | null;
  created_at: string;
  updated_at: string;
}

/** The eleven legacy passthrough columns, stored verbatim and excluded from every derivation. */
export interface CancellationCaseLegacyValues {
  legacy_send_flag: string | null;
  legacy_state: string | null;
  legacy_result: string | null;
  legacy_notices_sent: string | null;
  legacy_first_notice: string | null;
  legacy_last_notice: string | null;
  legacy_days_remaining: string | null;
  legacy_notice_label: string | null;
  legacy_subject: string | null;
  legacy_email_body: string | null;
  legacy_sms_body: string | null;
}

/**
 * A case row with everything the drawer's "imported data" view and a manager correction read:
 * the legacy passthrough columns and the preserved source row (Requirement 24.1).
 */
export interface CancellationCaseDetail extends CancellationCase, CancellationCaseLegacyValues {
  /** `jsonb` ARRAY of decoded field values in source column order — never an object (Req 24.2). */
  raw_row: unknown[];
  raw_header: string[];
}

/**
 * One `public.cancellation_contacts` row. Satisfies `ChannelEligibilityContact` and
 * `SuppressionContact` (`domain/suppression`) and `RenderContact` (`render/renderMessage`).
 */
export interface CancellationContact {
  id: string;
  case_id: string;
  channel: ContactChannel;
  normalized_value: string;
  raw_segment: string;
  validation_status: ContactValidationStatus;
  authorization_status: ContactAuthorizationStatus;
  sms_suppressed: boolean;
  email_suppressed: boolean;
  is_primary: boolean;
  preferred_language: ContactPreferredLanguage | null;
  preferred_channel: ContactChannel | null;
  contact_name: string | null;
  contact_role: string | null;
  segment_index: number;
  created_at: string;
  updated_at: string;
}

/**
 * One `public.cancellation_communications` row — the Communication_Record. Satisfies
 * `CommunicationRecord` (`domain/communication-status`).
 *
 * `channel` is the SEND channel (`sms | email`), not the `phone | email` of a contact row.
 * `coveredCaseIds` is joined through `cancellation_communication_cases`: it names every case a
 * combined multi-policy message covered, which is what lets the drawer say "this notice covers
 * N policies" from any case in the group (Requirement 13.8).
 */
export interface CancellationCommunication {
  id: string;
  case_id: string;
  contact_id: string;
  touchpoint: Touchpoint;
  channel: SuppressionChannel;
  template_version_id: string;
  rendered_subject: string;
  rendered_body: string;
  send_time: string;
  provider_message_id: string | null;
  delivery_result: DeliveryResult;
  failure_reason: string | null;
  attempt_count: number;
  combined_group_id: string | null;
  created_at: string;
  /** Every case this record covered, this case included; one entry for a single-case send. */
  coveredCaseIds: string[];
}

/** One `public.cancellation_events` row — an append-only audit timeline entry (Req 17.7, 22.8). */
export interface CancellationEvent {
  id: string;
  case_id: string;
  actor_id: string | null;
  event_type: string;
  detail: Record<string, unknown> | null;
  event_time: string;
  /** `bigserial`, so stored insertion order: the tie-break on equal event times (Req 17.7). */
  sequence: number;
}

/** One `public.cancellation_notes` row. `evidence` holds storage paths, not URLs. */
export interface CancellationNote {
  id: string;
  case_id: string;
  note: string;
  evidence: string[];
  created_by: string;
  created_at: string;
}

/** The six response types of Requirement 21.5. */
export type CustomerResponseType =
  | 'Assistance requested'
  | 'Callback requested'
  | 'Opted out of SMS'
  | 'Opted out of email'
  | 'No assistance needed'
  | 'Other';

export const CUSTOMER_RESPONSE_TYPES = [
  'Assistance requested',
  'Callback requested',
  'Opted out of SMS',
  'Opted out of email',
  'No assistance needed',
  'Other',
] as const satisfies readonly CustomerResponseType[];

/** The two response types that raise `Customer Assistance Requested` (Requirements 20.4, 21.7). */
export const ASSISTANCE_REQUEST_RESPONSE_TYPES = [
  'Assistance requested',
  'Callback requested',
] as const satisfies readonly CustomerResponseType[];

/** The two response types whose note text is required and non-blank (Requirement 21.5). */
const NOTE_REQUIRED_RESPONSE_TYPES = new Set<CustomerResponseType>(['Assistance requested', 'Other']);

/**
 * One `public.cancellation_customer_responses` row. Satisfies `CustomerResponseRecord` and
 * `EscalationResponseRecord`.
 */
export interface CancellationCustomerResponse {
  id: string;
  case_id: string;
  response_type: CustomerResponseType;
  response_channel: string | null;
  response_time: string;
  note: string | null;
  created_by: string;
  created_at: string;
}

/** One `public.cancellation_payment_reports` row (Requirements 18.5, 18.6). */
export interface CancellationPaymentReport {
  id: string;
  case_id: string;
  reported_by: string;
  reported_at: string;
  reported_amount: string | number | null;
  confirmation_reference: string | null;
  note: string;
  evidence: string[];
}

/** The seven verification outcomes of Requirement 19.1. The first carries an em dash. */
export type VerificationOutcome =
  | 'Payment verified \u2014 reinstatement pending'
  | 'Policy reinstated'
  | 'Payment not found'
  | 'Additional payment required'
  | 'Policy still scheduled for cancellation'
  | 'Policy cancelled'
  | 'Other';

export const VERIFICATION_OUTCOMES = [
  'Payment verified \u2014 reinstatement pending',
  'Policy reinstated',
  'Payment not found',
  'Additional payment required',
  'Policy still scheduled for cancellation',
  'Policy cancelled',
  'Other',
] as const satisfies readonly VerificationOutcome[];

/**
 * The four outcomes of Requirements 19.2 and 19.5 that require note text, a next Case_Status,
 * and a next required action. The database enforces the same set; naming it here lets the panel
 * reject an incomplete submission with the entered values retained rather than on a round trip.
 */
export const CONDITIONAL_VERIFICATION_OUTCOMES = [
  'Payment not found',
  'Additional payment required',
  'Policy still scheduled for cancellation',
  'Other',
] as const satisfies readonly VerificationOutcome[];

/** The three next Case_Status values a conditional outcome may select (Req 19.2, 19.5). */
export const VERIFICATION_NEXT_CASE_STATUSES = [
  'Open',
  'Verification Pending',
  'Cancelled',
] as const satisfies readonly CaseStatus[];

/** One `public.cancellation_verification_outcomes` row (Requirement 19.9). */
export interface CancellationVerificationOutcome {
  id: string;
  case_id: string;
  recorded_by: string;
  verified_at: string;
  outcome: VerificationOutcome;
  note: string | null;
  next_case_status: CaseStatus | null;
  next_required_action: NextRequiredAction | null;
  evidence: string[];
}

/** One `public.cancellation_escalations` row. Satisfies `EscalationRecord`. */
export interface CancellationEscalation {
  id: string;
  case_id: string;
  reason: EscalationReason;
  raised_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
  notified_at: string | null;
}

/** One `public.cancellation_suppressions` row. Satisfies `SuppressionRecord`. */
export interface CancellationSuppression {
  id: string;
  channel: SuppressionChannel;
  normalized_value: string;
  source: 'user-recorded' | 'customer inbound message';
  suppressed_at: string;
  actor_id: string | null;
  reason: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
  clear_reason: string | null;
}

/** One `public.cancellation_import_runs` row (Requirement 8.8). Read scope excludes `agent`. */
export interface CancellationImportRun {
  id: string;
  file_name: string;
  column_set: 'eficacia' | 'avisos';
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

/** One `public.cancellation_templates` row. `touchpoint` is its unique lookup key (Req 12.1). */
export interface CancellationTemplate {
  id: string;
  touchpoint: Touchpoint;
  name: string;
  created_at: string;
}

/**
 * One `public.cancellation_template_versions` row. Immutable: a saved change inserts
 * `version + 1` rather than updating a stored row (Requirement 14.17). Satisfies
 * `TemplateVersionRow` (`render/renderMessage`).
 */
export interface CancellationTemplateVersion {
  id: string;
  template_id: string;
  version: number;
  language: TemplateLanguage;
  subject: string;
  body: string;
  cancellation_statement: string;
  contact_request: string;
  fallback_text: Record<string, string | null>;
  created_by: string | null;
  created_at: string;
}

/** A template with its versions, newest first — what the manager template editor renders. */
export interface CancellationTemplateWithVersions extends CancellationTemplate {
  versions: CancellationTemplateVersion[];
}

/**
 * The single `public.cancellation_settings` row. Carries the kill switch and the render
 * constants; no credential of any kind lives on it (Requirement 22.7). Satisfies
 * `RenderSettings`.
 */
export interface CancellationSettings {
  automatic_sending_enabled: boolean;
  office_phone: string;
  agency_name: string;
  bilingual_separator: string;
  holidays: string[];
  updated_by: string | null;
  updated_at: string;
}

/** An assignable employee, as the manager reassignment control lists them (Requirement 22.3). */
export interface CancellationAssignee {
  id: string;
  display_name: string;
  initials: string;
  role: AppRole;
  is_active: boolean;
}

/** The signed-in profile as this module reads it, for the fail-closed role checks. */
export interface CancellationActor {
  id: string;
  display_name: string | null;
  role: AppRole;
}

// ---------------------------------------------------------------------------
// List paging (Requirement 16.5)
// ---------------------------------------------------------------------------

/** Requirement 16.5: the list loads in pages of at most 50 rows. */
export const CANCELLATION_PAGE_SIZE = 50;

/** One page of cancellation rows in the Requirement 16.5 order. */
export interface CancellationCasePage {
  rows: CancellationCase[];
  /** Zero-based page index this result answers. */
  page: number;
  pageSize: number;
  /** True when at least one further row exists after this page. */
  hasMore: boolean;
  /** Total rows visible to the signed-in profile under the requested restriction. */
  total: number;
}

/**
 * The optional server-side narrowing of a list read.
 *
 * Saved-filter matching and search are Requirement 16.3 and 16.4 work and belong to
 * `derive.ts`, because both read contacts, communications, responses, and escalations that no
 * single PostgREST filter can express. What is narrowed here is only what the database can
 * decide from a case row alone, so a page stays a page.
 */
export interface CancellationCaseQuery {
  page?: number;
  pageSize?: number;
  /** Restrict to these Case_Status values; absent means every value. */
  caseStatuses?: readonly CaseStatus[];
  /** `'unassigned'` means `assigned_to is null`; a profile id means that employee. */
  assignedTo?: string | 'all' | 'unassigned';
  /** Inclusive lower bound on `cancellation_effective_date`, `YYYY-MM-DD`. */
  effectiveDateFrom?: string;
  /** Inclusive upper bound on `cancellation_effective_date`, `YYYY-MM-DD`. */
  effectiveDateTo?: string;
}

/**
 * Every case-level column the list needs; `raw_row` and the legacy columns are excluded.
 *
 * Written as one string literal rather than a concatenation on purpose: `supabase-js` parses the
 * select string at the type level, and a value of plain type `string` degrades the result row to
 * `GenericStringError`.
 */
const CASE_LIST_COLUMNS =
  'id,policy_number,policy_number_normalized,cancellation_effective_date,customer_name,client_identifier,customer_match_key,carrier,cancellation_reason,amount_due,case_status,communication_status,next_required_action,assigned_to,assignment_source,producer_label,follow_up_deadline,assistance_requested,import_run_id,source_row_number,created_at,updated_at';

const CASE_LEGACY_COLUMNS =
  'legacy_send_flag,legacy_state,legacy_result,legacy_notices_sent,legacy_first_notice,legacy_last_notice,legacy_days_remaining,legacy_notice_label,legacy_subject,legacy_email_body,legacy_sms_body';

const CASE_DETAIL_COLUMNS = `${CASE_LIST_COLUMNS},${CASE_LEGACY_COLUMNS},raw_row,raw_header` as const;

// ---------------------------------------------------------------------------
// Evidence (Requirements 17.9, 18.10, 19.9)
// ---------------------------------------------------------------------------

/** The private bucket created by `v1.10.8`. Download is a signed URL, never a public URL. */
export const CANCELLATION_EVIDENCE_BUCKET = 'cancellation-evidence';

/** Requirement 17.9: at most 10 evidence files on one note. */
export const MAX_EVIDENCE_FILES = 10;

/** Requirements 17.9, 18.10: 100 megabytes per file, matching the bucket's own limit. */
export const MAX_EVIDENCE_SIZE_BYTES = 100 * 1024 * 1024;

/** How long a signed evidence URL stays valid, in seconds. */
const EVIDENCE_URL_TTL_SECONDS = 900;

// ---------------------------------------------------------------------------
// Field limits the write helpers enforce before a round trip
// ---------------------------------------------------------------------------

/** Requirement 17.8: note text of 1 to 4,000 characters after trimming. */
export const MIN_NOTE_LENGTH = 1;
export const MAX_NOTE_LENGTH = 4000;

/** Requirements 18.5, 19.2, 19.5: 2,000 characters for a report, response, or outcome note. */
export const MAX_ACTIVITY_NOTE_LENGTH = 2000;

/** Requirement 18.6: the accepted reported amount range and reference length. */
export const MIN_REPORTED_AMOUNT = 0.01;
export const MAX_REPORTED_AMOUNT = 999999999.99;
export const MAX_CONFIRMATION_REFERENCE_LENGTH = 100;

/** Requirements 22.4, 22.11: override reason text of 1 to 1,000 characters. */
export const MAX_OVERRIDE_REASON_LENGTH = 1000;

/** Requirement 22.10: the four Case_Status values an Agent_Role profile may set. */
export const AGENT_SETTABLE_CASE_STATUSES = [
  'Open',
  'Payment Reported',
  'Verification Pending',
  'Reinstatement Pending',
] as const satisfies readonly CaseStatus[];

/** Requirement 22.10: a change on a case at one of these is Manager_Role's alone. */
export const TERMINAL_CASE_STATUSES = [
  'Reinstated',
  'Cancelled',
  'Resolved',
  'Invalid',
  'Duplicate',
] as const satisfies readonly CaseStatus[];

/** Requirement 18.8: a payment report is refused on a case at one of these. */
const CLOSED_CASE_STATUSES = new Set<CaseStatus>(TERMINAL_CASE_STATUSES);

/** The three values Requirement 11.1 allows for a contact's preferred language. */
export const PREFERRED_LANGUAGES = [
  'English',
  'Spanish',
  'Bilingual',
] as const satisfies readonly ContactPreferredLanguage[];

/** The three values Requirement 10.9 allows for a contact's authorization status. */
export const AUTHORIZATION_STATUSES = [
  'Authorized',
  'Unknown',
  'Not Authorized',
] as const satisfies readonly ContactAuthorizationStatus[];

// ---------------------------------------------------------------------------
// Audit event types
// ---------------------------------------------------------------------------

/**
 * The `cancellation_events.event_type` values this module writes. The column is free text, so
 * the vocabulary lives here rather than in a check constraint; the two opt-out types come from
 * `domain/suppression` so a plan and a direct write cannot disagree.
 */
export const CANCELLATION_EVENT_TYPES = {
  contactAdded: 'contact_added',
  contactPreferredLanguageChanged: 'contact_preferred_language_changed',
  contactAuthorizationChanged: 'contact_authorization_changed',
  noteAdded: 'note_added',
  customerResponseRecorded: 'customer_response_recorded',
  paymentReported: 'payment_reported',
  verificationOutcomeRecorded: 'verification_outcome_recorded',
  caseStatusOverridden: 'case_status_overridden',
  caseAssigned: 'case_assigned',
  automaticSendingChanged: 'automatic_sending_changed',
} as const;

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

const GENERIC_MESSAGE = 'The cancellation request could not be completed.';

interface SupabaseErrorLike {
  message?: string;
  code?: string;
}

/**
 * Throws on a PostgREST error, wording the message the way `renewals/api.ts` words its own.
 *
 * A row level security refusal arrives as `42501` on a write and as zero rows on a read, so an
 * explicit privilege error is translated into the role sentence Requirement 22.6 asks the
 * surface to display.
 */
function throwIfError(error: SupabaseErrorLike | null, context?: string): void {
  if (error === null || error === undefined) return;
  if (error.code === '42501' || /permission denied|row-level security/i.test(error.message ?? '')) {
    throw new Error(
      context === undefined
        ? 'Your role does not permit that cancellation operation. Nothing was changed.'
        : `Your role does not permit ${context}. Nothing was changed.`,
    );
  }
  const detail = error.message ?? '';
  if (context === undefined) throw new Error(detail === '' ? GENERIC_MESSAGE : detail);
  throw new Error(detail === '' ? `${context} failed.` : `${context} failed: ${detail}`);
}

function reject(message: string): never {
  throw new Error(message);
}

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim();
}

// ---------------------------------------------------------------------------
// The signed-in profile
// ---------------------------------------------------------------------------

/**
 * The signed-in profile, or `null` when there is no session.
 *
 * Read once per action rather than cached: a role change must take effect without a reload, and
 * the value gates nothing on its own — the policies do that.
 */
export async function getCancellationActor(): Promise<CancellationActor | null> {
  const supabase = getSupabase();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError !== null || auth.user === null) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id,display_name,role')
    .eq('id', auth.user.id)
    .maybeSingle();
  if (error !== null) return null;
  return (data as CancellationActor | null) ?? null;
}

/** The signed-in profile, refusing the action outright when there is no session. */
async function requireActor(action: string): Promise<CancellationActor> {
  const actor = await getCancellationActor();
  if (actor === null) reject(`Your session expired. Sign in again to ${action}.`);
  return actor;
}

/** The signed-in profile, refused unless it holds Manager_Role (`manager` or `super_admin`). */
async function requireManager(action: string): Promise<CancellationActor> {
  const actor = await requireActor(action);
  if (!isBroadManagerRole(actor.role)) {
    reject(`${action} requires a manager or super admin. Nothing was changed.`);
  }
  return actor;
}

// ---------------------------------------------------------------------------
// Reads — the case list
// ---------------------------------------------------------------------------

/**
 * One page of cancellation cases in the Requirement 16.5 order, at most 50 rows.
 *
 * The order is the four keys of Requirement 16.5 — cancellation effective date ascending,
 * amount due descending with an absent amount after every present one, customer name, policy
 * number — applied in the database so paging is stable: an in-page sort cannot reorder rows
 * across a page boundary. `id` is appended as a last key so two rows that agreed on all four
 * (which the identity constraint makes impossible) could still not swap between reads.
 *
 * The name and policy keys are ordered by the column's collation, which folds case for the
 * agency's `en_US.UTF-8` database; `compareCancellationRows` in `derive.ts` is the same order
 * expressed case-insensitively for rows already in hand.
 */
export async function listCancellationCases(
  query: CancellationCaseQuery = {},
): Promise<CancellationCasePage> {
  const page = Math.max(0, Math.trunc(query.page ?? 0));
  const pageSize = Math.min(
    CANCELLATION_PAGE_SIZE,
    Math.max(1, Math.trunc(query.pageSize ?? CANCELLATION_PAGE_SIZE)),
  );
  const from = page * pageSize;

  let request = getSupabase()
    .from('cancellation_cases')
    .select(CASE_LIST_COLUMNS, { count: 'exact' })
    .order('cancellation_effective_date', { ascending: true })
    .order('amount_due', { ascending: false, nullsFirst: false })
    .order('customer_name', { ascending: true, nullsFirst: false })
    .order('policy_number', { ascending: true })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1);

  if (query.caseStatuses !== undefined && query.caseStatuses.length > 0) {
    request = request.in('case_status', [...query.caseStatuses]);
  }
  if (query.assignedTo === 'unassigned') request = request.is('assigned_to', null);
  else if (query.assignedTo !== undefined && query.assignedTo !== 'all') {
    request = request.eq('assigned_to', query.assignedTo);
  }
  if (query.effectiveDateFrom !== undefined) {
    request = request.gte('cancellation_effective_date', query.effectiveDateFrom);
  }
  if (query.effectiveDateTo !== undefined) {
    request = request.lte('cancellation_effective_date', query.effectiveDateTo);
  }

  const { data, error, count } = await request;
  throwIfError(error, 'loading the cancellation list');
  const rows = (data as unknown as CancellationCase[]) ?? [];
  const total = count ?? from + rows.length;
  return { rows, page, pageSize, hasMore: from + rows.length < total, total };
}

/** One case with its legacy passthrough columns and preserved source row, or `null`. */
export async function getCancellationCase(caseId: string): Promise<CancellationCaseDetail | null> {
  const { data, error } = await getSupabase()
    .from('cancellation_cases')
    .select(CASE_DETAIL_COLUMNS)
    .eq('id', caseId)
    .maybeSingle();
  throwIfError(error, 'loading the cancellation case');
  return (data as unknown as CancellationCaseDetail | null) ?? null;
}

/**
 * The case rows named, in no particular order.
 *
 * Used where the drawer resolves a combined message's covered cases (Requirement 13.8) and
 * where an opt-out has just touched cases outside the current page.
 */
export async function listCancellationCasesByIds(caseIds: readonly string[]): Promise<CancellationCase[]> {
  if (caseIds.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('cancellation_cases')
    .select(CASE_LIST_COLUMNS)
    .in('id', [...caseIds]);
  throwIfError(error, 'loading the covered cancellation cases');
  return (data as unknown as CancellationCase[]) ?? [];
}

// ---------------------------------------------------------------------------
// Reads — case-scoped detail
// ---------------------------------------------------------------------------

/** Every Contact_Recipient of one case, in imported cell order (Requirement 17.2). */
export async function listCancellationContacts(caseId: string): Promise<CancellationContact[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_contacts')
    .select('*')
    .eq('case_id', caseId)
    .order('channel', { ascending: true })
    .order('segment_index', { ascending: true });
  throwIfError(error, 'loading the contact information');
  return (data as CancellationContact[]) ?? [];
}

/** Every Contact_Recipient of the cases named, for the list's search and filter derivations. */
export async function listContactsForCases(caseIds: readonly string[]): Promise<CancellationContact[]> {
  if (caseIds.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('cancellation_contacts')
    .select('*')
    .in('case_id', [...caseIds])
    .order('case_id', { ascending: true })
    .order('channel', { ascending: true })
    .order('segment_index', { ascending: true });
  throwIfError(error, 'loading the contact information');
  return (data as CancellationContact[]) ?? [];
}

interface CommunicationRowWithLinks extends Omit<CancellationCommunication, 'coveredCaseIds'> {
  cancellation_communication_cases: { case_id: string }[] | null;
}

const COMMUNICATION_COLUMNS =
  'id,case_id,contact_id,touchpoint,channel,template_version_id,rendered_subject,rendered_body,send_time,provider_message_id,delivery_result,failure_reason,attempt_count,combined_group_id,created_at,cancellation_communication_cases(case_id)';

function withCoveredCases(rows: CommunicationRowWithLinks[]): CancellationCommunication[] {
  return rows.map((row) => {
    const { cancellation_communication_cases: links, ...record } = row;
    const covered = new Set<string>((links ?? []).map((link) => link.case_id));
    covered.add(record.case_id);
    return { ...record, coveredCaseIds: [...covered] };
  });
}

/**
 * Every stored Communication_Record of one case, most recent first, each carrying the cases it
 * covered.
 *
 * The link table is joined rather than read separately because a combined message is only
 * legible with it: `coveredCaseIds` of length greater than one is exactly the "this notice
 * covers N policies" line of Requirement 13.8. The drawer splits the result by `channel` for
 * its two histories (Requirement 17.1).
 *
 * `coveredCaseIds` names the covered cases the SIGNED-IN PROFILE MAY READ: the link table
 * carries the same read scope as the cases it points at, so a combined message covering a case
 * outside the caller's scope reports a shorter list rather than leaking the case (Req 22.1).
 */
export async function listCancellationCommunications(
  caseId: string,
): Promise<CancellationCommunication[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_communications')
    .select(COMMUNICATION_COLUMNS)
    .eq('case_id', caseId)
    .order('send_time', { ascending: false });
  throwIfError(error, 'loading the delivery history');
  return withCoveredCases((data as unknown as CommunicationRowWithLinks[]) ?? []);
}

/** Every Communication_Record of the cases named — the list's status-cell derivation input. */
export async function listCommunicationsForCases(
  caseIds: readonly string[],
): Promise<CancellationCommunication[]> {
  if (caseIds.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('cancellation_communications')
    .select(COMMUNICATION_COLUMNS)
    .in('case_id', [...caseIds])
    .order('send_time', { ascending: false });
  throwIfError(error, 'loading the delivery history');
  return withCoveredCases((data as unknown as CommunicationRowWithLinks[]) ?? []);
}

/**
 * The chronological audit timeline of one case in the Requirement 17.7 order: event time
 * descending, then stored insertion order descending so entries sharing an event time read
 * latest-recorded-first.
 */
export async function listCancellationEvents(caseId: string): Promise<CancellationEvent[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_events')
    .select('id,case_id,actor_id,event_type,detail,event_time,sequence')
    .eq('case_id', caseId)
    .order('event_time', { ascending: false })
    .order('sequence', { ascending: false });
  throwIfError(error, 'loading the audit timeline');
  return (data as CancellationEvent[]) ?? [];
}

/** Every note of one case, most recent first (Requirement 17.1). */
export async function listCancellationNotes(caseId: string): Promise<CancellationNote[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_notes')
    .select('id,case_id,note,evidence,created_by,created_at')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false });
  throwIfError(error, 'loading the case notes');
  return (data as CancellationNote[]) ?? [];
}

/** Every recorded customer response of one case, most recent first (Requirement 21.5). */
export async function listCustomerResponses(caseId: string): Promise<CancellationCustomerResponse[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_customer_responses')
    .select('id,case_id,response_type,response_channel,response_time,note,created_by,created_at')
    .eq('case_id', caseId)
    .order('response_time', { ascending: false });
  throwIfError(error, 'loading the recorded customer responses');
  return (data as CancellationCustomerResponse[]) ?? [];
}

/** Every recorded customer response of the cases named — the Customer Responded filter input. */
export async function listCustomerResponsesForCases(
  caseIds: readonly string[],
): Promise<CancellationCustomerResponse[]> {
  if (caseIds.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('cancellation_customer_responses')
    .select('id,case_id,response_type,response_channel,response_time,note,created_by,created_at')
    .in('case_id', [...caseIds])
    .order('response_time', { ascending: false });
  throwIfError(error, 'loading the recorded customer responses');
  return (data as CancellationCustomerResponse[]) ?? [];
}

/** Every payment report of one case, most recent first (Requirements 18.5, 18.9). */
export async function listPaymentReports(caseId: string): Promise<CancellationPaymentReport[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_payment_reports')
    .select('id,case_id,reported_by,reported_at,reported_amount,confirmation_reference,note,evidence')
    .eq('case_id', caseId)
    .order('reported_at', { ascending: false });
  throwIfError(error, 'loading the payment reports');
  return (data as CancellationPaymentReport[]) ?? [];
}

/** Every recorded verification outcome of one case, most recent first (Requirement 19.9). */
export async function listVerificationOutcomes(
  caseId: string,
): Promise<CancellationVerificationOutcome[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_verification_outcomes')
    .select('id,case_id,recorded_by,verified_at,outcome,note,next_case_status,next_required_action,evidence')
    .eq('case_id', caseId)
    .order('verified_at', { ascending: false });
  throwIfError(error, 'loading the verification outcomes');
  return (data as CancellationVerificationOutcome[]) ?? [];
}

/** Every escalation row of one case, cleared history included (Requirements 20.10, 20.12). */
export async function listCancellationEscalations(caseId: string): Promise<CancellationEscalation[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_escalations')
    .select('id,case_id,reason,raised_at,cleared_at,cleared_by,notified_at')
    .eq('case_id', caseId)
    .order('raised_at', { ascending: false });
  throwIfError(error, 'loading the escalations');
  return (data as CancellationEscalation[]) ?? [];
}

/** Every escalation row of the cases named — the Needs Action filter's override input. */
export async function listEscalationsForCases(
  caseIds: readonly string[],
): Promise<CancellationEscalation[]> {
  if (caseIds.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('cancellation_escalations')
    .select('id,case_id,reason,raised_at,cleared_at,cleared_by,notified_at')
    .in('case_id', [...caseIds])
    .order('raised_at', { ascending: false });
  throwIfError(error, 'loading the escalations');
  return (data as CancellationEscalation[]) ?? [];
}

/**
 * Suppression rows for the contact values named, cleared history included.
 *
 * A suppression is keyed by normalized contact value, not by case, so this read is by value:
 * one opt-out reaches every case holding that value including contacts created by a later
 * import (Requirements 21.3, 21.4).
 */
export async function listSuppressions(
  normalizedValues: readonly string[],
): Promise<CancellationSuppression[]> {
  if (normalizedValues.length === 0) return [];
  const { data, error } = await getSupabase()
    .from('cancellation_suppressions')
    .select('id,channel,normalized_value,source,suppressed_at,actor_id,reason,cleared_at,cleared_by,clear_reason')
    .in('normalized_value', [...normalizedValues])
    .order('suppressed_at', { ascending: false });
  throwIfError(error, 'loading the opt-out records');
  return (data as CancellationSuppression[]) ?? [];
}

// ---------------------------------------------------------------------------
// Reads — configuration
// ---------------------------------------------------------------------------

/** The most recent import runs. Row level security hides these from an `agent` profile. */
export async function listCancellationImportRuns(limit = 12): Promise<CancellationImportRun[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_import_runs')
    .select(
      'id,file_name,column_set,imported_by,confirmed_mapping,rows_total,rows_created,rows_updated,rows_rejected,rows_duplicate,rejected_rows,duplicate_rows,unmatched_producer_labels,unmatched_customer_rows,invalid_contact_count,contact_overflow_count,amount_due_absent_rows,completed_at',
    )
    .order('completed_at', { ascending: false })
    .limit(limit);
  throwIfError(error, 'loading the import history');
  return (data as unknown as CancellationImportRun[]) ?? [];
}

const TEMPLATE_VERSION_COLUMNS =
  'id,template_id,version,language,subject,body,cancellation_statement,contact_request,fallback_text,created_by,created_at';

/**
 * The four templates with their versions, newest version first.
 *
 * Versions are immutable, so this is a complete history: the editor of task 16.11 saves a new
 * version and the drawer resolves the exact words a stored Communication_Record was sent with
 * (Requirement 14.17).
 */
export async function listCancellationTemplates(): Promise<CancellationTemplateWithVersions[]> {
  const supabase = getSupabase();

  const { data: templateData, error: templateError } = await supabase
    .from('cancellation_templates')
    .select('id,touchpoint,name,created_at')
    .order('touchpoint', { ascending: false });
  throwIfError(templateError, 'loading the message templates');
  const templates = (templateData as CancellationTemplate[]) ?? [];
  if (templates.length === 0) return [];

  const { data: versionData, error: versionError } = await supabase
    .from('cancellation_template_versions')
    .select(TEMPLATE_VERSION_COLUMNS)
    .in('template_id', templates.map((template) => template.id))
    .order('version', { ascending: false })
    .order('language', { ascending: true });
  throwIfError(versionError, 'loading the message templates');
  const versions = (versionData as CancellationTemplateVersion[]) ?? [];

  return templates.map((template) => ({
    ...template,
    versions: versions.filter((version) => version.template_id === template.id),
  }));
}

/** Every version row of one template, newest first. */
export async function listTemplateVersions(templateId: string): Promise<CancellationTemplateVersion[]> {
  const { data, error } = await getSupabase()
    .from('cancellation_template_versions')
    .select(TEMPLATE_VERSION_COLUMNS)
    .eq('template_id', templateId)
    .order('version', { ascending: false })
    .order('language', { ascending: true });
  throwIfError(error, 'loading the template versions');
  return (data as CancellationTemplateVersion[]) ?? [];
}

/**
 * The single settings row.
 *
 * The table is capped at one row by a boolean primary key with `check (id)`, so this selects
 * without ordering or a limit. Nothing on the row is a credential (Requirement 22.7).
 */
export async function getCancellationSettings(): Promise<CancellationSettings | null> {
  const { data, error } = await getSupabase()
    .from('cancellation_settings')
    .select('automatic_sending_enabled,office_phone,agency_name,bilingual_separator,holidays,updated_by,updated_at')
    .maybeSingle();
  throwIfError(error, 'loading the cancellation settings');
  return (data as CancellationSettings | null) ?? null;
}

/** The active employees a manager may assign a case to. */
export async function listCancellationAssignees(): Promise<CancellationAssignee[]> {
  const { data, error } = await getSupabase()
    .from('profiles')
    .select('id,display_name,initials,role,is_active')
    .eq('is_active', true)
    .in('role', ['agent', 'customer_service', 'sales_supervisor'])
    .order('role', { ascending: true })
    .order('display_name', { ascending: true });
  throwIfError(error, 'loading the assignable employees');
  return (data as CancellationAssignee[]) ?? [];
}

// ---------------------------------------------------------------------------
// Audit timeline writes
// ---------------------------------------------------------------------------

/**
 * Appends one audit timeline entry.
 *
 * Every write below records its own entry through this function, so `actor_id` is always the
 * acting profile and the append-only guarantee of Requirement 22.8 is never worked around: the
 * table has no update policy, no delete policy, and a trigger that refuses both.
 */
async function appendEvent(
  caseId: string,
  actorId: string | null,
  eventType: string,
  detail: Record<string, unknown>,
  eventTime?: string,
): Promise<void> {
  const row: Record<string, unknown> = {
    case_id: caseId,
    actor_id: actorId,
    event_type: eventType,
    detail,
  };
  if (eventTime !== undefined) row.event_time = eventTime;
  const { error } = await getSupabase().from('cancellation_events').insert(row);
  throwIfError(error, 'recording the audit timeline entry');
}

/** Appends the audit entries a `domain/suppression` plan produced, in plan order. */
async function appendPlannedEvents(events: readonly CancellationEventInsert<unknown>[]): Promise<void> {
  if (events.length === 0) return;
  const { error } = await getSupabase().from('cancellation_events').insert(
    events.map((event) => ({
      case_id: event.case_id,
      actor_id: event.actor_id,
      event_type: event.event_type,
      event_time: event.event_time,
      detail: event.detail,
    })),
  );
  throwIfError(error, 'recording the audit timeline entry');
}

/**
 * Recomputes and stores Communication_Status for one case (Requirement 15.9).
 *
 * `pendingSends` is the number of Touchpoint channel sends scheduled for the case that have no
 * stored Communication_Record. Only a caller holding the Touchpoint schedule can know it — the
 * schedule is derived from the cancellation effective date and is stored nowhere — and it is what
 * separates `Scheduled` from `Not Scheduled` and `Partially Sent` from `Sent`. Passing `0` is
 * exact only for a case with nothing left to send, which is why every write below takes the count
 * as an explicit input and skips the recompute when it is absent rather than guessing zero.
 *
 * Returns the stored value.
 */
export async function recomputeCommunicationStatus(
  caseId: string,
  pendingSends = 0,
): Promise<CommunicationStatus> {
  const { data, error } = await getSupabase().rpc('cancellation_recompute_communication_status', {
    p_case_id: caseId,
    p_pending_sends: pendingSends,
  });
  throwIfError(error, 'recomputing the communication status');
  return data as CommunicationStatus;
}

// ---------------------------------------------------------------------------
// Evidence upload and download
// ---------------------------------------------------------------------------

function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'bin';
  return name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin';
}

/**
 * The stored file name: a fresh UUID, the original name reduced to safe characters, and the
 * original extension. Keeping the original name in the path is what lets the drawer label a
 * download without a second column, while the UUID prefix keeps two files of the same name
 * apart.
 */
function evidenceObjectName(file: File): string {
  const extension = fileExtension(file.name);
  const base = file.name
    .slice(0, file.name.lastIndexOf('.') > 0 ? file.name.lastIndexOf('.') : undefined)
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stem = base === '' ? 'evidence' : base;
  return `${crypto.randomUUID()}-${stem}.${extension}`;
}

/** The label for a stored evidence path: the original file name, without the UUID prefix. */
export function evidenceDisplayName(path: string): string {
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  const withoutUuid = fileName.replace(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i,
    '',
  );
  return withoutUuid === '' ? fileName : withoutUuid;
}

/**
 * Rejects an attachment set that exceeds the Requirement 17.9 limits before anything is
 * uploaded, so a rejected submission stores no evidence file at all.
 */
function assertEvidenceWithinLimits(files: readonly File[]): void {
  if (files.length > MAX_EVIDENCE_FILES) {
    reject(
      `At most ${MAX_EVIDENCE_FILES} evidence files may be attached; this submission has ${files.length}. Nothing was saved.`,
    );
  }
  const oversized = files.find((file) => file.size > MAX_EVIDENCE_SIZE_BYTES);
  if (oversized !== undefined) {
    reject(
      `"${oversized.name}" is larger than the 100 MB evidence limit. Compress it or attach a smaller file. Nothing was saved.`,
    );
  }
}

/**
 * Uploads evidence for one case and returns the stored paths.
 *
 * Objects are laid out as `<case_id>/<file>`, which is the layout
 * `public.cancellation_can_access_evidence(text)` reads: it takes the first path segment as the
 * case id and applies the case read scope, so an object under a case the caller cannot read is
 * refused by the storage policy rather than by anything here.
 */
async function uploadEvidence(caseId: string, files: readonly File[]): Promise<string[]> {
  if (files.length === 0) return [];
  const supabase = getSupabase();
  const stored: string[] = [];

  for (const file of files) {
    const path = `${caseId}/${evidenceObjectName(file)}`;
    const { error } = await supabase.storage
      .from(CANCELLATION_EVIDENCE_BUCKET)
      .upload(path, file, {
        upsert: false,
        cacheControl: '3600',
        contentType: file.type === '' ? 'application/octet-stream' : file.type,
      });

    if (error !== null) {
      await discardEvidence(stored);
      reject(`"${file.name}" could not be uploaded: ${error.message}. Nothing was saved.`);
    }
    stored.push(path);
  }

  return stored;
}

/**
 * Best-effort removal of objects uploaded for a submission that then failed.
 *
 * The `cancellation-evidence` bucket has a select policy and an insert policy and deliberately
 * no delete policy, so this may legitimately do nothing. It never throws: the caller is already
 * reporting a failure and the upload error is the one worth reading.
 */
async function discardEvidence(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  try {
    await getSupabase().storage.from(CANCELLATION_EVIDENCE_BUCKET).remove([...paths]);
  } catch {
    // Deliberately ignored — see the note above.
  }
}

/**
 * A short-lived signed URL for one stored evidence path.
 *
 * The bucket is private, so this is the only read path: no public URL is ever produced, and the
 * signed URL is issued only to a caller the storage select policy already admitted
 * (Requirement 22.7).
 */
export async function getEvidenceUrl(path: string): Promise<string | null> {
  const { data, error } = await getSupabase().storage
    .from(CANCELLATION_EVIDENCE_BUCKET)
    .createSignedUrl(path, EVIDENCE_URL_TTL_SECONDS);
  throwIfError(error, 'preparing the evidence download');
  return data?.signedUrl ?? null;
}

/** Downloads one stored evidence file through the browser, named as it was attached. */
export async function downloadEvidenceFile(path: string): Promise<void> {
  const { data, error } = await getSupabase().storage
    .from(CANCELLATION_EVIDENCE_BUCKET)
    .download(path);
  if (error !== null) {
    throw new Error(`The evidence file could not be downloaded: ${error.message}`);
  }
  if (data === null) throw new Error('The evidence file was not returned by storage.');

  const objectUrl = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = evidenceDisplayName(path);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

// ---------------------------------------------------------------------------
// Writes — contact information (Requirements 10.9, 11.1, 22.2)
// ---------------------------------------------------------------------------

export interface AddContactInput {
  caseId: string;
  channel: ContactChannel;
  /** The value as the user typed it; normalized here with the importer's own helpers. */
  value: string;
  contactName?: string | null;
  contactRole?: string | null;
  preferredLanguage?: ContactPreferredLanguage | null;
  authorizationStatus?: ContactAuthorizationStatus;
  isPrimary?: boolean;
}

/**
 * Adds one Contact_Recipient to a case and records the audit entry.
 *
 * Normalization and validation go through `import/contacts`, the same helpers the importer
 * uses, so a phone typed into the drawer and a phone read from a file resolve to the same
 * stored value and the Requirement 10.6 dedup key means the same thing on both paths. An
 * invalid value is refused here rather than stored: the importer stores an invalid value
 * because rejecting it would lose an imported row, which is not a concern for a value someone
 * is typing.
 *
 * `segment_index` continues the case's existing sequence for the channel, so imported cell
 * order and later additions share one ordering.
 */
export async function addCancellationContact(input: AddContactInput): Promise<CancellationContact> {
  const actor = await requireActor('add contact information');
  const supabase = getSupabase();

  const normalization =
    input.channel === 'phone'
      ? normalizePhoneSegment(input.value)
      : normalizeEmailSegment(input.value);

  if (trimmed(normalization.normalizedValue) === '') {
    reject('Enter a phone number or an email address. Nothing was saved.');
  }
  if (normalization.validationStatus === 'invalid') {
    reject(
      input.channel === 'phone'
        ? 'That phone number is not a 10-digit number, an 11-digit number beginning with 1, or a plus-prefixed international number. Nothing was saved.'
        : 'That email address is not a valid address. Nothing was saved.',
    );
  }
  if (
    input.preferredLanguage !== undefined &&
    input.preferredLanguage !== null &&
    !PREFERRED_LANGUAGES.includes(input.preferredLanguage)
  ) {
    reject(`Preferred language must be ${PREFERRED_LANGUAGES.join(', ')}. Nothing was saved.`);
  }

  const { data: existing, error: existingError } = await supabase
    .from('cancellation_contacts')
    .select('segment_index')
    .eq('case_id', input.caseId)
    .eq('channel', input.channel)
    .order('segment_index', { ascending: false })
    .limit(1);
  throwIfError(existingError, 'adding the contact information');
  const nextSegmentIndex =
    ((existing as { segment_index: number }[] | null)?.[0]?.segment_index ?? -1) + 1;

  const { data, error } = await supabase
    .from('cancellation_contacts')
    .insert({
      case_id: input.caseId,
      channel: input.channel,
      normalized_value: normalization.normalizedValue,
      raw_segment: input.value.trim(),
      validation_status: normalization.validationStatus,
      authorization_status: input.authorizationStatus ?? 'Unknown',
      is_primary: input.isPrimary ?? false,
      preferred_language: input.preferredLanguage ?? null,
      contact_name: trimmed(input.contactName) === '' ? null : trimmed(input.contactName),
      contact_role: trimmed(input.contactRole) === '' ? null : trimmed(input.contactRole),
      segment_index: nextSegmentIndex,
    })
    .select('*')
    .single();

  if (error !== null && error.code === '23505') {
    reject('That contact value is already on this cancellation. Nothing was saved.');
  }
  throwIfError(error, 'adding the contact information');
  const contact = data as CancellationContact;

  await appendEvent(input.caseId, actor.id, CANCELLATION_EVENT_TYPES.contactAdded, {
    contact_id: contact.id,
    channel: contact.channel,
    normalized_value: contact.normalized_value,
    validation_status: contact.validation_status,
    authorization_status: contact.authorization_status,
    preferred_language: contact.preferred_language,
  });

  return contact;
}

/**
 * Sets a contact's preferred language, restricted to the three values of Requirement 11.1.
 *
 * A value outside the three is refused with the three named and nothing written, so the panel
 * keeps the stored value on screen (task 16.8). The audit entry carries the previous and the
 * new value, the profile, and the time (Requirement 22.2).
 */
export async function updateContactPreferredLanguage(
  contactId: string,
  language: ContactPreferredLanguage,
): Promise<CancellationContact> {
  if (!PREFERRED_LANGUAGES.includes(language)) {
    reject(`Preferred language must be ${PREFERRED_LANGUAGES.join(', ')}. The stored value is unchanged.`);
  }
  return updateContactField(contactId, 'preferred_language', language, {
    action: 'change the preferred language',
    eventType: CANCELLATION_EVENT_TYPES.contactPreferredLanguageChanged,
  });
}

/**
 * Sets a contact's authorization status (Requirement 10.9). `Authorized` and `Unknown` permit
 * contact, `Not Authorized` prohibits it; the send path reads the stored value, so nothing here
 * decides eligibility.
 */
export async function updateContactAuthorization(
  contactId: string,
  status: ContactAuthorizationStatus,
): Promise<CancellationContact> {
  if (!AUTHORIZATION_STATUSES.includes(status)) {
    reject(`Authorization status must be ${AUTHORIZATION_STATUSES.join(', ')}. The stored value is unchanged.`);
  }
  return updateContactField(contactId, 'authorization_status', status, {
    action: 'change the authorization status',
    eventType: CANCELLATION_EVENT_TYPES.contactAuthorizationChanged,
  });
}

/** One contact-column write plus its previous-value audit entry. */
async function updateContactField(
  contactId: string,
  column: 'preferred_language' | 'authorization_status',
  value: string,
  meta: { action: string; eventType: string },
): Promise<CancellationContact> {
  const actor = await requireActor(meta.action);
  const supabase = getSupabase();

  const { data: before, error: beforeError } = await supabase
    .from('cancellation_contacts')
    .select('*')
    .eq('id', contactId)
    .maybeSingle();
  throwIfError(beforeError, meta.action);
  const stored = (before as CancellationContact | null) ?? null;
  if (stored === null) reject('That contact information is no longer available. Nothing was changed.');

  const { data, error } = await supabase
    .from('cancellation_contacts')
    .update({ [column]: value, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .select('*')
    .single();
  throwIfError(error, meta.action);
  const updated = data as CancellationContact;

  await appendEvent(stored.case_id, actor.id, meta.eventType, {
    contact_id: contactId,
    channel: stored.channel,
    normalized_value: stored.normalized_value,
    column,
    previous_value: stored[column],
    new_value: value,
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Writes — opt-out and clear (Requirements 21.1–21.4, 21.9)
// ---------------------------------------------------------------------------

/** What one recorded opt-out or one clear changed. */
export interface SuppressionWriteResult {
  channel: SuppressionChannel;
  normalizedValue: string;
  /**
   * Every case whose contact flag this write touched — the affected cases of Requirements 21.1
   * and 21.2. Requirement 15.9 makes each one due a Communication_Status recompute; call
   * `recomputeCommunicationStatus` for each with that case's pending-send count.
   */
  affectedCaseIds: string[];
  /** True when the value was already in the requested state, so only stale flags were repaired. */
  alreadyInState: boolean;
}

/**
 * The pending Touchpoint channel sends of the case a write touched, where the caller holds the
 * Touchpoint schedule.
 *
 * Supplied: the write recomputes and stores Communication_Status before it returns, satisfying
 * Requirement 15.9 in one round trip. Absent: the write leaves the stored value alone and the
 * caller recomputes once it has derived the schedule. It is never guessed — a guess of zero would
 * silently move a `Scheduled` case to `Not Scheduled`.
 */
export interface PendingSendsInput {
  pendingSends?: number;
}

/** Recomputes Communication_Status when, and only when, the caller supplied the count. */
async function recomputeIfCountSupplied(caseId: string, pendingSends: number | undefined): Promise<void> {
  if (pendingSends === undefined) return;
  await recomputeCommunicationStatus(caseId, pendingSends);
}

/**
 * Records a channel opt-out for one contact value (Requirements 21.1, 21.2).
 *
 * The plan comes from `domain/suppression.suppressChannel`, which owns every rule: channel
 * isolation, the one-active-row-per-value index, which contact flags actually need writing, and
 * one audit entry per affected case. This function only executes it — the suppression row, the
 * flag updates, the audit entries, and a status recompute for each affected case.
 *
 * Because a suppression is keyed by value rather than by case, the contact rows it reads span
 * every case holding that value, which is how the opt-out reaches cases outside the one on
 * screen (Requirements 21.3, 21.4). The returned `affectedCaseIds` is the recompute list the
 * caller works through; no recompute happens here, because the pending-send count differs per
 * case and only the caller holds it.
 */
export async function recordContactOptOut(input: {
  channel: SuppressionChannel;
  /** The contact value; normalized here, so a raw phone string is accepted. */
  normalizedValue: string;
  reason?: string | null;
}): Promise<SuppressionWriteResult> {
  const actor = await requireActor('record an opt-out');
  const context = await suppressionContext(input.channel, input.normalizedValue);

  const planned = suppressChannel(
    input.channel,
    input.normalizedValue,
    'user-recorded',
    actor.id,
    input.reason ?? null,
    context,
  );
  if (!planned.ok) reject(`${planned.rejection.message} Nothing was saved.`);

  return applySuppressionPlan(planned.plan, 'recording the opt-out');
}

/**
 * Clears a channel opt-out at the customer's request (Requirement 21.9).
 *
 * Manager_Role only, refused here before any write and refused again by the
 * `cancellation_suppressions_v1106_update_manager` policy, which additionally requires the
 * clearing profile and non-blank reason text the plan already supplies. The active row is
 * closed rather than deleted, so the value can be suppressed again later without losing either
 * record.
 */
export async function clearContactOptOut(input: {
  channel: SuppressionChannel;
  normalizedValue: string;
  reason: string;
}): Promise<SuppressionWriteResult> {
  const actor = await requireManager('Clearing an opt-out');
  const context = await suppressionContext(input.channel, input.normalizedValue);

  const planned = clearSuppression(
    input.channel,
    input.normalizedValue,
    { id: actor.id, role: actor.role },
    input.reason,
    context,
  );
  if (!planned.ok) reject(`${planned.rejection.message} Nothing was changed.`);

  return applySuppressionPlan(planned.plan, 'clearing the opt-out');
}

/**
 * Every contact row holding one value on one channel, plus that value's suppression history.
 *
 * The value is normalized with `domain/suppression.normalizeSuppressionValue` before the read,
 * the same function the plan applies to it, so a phone typed as `555-123-4567` and a phone read
 * off a contact row resolve to one key. Reading with the raw text would match zero rows and plan
 * a suppression that touched nothing.
 */
async function suppressionContext(
  channel: SuppressionChannel,
  value: string,
): Promise<{ now: Date; contacts: SuppressionContact[]; suppressions: SuppressionRecord[] }> {
  const contactChannel: ContactChannel = channel === 'sms' ? 'phone' : 'email';
  const { normalizedValue } = normalizeSuppressionValue(channel, value);

  const { data, error } = await getSupabase()
    .from('cancellation_contacts')
    .select('id,case_id,channel,normalized_value,validation_status,authorization_status,sms_suppressed,email_suppressed')
    .eq('channel', contactChannel)
    .eq('normalized_value', normalizedValue);
  throwIfError(error, 'reading the contact information');

  return {
    now: new Date(),
    contacts: (data as unknown as SuppressionContact[]) ?? [],
    suppressions: await listSuppressions([normalizedValue]),
  };
}

/** Executes a suppression or clear plan: the row, the flags, the audit entries, the recompute. */
async function applySuppressionPlan(
  plan: SuppressChannelPlan | ClearSuppressionPlan,
  context: string,
): Promise<SuppressionWriteResult> {
  const supabase = getSupabase();

  if ('suppressionInsert' in plan && plan.suppressionInsert !== null) {
    const { error } = await supabase.from('cancellation_suppressions').insert(plan.suppressionInsert);
    throwIfError(error, context);
  }

  if ('suppressionUpdate' in plan && plan.suppressionUpdate !== null) {
    const update = plan.suppressionUpdate;
    let request = supabase
      .from('cancellation_suppressions')
      .update({
        cleared_at: update.cleared_at,
        cleared_by: update.cleared_by,
        clear_reason: update.clear_reason,
      })
      .is('cleared_at', null);
    request =
      update.suppression_id === null
        ? request.eq('channel', update.channel).eq('normalized_value', update.normalized_value)
        : request.eq('id', update.suppression_id);
    const { error } = await request;
    throwIfError(error, context);
  }

  for (const update of plan.contactUpdates) {
    const { error } = await supabase
      .from('cancellation_contacts')
      .update({ [update.column]: update.value, updated_at: new Date().toISOString() })
      .eq('id', update.contact_id);
    throwIfError(error, context);
  }

  await appendPlannedEvents(plan.events);

  const alreadyInState =
    'alreadyActive' in plan ? plan.alreadyActive : plan.alreadyCleared;
  return {
    channel: plan.channel,
    normalizedValue: plan.normalizedValue,
    affectedCaseIds: [...plan.affectedCaseIds],
    alreadyInState,
  };
}

// ---------------------------------------------------------------------------
// Writes — notes with evidence (Requirements 17.8, 17.9)
// ---------------------------------------------------------------------------

/**
 * Adds a note, with any evidence files, and records the audit entry.
 *
 * Note text is measured after trimming and refused outside 1 to 4,000 characters, and the
 * attachment limits are checked before the first upload, so a rejected submission stores no
 * note and no evidence file. An upload failure after some files landed discards what it can and
 * leaves the note unsaved (Requirement 17.9).
 */
export async function addCancellationNote(input: {
  caseId: string;
  note: string;
  files?: readonly File[];
}): Promise<CancellationNote> {
  const actor = await requireActor('add a note');
  const note = trimmed(input.note);
  const files = input.files ?? [];

  if (note.length < MIN_NOTE_LENGTH || note.length > MAX_NOTE_LENGTH) {
    reject(
      `A note must be ${MIN_NOTE_LENGTH} to ${MAX_NOTE_LENGTH} characters; this one is ${note.length}. Nothing was saved.`,
    );
  }
  assertEvidenceWithinLimits(files);

  const evidence = await uploadEvidence(input.caseId, files);

  const { data, error } = await getSupabase()
    .from('cancellation_notes')
    .insert({ case_id: input.caseId, note, evidence, created_by: actor.id })
    .select('id,case_id,note,evidence,created_by,created_at')
    .single();
  if (error !== null) {
    await discardEvidence(evidence);
    throwIfError(error, 'saving the note');
  }
  const stored = data as CancellationNote;

  await appendEvent(input.caseId, actor.id, CANCELLATION_EVENT_TYPES.noteAdded, {
    note_id: stored.id,
    evidence_count: evidence.length,
  });

  return stored;
}

// ---------------------------------------------------------------------------
// Writes — customer responses (Requirements 21.5, 21.6, 21.7)
// ---------------------------------------------------------------------------

/**
 * Records a customer response.
 *
 * Exactly one of the six response types, note text at most 2,000 characters and non-blank for
 * `Assistance requested` and `Other`. `Assistance requested` and `Callback requested` also set
 * the case's assistance flag, which is what the `Customer Assistance Requested` escalation of
 * Requirement 20.4 reads; the escalation row itself is the evaluator's to write, and the status
 * recompute below is what makes the case read `Manual Follow-up Required` once it exists.
 *
 * `responseTime` is the customer's time, not the recording time: a response relayed after the
 * fact happened earlier than its recording.
 */
export async function recordCustomerResponse(
  input: PendingSendsInput & {
    caseId: string;
    responseType: CustomerResponseType;
    responseChannel?: string | null;
    responseTime?: string;
    note?: string | null;
  },
): Promise<CancellationCustomerResponse> {
  const actor = await requireActor('record a customer response');

  if (!CUSTOMER_RESPONSE_TYPES.includes(input.responseType)) {
    reject('Select one of the six customer response types. Nothing was saved.');
  }
  const note = trimmed(input.note);
  if (NOTE_REQUIRED_RESPONSE_TYPES.has(input.responseType) && note === '') {
    reject(`"${input.responseType}" requires note text. Nothing was saved.`);
  }
  if (note.length > MAX_ACTIVITY_NOTE_LENGTH) {
    reject(
      `Note text must be ${MAX_ACTIVITY_NOTE_LENGTH} characters or fewer; this one is ${note.length}. Nothing was saved.`,
    );
  }

  const supabase = getSupabase();
  const row: Record<string, unknown> = {
    case_id: input.caseId,
    response_type: input.responseType,
    response_channel: trimmed(input.responseChannel) === '' ? null : trimmed(input.responseChannel),
    note: note === '' ? null : note,
    created_by: actor.id,
  };
  if (input.responseTime !== undefined) row.response_time = input.responseTime;

  const { data, error } = await supabase
    .from('cancellation_customer_responses')
    .insert(row)
    .select('id,case_id,response_type,response_channel,response_time,note,created_by,created_at')
    .single();
  throwIfError(error, 'recording the customer response');
  const stored = data as CancellationCustomerResponse;

  const assistance = (ASSISTANCE_REQUEST_RESPONSE_TYPES as readonly CustomerResponseType[]).includes(
    input.responseType,
  );
  if (assistance) {
    const { error: flagError } = await supabase
      .from('cancellation_cases')
      .update({ assistance_requested: true, updated_at: new Date().toISOString() })
      .eq('id', input.caseId);
    throwIfError(flagError, 'recording the customer response');
  }

  await appendEvent(input.caseId, actor.id, CANCELLATION_EVENT_TYPES.customerResponseRecorded, {
    response_id: stored.id,
    response_type: stored.response_type,
    response_channel: stored.response_channel,
    response_time: stored.response_time,
    assistance_requested: assistance,
  });
  await recomputeIfCountSupplied(input.caseId, input.pendingSends);

  return stored;
}

// ---------------------------------------------------------------------------
// Writes — payment report (Requirement 18)
// ---------------------------------------------------------------------------

/**
 * Records a customer payment report and moves the case to `Payment Reported`.
 *
 * `followUpDeadline` is supplied by the caller because the end-of-second-business-day rule of
 * Requirement 18.4 counts weekends and agency-configured holidays, which is a pure computation
 * over `cancellation_settings.holidays` and belongs outside a data-access module. Everything
 * else the criteria fix is enforced here: required note text of 1 to 2,000 trimmed characters,
 * the optional amount range, the reference length, the evidence limits, and the refusal on a
 * case that is already closed (Requirement 18.8).
 *
 * Stored Communication_Record rows are left untouched — nothing below writes that table.
 */
export async function recordPaymentReport(
  input: PendingSendsInput & {
    caseId: string;
    note: string;
    reportedAmount?: number | null;
    confirmationReference?: string | null;
    /** `timestamptz`; the end of the second business day after the report, clamped by the caller. */
    followUpDeadline: string;
    files?: readonly File[];
  },
): Promise<CancellationPaymentReport> {
  const actor = await requireActor('record a payment report');
  const note = trimmed(input.note);
  const files = input.files ?? [];
  const reference = trimmed(input.confirmationReference);

  if (note.length < 1 || note.length > MAX_ACTIVITY_NOTE_LENGTH) {
    reject(
      `A payment report needs note text of 1 to ${MAX_ACTIVITY_NOTE_LENGTH} characters; this one is ${note.length}. Nothing was saved.`,
    );
  }
  if (
    input.reportedAmount !== undefined &&
    input.reportedAmount !== null &&
    (!Number.isFinite(input.reportedAmount) ||
      input.reportedAmount < MIN_REPORTED_AMOUNT ||
      input.reportedAmount > MAX_REPORTED_AMOUNT)
  ) {
    reject(
      `A reported amount must be ${MIN_REPORTED_AMOUNT} to ${MAX_REPORTED_AMOUNT}. Nothing was saved.`,
    );
  }
  if (reference.length > MAX_CONFIRMATION_REFERENCE_LENGTH) {
    reject(
      `A confirmation reference must be ${MAX_CONFIRMATION_REFERENCE_LENGTH} characters or fewer; this one is ${reference.length}. Nothing was saved.`,
    );
  }
  assertEvidenceWithinLimits(files);

  const supabase = getSupabase();
  const stored = await readCaseStatus(input.caseId, 'record a payment report');
  if (CLOSED_CASE_STATUSES.has(stored.case_status)) {
    reject(
      `This cancellation is already ${stored.case_status}. A payment report cannot be recorded on a closed case. Nothing was saved.`,
    );
  }

  const evidence = await uploadEvidence(input.caseId, files);

  const { data, error } = await supabase
    .from('cancellation_payment_reports')
    .insert({
      case_id: input.caseId,
      reported_by: actor.id,
      reported_amount: input.reportedAmount ?? null,
      confirmation_reference: reference === '' ? null : reference,
      note,
      evidence,
    })
    .select('id,case_id,reported_by,reported_at,reported_amount,confirmation_reference,note,evidence')
    .single();
  if (error !== null) {
    await discardEvidence(evidence);
    throwIfError(error, 'saving the payment report');
  }
  const report = data as CancellationPaymentReport;

  const { error: caseError } = await supabase
    .from('cancellation_cases')
    .update({
      case_status: 'Payment Reported',
      next_required_action: 'Verify Payment',
      follow_up_deadline: input.followUpDeadline,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.caseId);
  throwIfError(caseError, 'saving the payment report');

  await appendEvent(input.caseId, actor.id, CANCELLATION_EVENT_TYPES.paymentReported, {
    payment_report_id: report.id,
    reported_at: report.reported_at,
    reported_amount: report.reported_amount,
    confirmation_reference: report.confirmation_reference,
    previous_case_status: stored.case_status,
    new_case_status: 'Payment Reported',
    follow_up_deadline: input.followUpDeadline,
    evidence_count: evidence.length,
  });
  await recomputeIfCountSupplied(input.caseId, input.pendingSends);

  return report;
}

// ---------------------------------------------------------------------------
// Writes — verification outcome (Requirement 19)
// ---------------------------------------------------------------------------

/**
 * Records a payment verification outcome. Manager_Role only (Requirement 19.11).
 *
 * The outcome row is the evidence; the resulting Case_Status, next required action, and
 * follow-up deadline are supplied by the caller, because which of the seven outcomes leads
 * where is Requirement 19.3, 19.4, and 19.7 policy that the verification panel owns and that a
 * conditional outcome puts in the user's hands (Requirements 19.2, 19.5). What is enforced here
 * is the shape those criteria fix: the four conditional outcomes each need note text, a next
 * Case_Status from the three permitted values, and a next required action, and an incomplete
 * submission is refused with nothing written.
 *
 * Every existing Communication_Record is retained — nothing below writes that table.
 */
export async function recordVerificationOutcome(
  input: PendingSendsInput & {
    caseId: string;
    outcome: VerificationOutcome;
    note?: string | null;
    /** The resulting stored Case_Status. Required for a conditional outcome. */
    nextCaseStatus?: CaseStatus | null;
    nextRequiredAction?: NextRequiredAction | null;
    /** `timestamptz`, or `null` to leave the stored deadline alone. */
    followUpDeadline?: string | null;
    files?: readonly File[];
  },
): Promise<CancellationVerificationOutcome> {
  const actor = await requireManager('Recording a payment verification outcome');
  const note = trimmed(input.note);
  const files = input.files ?? [];

  if (!VERIFICATION_OUTCOMES.includes(input.outcome)) {
    reject('Select one of the seven verification outcomes. Nothing was saved.');
  }
  if (note.length > MAX_ACTIVITY_NOTE_LENGTH) {
    reject(
      `Note text must be ${MAX_ACTIVITY_NOTE_LENGTH} characters or fewer; this one is ${note.length}. Nothing was saved.`,
    );
  }

  const conditional = (CONDITIONAL_VERIFICATION_OUTCOMES as readonly VerificationOutcome[]).includes(
    input.outcome,
  );
  if (conditional) {
    if (note === '') reject(`"${input.outcome}" requires note text. Nothing was saved.`);
    if (
      input.nextCaseStatus === undefined ||
      input.nextCaseStatus === null ||
      !(VERIFICATION_NEXT_CASE_STATUSES as readonly CaseStatus[]).includes(input.nextCaseStatus)
    ) {
      reject(
        `"${input.outcome}" requires a next case status of ${VERIFICATION_NEXT_CASE_STATUSES.join(', ')}. Nothing was saved.`,
      );
    }
    if (trimmed(input.nextRequiredAction) === '') {
      reject(`"${input.outcome}" requires a next required action. Nothing was saved.`);
    }
  }
  assertEvidenceWithinLimits(files);

  const supabase = getSupabase();
  const stored = await readCaseStatus(input.caseId, 'record a payment verification outcome');
  const evidence = await uploadEvidence(input.caseId, files);

  const { data, error } = await supabase
    .from('cancellation_verification_outcomes')
    .insert({
      case_id: input.caseId,
      recorded_by: actor.id,
      outcome: input.outcome,
      note: note === '' ? null : note,
      next_case_status: input.nextCaseStatus ?? null,
      next_required_action: input.nextRequiredAction ?? null,
      evidence,
    })
    .select('id,case_id,recorded_by,verified_at,outcome,note,next_case_status,next_required_action,evidence')
    .single();
  if (error !== null) {
    await discardEvidence(evidence);
    throwIfError(error, 'saving the verification outcome');
  }
  const outcome = data as CancellationVerificationOutcome;

  const casePatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.nextCaseStatus !== undefined && input.nextCaseStatus !== null) {
    casePatch.case_status = input.nextCaseStatus;
  }
  if (input.nextRequiredAction !== undefined) {
    casePatch.next_required_action = input.nextRequiredAction;
  }
  if (input.followUpDeadline !== undefined) casePatch.follow_up_deadline = input.followUpDeadline;

  const { error: caseError } = await supabase
    .from('cancellation_cases')
    .update(casePatch)
    .eq('id', input.caseId);
  throwIfError(caseError, 'saving the verification outcome');

  await appendEvent(input.caseId, actor.id, CANCELLATION_EVENT_TYPES.verificationOutcomeRecorded, {
    verification_outcome_id: outcome.id,
    outcome: outcome.outcome,
    verified_at: outcome.verified_at,
    previous_case_status: stored.case_status,
    new_case_status: input.nextCaseStatus ?? stored.case_status,
    next_required_action: input.nextRequiredAction ?? null,
    evidence_count: evidence.length,
  });
  await recomputeIfCountSupplied(input.caseId, input.pendingSends);

  return outcome;
}

// ---------------------------------------------------------------------------
// Writes — Case_Status override and assignment (Requirements 22.3, 22.4, 22.10, 22.11)
// ---------------------------------------------------------------------------

/** The stored Case_Status of one case, read before a write that reports the previous value. */
async function readCaseStatus(
  caseId: string,
  action: string,
): Promise<{ id: string; case_status: CaseStatus; assigned_to: string | null }> {
  const { data, error } = await getSupabase()
    .from('cancellation_cases')
    .select('id,case_status,assigned_to')
    .eq('id', caseId)
    .maybeSingle();
  throwIfError(error, action);
  const row = (data as { id: string; case_status: CaseStatus; assigned_to: string | null } | null) ?? null;
  if (row === null) reject('That cancellation is no longer available to you. Nothing was changed.');
  return row;
}

/**
 * Overrides a case's Case_Status with reason text (Requirement 22.4).
 *
 * Reason text of 1 to 1,000 characters is required and is refused outside that range with the
 * status unchanged (Requirement 22.11). One audit entry carries the reason, the overriding
 * profile, the override time, the previous Case_Status, and the new one.
 *
 * The role gate fails closed twice over: a profile that does not hold Manager_Role may set only
 * the four values of Requirement 22.10 and only on a case that is not already at a terminal
 * status, checked here so the refusal is readable, and enforced again by
 * `cancellation_cases_v1106_update_own`, which compares the resulting row against the stored
 * status past row level security.
 */
export async function overrideCaseStatus(
  input: PendingSendsInput & {
    caseId: string;
    caseStatus: CaseStatus;
    reason: string;
  },
): Promise<CancellationCase> {
  const actor = await requireActor('change a case status');
  const reason = trimmed(input.reason);

  if (!CASE_STATUSES.includes(input.caseStatus)) {
    reject(`"${input.caseStatus}" is not an allowed case status. The stored status is unchanged.`);
  }
  if (reason.length < 1 || reason.length > MAX_OVERRIDE_REASON_LENGTH) {
    reject(
      `A case status change needs reason text of 1 to ${MAX_OVERRIDE_REASON_LENGTH} characters; this one is ${reason.length}. The stored status is unchanged.`,
    );
  }

  const stored = await readCaseStatus(input.caseId, 'change a case status');
  const manager = isBroadManagerRole(actor.role);

  if (!manager) {
    if ((TERMINAL_CASE_STATUSES as readonly CaseStatus[]).includes(stored.case_status)) {
      reject(
        `This cancellation is ${stored.case_status}. Changing the status of a closed case requires a manager or super admin. Nothing was changed.`,
      );
    }
    if (!(AGENT_SETTABLE_CASE_STATUSES as readonly CaseStatus[]).includes(input.caseStatus)) {
      reject(
        `Setting a case status to "${input.caseStatus}" requires a manager or super admin. Your role may set ${AGENT_SETTABLE_CASE_STATUSES.join(', ')}. Nothing was changed.`,
      );
    }
  }

  const overriddenAt = new Date().toISOString();
  const { data, error } = await getSupabase()
    .from('cancellation_cases')
    .update({ case_status: input.caseStatus, updated_at: overriddenAt })
    .eq('id', input.caseId)
    .select(CASE_LIST_COLUMNS)
    .single();
  throwIfError(error, 'changing the case status');

  await appendEvent(
    input.caseId,
    actor.id,
    CANCELLATION_EVENT_TYPES.caseStatusOverridden,
    {
      reason,
      previous_case_status: stored.case_status,
      new_case_status: input.caseStatus,
      overridden_by: actor.id,
      overridden_at: overriddenAt,
    },
    overriddenAt,
  );
  await recomputeIfCountSupplied(input.caseId, input.pendingSends);

  return data as unknown as CancellationCase;
}

/**
 * Assigns a case to an employee (Requirement 22.3). Manager_Role only.
 *
 * `assignment_source` is set to `manager`, which is what makes the assignment outrank a later
 * import: the loader holds both columns where the stored source is already `manager`.
 * Passing `null` clears the assignment.
 */
export async function assignCancellationCase(
  caseId: string,
  profileId: string | null,
): Promise<CancellationCase> {
  const actor = await requireManager('Reassigning a cancellation');
  const stored = await readCaseStatus(caseId, 'reassign a cancellation');

  const { data, error } = await getSupabase()
    .from('cancellation_cases')
    .update({
      assigned_to: profileId,
      assignment_source: profileId === null ? null : 'manager',
      updated_at: new Date().toISOString(),
    })
    .eq('id', caseId)
    .select(CASE_LIST_COLUMNS)
    .single();
  throwIfError(error, 'reassigning the cancellation');

  await appendEvent(caseId, actor.id, CANCELLATION_EVENT_TYPES.caseAssigned, {
    previous_assigned_to: stored.assigned_to,
    new_assigned_to: profileId,
    assignment_source: profileId === null ? null : 'manager',
  });

  return data as unknown as CancellationCase;
}

// ---------------------------------------------------------------------------
// Writes — the settings kill switch (Requirement 26.4)
// ---------------------------------------------------------------------------

/**
 * Turns automatic Touchpoint sending on or off for every case (Requirement 26.4).
 *
 * Manager_Role only, refused here and again by `cancellation_settings_v1106_update_manager`,
 * which additionally requires `updated_by` to be the acting profile. The new value, the
 * changing profile, and the change time are all stored. While the switch is off the scheduler
 * sends nothing automatically and creates no Communication_Record for the Touchpoints it would
 * have sent; Send Reminder Now and Retry Failed Communication keep working (Requirements 26.5,
 * 26.6), neither of which this function affects.
 */
export async function setAutomaticSendingEnabled(enabled: boolean): Promise<CancellationSettings> {
  const actor = await requireManager('Changing the automatic sending setting');

  const { data, error } = await getSupabase()
    .from('cancellation_settings')
    .update({
      automatic_sending_enabled: enabled,
      updated_by: actor.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', true)
    .select('automatic_sending_enabled,office_phone,agency_name,bilingual_separator,holidays,updated_by,updated_at')
    .single();
  throwIfError(error, 'changing the automatic sending setting');

  return data as CancellationSettings;
}

// ---------------------------------------------------------------------------
// Re-exported vocabulary
// ---------------------------------------------------------------------------

/**
 * The stored value types the UI needs, re-exported so a component imports one module.
 * The definitions stay in the domain and render modules, which own them.
 */
export type {
  CaseStatus,
  CommunicationStatus,
  DeliveryResult,
  NextRequiredAction,
} from './domain/communication-status';
export type { EscalationReason } from './domain/escalation';
export type { SuppressionChannel } from './domain/suppression';
export type {
  ContactAuthorizationStatus,
  ContactChannel,
  ContactPreferredLanguage,
  ContactValidationStatus,
} from './import/contacts';
export type { TemplateLanguage, Touchpoint } from './render/renderMessage';
