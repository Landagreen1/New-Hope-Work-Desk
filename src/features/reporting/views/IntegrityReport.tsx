'use client';

/**
 * View 4 — Review & Integrity.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 14.9, 15.1-15.8, 19.2, 19.4
 *
 * An objective review queue. Every item shows the data that produced it, and the wording
 * throughout has to survive being read by the employee it concerns: these are
 * discrepancies to investigate, not accusations.
 *
 * Explained and Confirmed Data Issue require an explanation. Reopening keeps the earlier
 * explanation and appends to an append-only history, so a discrepancy that was explained
 * once stays explained the next time detection runs.
 */

import { useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import { REVIEW_SAVED_FILTERS, reviewActionRequiresExplanation } from '../definitions';
import { formatCount, formatDate, reviewStatusTone, severityTone } from '../derive';
import type { IntegrityFlagRow, ReviewAction } from '../types';

const ACTIONS: ReadonlyArray<{ action: ReviewAction; label: string; tone: string }> = [
  { action: 'Explained', label: 'Mark Explained', tone: ui.btnSecondary },
  { action: 'Confirmed Data Issue', label: 'Confirm Data Issue', tone: ui.btnDanger },
  { action: 'Dismissed', label: 'Dismiss', tone: ui.btnGhost },
];

function EvidenceList({ evidence }: { evidence: Record<string, unknown> }) {
  const entries = Object.entries(evidence ?? {});
  if (entries.length === 0) {
    return (
      <p className="text-xs font-semibold text-slate-400">
        No supporting data was recorded with this flag.
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {entries.map(([key, value]) => (
        <div key={key} className="min-w-0">
          <dt className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
            {key.replace(/_/g, ' ')}
          </dt>
          <dd className="mt-0.5 truncate text-xs font-bold text-slate-800">
            {value === null || value === undefined
              ? '—'
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FlagCard({
  row,
  canReview,
  onReview,
  onOpenQuoteLog,
}: {
  row: IntegrityFlagRow;
  canReview: boolean;
  onReview: (flagId: string, action: ReviewAction, explanation: string) => Promise<void>;
  onOpenQuoteLog?: (sourceWorkItemId: string) => void;
}) {
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  async function submit(action: ReviewAction) {
    if (reviewActionRequiresExplanation(action) && explanation.trim().length === 0) {
      setError(`${action} requires an explanation.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onReview(row.id, action, explanation.trim());
      setExplanation('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to record that decision.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`${ui.badge} ${ui.badgeTone[severityTone(row.severity)]}`}>
              {row.severity}
            </span>
            <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>{row.flag_type}</span>
            <span className={`${ui.badge} ${ui.badgeTone[reviewStatusTone(row.review_status)]}`}>
              {row.review_status}
            </span>
            <span className="text-[11px] font-bold text-slate-400">
              detected {formatDate(row.detected_on)}
            </span>
          </div>
          <p className="mt-2 text-sm font-black text-slate-950">{row.explanation}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            {row.subject_kind === 'system'
              ? 'Applies to the whole period rather than one record'
              : `${row.subject_label ?? 'Unknown record'}${
                  row.subject_agent_name !== null ? ` · ${row.subject_agent_name}` : ''
                }`}
          </p>
        </div>
        {row.subject_kind === 'quote' && onOpenQuoteLog !== undefined ? (
          <button
            type="button"
            onClick={() => onOpenQuoteLog(row.subject_id)}
            className="shrink-0 rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-1.5 text-xs font-black text-[#223f7a] hover:bg-[#e7eef9]"
          >
            Log
          </button>
        ) : null}
      </div>

      <div className="mt-3 rounded-2xl bg-slate-50 p-3">
        <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
          Supporting data
        </p>
        <div className="mt-2">
          <EvidenceList evidence={row.evidence} />
        </div>
      </div>

      {row.manager_explanation !== null && row.manager_explanation.length > 0 ? (
        <div className={`${ui.info} mt-3`}>
          <span className="font-black">Management explanation: </span>
          {row.manager_explanation}
          {row.reviewer_name !== null ? (
            <span className="mt-1 block text-[11px] font-bold text-blue-700">
              {row.reviewer_name}
              {row.reviewed_at !== null ? ` · ${formatDate(row.reviewed_at)}` : ''}
              {row.review_count > 1 ? ` · ${row.review_count} review entries` : ''}
            </span>
          ) : null}
        </div>
      ) : null}

      {canReview ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          {!expanded ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="text-xs font-black text-[#223f7a] hover:underline"
            >
              {row.review_status === 'Open' ? 'Record a decision' : 'Change the decision'}
            </button>
          ) : (
            <div className="space-y-3">
              <label className="block">
                <span className={ui.label}>Explanation</span>
                <textarea
                  value={explanation}
                  onChange={(event) => setExplanation(event.target.value)}
                  rows={3}
                  className={ui.textarea}
                  placeholder="What did you find when you looked into this?"
                />
                <span className="mt-1 block text-[11px] font-semibold text-slate-400">
                  Required for Explained and Confirm Data Issue. Kept permanently in the
                  review history.
                </span>
              </label>
              {error !== null ? <p className={ui.error}>{error}</p> : null}
              <div className="flex flex-wrap gap-2">
                {ACTIONS.map((entry) => (
                  <button
                    key={entry.action}
                    type="button"
                    disabled={busy}
                    onClick={() => void submit(entry.action)}
                    className={entry.tone}
                  >
                    {entry.label}
                  </button>
                ))}
                {row.review_status !== 'Open' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void submit('Reopened')}
                    className={ui.btnSecondary}
                  >
                    Reopen
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => {
                    setExpanded(false);
                    setError(null);
                  }}
                  className={ui.btnGhost}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

export function IntegrityReport({
  rows,
  totalCount,
  savedFilter,
  onSavedFilterChange,
  page,
  pageSize,
  onPageChange,
  canReview,
  onReview,
  onRunDetection,
  detectionBusy,
  onOpenQuoteLog,
}: {
  rows: IntegrityFlagRow[];
  totalCount: number;
  savedFilter: string;
  onSavedFilterChange: (filter: string) => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  canReview: boolean;
  onReview: (flagId: string, action: ReviewAction, explanation: string) => Promise<void>;
  onRunDetection: () => Promise<void>;
  detectionBusy: boolean;
  onOpenQuoteLog?: (sourceWorkItemId: string) => void;
}) {
  const lastPage = Math.max(1, Math.ceil(totalCount / pageSize));

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <p className={ui.sectionTitle}>Review &amp; Integrity</p>
          <h3 className="mt-1 text-xl font-black text-slate-950">
            Discrepancies to investigate
          </h3>
          <p className="mt-1 max-w-3xl text-sm font-semibold text-slate-500">
            These are inconsistencies in the record, not conclusions about anybody. Each
            item shows the data that produced it so it can be checked, explained, or
            confirmed as a data problem.
          </p>
        </div>
        {canReview ? (
          <button
            type="button"
            onClick={() => void onRunDetection()}
            disabled={detectionBusy}
            className={ui.btnSecondary}
          >
            {detectionBusy ? 'Scanning…' : 'Re-scan this period'}
          </button>
        ) : null}
      </div>

      <div className="border-b border-slate-100 px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {REVIEW_SAVED_FILTERS.map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => onSavedFilterChange(filter)}
              className={`rounded-xl px-3 py-2 text-xs font-black transition ${
                savedFilter === filter
                  ? 'bg-[#223f7a] text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              aria-pressed={savedFilter === filter}
            >
              {filter}
            </button>
          ))}
        </div>
      </div>

      <div className={ui.cardPad}>
        {rows.length === 0 ? (
          <p className={ui.empty}>
            Nothing matches {savedFilter}. If this is the first time the report has been
            opened, run a scan to look for discrepancies.
          </p>
        ) : (
          <ul className="space-y-3">
            {rows.map((row) => (
              <FlagCard
                key={row.id}
                row={row}
                canReview={canReview}
                onReview={onReview}
                onOpenQuoteLog={onOpenQuoteLog}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3">
        <p className="text-xs font-bold text-slate-500">
          {totalCount === 0
            ? 'No matching flags'
            : `${formatCount(totalCount)} flag${totalCount === 1 ? '' : 's'} match ${savedFilter}`}
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            className={ui.btnSecondary}
          >
            Previous
          </button>
          <span className="text-xs font-black text-slate-500">
            {page} / {lastPage}
          </span>
          <button
            type="button"
            disabled={page >= lastPage}
            onClick={() => onPageChange(page + 1)}
            className={ui.btnSecondary}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
