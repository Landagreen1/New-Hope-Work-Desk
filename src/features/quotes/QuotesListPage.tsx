'use client';

import { AlertCircle, Filter, Link2, RefreshCw, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/client';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { ui } from '../nhwd-shared/ui';
import { changeQuoteStatus, flagQuoteDuplicate, getMyQuotes, getQuoteHistory } from './api';
import DuplicateFlagForm from './DuplicateFlagForm';
import QuoteCard from './QuoteCard';
import QuoteHistory from './QuoteHistory';
import type { OperationalQuote, QuoteHistoryEvent, QuoteStatus } from './types';

interface QuotesListPageProps {
  initialProfile: ProfileLite;
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'All Statuses' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'quoting', label: 'Quoting' },
  { value: 'pricing_sent', label: 'Pricing Sent' },
  { value: 'activation_pending', label: 'Activation Pending' },
  { value: 'activated', label: 'Activated' },
  { value: 'sold', label: 'Sold' },
  { value: 'not_sold', label: 'Not Sold' },
  { value: 'duplicate_review', label: 'Duplicate Review' },
];

export default function QuotesListPage({ initialProfile }: QuotesListPageProps) {
  const router = useRouter();
  const isManager = initialProfile.role === 'manager';

  const [quotes, setQuotes] = useState<OperationalQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Duplicate flag modal state
  const [flaggingQuoteId, setFlaggingQuoteId] = useState<string | null>(null);

  // ─── Data fetching ───────────────────────────────────────────────────────────

  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (isManager) {
        // Manager: fetch all quotes from API route with optional status filter
        const params = new URLSearchParams();
        if (statusFilter) params.set('status', statusFilter);
        const res = await fetch(`/api/quotes?${params.toString()}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Failed to load quotes.');
        }
        const body = await res.json();
        setQuotes(body.quotes as OperationalQuote[]);
      } else {
        // Agent: fetch own quotes
        const data = await getMyQuotes();
        setQuotes(data);
      }
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quotes.');
    } finally {
      setLoading(false);
    }
  }, [isManager, statusFilter]);

  useEffect(() => {
    void fetchQuotes();
  }, [fetchQuotes]);

  // ─── Handlers ────────────────────────────────────────────────────────────────

  const handleStatusChange = async (quoteId: string, newStatus: QuoteStatus) => {
    try {
      await changeQuoteStatus(quoteId, newStatus);
      await fetchQuotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed.');
    }
  };

  const handleFlagDuplicate = (quoteId: string) => {
    setFlaggingQuoteId(quoteId);
  };

  const handleFlagSubmit = async (originalId: string, reason: string) => {
    if (!flaggingQuoteId) return;
    await flagQuoteDuplicate(flaggingQuoteId, originalId, reason);
    setFlaggingQuoteId(null);
    await fetchQuotes();
  };

  const handleOpen = (quoteId: string) => {
    router.push(`/tools/quotes/${quoteId}`);
  };

  // Quote Log modal state
  const [logQuoteId, setLogQuoteId] = useState<string | null>(null);
  const [logEvents, setLogEvents] = useState<QuoteHistoryEvent[]>([]);
  const [logLoading, setLogLoading] = useState(false);

  const handleViewLog = async (quoteId: string) => {
    setLogQuoteId(quoteId);
    setLogLoading(true);
    try {
      const events = await getQuoteHistory(quoteId);
      setLogEvents(events as QuoteHistoryEvent[]);
    } catch {
      setLogEvents([]);
    } finally {
      setLogLoading(false);
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <ModuleShell
      title={isManager ? 'All Quotes' : 'My Desk'}
      subtitle={
        isManager
          ? 'All operational quotes across the team'
          : 'Your assigned quotes and active work'
      }
      role={initialProfile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void fetchQuotes()}
    >
      {/* Manager toolbar: status filter + duplicate review link */}
      {isManager && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Filter className="h-4 w-4 text-slate-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className={ui.select + ' mt-0 w-52'}
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <a
            href="/tools/quotes/duplicate-review"
            className={ui.btnSecondary}
          >
            <Link2 className="h-4 w-4" />
            Duplicate Review Queue
          </a>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className={ui.error + ' mb-4'}>
          <AlertCircle className="mr-2 inline h-4 w-4" />
          {error}
        </div>
      )}

      {/* Loading */}
      {loading && quotes.length === 0 && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-sm font-semibold text-slate-500">Loading quotes...</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && quotes.length === 0 && (
        <div className={ui.empty}>
          {isManager
            ? 'No quotes match the selected filter.'
            : 'No quotes assigned to you yet.'}
        </div>
      )}

      {/* Quote cards */}
      {quotes.length > 0 && (
        <div className="space-y-4">
          {quotes.map((quote) => (
            <QuoteCard
              key={quote.id}
              quote={quote}
              onStatusChange={handleStatusChange}
              onFlagDuplicate={handleFlagDuplicate}
              onOpen={handleOpen}
              onViewLog={(id) => void handleViewLog(id)}
            />
          ))}
        </div>
      )}

      {/* Duplicate flag modal */}
      {flaggingQuoteId && (
        <DuplicateFlagForm
          quoteId={flaggingQuoteId}
          onSubmit={handleFlagSubmit}
          onCancel={() => setFlaggingQuoteId(null)}
        />
      )}

      {/* Quote Log modal */}
      {logQuoteId && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={() => { setLogQuoteId(null); setLogEvents([]); }}>
          <div className="mx-auto max-w-6xl rounded-[30px] bg-[#f3f5f9] p-3 shadow-2xl sm:p-5" onMouseDown={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-black text-slate-900">Quote Activity</h2>
                <p className="mt-1 text-sm font-semibold text-slate-500">Read-only timeline of all events for this quote.</p>
              </div>
              <button className={ui.btnGhost} onClick={() => { setLogQuoteId(null); setLogEvents([]); }}><X className="h-4 w-4" />Close</button>
            </div>
            {logLoading ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
                <span className="ml-2 text-sm font-semibold text-slate-500">Loading history...</span>
              </div>
            ) : (
              <QuoteHistory quoteId={logQuoteId} events={logEvents} />
            )}
          </div>
        </div>
      )}
    </ModuleShell>
  );
}
