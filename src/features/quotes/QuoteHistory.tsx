'use client';

// src/features/quotes/QuoteHistory.tsx
// Chronological timeline of quote history events. Displays the Intake Note Log
// as the first entry, intake_update events with changed fields, and all other
// lifecycle events (quote_created, agent_started_quoting, pricing_sent, etc.).

import {
  BookOpen,
  CheckCircle2,
  Clock,
  DollarSign,
  Edit3,
  FileText,
  Flag,
  Link2,
  Merge,
  Send,
  UserCheck,
  XCircle,
} from 'lucide-react';
import type { QuoteHistoryEvent } from './types';
import IntakeNoteLog from './IntakeNoteLog';
import IntakeDataDisplay, { type IntakeDataDetails } from '../cs-intake/IntakeDataDisplay';

interface QuoteHistoryProps {
  quoteId: string;
  events: QuoteHistoryEvent[];
}

/** Maps event_type to a human-readable label. */
function eventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    intake_note_log: 'Intake Note Log',
    intake_update: 'Intake Updated',
    created_from_cs_intake: 'Created from CS Intake',
    quote_created: 'Quote Created',
    agent_started_quoting: 'Quoting Started',
    pricing_sent: 'Pricing Sent',
    activation_pending: 'Activation Pending',
    activated: 'Activated',
    sold: 'Sold',
    not_sold: 'Not Sold',
    duplicate_flagged: 'Duplicate Flagged',
    duplicate_resolved: 'Duplicate Resolved',
    merged_source: 'Merged (Source)',
    merged_target: 'Merged (Target)',
    reassigned: 'Reassigned',
    linked: 'Linked',
    status_changed: 'Status Changed',
  };
  return labels[eventType] ?? eventType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Returns the icon for an event type. */
function eventIcon(eventType: string) {
  switch (eventType) {
    case 'intake_note_log':
      return <BookOpen className="h-4 w-4" />;
    case 'intake_update':
      return <Edit3 className="h-4 w-4" />;
    case 'quote_created':
      return <FileText className="h-4 w-4" />;
    case 'created_from_cs_intake':
      return <FileText className="h-4 w-4" />;
    case 'agent_started_quoting':
      return <Clock className="h-4 w-4" />;
    case 'pricing_sent':
      return <Send className="h-4 w-4" />;
    case 'activation_pending':
      return <CheckCircle2 className="h-4 w-4" />;
    case 'activated':
      return <CheckCircle2 className="h-4 w-4" />;
    case 'sold':
      return <DollarSign className="h-4 w-4" />;
    case 'not_sold':
      return <XCircle className="h-4 w-4" />;
    case 'duplicate_flagged':
      return <Flag className="h-4 w-4" />;
    case 'duplicate_resolved':
      return <UserCheck className="h-4 w-4" />;
    case 'merged_source':
    case 'merged_target':
      return <Merge className="h-4 w-4" />;
    case 'linked':
      return <Link2 className="h-4 w-4" />;
    default:
      return <Clock className="h-4 w-4" />;
  }
}

