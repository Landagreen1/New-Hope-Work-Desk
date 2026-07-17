'use client';

import { Clock, DollarSign, FileText, MessageCircle, Phone, Send, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import { getLinkedQuoteEvents, type LinkedQuoteEvent } from './api';
import IntakeDataDisplay, { type IntakeDataDetails } from './IntakeDataDisplay';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface QuoteActivityModalProps {
  workItemId: string | null;
  isOpen: boolean;
  onClose: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Maps event_type to a human-readable label. */
function eventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    created_from_cs_intake: 'Created from CS Intake',
    created: 'Quote Created',
    assigned: 'Assigned',
    accepted: 'Accepted',
    reassigned: 'Reassigned',
    price_sent: 'Pricing Sent',
    sold: 'Sold',
    not_sold: 'Not Sold',
    completed: 'Completed',
    cancelled: 'Cancelled',
    note: 'Note Added',
    customer_contacted: 'Customer Contacted',
    cancelled_from_cs_queue: 'Cancelled from CS Queue',
    ringcentral_intake_claim_completed: 'RC Intake Claimed',
    outcome_change: 'Outcome Changed',
  };
  return labels[eventType] ?? eventType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Returns Tailwind color classes for the timeline dot based on event type. */
function eventColor(eventType: string): { dot: string; text: string } {
  switch (eventType) {
    case 'created_from_cs_intake':
      return { dot: 'bg-indigo-500 ring-indigo-100', text: 'text-indigo-700' };
    case 'created':
    case 'assigned':
    case 'accepted':
      return { dot: 'bg-blue-500 ring-blue-100', text: 'text-blue-700' };
    case 'price_sent':
      return { dot: 'bg-violet-500 ring-violet-100', text: 'text-violet-700' };
    case 'sold':
      return { dot: 'bg-emerald-600 ring-emerald-100', text: 'text-emerald-700' };
    case 'not_sold':
      return { dot: 'bg-rose-500 ring-rose-100', text: 'text-rose-700' };
    case 'note':
      return { dot: 'bg-amber-500 ring-amber-100', text: 'text-amber-700' };
    case 'customer_contacted':
      return { dot: 'bg-sky-500 ring-sky-100', text: 'text-sky-700' };
    case 'cancelled_from_cs_queue':
    case 'cancelled':
      return { dot: 'bg-orange-500 ring-orange-100', text: 'text-orange-700' };
    case 'outcome_change':
      return { dot: 'bg-purple-500 ring-purple-100', text: 'text-purple-700' };
    default:
      return { dot: 'bg-slate-400 ring-slate-100', text: 'text-slate-600' };
  }
}

/** Returns the icon for an event type. */
function eventIcon(eventType: string) {
  switch (eventType) {
    case 'created_from_cs_intake':
      return <FileText className="h-4 w-4" />;
    case 'price_sent':
      return <Send className="h-4 w-4" />;
    case 'sold':
      return <DollarSign className="h-4 w-4" />;
    case 'not_sold':
      return <XCircle className="h-4 w-4" />;
    case 'note':
      return <MessageCircle className="h-4 w-4" />;
    case 'customer_contacted':
      return <Phone className="h-4 w-4" />;
    case 'cancelled_from_cs_queue':
      return <X className="h-4 w-4" />;
    default:
      return <Clock className="h-4 w-4" />;
  }
}

/** Format a timestamp string into human-readable form: "Jan 15, 2024 at 2:30 PM" */
function formatDatetime(iso: string): string {
  const date = new Date(iso);
  return (
    date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }) +
    ' at ' +
    date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
  );
}

/* -------------------------------------------------------------------------- */
/*  Modal Shell (same pattern as QueueModal in IntakeQueue.tsx)                */
/* -------------------------------------------------------------------------- */

function ActivityModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <div className="mx-auto max-w-6xl rounded-[30px] bg-[#f3f5f9] p-3 shadow-2xl sm:p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-3 flex justify-end">
          <button className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main Component                                                             */
/* -------------------------------------------------------------------------- */

export default function QuoteActivityModal({ workItemId, isOpen, onClose }: QuoteActivityModalProps) {
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<LinkedQuoteEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !workItemId) {
      setEvents([]);
      setError(null);
      return;
    }

    let cancelled = false;

    async function fetchEvents() {
      setLoading(true);
      setError(null);
      try {
        const data = await getLinkedQuoteEvents(workItemId!);
        if (!cancelled) setEvents(data);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load quote activity');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchEvents();
    return () => { cancelled = true; };
  }, [isOpen, workItemId]);

  return (
    <ActivityModal open={isOpen} onClose={onClose}>
      <div className="px-2 pb-2">
        <h2 className="text-lg font-black text-slate-900">Quote Activity</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">Read-only timeline of all events for this quote.</p>

        <div className="mt-5">
          {/* Loading State */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
              <span className="ml-3 text-sm font-semibold text-slate-500">Loading events…</span>
            </div>
          )}

          {/* Error State */}
          {!loading && error && (
            <div className={ui.error}>{error}</div>
          )}

          {/* Empty State */}
          {!loading && !error && events.length === 0 && (
            <div className={ui.empty}>No activity events found for this quote.</div>
          )}

          {/* Timeline */}
          {!loading && !error && events.length > 0 && (
            <div className="relative">
              {/* Vertical timeline line */}
              <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-slate-200" aria-hidden="true" />

              <ul className="relative space-y-4">
                {events.map((event) => {
                  const color = eventColor(event.event_type);
                  const isIntakeEvent = event.event_type === 'created_from_cs_intake';

                  return (
                    <li key={event.id} className="relative pl-12">
                      {/* Timeline dot with icon */}
                      <div
                        className={`absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full ring-4 ${color.dot}`}
                      >
                        <span className="text-white">{eventIcon(event.event_type)}</span>
                      </div>

                      {/* Event card */}
                      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                        {/* Header row: label + datetime */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={`text-xs font-black uppercase tracking-wide ${color.text}`}>
                            {eventLabel(event.event_type)}
                          </span>
                          <span className="text-xs font-semibold text-slate-400">
                            {formatDatetime(event.created_at)}
                          </span>
                        </div>

                        {/* Actor */}
                        <p className="mt-1 text-sm font-bold text-slate-800">
                          {event.actor_name}
                        </p>

                        {/* Intake data display for created_from_cs_intake events */}
                        {isIntakeEvent && event.details && (
                          <div className="mt-3">
                            <IntakeDataDisplay details={event.details as unknown as IntakeDataDetails} />
                          </div>
                        )}

                        {/* Standard details for other event types */}
                        {!isIntakeEvent && event.details && (
                          <div className="mt-1">
                            {typeof event.details === 'object' && event.details !== null ? (
                              <div className="space-y-1">
                                {Object.entries(event.details).map(([key, value]) => (
                                  <p key={key} className="text-sm font-semibold text-slate-600">
                                    <span className="font-bold text-slate-700">
                                      {key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase())}:
                                    </span>{' '}
                                    {value === null || value === undefined ? '—' : String(value)}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <p className="text-sm font-semibold text-slate-600">{String(event.details)}</p>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </ActivityModal>
  );
}
