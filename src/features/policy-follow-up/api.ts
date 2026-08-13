'use client';

// Policy Follow-up: the shared data access for My Work, Manager Overview, and Imports.
//
// This module owns only what is genuinely cross-domain. It does not duplicate either domain's API:
// the renewal reads come from `../renewals/api`, the cancellation reads from `../cancellations/api`,
// and every *write* to a renewal or a cancellation still goes through that domain's own function and
// its own drawer. What is added here is the shared ownership layer, the manager aggregates, and the
// collector import calls — none of which belongs to one domain.
//
// Nothing here sends a customer message. Requirement 12.1 is explicit that the shared surfaces
// consume communication status and never become a second sender, and the absence of any send call in
// this file is that guarantee.

import type { AppRole } from '@/lib/types';

import { getSupabase } from '../nhwd-shared/client';
import {
  getCancellationSettings,
  listCancellationAssignees,
  listCancellationCases,
  listCommunicationsForCases,
  listContactsForCases,
  listCustomerResponsesForCases,
  listEscalationsForCases,
  listSuppressions,
  type CancellationCase,
  type CancellationCommunication,
  type CancellationContact,
  type CancellationCustomerResponse,
  type CancellationEscalation,
  type CancellationSuppression,
} from '../cancellations/api';
import { cancellationScheduledSends } from '../cancellations/CancellationDrawer';
import { CANCELLATION_PAGE_SIZE, type CancellationRowState } from '../cancellations/derive';
import {
  listRenewalContactSummaries,
  listRenewalRequoteSummaries,
  listRenewals,
  type RenewalContactSummaryRow,
  type RenewalRecord,
  type RenewalRequoteSummaryRow,
} from '../renewals/api';
import { currentBusinessDate } from '../renewals/derive';
import type {
  PolicyAgentOverviewRow,
  PolicyAssignmentEvent,
  PolicyAssignmentOutcome,
  PolicyEligibleAgent,
  PolicyFollowUpManagerOverview,
  PolicySearchResult,
  PolicyWorkItem,
} from './types';
import type { PolicyAssignmentMode } from './normalization';
import { cancellationWorkItem, renewalWorkItem, sortPolicyWorkItems } from './work-projection';
import type { CancellationCollectorPayloadRow, RenewalCollectorPayloadRow } from './collector';

function throwIfError(error: { message?: string } | null): void {
  if (error) throw new Error(error.message || 'The Policy Follow-up request could not be completed.');
}

// ---------------------------------------------------------------------------
// My Work (Requirements 6.1, 6.2)
// ---------------------------------------------------------------------------

/**
 * At most this many cancellation pages are followed for one employee's own book.
 *
 * An agent's assigned cancellations are a working list, not the agency's whole book, so this cap is
 * a safety bound rather than the windowing problem Requirement 9.5 is about: the *manager* counters
 * come from a server aggregate, and nothing on this surface claims to be a full-population count.
 */
const MAX_MY_WORK_PAGES = 10;

export interface MyPolicyWork {
  items: readonly PolicyWorkItem[];
  /** True where the cap above stopped the read before the employee's book was exhausted. */
  truncated: boolean;
  /** True where automatic cancellation sending is on, which the surface reports but never changes. */
  automaticSendingEnabled: boolean;
}

/**
 * One employee's assigned open work across both domains (Requirement 6.1).
 *
 * Read scope is whatever row level security already allows; the `assigned_to` filter is the
 * ownership narrowing on top of that, not a substitute for it. An agent cannot widen this by asking
 * for somebody else's id — the policies would return nothing.
 */
