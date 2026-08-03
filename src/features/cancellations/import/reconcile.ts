// Cancellation import: reconciliation of two-file (eficacia + avisos) imports.
//
// Pure module: no React, no Supabase, no I/O, no clock. Compares two import previews
// to produce a reconciliation summary showing how the files relate to each other.
//
// REQ-5.1, REQ-5.2: Guided two-file import with reconciliation summary.

import type { ImportedCaseStatus } from './status-mapping';
import { identityKey, type ImportPreview, type PreviewedCaseRow } from './preview';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconciliationIssue {
  readonly category: ReconciliationIssueCategory;
  readonly rowNumber: number;
  readonly policyNumber: string;
  readonly detail: string;
}

export type ReconciliationIssueCategory =
  | 'unassigned'
  | 'missing_contacts'
  | 'invalid_contacts'
  | 'status_conflict'
  | 'deleted_producer'
  | 'multiple_policies'
  | 'excluded_from_reminders'
  | 'ready_for_reminders';

export interface ReconciliationSummary {
  /** Total eficacia cases in the preview plan. */
  eficaciaCaseCount: number;
  /** Total avisos rows in the preview plan. */
  avisosRowCount: number;
  /** Cases whose identity appears in both files. */
  matchingCases: number;
  /** Cases present only in eficacia (no avisos contact data). */
  eficaciaOnlyCases: number;
  /** Cases present only in avisos (no eficacia). */
  avisosOnlyCases: number;
  /** Cases with status Imported (eligible for reminders). */
  activeCases: number;
  /** Cases with status Reinstated. */
  paidRecoveredCases: number;
  /** Cases with status Cancelled. */
  cancelledLostCases: number;
  /** Cases with status Import Review Required. */
  reviewRequiredCases: number;
  /** Cases with empty or unresolved producer label. */
  missingProducerCount: number;
  /** Cases with a producer label ending in (Deleted). */
  deletedProducerCount: number;
  /** Customers with more than one policy across both files. */
  multiPolicyCustomers: number;
  /** Categorized issues for the reconciliation panel. */
  issues: readonly ReconciliationIssue[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Reconciles two import previews (one eficacia, one avisos) and produces a summary
 * with matching counts and categorized issues.
 *
 * Either preview may be null (single-file import is valid). When both are present,
 * identity matching uses the same key as the import pipeline:
 * (normalized policy number, cancellation effective date).
 */
export function reconcileImports(
  eficaciaPreview: ImportPreview | null,
  avisosPreview: ImportPreview | null,
): ReconciliationSummary {
  const eficaciaRows = eficaciaPreview?.plan ?? [];
  const avisosRows = avisosPreview?.plan ?? [];

  // Build identity key sets
  const eficaciaKeys = new Set<string>();
  const eficaciaByKey = new Map<string, PreviewedCaseRow>();
  for (const row of eficaciaRows) {
    const key = identityKey(row.identity);
    eficaciaKeys.add(key);
    eficaciaByKey.set(key, row);
  }

  const avisosKeys = new Set<string>();
  for (const row of avisosRows) {
    avisosKeys.add(identityKey(row.identity));
  }

  // Matching
  let matchingCases = 0;
  let eficaciaOnlyCases = 0;
  let avisosOnlyCases = 0;

  for (const key of eficaciaKeys) {
    if (avisosKeys.has(key)) matchingCases++;
    else eficaciaOnlyCases++;
  }
  for (const key of avisosKeys) {
    if (!eficaciaKeys.has(key)) avisosOnlyCases++;
  }

  // Status distribution (from eficacia, which owns status)
  let activeCases = 0;
  let paidRecoveredCases = 0;
  let cancelledLostCases = 0;
  let reviewRequiredCases = 0;

  for (const row of eficaciaRows) {
    const status = (row.fields.case_status ?? 'Imported') as ImportedCaseStatus;
    switch (status) {
      case 'Imported': activeCases++; break;
      case 'Reinstated': paidRecoveredCases++; break;
      case 'Cancelled': cancelledLostCases++; break;
      case 'Import Review Required': reviewRequiredCases++; break;
    }
  }

  // Producer issues
  let missingProducerCount = 0;
  let deletedProducerCount = 0;
  for (const row of eficaciaRows) {
    if (row.producer.normalizedLabel === null) {
      missingProducerCount++;
    }
    if (row.producer.deleted) {
      deletedProducerCount++;
    }
  }

  // Multi-policy customers (same customer_match_key, different policies)
  const customerPolicies = new Map<string, string[]>();
  for (const row of eficaciaRows) {
    const matchKey = row.fields.customer_match_key;
    if (matchKey && matchKey.length > 0) {
      if (!customerPolicies.has(matchKey)) customerPolicies.set(matchKey, []);
      customerPolicies.get(matchKey)!.push(row.fields.policy_number);
    }
  }
  const multiPolicyCustomers = [...customerPolicies.values()].filter((p) => p.length > 1).length;

  // Build issues list
  const issues: ReconciliationIssue[] = [];

  for (const row of eficaciaRows) {
    const status = (row.fields.case_status ?? 'Imported') as ImportedCaseStatus;
    const key = identityKey(row.identity);

    // Missing contacts (eficacia-only, no avisos)
    if (!avisosKeys.has(key)) {
      issues.push({
        category: 'missing_contacts',
        rowNumber: row.rowNumber,
        policyNumber: row.fields.policy_number,
        detail: 'No avisos contact data for this case.',
      });
    }

    // Deleted producer
    if (row.producer.deleted) {
      issues.push({
        category: 'deleted_producer',
        rowNumber: row.rowNumber,
        policyNumber: row.fields.policy_number,
        detail: `Producer label "${row.producer.label}" is marked as deleted.`,
      });
    }

    // Unassigned (no producer)
    if (row.producer.normalizedLabel === null && !row.producer.deleted) {
      issues.push({
        category: 'unassigned',
        rowNumber: row.rowNumber,
        policyNumber: row.fields.policy_number,
        detail: 'No producer label — case will be unassigned.',
      });
    }

    // Excluded from reminders
    if (status !== 'Imported') {
      issues.push({
        category: 'excluded_from_reminders',
        rowNumber: row.rowNumber,
        policyNumber: row.fields.policy_number,
        detail: `Status "${status}" — not eligible for automatic reminders.`,
      });
    }
  }

  return {
    eficaciaCaseCount: eficaciaRows.length,
    avisosRowCount: avisosRows.length,
    matchingCases,
    eficaciaOnlyCases,
    avisosOnlyCases,
    activeCases,
    paidRecoveredCases,
    cancelledLostCases,
    reviewRequiredCases,
    missingProducerCount,
    deletedProducerCount,
    multiPolicyCustomers,
    issues,
  };
}
