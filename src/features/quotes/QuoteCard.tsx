'use client';

import { AlertTriangle, BookOpen, Clock, ExternalLink, Flag } from 'lucide-react';

import { statusLabel, ui } from '../nhwd-shared/ui';
import {
  calculateUrgency,
  QUOTE_TRANSITIONS,
  type OperationalQuote,
  type QuoteStatus,
  type UrgencyLevel,
} from './types';

export interface QuoteCardProps {
  quote: OperationalQuote;
  onStatusChange: (quoteId: string, newStatus: QuoteStatus) => Promise<void>;
  onFlagDuplicate: (quoteId: string) => void;
  onOpen: (quoteId: string) => void;
  onViewLog?: (quoteId: string) => void;
}

const STATUS_TONE: Record<QuoteStatus, string> = {
  assigned: 'info',
  quoting: 'progress',
  pricing_sent: 'violet',
  activation_pending: 'cyan',
  activated: 'success',
  sold: 'success',
  not_sold: 'danger',
  duplicate_review: 'danger',
  merged_duplicate: 'neutral',
};

const URGENCY_STYLES: Record<UrgencyLevel, { bg: string; text: string; ring: string; label: string }> = {
  normal: { bg: 'bg-emerald-50', text: 'text-emerald-700', ring: 'ring-emerald-200', label: 'Normal' },
  elevated: { bg: 'bg-amber-50', text: 'text-amber-800', ring: 'ring-amber-200', label: 'Elevated' },
  high: { bg: 'bg-rose-50', text: 'text-rose-700', ring: 'ring-rose-200', label: 'High' },
};

function formatSourceType(source: string): string {
  return statusLabel(source);
}

function formatDate(iso: string): string {
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

function transitionLabel(status: QuoteStatus): string {
  const labels: Record<QuoteStatus, string> = {
    assigned: 'Assigned',
    quoting: 'Start Quoting',
    pricing_sent: 'Pricing Sent',
    activation_pending: 'Activation Pending',
    activated: 'Activated',
    sold: 'Mark Sold',
    not_sold: 'Mark Not Sold',
    duplicate_review: 'Duplicate Review',
    merged_duplicate: 'Merged',
  };
  return labels[status] || statusLabel(status);
}

export default function QuoteCard({ quote, onStatusChange, onFlagDuplicate, onOpen, onViewLog }: QuoteCardProps) {
  const urgency = calculateUrgency(quote);
  const urgencyStyle = URGENCY_STYLES[urgency];
  const validTransitions = QUOTE_TRANSITIONS[quote.status] ?? [];
  const tone = STATUS_TONE[quote.status] || 'neutral';

  return (
    <div className={`${ui.card} overflow-hidden`}>
      {/* Header: customer name + urgency */}
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-black text-slate-900">{quote.customer_name}</h3>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            {formatSourceType(quote.source_type)}
            {quote.dealer_id ? ' · Dealership' : ''}
            {quote.dealer_salesperson_id ? ` · Salesperson: ${quote.dealer_salesperson_id}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Urgency indicator */}
          <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-black ring-1 ${urgencyStyle.bg} ${urgencyStyle.text} ${urgencyStyle.ring}`}>
            {urgency === 'high' ? <AlertTriangle className="h-3 w-3" /> : urgency === 'elevated' ? <Clock className="h-3 w-3" /> : null}
            {urgencyStyle.label}
          </span>
          {/* Status badge */}
          <span className={`${ui.badge} ${ui.badgeTone[tone]}`}>
            {statusLabel(quote.status)}
          </span>
        </div>
      </div>

      {/* Body: details */}
      <div className="grid gap-x-4 gap-y-2 px-5 py-4 sm:grid-cols-2 lg:grid-cols-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Quote Type</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{statusLabel(quote.line_of_business)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Intake Creator</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{quote.intake_creator || '—'}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Assigned Date</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{formatDate(quote.assigned_at)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Source</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{formatSourceType(quote.source_type)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Last Activity</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{formatDate(quote.last_progression_at)}</p>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Assignment Method</p>
          <p className="mt-0.5 text-sm font-bold text-slate-700">{statusLabel(quote.assignment_method)}</p>
        </div>
      </div>

      {/* Footer: actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
        {/* Log button */}
        {onViewLog && (
          <button
            type="button"
            className={ui.btnSecondary}
            onClick={() => onViewLog(quote.id)}
          >
            <BookOpen className="h-4 w-4" />
            Log
          </button>
        )}

        {/* Open button */}
        <button
          type="button"
          className={ui.btnPrimary}
          onClick={() => onOpen(quote.id)}
        >
          <ExternalLink className="h-4 w-4" />
          Open
        </button>

        {/* Valid status transitions */}
        {validTransitions.map((nextStatus) => (
          <button
            key={nextStatus}
            type="button"
            className={nextStatus === 'not_sold' ? ui.btnDanger : ui.btnSecondary}
            onClick={() => void onStatusChange(quote.id, nextStatus)}
          >
            {transitionLabel(nextStatus)}
          </button>
        ))}

        {/* Mark as Possible Duplicate — available on non-terminal, non-review statuses */}
        {!['sold', 'not_sold', 'duplicate_review', 'merged_duplicate'].includes(quote.status) && (
          <button
            type="button"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm font-black text-amber-800 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onFlagDuplicate(quote.id)}
          >
            <Flag className="h-4 w-4" />
            Mark as Possible Duplicate
          </button>
        )}
      </div>
    </div>
  );
}
