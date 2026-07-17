'use client';

import { Search, X, CheckCircle, AlertCircle } from 'lucide-react';
import { useState, useCallback, useRef, useEffect } from 'react';

import { getSupabase } from '../nhwd-shared/client';
import { statusLabel, ui } from '../nhwd-shared/ui';
import type { OperationalQuote, QuoteStatus } from './types';

export interface DuplicateFlagFormProps {
  quoteId: string;
  onSubmit: (originalId: string, reason: string) => Promise<void>;
  onCancel: () => void;
}

interface SearchResult {
  id: string;
  customer_name: string;
  status: QuoteStatus;
  source_type: string;
  line_of_business: string;
}

const MIN_REASON = 10;
const MAX_REASON = 500;

export default function DuplicateFlagForm({ quoteId, onSubmit, onCancel }: DuplicateFlagFormProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedOriginal, setSelectedOriginal] = useState<SearchResult | null>(null);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reasonLen = reason.length;
  const reasonValid = reasonLen >= MIN_REASON && reasonLen <= MAX_REASON;
  const canSubmit = selectedOriginal !== null && reasonValid && !isSubmitting;

  // Debounced search
  const performSearch = useCallback(
    async (query: string) => {
      if (query.trim().length < 2) {
        setSearchResults([]);
        return;
      }

      setIsSearching(true);
      try {
        const supabase = getSupabase();
        const { data, error: searchError } = await supabase
          .from('operational_quotes')
          .select('id, customer_name, status, source_type, line_of_business')
          .ilike('customer_name', `%${query.trim()}%`)
          .neq('id', quoteId) // Cannot select self
          .not('status', 'in', '(merged_duplicate)')
          .order('customer_name', { ascending: true })
          .limit(10);

        if (searchError) {
          setError(searchError.message);
        } else {
          setSearchResults((data ?? []) as SearchResult[]);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Search failed.');
      } finally {
        setIsSearching(false);
      }
    },
    [quoteId],
  );

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    setError(null);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      void performSearch(value);
    }, 300);
  };

  // Clean up debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleSelectOriginal = (result: SearchResult) => {
    setSelectedOriginal(result);
    setSearchQuery('');
    setSearchResults([]);
    setError(null);
  };

  const handleClearSelection = () => {
    setSelectedOriginal(null);
  };

  const handleSubmit = async () => {
    if (!canSubmit || !selectedOriginal) return;

    setIsSubmitting(true);
    setError(null);

    try {
      await onSubmit(selectedOriginal.id, reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-[26px] border border-slate-200 bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <h2 className="text-lg font-black text-slate-900">Flag as Possible Duplicate</h2>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-5">
          {/* Error display */}
          {error && (
            <div className={ui.error}>
              <AlertCircle className="mr-2 inline h-4 w-4" />
              {error}
            </div>
          )}

          {/* Search for original quote */}
          <div>
            <label className={ui.label}>Select Original Quote</label>

            {selectedOriginal ? (
              <div className="mt-2 flex items-center justify-between rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                <div className="flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-emerald-600" />
                  <span className="text-sm font-bold text-emerald-800">
                    {selectedOriginal.customer_name}
                  </span>
                  <span className={`${ui.badge} ${ui.badgeTone.info}`}>
                    {statusLabel(selectedOriginal.status)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="rounded-full p-1 text-emerald-600 hover:bg-emerald-100"
                  aria-label="Clear selection"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <div className="relative mt-2">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search by customer name..."
                  className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-4 text-sm font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]"
                />

                {/* Search results dropdown */}
                {(searchResults.length > 0 || isSearching) && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg">
                    {isSearching ? (
                      <div className="px-4 py-3 text-center text-sm font-semibold text-slate-500">
                        Searching...
                      </div>
                    ) : (
                      searchResults.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          onClick={() => handleSelectOriginal(result)}
                          className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-slate-50"
                        >
                          <div>
                            <p className="text-sm font-bold text-slate-900">
                              {result.customer_name}
                            </p>
                            <p className="mt-0.5 text-xs font-semibold text-slate-500">
                              {statusLabel(result.source_type)} &middot; {statusLabel(result.line_of_business)}
                            </p>
                          </div>
                          <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
                            {statusLabel(result.status)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                )}

                {/* Empty search state */}
                {searchQuery.trim().length >= 2 && !isSearching && searchResults.length === 0 && (
                  <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg">
                    <p className="text-center text-sm font-semibold text-slate-500">
                      No quotes found matching &ldquo;{searchQuery.trim()}&rdquo;
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Reason textarea */}
          <div>
            <label className={ui.label}>Reason</label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why you believe this is a duplicate (10-500 characters)..."
              rows={4}
              maxLength={MAX_REASON}
              className={ui.textarea}
            />
            <div className="mt-1.5 flex items-center justify-between">
              <p
                className={`text-xs font-semibold ${
                  reasonLen > 0 && reasonLen < MIN_REASON
                    ? 'text-rose-600'
                    : reasonLen >= MIN_REASON
                      ? 'text-emerald-600'
                      : 'text-slate-400'
                }`}
              >
                {reasonLen > 0 && reasonLen < MIN_REASON && `${MIN_REASON - reasonLen} more characters needed`}
                {reasonLen >= MIN_REASON && reasonLen <= MAX_REASON && 'Valid length'}
                {reasonLen === 0 && 'Minimum 10 characters'}
              </p>
              <p
                className={`text-xs font-semibold ${
                  reasonLen > MAX_REASON ? 'text-rose-600' : 'text-slate-400'
                }`}
              >
                {reasonLen}/{MAX_REASON}
              </p>
            </div>
          </div>
        </div>

        {/* Footer: actions */}
        <div className="flex items-center justify-end gap-3 border-t border-slate-100 px-6 py-4">
          <button type="button" onClick={onCancel} className={ui.btnSecondary}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className={ui.btnPrimary}
          >
            {isSubmitting ? 'Submitting...' : 'Flag as Duplicate'}
          </button>
        </div>
      </div>
    </div>
  );
}
