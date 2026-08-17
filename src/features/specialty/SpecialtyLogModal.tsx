'use client';

/**
 * The Log modal for a specialty quote.
 *
 * Every view that lists quotes carries a Log action, and it opens the full event
 * history for that row. The Customer Service `QuoteActivityModal` is keyed on
 * `source_work_item_id`, and a specialty opportunity has no work item — its work
 * never enters the sales queue — so this is the equivalent surface for specialty
 * rows: the same purpose, the same visual language, reading
 * `specialty_activity_timeline`, which already merges the opportunity's own history
 * with the linked intake's event log and the shared notes.
 *
 * That merge is the point. "What has happened on this quote and who did it" has to
 * include the Customer Service half of the story, otherwise the timeline starts in
 * the middle.
 */

import { AlertCircle, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import { getTimeline } from './api';
import { eventLabel, eventTone, formatRelative } from './status';
import type { TimelineEntry } from './types';

const ORIGIN_LABELS: Record<TimelineEntry['origin'], string> = {
  specialty: 'Specialty',
  intake: 'Intake',
  note: 'Note',
};

/** Renders whichever detail keys are worth reading, without dumping raw JSON. */
function describeDetail(entry: TimelineEntry): string | null {
  const detail = entry.detail;
  if (!detail) return null;

  const pick = (key: string): string | null => {
    const value = detail[key];
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  };

  const parts: string[] = [];
  const note = pick('note');
  if (note) parts.push(note);

  const carrier = pick('carrier_name');
  const from = pick('from_status') ?? pick('from_stage');
  const to = pick('to_status') ?? pick('to_stage');
  if (carrier && to) parts.push(`${carrier}: ${eventStatusWords(from)}${to.replace(/_/g, ' ')}`);
  else if (carrier) parts.push(carrier);
  else if (to) parts.push(`${eventStatusWords(from)}${to.replace(/_/g, ' ')}`);

  const label = pick('label');
  if (label) parts.push(label);

  const premium = pick('premium') ?? pick('sold_premium');
  if (premium) parts.push(`$${Number(premium).toLocaleString()}`);

  const lostReason = pick('lost_reason');
  if (lostReason) parts.push(lostReason.replace(/_/g, ' '));

  const optionCount = pick('option_count');
  if (optionCount) parts.push(`${optionCount} option(s)`);

  const fields = detail.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    parts.push(`${fields.length} field(s): ${fields.slice(0, 6).join(', ')}`);
  }

  const changes = detail.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    parts.push(
      changes
        .map((change) => {
          const record = change as Record<string, unknown>;
          return `${String(record.field ?? '')} → ${String(record.new_value ?? '')}`;
        })
        .join('; '),
    );
  }

  const reason = pick('reason');
  if (reason) parts.push(reason);

  if (detail.automatic === true) parts.push('automatic');
  if (detail.via === 'customer_service') parts.push('via Customer Service');
  if (detail.legacy === true) parts.push('from the Commercial Board');

  return parts.length > 0 ? parts.join(' · ') : null;
}

function eventStatusWords(from: string | null): string {
  return from ? `${from.replace(/_/g, ' ')} → ` : '';
}

export interface SpecialtyLogModalProps {
  opportunityId: string | null;
  reference?: string | null;
  displayName?: string | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function SpecialtyLogModal({
  opportunityId,
  reference,
  displayName,
  isOpen,
  onClose,
}: SpecialtyLogModalProps) {
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await getTimeline(id, 400));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The activity log could not be loaded.');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !opportunityId) return;
    void load(opportunityId);
  }, [isOpen, load, opportunityId]);

  useEffect(() => {
    if (!isOpen) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen || !opportunityId) return null;

  return (
    <div
      className="fixed inset-0 z-[60] overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="mx-auto max-w-3xl rounded-[30px] border border-slate-200 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Quote activity log"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#526b9a]">
              Activity log
            </p>
            <h2 className="text-lg font-black text-slate-950">{displayName ?? 'Specialty quote'}</h2>
            {reference ? (
              <p className="mt-0.5 text-xs font-bold text-slate-400">{reference}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={ui.btnGhost}
              onClick={() => void load(opportunityId)}
              aria-label="Refresh activity"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100"
              aria-label="Close activity log"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-5 sm:px-6">
          {error ? (
            <div className={`${ui.error} mb-4 flex items-start gap-2`}>
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          {loading && entries.length === 0 ? (
            <p className={ui.empty}>Loading activity…</p>
          ) : null}

          {!loading && entries.length === 0 && !error ? (
            <p className={ui.empty}>Nothing has been recorded on this quote yet.</p>
          ) : null}

          {entries.length > 0 ? (
            <ol className="relative space-y-4 border-l border-slate-200 pl-6">
              {entries.map((entry, index) => {
                const tone = eventTone(entry.event_type);
                const detail = describeDetail(entry);
                return (
                  <li key={`${entry.occurred_at}-${entry.event_type}-${index}`} className="relative">
                    <span
                      className={`absolute -left-[1.6875rem] top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full ring-4 ring-white ${
                        tone === 'success'
                          ? 'bg-emerald-500'
                          : tone === 'danger'
                            ? 'bg-rose-500'
                            : tone === 'cyan'
                              ? 'bg-cyan-500'
                              : tone === 'violet'
                                ? 'bg-violet-500'
                                : tone === 'progress'
                                  ? 'bg-amber-500'
                                  : 'bg-slate-300'
                      }`}
                      aria-hidden
                    />
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <p className="text-sm font-black text-slate-900">
                        {eventLabel(entry.event_type)}
                      </p>
                      <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
                        {ORIGIN_LABELS[entry.origin]}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs font-bold text-slate-500">
                      {entry.actor_name} · {formatRelative(entry.occurred_at)}
                    </p>
                    {detail ? (
                      <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-slate-600">
                        {detail}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      </div>
    </div>
  );
}