export async function loadMyPolicyWork(options: {
  profileId: string;
  role: AppRole;
  businessDate?: string;
}): Promise<MyPolicyWork> {
  const businessDate = options.businessDate ?? currentBusinessDate();

  const [renewalPart, cancellationPart, settings] = await Promise.all([
    loadRenewalWorkFor(options.profileId, businessDate),
    loadCancellationWorkFor(options.profileId, options.role, businessDate),
    getCancellationSettings().catch(() => null),
  ]);

  return {
    items: sortPolicyWorkItems([...renewalPart.items, ...cancellationPart.items]),
    truncated: cancellationPart.truncated,
    automaticSendingEnabled: settings?.automatic_sending_enabled === true,
  };
}

async function loadRenewalWorkFor(
  profileId: string,
  businessDate: string,
): Promise<{ items: PolicyWorkItem[] }> {
  const records = await listRenewals({ status: 'open', assignedTo: profileId });
  if (records.length === 0) return { items: [] };

  const ids = records.map((record) => record.id);
  const [contacts, requotes] = await Promise.all([
    listRenewalContactSummaries(ids).catch(() => [] as RenewalContactSummaryRow[]),
    listRenewalRequoteSummaries(ids).catch(() => [] as RenewalRequoteSummaryRow[]),
  ]);

  const contactById = new Map(contacts.map((row) => [row.record_id, row]));
  const requoteById = new Map(requotes.map((row) => [row.record_id, row]));

  return {
    items: records.map((record) => {
      const contact = contactById.get(record.id) ?? null;
      const requote = requoteById.get(record.id) ?? null;
      return renewalWorkItem({
        record,
        contacts: contact === null || contact.contact_count <= 0
          ? []
          : [{ occurred_at: contact.last_contact_at ?? '' }],
        requotes: requote === null || requote.requote_event_count <= 0
          ? []
          : [{ created_at: requote.last_requote_at ?? '' }],
        lastContactAt: contact?.last_contact_at ?? null,
        businessDate,
      });
    }),
  };
}

async function loadCancellationWorkFor(
  profileId: string,
  role: AppRole,
  businessDate: string,
): Promise<{ items: PolicyWorkItem[]; truncated: boolean }> {
  const cases: CancellationCase[] = [];
  let page = 0;
  let hasMore = true;

  while (hasMore && page < MAX_MY_WORK_PAGES) {
    const result = await listCancellationCases({
      page,
      pageSize: CANCELLATION_PAGE_SIZE,
      assignedTo: profileId,
    });
    cases.push(...result.rows);
    hasMore = result.hasMore;
    page += 1;
  }

  if (cases.length === 0) return { items: [], truncated: hasMore };

  const caseIds = cases.map((row) => row.id);
  const [contacts, communications, responses, escalations, assignees] = await Promise.all([
    listContactsForCases(caseIds),
    listCommunicationsForCases(caseIds),
    listCustomerResponsesForCases(caseIds),
    listEscalationsForCases(caseIds),
    listCancellationAssignees().catch(() => []),
  ]);

  const suppressions = await listSuppressions([
    ...new Set(contacts.map((contact) => contact.normalized_value)),
  ]).catch(() => [] as CancellationSuppression[]);

  const contactsByCase = groupByCase(contacts);
  const communicationsByCase = groupByCase(communications);
  const responsesByCase = groupByCase(responses);
  const escalationsByCase = groupByCase(escalations);
  const assigneeById = new Map(assignees.map((person) => [person.id, person]));

  const items = cases.map((caseRow) => {
    const caseContacts = contactsByCase.get(caseRow.id) ?? [];
    // Exactly the bundle `CancellationsPage` builds for its own list, so the two surfaces derive
    // from identical facts and cannot disagree about a case (Requirement 5.3).
    const state: CancellationRowState = {
      case: caseRow,
      contacts: caseContacts,
      communications: communicationsByCase.get(caseRow.id) ?? [],
      responses: responsesByCase.get(caseRow.id) ?? [],
      escalations: escalationsByCase.get(caseRow.id) ?? [],
      suppressions,
      scheduledSends:
        cancellationScheduledSends(caseRow, caseContacts, suppressions, businessDate) ?? [],
      businessDate,
      assignedEmployee:
        caseRow.assigned_to === null ? null : assigneeById.get(caseRow.assigned_to) ?? null,
      viewerRole: role,
    };

    return cancellationWorkItem({ state, viewerRole: role, businessDate });
  });

  return { items, truncated: hasMore };
}

