'use client';

// src/app/tools/quotes/duplicate-review/[id]/page.tsx
// Duplicate review detail page — fetches both quotes and renders the
// DuplicateReviewScreen component for Manager decision.

import { use, useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { ui } from '@/features/nhwd-shared/ui';
import DuplicateReviewScreen from '@/features/quotes/DuplicateReviewScreen';
import {
  getDuplicateReviewDetail,
  getQuoteDetail,
  resolveDuplicate,
  getPendingDuplicateReviews,
} from '@/features/quotes/api';
import type {
  DuplicateDecision,
  DuplicateReview,
  OperationalQuote,
} from '@/features/quotes/types';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function DuplicateReviewPage({ params }: PageProps) {
  const { id } = use(params);
  const router = useRouter();

  const [review, setReview] = useState<DuplicateReview | null>(null);
  const [flaggedQuote, setFlaggedQuote] = useState<OperationalQuote | null>(null);
  const [originalQuote, setOriginalQuote] = useState<OperationalQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  // Fetch the review detail and both quotes
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const reviewData = await getDuplicateReviewDetail(id);
      if (!reviewData) {
        setError('Duplicate review not found.');
        return;
      }

      setReview(reviewData);

      const [flagged, original] = await Promise.all([
        getQuoteDetail(reviewData.flagged_quote_id),
        getQuoteDetail(reviewData.original_quote_id),
      ]);

      if (!flagged || !original) {
        setError('One or both quote records could not be loaded.');
        return;
      }

      setFlaggedQuote(flagged);
      setOriginalQuote(original);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load duplicate review.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  // Handle decision from DuplicateReviewScreen
  const handleDecision = useCallback(
    async (decision: DuplicateDecision, fieldSelections?: Record<string, string>) => {
      if (!review) return;
      const result = await resolveDuplicate(review.id, decision, fieldSelections);
      if (result.error) {
        throw new Error(result.error);
      }
      setResolved(true);

      // After resolution, navigate to next pending review or back to quotes list
      const pending = await getPendingDuplicateReviews();
      if (pending.length > 0) {
        router.push(`/tools/quotes/duplicate-review/${pending[0].id}`);
      } else {
        router.push('/tools/quotes');
      }
    },
    [review, router],
  );

  // Loading state
  if (loading) {
    return (
      <main className={ui.page}>
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[#223f7a]" />
            <p className="text-sm font-bold text-slate-500">Loading duplicate review...</p>
          </div>
        </div>
      </main>
    );
  }

  // Error state
  if (error) {
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

  // Resolved state (brief transition before navigation)
  if (resolved) {
    return (
      <main className={ui.page}>
        <div className="flex min-h-[400px] items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin text-[#223f7a]" />
            <p className="text-sm font-bold text-slate-500">
              Resolution saved. Loading next review...
            </p>
          </div>
        </div>
      </main>
    );
  }

  // Missing data guard
  if (!review || !flaggedQuote || !originalQuote) {
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
          <div className={ui.empty}>Duplicate review data is unavailable.</div>
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
          onClick={() => router.push('/tools/quotes')}
          className={ui.btnGhost}
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Quotes
        </button>
        <h1 className={ui.pageTitle}>Duplicate Review</h1>
      </div>

      {/* DuplicateReviewScreen with both quotes */}
      <DuplicateReviewScreen
        review={review}
        flaggedQuote={flaggedQuote}
        originalQuote={originalQuote}
        onDecision={handleDecision}
      />
    </main>
  );
}
