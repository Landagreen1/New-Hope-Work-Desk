'use client';

// Reconciliation panel for the guided two-file import (REQ-5.4).
//
// Renders the ReconciliationSummary counts and categorized issues after both eficacia and
// avisos files have been uploaded and previewed.

import { AlertTriangle, CheckCircle2, FileText, Users, XCircle } from 'lucide-react';

import { ui } from '../nhwd-shared/ui';
import type { ReconciliationSummary } from './import/reconcile';

export interface CancellationReconciliationPanelProps {
  summary: ReconciliationSummary;
  onProceed: () => void;
  onGoBack: () => void;
}

export default function CancellationReconciliationPanel({
  summary,
  onProceed,
  onGoBack,
}: CancellationReconciliationPanelProps) {
  return (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-slate-900">Import Reconciliation</h3>
      <p className="text-sm text-slate-600">
        Both files have been parsed. Review the reconciliation summary below before proceeding.
      </p>

      {/* Summary counts grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <CountCard label="Eficacia Cases" value={summary.eficaciaCaseCount} icon={FileText} />
        <CountCard label="Avisos Rows" value={summary.avisosRowCount} icon={FileText} />
        <CountCard label="Matching" value={summary.matchingCases} icon={CheckCircle2} tone="success" />
        <CountCard label="Eficacia Only" value={summary.eficaciaOnlyCases} icon={AlertTriangle} tone="warning" />
      </div>

      {/* Status distribution */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <h4 className="mb-2 text-sm font-medium text-slate-700">Status Distribution</h4>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatusBadge label="Active (reminders)" count={summary.activeCases} tone="info" />
          <StatusBadge label="Paid/Recovered" count={summary.paidRecoveredCases} tone="success" />
          <StatusBadge label="Cancelled/Lost" count={summary.cancelledLostCases} tone="danger" />
          <StatusBadge label="Review Required" count={summary.reviewRequiredCases} tone="warning" />
        </div>
      </div>

      {/* Issues summary */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <h4 className="mb-2 text-sm font-medium text-slate-700">Issues to Review</h4>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <IssueRow label="Missing Producer" count={summary.missingProducerCount} />
          <IssueRow label="Deleted Producer" count={summary.deletedProducerCount} />
          <IssueRow label="Multi-Policy Customers" count={summary.multiPolicyCustomers} />
          <IssueRow label="Missing Contacts" count={summary.eficaciaOnlyCases} />
          <IssueRow label="Avisos Only" count={summary.avisosOnlyCases} />
        </div>
      </div>

      {/* Categorized issues detail */}
      {summary.issues.length > 0 ? (
        <details className="rounded-lg border border-slate-200 bg-white">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700">
            {summary.issues.length} issue{summary.issues.length !== 1 ? 's' : ''} found — click to expand
          </summary>
          <div className="max-h-60 overflow-y-auto border-t border-slate-100 px-3 py-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-left text-slate-500">
                  <th className="pb-1 pr-2">Category</th>
                  <th className="pb-1 pr-2">Policy</th>
                  <th className="pb-1">Detail</th>
                </tr>
              </thead>
              <tbody>
                {summary.issues.slice(0, 100).map((issue, i) => (
                  <tr key={i} className="border-b border-slate-50 text-slate-700">
                    <td className="py-1 pr-2 capitalize">{issue.category.replace(/_/g, ' ')}</td>
                    <td className="py-1 pr-2 font-mono">{issue.policyNumber}</td>
                    <td className="py-1 text-slate-500">{issue.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {summary.issues.length > 100 ? (
              <p className="mt-2 text-xs text-slate-500">
                Showing first 100 of {summary.issues.length} issues.
              </p>
            ) : null}
          </div>
        </details>
      ) : null}

      {/* Actions */}
      <div className="flex items-center justify-between gap-3 pt-2">
        <button type="button" className={ui.btnSecondary} onClick={onGoBack}>
          Go Back
        </button>
        <button type="button" className={ui.btnPrimary} onClick={onProceed}>
          Proceed to Import
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentation components
// ---------------------------------------------------------------------------

function CountCard({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string;
  value: number;
  icon: typeof FileText;
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info';
}) {
  const tones: Record<string, string> = {
    neutral: 'border-slate-200 bg-white text-slate-900',
    success: 'border-green-200 bg-green-50 text-green-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-red-200 bg-red-50 text-red-900',
    info: 'border-blue-200 bg-blue-50 text-blue-900',
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 opacity-60" aria-hidden="true" />
        <span className="text-lg font-bold">{value}</span>
      </div>
      <p className="mt-1 text-xs opacity-75">{label}</p>
    </div>
  );
}

function StatusBadge({
  label,
  count,
  tone,
}: {
  label: string;
  count: number;
  tone: 'info' | 'success' | 'danger' | 'warning';
}) {
  const tones: Record<string, string> = {
    info: 'text-blue-700',
    success: 'text-green-700',
    danger: 'text-red-700',
    warning: 'text-amber-700',
  };
  return (
    <div className="flex items-center gap-1.5 text-sm">
      <span className={`font-semibold ${tones[tone]}`}>{count}</span>
      <span className="text-slate-600">{label}</span>
    </div>
  );
}

function IssueRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between rounded border border-slate-100 px-2 py-1 text-sm">
      <span className="text-slate-600">{label}</span>
      <span className={`font-medium ${count > 0 ? 'text-amber-600' : 'text-green-600'}`}>
        {count}
      </span>
    </div>
  );
}