function groupByCase<T extends { case_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const held = grouped.get(row.case_id);
    if (held === undefined) grouped.set(row.case_id, [row]);
    else held.push(row);
  }
  return grouped;
}

// Re-exported so the My Work surface can name the types it renders without importing two modules.
export type {
  CancellationCase,
  CancellationCommunication,
  CancellationContact,
  CancellationCustomerResponse,
  CancellationEscalation,
  RenewalRecord,
};

// ---------------------------------------------------------------------------
// Manager Overview (Requirements 9.2, 9.4, 9.5)
// ---------------------------------------------------------------------------

/** The shape `policy_followup_manager_overview` returns, before adaptation. */
interface ManagerOverviewPayload {
  businessDate: string;
  renewals: Record<string, number>;
  cancellations: Record<string, number>;
  attention: Record<string, number>;
  agents: readonly Record<string, unknown>[];
  fullPopulation: boolean;
}

/**
 * The Manager Overview payload, computed server-side over the full authorized population
 * (Requirement 9.5).
 *
 * Deliberately one RPC rather than a client-side aggregation over loaded rows: the Cancellations
 * list caps its read at twenty pages, so any counter computed from what the client holds is wrong
 * on a book larger than a thousand cases, silently and in the direction that hides work.
 */
export async function loadManagerOverview(
  businessDate?: string,
): Promise<PolicyFollowUpManagerOverview> {
  const { data, error } = await getSupabase().rpc('policy_followup_manager_overview', {
    p_business_date: businessDate ?? currentBusinessDate(),
  });
  throwIfError(error);

  const payload = data as ManagerOverviewPayload;
  return {
    businessDate: payload.businessDate,
    renewals: {
      active: payload.renewals.active ?? 0,
      needActionToday: payload.renewals.needActionToday ?? 0,
      overdue: payload.renewals.overdue ?? 0,
      unassigned: payload.renewals.unassigned ?? 0,
      neverContacted: payload.renewals.neverContacted ?? 0,
      waiting: payload.renewals.waiting ?? 0,
      completedThisMonth: payload.renewals.completedThisMonth ?? 0,
      reviewRequired: payload.renewals.reviewRequired ?? 0,
    },
    cancellations: {
      active: payload.cancellations.active ?? 0,
      needActionToday: payload.cancellations.needActionToday ?? 0,
      overdue: payload.cancellations.overdue ?? 0,
      unassigned: payload.cancellations.unassigned ?? 0,
      neverContacted: payload.cancellations.neverContacted ?? 0,
      waiting: payload.cancellations.waiting ?? 0,
      completedThisMonth: payload.cancellations.completedThisMonth ?? 0,
      reviewRequired: payload.cancellations.reviewRequired ?? 0,
    },
    attention: {
      carrierNonRenewalAwaitingRequote: payload.attention.carrierNonRenewalAwaitingRequote ?? 0,
      paymentVerificationRequired: payload.attention.paymentVerificationRequired ?? 0,
      failedCommunications: payload.attention.failedCommunications ?? 0,
      reviewRequiredImports: payload.attention.reviewRequiredImports ?? 0,
      unmatchedProducerLabels: payload.attention.unmatchedProducerLabels ?? 0,
      matchReviewRows: payload.attention.matchReviewRows ?? 0,
      missingValidContact: payload.attention.missingValidContact ?? 0,
      unknownImportedStatus: payload.attention.unknownImportedStatus ?? 0,
      unassignedPolicies: payload.attention.unassignedPolicies ?? 0,
      ownershipConflicts: payload.attention.ownershipConflicts ?? 0,
    },
    agents: (payload.agents ?? []).map(adaptAgentRow),
    fullPopulation: payload.fullPopulation === true,
  };
}

