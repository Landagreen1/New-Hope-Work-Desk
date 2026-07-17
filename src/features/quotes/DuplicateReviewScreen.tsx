'use client';

import { useState, useMemo, useCallback } from 'react';
import { AlertTriangle, Check, GitMerge, Link2, X } from 'lucide-react';

import { statusLabel, ui } from '../nhwd-shared/ui';
import type { DuplicateDecision, DuplicateReview, OperationalQuote } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DuplicateReviewScreenProps {
  review: DuplicateReview;
  flaggedQuote: OperationalQuote;
  originalQuote: OperationalQuote;
  onDecision: (decision: DuplicateDecision, fieldSelections?: Record<string, string>) => Promise<void>;
}

/** Fields displayed for side-by-side comparison */
const COMPARISON_FIELDS: { key: keyof OperationalQuote; label: string }[] = [
  { key: 'customer_name', label: 'Customer Name' },
  { key: 'source_type', label: 'Source Type' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'line_of_business', label: 'Line of Business' },
  { key: 'dealer_id', label: 'Dealer ID' },
  { key: 'dealer_salesperson_id', label: 'Dealer Salesperson' },
  { key: 'quote_origin', label: 'Quote Origin' },
  { key: 'status', label: 'Status' },
  { key: 'assignment_method', label: 'Assignment Method' },
  { key: 'assigned_to', label: 'Assigned To' },
  { key: 'intake_creator', label: 'Intake Creator' },
];

type MergeSelections = Record<string, 'flagged' | 'original'>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function displayValue(val: unknown): string {
  if (val === null || val === undefined || val === '') return '—';
  if (typeof val === 'string') return statusLabel(val);
  return String(val);
}

function formatDateTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DuplicateReviewScreen({
  review,
  flaggedQuote,
  originalQuote,
  onDecision,
}: DuplicateReviewScreenProps) {
  const [mode, setMode] = useState<'review' | 'merge'>('review');
  const [mergeSelections, setMergeSelections] = useState<MergeSelections>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Identify differing fields
  const diffs = useMemo(() => {
    const diffSet = new Set<string>();
    for (const { key } of COMPARISON_FIELDS) {
      const fVal = flaggedQuote[key] ?? '';
      const oVal = originalQuote[key] ?? '';
      if (String(fVal).toLowerCase() !== String(oVal).toLowerCase()) {
        diffSet.add(key);
      }
    }
    return diffSet;
  }, [flaggedQuote, originalQuote]);

  // Fields that differ (used for merge mode)
  const conflictFields = useMemo(
    () => COMPARISON_FIELDS.filter(({ key }) => diffs.has(key)),
    [diffs],
  );

  // Merge readiness: all conflicts must be resolved
  const mergeReady = useMemo(
    () => conflictFields.every(({ key }) => mergeSelections[key] !== undefined),
    [conflictFields, mergeSelections],
  );

  // Action handlers
  const handleDecision = useCallback(
    async (decision: DuplicateDecision, fieldSelections?: Record<string, string>) => {
      setBusy(true);
      setError(null);
      try {
        await onDecision(decision, fieldSelections);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred while processing the decision.');
      } finally {
        setBusy(false);
      }
    },
    [onDecision],
  );

  const handleMergeSubmit = useCallback(async () => {
    if (!mergeReady) return;
    // Build field selections: key → actual value from the chosen side
    const fieldSelections: Record<string, string> = {};
    for (const { key } of conflictFields) {
      const side = mergeSelections[key];
      fieldSelections[key] = String(
        side === 'flagged' ? (flaggedQuote[key] ?? '') : (originalQuote[key] ?? ''),
      );
    }
    await handleDecision('merge', fieldSelections);
  }, [mergeReady, conflictFields, mergeSelections, flaggedQuote, originalQuote, handleDecision]);

  const handleCancelMerge = useCallback(() => {
    setMergeSelections({});
    setMode('review');
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header: Flagging info */}
      <div className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-600" />
            <span className="text-sm font-black text-slate-900">Duplicate Flag</span>
          </div>
          <div className="text-sm font-semibold text-slate-600">
            <span className="font-bold text-slate-800">Flagged by:</span>{' '}
            {review.flagged_by}
          </div>
          <div className="text-sm font-semibold text-slate-600">
            <span className="font-bold text-slate-800">Date:</span>{' '}
            {formatDateTime(review.flagged_at)}
          </div>
        </div>
        <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <p className="text-xs font-black uppercase tracking-wider text-amber-700">Reason</p>
          <p className="mt-1 text-sm font-semibold text-amber-900">{review.reason}</p>
        </div>
      </div>

      {/* Error display */}
      {error && <div className={ui.error}>{error}</div>}

      {/* Side-by-side comparison */}
      <div className={`${ui.card} overflow-hidden`}>
        <div className="grid grid-cols-[1fr_1fr] border-b border-slate-200">
          <div className="border-r border-slate-200 bg-slate-50 px-5 py-3">
            <p className="text-xs font-black uppercase tracking-wider text-slate-500">
              Flagged Quote
            </p>
            <p className="mt-0.5 truncate text-sm font-bold text-slate-800">
              {flaggedQuote.customer_name}
            </p>
          </div>
          <div className="bg-slate-50 px-5 py-3">
            <p className="text-xs font-black uppercase tracking-wider text-slate-500">
              Original Quote
            </p>
            <p className="mt-0.5 truncate text-sm font-bold text-slate-800">
              {originalQuote.customer_name}
            </p>
          </div>
        </div>

        {/* Field rows */}
        <div className="divide-y divide-slate-100">
          {COMPARISON_FIELDS.map(({ key, label }) => {
            const isDiff = diffs.has(key);
            const flaggedVal = displayValue(flaggedQuote[key]);
            const originalVal = displayValue(originalQuote[key]);

            return (
              <div
                key={key}
                className={`grid grid-cols-[1fr_1fr] ${isDiff ? 'bg-amber-50/60' : ''}`}
              >
                {/* Flagged column */}
                <div className="border-r border-slate-100 px-5 py-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                    {label}
                  </p>
                  <p
                    className={`mt-0.5 text-sm font-semibold ${
                      isDiff ? 'font-bold text-amber-900' : 'text-slate-700'
                    }`}
                  >
                    {flaggedVal}
                  </p>
                </div>
                {/* Original column */}
                <div className="px-5 py-3">
                  <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                    {label}
                  </p>
                  <p
                    className={`mt-0.5 text-sm font-semibold ${
                      isDiff ? 'font-bold text-amber-900' : 'text-slate-700'
                    }`}
                  >
                    {originalVal}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Merge mode: field-by-field conflict resolution */}
      {mode === 'merge' && (
        <div className={`${ui.card} overflow-hidden`}>
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-4">
            <p className="text-sm font-black text-slate-900">
              Resolve Conflicting Fields
            </p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Select which value to keep for each differing field. All conflicts must be resolved before merging.
            </p>
          </div>

          {conflictFields.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm font-semibold text-slate-500">
              No conflicting fields — records can be merged directly.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {conflictFields.map(({ key, label }) => {
                const flaggedVal = displayValue(flaggedQuote[key]);
                const originalVal = displayValue(originalQuote[key]);
                const selected = mergeSelections[key];

                return (
                  <div key={key} className="px-5 py-4">
                    <p className="text-xs font-black uppercase tracking-wider text-slate-500">
                      {label}
                    </p>
                    <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                      {/* Flagged option */}
                      <label
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                          selected === 'flagged'
                            ? 'border-[#223f7a] bg-[#f3f6fb] ring-2 ring-[#223f7a]/20'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`merge-${key}`}
                          checked={selected === 'flagged'}
                          onChange={() =>
                            setMergeSelections((prev) => ({ ...prev, [key]: 'flagged' }))
                          }
                          className="h-4 w-4 accent-[#223f7a]"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-bold uppercase text-slate-400">Flagged</p>
                          <p className="truncate text-sm font-bold text-slate-800">{flaggedVal}</p>
                        </div>
                      </label>

                      {/* Original option */}
                      <label
                        className={`flex cursor-pointer items-center gap-3 rounded-xl border px-4 py-3 transition ${
                          selected === 'original'
                            ? 'border-[#223f7a] bg-[#f3f6fb] ring-2 ring-[#223f7a]/20'
                            : 'border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name={`merge-${key}`}
                          checked={selected === 'original'}
                          onChange={() =>
                            setMergeSelections((prev) => ({ ...prev, [key]: 'original' }))
                          }
                          className="h-4 w-4 accent-[#223f7a]"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-[10px] font-bold uppercase text-slate-400">Original</p>
                          <p className="truncate text-sm font-bold text-slate-800">{originalVal}</p>
                        </div>
                      </label>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Merge actions */}
          <div className="flex items-center justify-end gap-3 border-t border-slate-200 px-5 py-4">
            <button
              type="button"
              className={ui.btnSecondary}
              onClick={handleCancelMerge}
              disabled={busy}
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={!mergeReady || busy}
              onClick={() => void handleMergeSubmit()}
            >
              <GitMerge className="h-4 w-4" />
              {busy ? 'Merging…' : 'Confirm Merge'}
            </button>
          </div>
        </div>
      )}

      {/* Action buttons (shown only in review mode) */}
      {mode === 'review' && (
        <div className={`${ui.card} ${ui.cardPad}`}>
          <p className="mb-4 text-xs font-black uppercase tracking-wider text-slate-500">
            Resolution Actions
          </p>
          <div className="flex flex-wrap gap-3">
            {/* Not a Duplicate */}
            <button
              type="button"
              className={ui.btnSecondary}
              disabled={busy}
              onClick={() => void handleDecision('not_duplicate')}
            >
              <Check className="h-4 w-4" />
              {busy ? 'Processing…' : 'Not a Duplicate'}
            </button>

            {/* Merge Records — switches to merge mode */}
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={busy}
              onClick={() => setMode('merge')}
            >
              <GitMerge className="h-4 w-4" />
              Merge Records
            </button>

            {/* Keep Both but Link */}
            <button
              type="button"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-2.5 text-sm font-black text-violet-800 transition hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={busy}
              onClick={() => void handleDecision('keep_both_link')}
            >
              <Link2 className="h-4 w-4" />
              {busy ? 'Processing…' : 'Keep Both but Link'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
