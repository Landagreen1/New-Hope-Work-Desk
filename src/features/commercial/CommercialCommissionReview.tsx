'use client';

import {
  AlertCircle,
  Ban,
  CheckCircle2,
  DollarSign,
  RefreshCw,
  Shield,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import type { CommercialQuote } from './types';
import { BOARD_COLUMNS, COMMISSION_STATUS_STYLES, COVERAGE_LABELS, RISK_STYLES } from './types';

interface CommercialCommissionReviewProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

export default function CommercialCommissionReview({ initialProfile, embedded = false }: CommercialCommissionReviewProps) {
  const [quotes, setQuotes] = useState<CommercialQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Decision modal state
  const [reviewingQuote, setReviewingQuote] = useState<CommercialQuote | null>(null);
  const [decision, setDecision] = useState<'approved' | 'denied' | ''>('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isManager = initialProfile.role === 'manager';

  // ─── Fetch cards in 'sold' column (pending commission review) ────────────────
  const fetchPendingQuotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/commercial-quotes?board_column=sold');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load sold quotes.');
      }
      const body = await res.json();
      setQuotes(body.quotes as CommercialQuote[]);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPendingQuotes();
  }, [fetchPendingQuotes]);

  // ─── Submit commission decision ──────────────────────────────────────────────
  const submitDecision = async () => {
    if (!reviewingQuote || !decision) return;
    if (decision === 'denied' && !reason.trim()) {
      setError('A denial reason is required.');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/commercial-quotes/${reviewingQuote.id}/commission`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reason: reason.trim(),
          notes: notes.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Commission decision failed.');
      }
      setReviewingQuote(null);
      setDecision('');
      setReason('');
      setNotes('');
      await fetchPendingQuotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // ─── Format helpers ─────────────────────────────────────────────────────────
  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function getRelativeTime(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const days = Math.floor(diff / 86400000);
    if (days < 1) return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 7) return `${days} days ago`;
    const weeks = Math.floor(days / 7);
    if (weeks === 1) return '1 week ago';
    return `${weeks} weeks ago`;
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
            Commission Management
          </p>
          <h2 className={ui.pageTitle}>Commission Review</h2>
          <p className={ui.pageSubtitle}>
            {isManager
              ? 'Review sold quotes and approve or deny agent commissions.'
              : 'Track your commission status on sold policies.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {lastUpdated && (
            <p className="text-xs font-bold text-slate-400">
              {quotes.length} pending review
            </p>
          )}
          <button type="button" onClick={() => void fetchPendingQuotes()} className={ui.btnSecondary}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className={ui.error + ' mb-4'}>
          <AlertCircle className="mr-2 inline h-4 w-4" />
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-3 text-xs font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Loading */}
      {loading && quotes.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-sm font-semibold text-slate-500">Loading...</span>
        </div>
      ) : quotes.length === 0 ? (
        <div className={ui.empty}>
          <Shield className="mx-auto h-8 w-8 text-slate-300 mb-3" />
          No sold quotes pending commission review.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quotes.map((quote) => {
            const riskStyle = RISK_STYLES[quote.risk_level];
            const commStyle = quote.commission_status
              ? COMMISSION_STATUS_STYLES[quote.commission_status]
              : null;

            return (
              <div
                key={quote.id}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-[#7890bc] hover:shadow-md"
              >
                {/* Agent label */}
                <div className="mb-3 flex items-center justify-between">
                  <span className="rounded-lg bg-[#223f7a] px-2.5 py-1 text-[10px] font-black text-white">
                    {quote.profiles?.display_name?.split(' ')[0] ?? 'Agent'}
                  </span>
                  {commStyle && (
                    <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${commStyle.bg} ${commStyle.text}`}>
                      {commStyle.label}
                    </span>
                  )}
                </div>

                {/* Business name */}
                <h3 className="text-base font-black text-slate-900">{quote.business_name}</h3>

                {/* Details grid */}
                <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <span className="font-bold text-slate-400">Coverage</span>
                    <p className="font-bold text-slate-700">
                      {quote.coverage_type ? COVERAGE_LABELS[quote.coverage_type] : '—'}
                    </p>
                  </div>
                  <div>
                    <span className="font-bold text-slate-400">Risk</span>
                    <p className={`font-bold ${riskStyle.text}`}>{riskStyle.label}</p>
                  </div>
                  <div>
                    <span className="font-bold text-slate-400">Policy #</span>
                    <p className="font-bold text-slate-700">{quote.policy_number || '—'}</p>
                  </div>
                  <div>
                    <span className="font-bold text-slate-400">Sold</span>
                    <p className="font-bold text-slate-700">
                      {quote.sold_at ? formatDate(quote.sold_at) : getRelativeTime(quote.column_entered_at)}
                    </p>
                  </div>
                  {quote.sold_premium && (
                    <div className="col-span-2">
                      <span className="font-bold text-slate-400">Premium</span>
                      <p className="text-sm font-black text-emerald-700">
                        ${quote.sold_premium.toLocaleString()}
                      </p>
                    </div>
                  )}
                </div>

                {/* Commission denial reason (visible to agents) */}
                {quote.commission_status === 'denied' && quote.commission_denial_reason && (
                  <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-rose-600">
                      Denial Reason
                    </p>
                    <p className="mt-1 text-xs font-medium text-rose-800">
                      {quote.commission_denial_reason}
                    </p>
                  </div>
                )}

                {/* Commission notes */}
                {quote.commission_notes && (
                  <div className="mt-2 rounded-xl border border-slate-100 bg-slate-50 p-3">
                    <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Notes</p>
                    <p className="mt-1 text-xs font-medium text-slate-700">{quote.commission_notes}</p>
                  </div>
                )}

                {/* Manager action buttons */}
                {isManager && (!quote.commission_status || quote.commission_status === 'pending') && (
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setReviewingQuote(quote); setDecision('approved'); }}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-xs font-black text-emerald-700 transition hover:bg-emerald-100"
                    >
                      <ThumbsUp className="h-3.5 w-3.5" />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => { setReviewingQuote(quote); setDecision('denied'); }}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-50 border border-rose-200 px-3 py-2.5 text-xs font-black text-rose-700 transition hover:bg-rose-100"
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                      Deny
                    </button>
                  </div>
                )}

                {/* Already decided badge */}
                {quote.commission_status === 'approved' && (
                  <div className="mt-4 flex items-center gap-2 text-xs font-bold text-emerald-700">
                    <CheckCircle2 className="h-4 w-4" />
                    Commission Approved
                  </div>
                )}
                {quote.commission_status === 'denied' && (
                  <div className="mt-4 flex items-center gap-2 text-xs font-bold text-rose-700">
                    <Ban className="h-4 w-4" />
                    Commission Denied
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Decision Modal */}
      {reviewingQuote && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) { setReviewingQuote(null); setDecision(''); setReason(''); setNotes(''); } }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="mb-5 flex items-center gap-3">
              {decision === 'approved' ? (
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-100">
                  <ThumbsUp className="h-5 w-5 text-emerald-700" />
                </div>
              ) : (
                <div className="grid h-10 w-10 place-items-center rounded-xl bg-rose-100">
                  <ThumbsDown className="h-5 w-5 text-rose-700" />
                </div>
              )}
              <div>
                <h3 className="text-lg font-black text-slate-900">
                  {decision === 'approved' ? 'Approve Commission' : 'Deny Commission'}
                </h3>
                <p className="text-xs font-semibold text-slate-500">
                  {reviewingQuote.business_name}
                </p>
              </div>
            </div>

            {/* Premium display */}
            {reviewingQuote.sold_premium && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
                <DollarSign className="h-4 w-4 text-emerald-600" />
                <span className="text-sm font-black text-emerald-800">
                  Premium: ${reviewingQuote.sold_premium.toLocaleString()}
                </span>
              </div>
            )}

            {/* Reason (required for denial) */}
            {decision === 'denied' && (
              <div className="mb-4">
                <label className={ui.label}>
                  Denial Reason <span className="text-rose-500">*</span>
                </label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Explain why the commission is being denied (visible to agent)..."
                  className={ui.textarea}
                  rows={3}
                  required
                />
                <p className="mt-1 text-[10px] font-semibold text-slate-400">
                  This reason will be visible to the agent on their card.
                </p>
              </div>
            )}

            {/* Notes (optional for both) */}
            <div className="mb-5">
              <label className={ui.label}>Notes (optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Internal notes about this decision..."
                className={ui.textarea}
                rows={2}
              />
            </div>

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void submitDecision()}
                disabled={submitting || (decision === 'denied' && !reason.trim())}
                className={decision === 'approved' ? ui.btnPrimary : ui.btnDanger}
              >
                {submitting
                  ? 'Processing...'
                  : decision === 'approved'
                    ? 'Confirm Approval'
                    : 'Confirm Denial'}
              </button>
              <button
                type="button"
                onClick={() => { setReviewingQuote(null); setDecision(''); setReason(''); setNotes(''); }}
                className={ui.btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
