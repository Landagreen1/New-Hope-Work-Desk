'use client';

import {
  CheckCircle2,
  Clock,
  Edit3,
  FileText,
  RotateCcw,
  Send,
  Trash2,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import type { IntakeHistoryEvent } from '../quotes/types';

interface IntakeHistoryProps {
  intakeId: string;
  events: IntakeHistoryEvent[];
}

/** Maps event_type to a human-readable label. */
function eventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    created: 'Created',
    updated: 'Updated',
    source_changed: 'Source Changed',
    submitted: 'Submitted',
    claimed: 'Claimed',
    assigned: 'Assigned',
    converted_to_quote: 'Converted',
    deleted: 'Deleted',
    restored: 'Restored',
  };
  return labels[eventType] ?? eventType.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Returns the icon component for an event type. */
function eventIcon(eventType: string) {
  switch (eventType) {
    case 'created':
      return <FileText className="h-4 w-4" />;
    case 'updated':
    case 'source_changed':
      return <Edit3 className="h-4 w-4" />;
    case 'submitted':
      return <Send className="h-4 w-4" />;
    case 'claimed':
      return <UserCheck className="h-4 w-4" />;
    case 'assigned':
      return <UserPlus className="h-4 w-4" />;
    case 'converted_to_quote':
      return <CheckCircle2 className="h-4 w-4" />;
    case 'deleted':
      return <Trash2 className="h-4 w-4" />;
    case 'restored':
      return <RotateCcw className="h-4 w-4" />;
    default:
      return <Clock className="h-4 w-4" />;
  }
}

/** Returns Tailwind classes for the event dot/icon color based on event type. */
function eventColor(eventType: string): { dot: string; text: string } {
  switch (eventType) {
    case 'created':
      return { dot: 'bg-emerald-500 ring-emerald-100', text: 'text-emerald-700' };
    case 'updated':
    case 'source_changed':
      return { dot: 'bg-blue-500 ring-blue-100', text: 'text-blue-700' };
    case 'submitted':
      return { dot: 'bg-indigo-500 ring-indigo-100', text: 'text-indigo-700' };
    case 'claimed':
      return { dot: 'bg-amber-500 ring-amber-100', text: 'text-amber-700' };
    case 'assigned':
      return { dot: 'bg-violet-500 ring-violet-100', text: 'text-violet-700' };
    case 'converted_to_quote':
      return { dot: 'bg-emerald-600 ring-emerald-100', text: 'text-emerald-700' };
    case 'deleted':
      return { dot: 'bg-rose-500 ring-rose-100', text: 'text-rose-700' };
    case 'restored':
      return { dot: 'bg-teal-500 ring-teal-100', text: 'text-teal-700' };
    default:
      return { dot: 'bg-slate-400 ring-slate-100', text: 'text-slate-600' };
  }
}

/** Format a timestamp string into human-readable form: "Jan 15, 2024 at 2:30 PM" */
function formatDatetime(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }) + ' at ' + date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
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
    // Arrays or objects — summarize
    if (Array.isArray(value)) return `${value.length} item${value.length !== 1 ? 's' : ''}`;
    return '(complex value)';
  }
  return String(value);
}

export default function IntakeHistory({ intakeId: _intakeId, events }: IntakeHistoryProps) {
  if (!events.length) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center text-sm font-semibold text-slate-500">
        No history events recorded for this intake.
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
            const hasChangedFields =
              event.event_type === 'updated' &&
              event.changed_fields &&
              event.changed_fields.length > 0;

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

                  {/* Details text */}
                  {event.details && (
                    <p className="mt-1 text-sm font-semibold text-slate-600">
                      {event.details}
                    </p>
                  )}

                  {/* Reason (for manager edits, deletes, restores) */}
                  {event.reason && (
                    <p className="mt-1 text-xs font-semibold italic text-slate-500">
                      Reason: {event.reason}
                    </p>
                  )}

                  {/* Grouped field changes for 'updated' events */}
                  {hasChangedFields && (
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
