'use client';

// Renewal activity timeline (Requirements 5.8, 1.4).
//
// Purely presentational and controlled (Requirement 7.2): no direct Supabase client call, no
// renewal database function call, no `fetch`, and no value import from `./api` — contact, event,
// and SMS rows arrive as props already loaded by the drawer. Evidence is not resolved here
// either: the entry raises `onOpenEvidence` with the stored reference and the caller owns the
// signed-URL round trip.
//
// The merge, the classification, and the ordering live in `buildRenewalTimeline` in `./timeline`,
// a pure module with no React, no clock read, and no I/O, so the ordering rule of Requirement 5.8
// is testable without rendering. It is re-exported here with its entry types, so a caller reading
// the timeline component finds the whole contract in one place.

import {
  CalendarClock, CheckCircle2, Clock, LoaderCircle, MessageSquareText,
  Paperclip, RefreshCw, Send, Smartphone, UserCheck,
} from 'lucide-react';
import { useMemo } from 'react';

import { statusLabel, ui } from '../nhwd-shared/ui';
import type { RenewalContact, RenewalEvent } from './api';
// The em dash for an absent value and the timestamp formats (Req 5.1) come from `./format`.
import { EM_DASH, formatTimestamp, machineTimestamp } from './format';
import { buildRenewalTimeline } from './timeline';
import type { RenewalTimelineEntryKind, RenewalTimelineInput } from './timeline';

export { buildRenewalTimeline } from './timeline';
export type {
  RenewalTimelineEntry, RenewalTimelineEntryKind, RenewalTimelineEvidence, RenewalTimelineInput,
} from './timeline';

export interface RenewalTimelineProps extends RenewalTimelineInput {
  contacts: readonly RenewalContact[];
  events: readonly RenewalEvent[];
  /** Raised with `RenewalTimelineEvidence.reference`; the caller resolves and opens it. */
  onOpenEvidence?: (evidencePath: string) => void;
  loading?: boolean;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

/**
 * Per-kind dot tint, icon, and text label. Colour is never the only cue: every dot carries an
 * icon and every entry carries its kind label as text.
 */
const KIND_META: Record<RenewalTimelineEntryKind, { label: string; dot: string; text: string; Icon: typeof Clock }> = {
  contact: { label: 'Customer contact', dot: 'bg-cyan-600 ring-cyan-100', text: 'text-cyan-800', Icon: MessageSquareText },
  status: { label: 'Status change', dot: 'bg-[#223f7a] ring-[#eef3fb]', text: 'text-[#223f7a]', Icon: RefreshCw },
  assignment: { label: 'Assignment change', dot: 'bg-blue-600 ring-blue-100', text: 'text-blue-800', Icon: UserCheck },
  'follow-up': { label: 'Follow-up date change', dot: 'bg-amber-500 ring-amber-100', text: 'text-amber-800', Icon: CalendarClock },
  requote: { label: 'Requote activity', dot: 'bg-violet-600 ring-violet-100', text: 'text-violet-800', Icon: Send },
  outcome: { label: 'Final outcome', dot: 'bg-emerald-600 ring-emerald-100', text: 'text-emerald-800', Icon: CheckCircle2 },
  sms: { label: 'Text message', dot: 'bg-sky-600 ring-sky-100', text: 'text-sky-800', Icon: Smartphone },
  activity: { label: 'Renewal activity', dot: 'bg-slate-500 ring-slate-100', text: 'text-slate-700', Icon: Clock },
};

export default function RenewalTimeline(
  { contacts, events, smsLogs, actorNames, onOpenEvidence, loading = false }: RenewalTimelineProps,
) {
  const entries = useMemo(
    () => buildRenewalTimeline({ contacts, events, smsLogs, actorNames }),
    [contacts, events, smsLogs, actorNames],
  );

  if (loading) {
    return (
      <div aria-busy="true" className="flex items-center justify-center gap-3 py-10">
        <LoaderCircle className="h-5 w-5 animate-spin text-[#223f7a]" aria-hidden="true" />
        <span role="status" className="text-sm font-bold text-slate-500">Loading renewal activity…</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return <div className={ui.empty}>No customer contacts, evidence, or renewal activity has been recorded yet.</div>;
  }

  return (
    <div className="relative">
      {/* Rail behind the dots. Decorative, so it is hidden from assistive technology. */}
      <div className="absolute top-4 bottom-4 left-[15px] w-0.5 bg-slate-200" aria-hidden="true" />

      <ol aria-label="Renewal activity timeline, most recent event first" className="relative space-y-3">
        {entries.map((entry) => {
          const meta = KIND_META[entry.kind];
          const machine = machineTimestamp(entry.eventTime);
          const readable = formatTimestamp(entry.eventTime);
          const channel = entry.channel ? statusLabel(entry.channel) : null;
          const evidence = entry.evidence;

          return (
            <li key={entry.id} className="relative pl-11">
              <span
                aria-hidden="true"
                className={`absolute top-2 left-0.5 grid h-7 w-7 place-items-center rounded-full ring-4 ${meta.dot}`}
              >
                <meta.Icon className="h-3.5 w-3.5 text-white" />
              </span>

              <article className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-[11px] font-black uppercase tracking-wider ${meta.text}`}>
                    {meta.label}
                    {channel ? ` · ${channel}` : ''}
                  </span>
                  {machine && readable ? (
                    <time dateTime={machine} className="text-xs font-semibold text-slate-400">
                      {readable}
                    </time>
                  ) : (
                    <span className="text-xs font-semibold text-slate-400">{EM_DASH}</span>
                  )}
                </div>

                <p className="mt-1 text-sm font-black text-slate-900">{entry.label}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">{entry.actor ?? EM_DASH}</p>

                {entry.notes ? (
                  <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-sm font-semibold whitespace-pre-wrap text-slate-700">
                    {entry.notes}
                  </p>
                ) : null}

                {entry.details.length > 0 ? (
                  <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                    {entry.details.map((line) => (
                      <div key={`${entry.id}-${line.label}`} className="text-xs">
                        <dt className="inline font-black text-slate-500">{line.label}: </dt>
                        <dd className="inline font-semibold text-slate-700">{line.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {evidence ? (
                  <button
                    type="button"
                    // No signed URL is resolved here (Req 7.2): the caller receives the
                    // stored reference and owns the download.
                    onClick={() => onOpenEvidence?.(evidence.reference)}
                    disabled={!onOpenEvidence}
                    aria-label={`Open evidence ${evidence.name}${evidence.size ? `, ${evidence.size}` : ''}`}
                    className={`${ui.btnSecondary} mt-3 px-3 py-1.5 text-xs`}
                  >
                    <Paperclip className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="max-w-[18rem] truncate">{evidence.name}</span>
                    {evidence.size ? <span className="font-bold text-slate-400">{evidence.size}</span> : null}
                  </button>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
