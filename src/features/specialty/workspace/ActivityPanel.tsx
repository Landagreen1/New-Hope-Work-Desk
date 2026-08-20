'use client';

/**
 * The Activity tab — one chronological story per quote.
 *
 * `specialty_activity_timeline` already merges the three places a quote's history
 * lives: the opportunity's own `specialty_activity`, the linked Customer Service
 * intake's event log, and the shared notes. That merge is the point — a timeline that
 * started when the specialty team picked the quote up would start in the middle of the
 * customer's story.
 *
 * Grouped by day, because that is how the question gets asked. Nothing is written
 * here and nothing is duplicated: the events are the ones the mutation RPCs recorded
 * as they happened.
 */

import { RefreshCw } from 'lucide-react';

import { ui } from '../../nhwd-shared/ui';
import { eventTone, formatRelative } from '../status';
import {
  describeTimelineDetail,
  groupTimelineByDay,
  originLabel,
  timeOfDay,
  timelineTitle,
} from '../timeline';
import type { OpportunityDetail, TimelineEntry } from '../types';
import { Badge, SectionCard, toneDotColour } from './shared';

export default function ActivityPanel({
  detail,
  timeline,
  loading,
  onRefresh,
}: {
  detail: OpportunityDetail;
  timeline: TimelineEntry[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const days = groupTimelineByDay(timeline);

  const carrierName = (id: string | null) =>
    detail.carrier_markets.find((market) => market.id === id)?.carrier_name ?? null;

  return (
    <SectionCard
      title="Everything that has happened"
      description="Includes the Customer Service intake's own history, so the story starts where the customer did. Every entry names the employee who actually acted."
      actions={
        <button type="button" className={ui.btnSecondary} onClick={onRefresh} disabled={loading}>
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      }
    >
      {loading && timeline.length === 0 ? (
        <p className={ui.empty}>Loading activity…</p>
      ) : timeline.length === 0 ? (
        <p className={ui.empty}>Nothing has been recorded on this quote yet.</p>
      ) : (
        <div className="space-y-6">
          {days.map((day) => (
            <div key={day.key}>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                {day.label}
              </p>
              <ol className="relative mt-3 space-y-4 border-l border-slate-200 pl-6">
                {day.entries.map((entry, index) => {
                  const description = describeTimelineDetail(entry);
                  return (
                    <li key={`${entry.occurred_at}-${entry.event_type}-${index}`} className="relative">
                      <span
                        aria-hidden
                        className={`absolute -left-[1.6875rem] top-1.5 h-3.5 w-3.5 rounded-full ring-4 ring-white ${toneDotColour(
                          eventTone(entry.event_type),
                        )}`}
                      />
                      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span className="font-mono text-xs font-black text-slate-400">
                          {timeOfDay(entry.occurred_at)}
                        </span>
                        <p className="text-sm font-black text-slate-900">
                          {timelineTitle(entry, carrierName(entry.carrier_market_id))}
                        </p>
                        {entry.origin !== 'specialty' ? (
                          <Badge tone="neutral">{originLabel(entry.origin)}</Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-xs font-bold text-slate-500">
                        {entry.actor_name} · {formatRelative(entry.occurred_at)}
                      </p>
                      {description ? (
                        <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-slate-600">
                          {description}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
