'use client';

// src/app/tools/quotes/[id]/page.tsx
// Quote detail page — fetches and displays QuoteCard, QuoteHistory, and
// supports status change actions and duplicate flag modal.

import { use, useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { ui } from '@/features/nhwd-shared/ui';
import QuoteCard from '@/features/quotes/QuoteCard';
import QuoteHistory from '@/features/quotes/QuoteHistory';
import DuplicateFlagForm from '@/features/quotes/DuplicateFlagForm';
import {
  getQuoteDetail,
  getQuoteHistory,
  changeQuoteStatus,
  flagQuoteDuplicate,
} from '@/features/quotes/api';
import type { OperationalQuote, QuoteHistoryEvent, QuoteStatus } from '@/features/quotes/types';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function QuoteDetailPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();

  const [quote, setQuote] = useState<OperationalQuote | null>(null);
  const [events, setEvents] = useState<QuoteHistoryEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDuplicateForm, setShowDuplicateForm] = useState(false);

  // Fetch quote detail and history
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [quoteData, historyData] = await Promise.all([
        getQuoteDetail(id),
        getQuoteHistory(id),
      ]);

      if (!quoteData) {
        setError('Quote not found.');
        setQuote(null);
        setEvents([]);
        return;
      }

      setQuote(quoteData);
      setEvents(historyData as QuoteHistoryEvent[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quote details.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Handle status change via QuoteCard actions
  const handleStatusChange = async (quoteId: string, newStatus: QuoteStatus) => {
    try {
      await changeQuoteStatus(quoteId, newStatus);
      await fetchData(); // Refresh after status change
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Status change failed.');
    }
  };

  // Handle "Mark as Possible Duplicate" button click
  const handleFlagDuplicate = (_quoteId: string) => {
    setShowDuplicateForm(true);
  };

  // Handle duplicate flag submission
  const handleDuplicateSubmit = async (originalId: string, reason: string) => {
    await flagQuoteDuplicate(id, originalId, reason);
    setShowDuplicateForm(false);
    await fetchData(); // Refresh to show new status
  };

  // Handle "Open" button — already on this page, no-op
  const handleOpen = (_quoteId: string) => {
    // Already viewing detail — no navigation needed
  };

  // Loading state
  if (loading) {
    return (
      <main className={ui.page}>
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[#223f7a]" />
            <p className="text-sm font-bold text-slate-500">Loading quote details...</p>
          </div>
        </div>
      </main>
    );
  }

  // Error state
  if (error && !quote) {
    return (
      <main className={ui.page}>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => router.back()}
            className={ui.btnGhost}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className={ui.error}>{error}</div>
        </div>
      </main>
    );
  }

  if (!quote) {
    return (
      <main className={ui.page}>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => router.back()}
            className={ui.btnGhost}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </button>
          <div className={ui.empty}>Quote not found.</div>
        </div>
      </main>
    );
  }

  return (
    <main className={ui.page}>
      {/* Navigation */}
      <div className="mb-6 flex items-center gap-4">
        <button
          type="button"
          onClick={() => router.back()}
          className={ui.btnGhost}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <h1 className={ui.pageTitle}>{quote.customer_name}</h1>
      </div>

      {/* Inline error banner (for action failures) */}
      {error && (
        <div className={`${ui.error} mb-4`}>{error}</div>
      )}

      {/* Quote Card — expanded with full details and actions */}
      <div className="mb-6">
        <QuoteCard
          quote={quote}
          onStatusChange={handleStatusChange}
          onFlagDuplicate={handleFlagDuplicate}
          onOpen={handleOpen}
        />
      </div>

      {/* Quote History timeline with IntakeNoteLog */}
      <div className={`${ui.card} ${ui.cardPad}`}>
        <h2 className={`${ui.sectionTitle} mb-4`}>Quote History</h2>
        <QuoteHistory quoteId={id} events={events} />
      </div>

      {/* Duplicate Flag Modal */}
      {showDuplicateForm && (
        <DuplicateFlagForm
          quoteId={id}
          onSubmit={handleDuplicateSubmit}
          onCancel={() => setShowDuplicateForm(false)}
        />
      )}
    </main>
  );
}