function adaptAgentRow(row: Record<string, unknown>): PolicyAgentOverviewRow {
  const number = (key: string): number => Number(row[key] ?? 0);
  return {
    profileId: String(row.profile_id ?? ''),
    displayName: String(row.display_name ?? ''),
    username: (row.username as string | null) ?? null,
    role: (row.role as string | null) ?? null,
    renewalsEnabled: row.renewals_enabled === true,
    cancellationsEnabled: row.cancellations_enabled === true,
    autoAssignmentEnabled: row.auto_assignment_enabled === true,
    assignmentMode: ((row.assignment_mode as PolicyAssignmentMode | null) ?? 'producer_preferred'),
    activeRenewals: number('active_renewals'),
    activeCancellations: number('active_cancellations'),
    dueToday: number('due_today'),
    overdue: number('overdue'),
    criticalCancellations: number('critical_cancellations'),
    carrierNonRenewals: number('carrier_non_renewals'),
    waiting: number('waiting'),
    workloadScore: number('workload_score'),
  };
}

// ---------------------------------------------------------------------------
// Agent eligibility (Requirement 3.4)
// ---------------------------------------------------------------------------

/** Every employee who may hold Policy Follow-up work, with their current settings. */
export async function listPolicyEligibleAgents(): Promise<PolicyEligibleAgent[]> {
  const { data, error } = await getSupabase().rpc('policy_followup_eligible_agents', {
    p_domain: null,
  });
  throwIfError(error);
  return ((data as Record<string, unknown>[]) ?? []).map((row) => ({
    profile_id: String(row.profile_id ?? ''),
    display_name: String(row.display_name ?? ''),
    username: (row.username as string | null) ?? null,
    initials: (row.initials as string | null) ?? null,
    role: String(row.role ?? ''),
    is_active: true,
    renewals_enabled: row.renewals_enabled === true,
    cancellations_enabled: row.cancellations_enabled === true,
    auto_assignment_enabled: row.auto_assignment_enabled === true,
    assignment_mode: ((row.assignment_mode as PolicyAssignmentMode | null) ?? 'producer_preferred'),
  }));
}

/**
 * Saves one employee's eligibility (Requirement 3.4).
 *
 * These settings govern *automatic assignment only*. The employee's application role still decides
 * what they can reach, and nothing written here touches quote queue status, attendance status, a
 * RingCentral or WhatsApp turn, or a rotation position.
 */
export async function savePolicyAgentSetting(input: {
  profileId: string;
  renewalsEnabled: boolean;
  cancellationsEnabled: boolean;
  autoAssignmentEnabled: boolean;
  assignmentMode: PolicyAssignmentMode;
}): Promise<void> {
  const { data: auth } = await getSupabase().auth.getUser();

  const { error } = await getSupabase()
    .from('policy_followup_agent_settings')
    .upsert({
      profile_id: input.profileId,
      renewals_enabled: input.renewalsEnabled,
      cancellations_enabled: input.cancellationsEnabled,
      auto_assignment_enabled: input.autoAssignmentEnabled,
      assignment_mode: input.assignmentMode,
      updated_by: auth.user?.id ?? null,
    }, { onConflict: 'profile_id' });
  throwIfError(error);
}

// ---------------------------------------------------------------------------
// Ownership (Requirements 3.5, 9.3, 13.2)
// ---------------------------------------------------------------------------

/**
 * Assigns or reassigns one policy (Requirement 3.5).
 *
 * The RPC updates the shared owner, every open renewal and active cancellation for that policy, and
 * all three audit trails, then locks the result against future automatic reassignment. It is
 * manager-gated server-side, so a UI mistake cannot let an agent through.
 */