/** Returns Tailwind color classes for the timeline dot and label based on event type. */
function eventColor(eventType: string): { dot: string; text: string } {
  switch (eventType) {
    case 'intake_note_log':
      return { dot: 'bg-indigo-500 ring-indigo-100', text: 'text-indigo-700' };
    case 'created_from_cs_intake':
      return { dot: 'bg-indigo-500 ring-indigo-100', text: 'text-indigo-700' };
    case 'intake_update':
      return { dot: 'bg-blue-500 ring-blue-100', text: 'text-blue-700' };
    case 'quote_created':
      return { dot: 'bg-emerald-500 ring-emerald-100', text: 'text-emerald-700' };
    case 'agent_started_quoting':
      return { dot: 'bg-amber-500 ring-amber-100', text: 'text-amber-700' };
    case 'pricing_sent':
      return { dot: 'bg-violet-500 ring-violet-100', text: 'text-violet-700' };
    case 'activation_pending':
      return { dot: 'bg-cyan-500 ring-cyan-100', text: 'text-cyan-700' };
    case 'activated':
      return { dot: 'bg-teal-500 ring-teal-100', text: 'text-teal-700' };
    case 'sold':
      return { dot: 'bg-emerald-600 ring-emerald-100', text: 'text-emerald-700' };
    case 'not_sold':
      return { dot: 'bg-rose-500 ring-rose-100', text: 'text-rose-700' };
    case 'duplicate_flagged':
      return { dot: 'bg-orange-500 ring-orange-100', text: 'text-orange-700' };
    case 'duplicate_resolved':
      return { dot: 'bg-teal-500 ring-teal-100', text: 'text-teal-700' };
    case 'merged_source':
    case 'merged_target':
      return { dot: 'bg-purple-500 ring-purple-100', text: 'text-purple-700' };
    case 'linked':
      return { dot: 'bg-sky-500 ring-sky-100', text: 'text-sky-700' };
    default:
      return { dot: 'bg-slate-400 ring-slate-100', text: 'text-slate-600' };
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

/** Converts a field name (snake_case) into a readable label. */
function fieldLabel(field: string): string {
  return field
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Formats a value for display — no raw JSON. */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(empty)';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') {
    if (Array.isArray(value)) return `${value.length} item${value.length !== 1 ? 's' : ''}`;
    return '(complex value)';
  }
  return String(value);
}

export default function QuoteHistory({ quoteId: _quoteId, events }: QuoteHistoryProps) {
  if (!events.length) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center text-sm font-semibold text-slate-500">
        No history events recorded for this quote.
      </div>
    );
  }

  return (
    <div className="space-y-0">
      <div className="relative">
        {/* Vertical timeline line */}
        <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-slate-200" aria-hidden="true" />

        <ul className="relative space-y-4">
          {events.map((event) => {
            const color = eventColor(event.event_type);
            const isNoteLog = event.event_type === 'intake_note_log';
            const isIntakeUpdate =
              event.event_type === 'intake_update' &&
              event.changed_fields &&
              event.changed_fields.length > 0;
            const isCsIntakeEvent = event.event_type === 'created_from_cs_intake';

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
                    {event.actor_display_name}
                  </p>

                  {/* Intake Note Log rendered via IntakeNoteLog component */}
                  {isNoteLog && event.note_log_content && (
                    <div className="mt-3">
                      <IntakeNoteLog content={event.note_log_content} />
                    </div>
                  )}

                  {/* Details text (for non-note-log, non-cs-intake events) */}
                  {!isNoteLog && !isCsIntakeEvent && event.details && (
                    <p className="mt-1 text-sm font-semibold text-slate-600">
                      {event.details}
                    </p>
                  )}

                  {/* Structured intake data for created_from_cs_intake events */}
                  {isCsIntakeEvent && event.details && (
                    <div className="mt-3">
                      <IntakeDataDisplay details={event.details as unknown as IntakeDataDetails} />
                    </div>
                  )}

                  {/* Reason */}
                  {event.reason && (
                    <p className="mt-1 text-xs font-semibold italic text-slate-500">
                      Reason: {event.reason}
                    </p>
                  )}

                  {/* Grouped field changes for intake_update events */}
                  {isIntakeUpdate && (
                    <div className="mt-2 space-y-1 rounded-xl bg-slate-50 px-3 py-2">
                      <p className="text-[11px] font-black uppercase tracking-wide text-slate-400">
                        Fields changed
                      </p>
                      {event.changed_fields!.map((change, idx) => (
                        <div
                          key={`${event.id}-${change.field}-${idx}`}
                          className="flex flex-wrap items-baseline gap-1 text-sm"
                        >
                          <span className="font-bold text-slate-700">
                            {fieldLabel(change.field)}:
                          </span>
                          <span className="font-semibold text-rose-600 line-through">
                            {formatValue(change.old_value)}
                          </span>
                          <span className="text-slate-400">&rarr;</span>
                          <span className="font-semibold text-emerald-700">
                            {formatValue(change.new_value)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