export async function assignPolicy(input: {
  carrierKey: string;
  policyNumberNormalized: string;
  profileId: string;
  managerNote?: string | null;
}): Promise<PolicyAssignmentOutcome & { renewals_updated: number; cancellations_updated: number }> {
  const { data, error } = await getSupabase().rpc('policy_followup_assign_policy', {
    p_carrier_key: input.carrierKey,
    p_policy_number_normalized: input.policyNumberNormalized,
    p_profile_id: input.profileId,
    p_manager_note: input.managerNote ?? null,
  });
  throwIfError(error);
  return data as PolicyAssignmentOutcome & {
    renewals_updated: number;
    cancellations_updated: number;
  };
}

/**
 * Releases the manager protection on one policy (Requirement 3.5).
 *
 * Unlocking does not reassign: the precedence then *preserves* the same owner on the next import,
 * which is the point — a manager unlocks to allow future automatic reassignment, not to trigger one
 * now. `clearOwner` is the second, explicit choice of also removing the owner.
 */
export async function unlockPolicyOwner(input: {
  carrierKey: string;
  policyNumberNormalized: string;
  clearOwner?: boolean;
}): Promise<{ assigned_to: string | null; cleared_owner: boolean }> {
  const { data, error } = await getSupabase().rpc('policy_followup_unlock_policy_owner', {
    p_carrier_key: input.carrierKey,
    p_policy_number_normalized: input.policyNumberNormalized,
    p_clear_owner: input.clearOwner === true,
  });
  throwIfError(error);
  return data as { assigned_to: string | null; cleared_owner: boolean };
}

/** Runs the Requirement 3.3 precedence for one domain record, manager-gated server-side. */
export async function autoAssignPolicyRecord(input: {
  domain: 'renewal' | 'cancellation';
  recordId: string;
  businessDate?: string;
}): Promise<PolicyAssignmentOutcome> {
  const { data, error } = await getSupabase().rpc('policy_followup_auto_assign', {
    p_domain: input.domain,
    p_record_id: input.recordId,
    p_business_date: input.businessDate ?? currentBusinessDate(),
  });
  throwIfError(error);
  return data as PolicyAssignmentOutcome;
}

/** Re-runs the ownership bootstrap for policies that appeared since the last run. */
export async function bootstrapPolicyOwners(): Promise<{
  bootstrapped: number;
  conflicts: number;
  unowned: number;
  already_recorded: number;
}> {
  const { data, error } = await getSupabase().rpc('policy_followup_bootstrap_owners', {});
  throwIfError(error);
  return data as { bootstrapped: number; conflicts: number; unowned: number; already_recorded: number };
}

export interface PolicyOwnershipException {
  carrier_key: string;
  policy_number_normalized: string;
  carrier: string | null;
  policy_number: string | null;
  customer_name: string | null;
  conflict: boolean;
  conflict_detail: Record<string, unknown> | null;
  producer_label: string | null;
  renewal_record_id: string | null;
  cancellation_case_id: string | null;
  updated_at: string;
}

/** Unassigned policies and bootstrap ownership conflicts that still have live work (Req 9.3). */
export async function listPolicyOwnershipExceptions(
  kind: 'all' | 'unassigned' | 'conflict' = 'all',
  limit = 200,
): Promise<PolicyOwnershipException[]> {
  const { data, error } = await getSupabase().rpc('policy_followup_ownership_exceptions', {
    p_kind: kind,
    p_limit: limit,
  });
  throwIfError(error);
  return (data as PolicyOwnershipException[]) ?? [];
}

/** The ownership history of one policy, newest first (Requirement 13.2). */
export async function listPolicyAssignmentEvents(input: {
  carrierKey: string;
  policyNumberNormalized: string;
  limit?: number;
}): Promise<PolicyAssignmentEvent[]> {
  const { data, error } = await getSupabase()
    .from('policy_followup_assignment_events')
    .select('*')
    .eq('carrier_key', input.carrierKey)
    .eq('policy_number_normalized', input.policyNumberNormalized)
    .order('created_at', { ascending: false })
    .limit(input.limit ?? 50);
  throwIfError(error);
  return (data as PolicyAssignmentEvent[]) ?? [];
}

// ---------------------------------------------------------------------------
// Cross-domain search (Requirement 10.2)
// ---------------------------------------------------------------------------

/** Finds a policy by customer, policy number, carrier, phone, or email (Requirement 10.2). */
export async function searchPolicies(query: string, limit = 25): Promise<PolicySearchResult[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const { data, error } = await getSupabase().rpc('policy_followup_policy_search', {
    p_query: trimmed,
    p_limit: limit,
  });
  throwIfError(error);

  return ((data as Record<string, unknown>[]) ?? []).map((row) => ({
    carrierKey: (row.carrier_key as string | null) ?? null,
    carrier: (row.carrier as string | null) ?? null,
    policyNumber: String(row.policy_number ?? ''),
    policyNumberNormalized: (row.policy_number_normalized as string | null) ?? null,
    customerName: (row.customer_name as string | null) ?? null,
    ownerName: (row.owner_name as string | null) ?? null,
    ownerProfileId: (row.owner_profile_id as string | null) ?? null,
    assignmentSource: (row.assignment_source as PolicySearchResult['assignmentSource']) ?? null,
    assignmentLocked: row.assignment_locked === true,
    ownershipConflict: row.ownership_conflict === true,
    hasActiveRenewal: row.has_active_renewal === true,
    hasActiveCancellation: row.has_active_cancellation === true,
    renewalRecordId: (row.renewal_record_id as string | null) ?? null,
    cancellationCaseId: (row.cancellation_case_id as string | null) ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Collector import (Requirements 2.1, 2.2, 11.2)
// ---------------------------------------------------------------------------

/** What the renewal collector import reports (Requirement 11.2). */
export interface RenewalCollectorImportResult {
  id: string;
  rows_total: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  rows_closed_preserved: number;
  rows_review_required: number;
  rows_carrier_nonrenewal: number;
  /** Requirement 11.2: import success and assignment completion are different questions. */
  assignment: {
    manager_locked: number;
    existing_owner: number;
    producer_mapping: number;
    weighted_auto: number;
    ownership_conflict: number;
    unassigned_review: number;
  };
  unmatched_producer_labels: readonly string[];
}

/** Loads one consolidated Renewals collector export (Requirement 2.1). */
export async function importRenewalCollectorBatch(
  fileName: string,
  rows: readonly RenewalCollectorPayloadRow[],
): Promise<RenewalCollectorImportResult> {
  const { data, error } = await getSupabase().rpc('renewal_import_collector_batch', {
    p_file_name: fileName,
    p_rows: rows,
  });
  throwIfError(error);
  return data as RenewalCollectorImportResult;
}

/** What the cancellation import returns: the stored `cancellation_import_runs` row. */
export interface CancellationCollectorImportResult {
  id: string;
  file_name: string;
  column_set: string;
  rows_total: number;
  rows_created: number;
  rows_updated: number;
  rows_rejected: number;
  rows_duplicate: number;
  invalid_contact_count: number;
  completed_at: string;
}

/**
 * Loads one consolidated PendingCancellation collector export (Requirement 2.2).
 *
 * Goes through the existing `cancellation_import_batch` under the `collector` column set, so the
 * source-aware merge, the contact dedup, the raw-row preservation, and the audit trail are the ones
 * the cancellations module already owns — design 11.2 rather than a second importer.
 */
export async function importCancellationCollectorBatch(input: {
  fileName: string;
  header: readonly string[];
  rows: readonly CancellationCollectorPayloadRow[];
}): Promise<CancellationCollectorImportResult> {
  const { data, error } = await getSupabase().rpc('cancellation_import_batch', {
    p_file_name: input.fileName,
    p_column_set: 'collector',
    p_mapping: { header: input.header, source: 'pending_cancellation_collector' },
    p_rows: input.rows,
  });
  throwIfError(error);
  return data as CancellationCollectorImportResult;
}
