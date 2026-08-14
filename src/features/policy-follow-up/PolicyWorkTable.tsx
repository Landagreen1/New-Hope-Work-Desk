'use client';

// The compact My Work rows (Requirements 6.3, 6.4).
//
// Presentational only: it renders `PolicyWorkItem` values that `work-projection.ts` already derived
// and computes nothing of its own beyond date formatting. No data access, no clock.
//
// Requirement 6.3 is the shape of this file. An agent opening Policy Follow-up has to be able to
// answer five questions at a glance — who is the customer, which policy and carrier, renewal or
// cancellation, how urgent, and what do I do next — so each item is a short card, not a row in a
// twenty-column spreadsheet. Requirement 6.3 also forbids showing raw Spanish column names or the
// imported source fields here; `normalizedStatus` and `nextAction` are the only status text, and both
// arrive already in operational language.

import { AlertTriangle, ArrowRight, Clock, Lock, ShieldAlert } from 'lucide-react';

import { POLICY_CRITICAL_REASON_LABELS, type PolicyWorkItem } from './types';

/** Em dash, matching both domain modules. */
const EM_DASH = '\u2014';

/** `Feb 9` / `Feb 9, 2027` — the year only when it is not the current one. */
function shortDate(value: string | null | undefined, businessDate: string): string {
  const text = (value ?? '').trim();
  if (text.length === 0) return EM_DASH;
  const date = text.slice(0, 10);
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed)) return EM_DASH;

  const sameYear = date.slice(0, 4) === businessDate.slice(0, 4);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    timeZone: 'UTC',
  }).format(new Date(parsed));
}

/**
 * `Today`, `Tomorrow`, `in 12 days`, `3 days ago` — the phrase an agent reads rather than a signed
 * integer, because "-3" and "3" are the difference between late and not and a minus sign is easy to
 * miss.
 */
export function daysPhrase(daysRemaining: number | null): string {
  if (daysRemaining === null) return EM_DASH;
  if (daysRemaining === 0) return 'Today';
  if (daysRemaining === 1) return 'Tomorrow';
  if (daysRemaining === -1) return 'Yesterday';
  if (daysRemaining > 1) return `in ${daysRemaining} days`;
  return `${Math.abs(daysRemaining)} days ago`;
}

/** The domain label, in the vocabulary the agency uses out loud. */
function domainLabel(item: PolicyWorkItem): string {
  return item.domain === 'renewal' ? 'RENEWAL' : 'CANCELLATION';
}

const DOMAIN_TONE: Record<PolicyWorkItem['domain'], string> = {
  renewal: 'bg-[#eef3fb] text-[#223f7a]',
  cancellation: 'bg-amber-50 text-amber-900',
};

const URGENCY_TONE: Record<PolicyWorkItem['urgency'], string> = {
  critical: 'border-rose-300 bg-rose-50/60',
  today: 'border-[#c9d5e9] bg-[#f8faff]',
  upcoming: 'border-slate-200 bg-white',
  waiting: 'border-slate-200 bg-slate-50/70',
  later: 'border-slate-200 bg-white',
};

export interface PolicyWorkTableProps {
  items: readonly PolicyWorkItem[];
  businessDate: string;
  selectedId: string | null;
  /** Raised with the domain and the source record id, which is what opens the existing drawer. */
  onOpen: (item: PolicyWorkItem) => void;
  /** Shown in place of the rows while the first read is outstanding. */
  loading?: boolean;
  /** What to say when the bucket is empty; each bucket says something different. */
  emptyMessage?: string;
}

export default function PolicyWorkTable({
  items,
  businessDate,
  selectedId,
  onOpen,
  loading = false,
  emptyMessage = 'Nothing here.',
}: PolicyWorkTableProps) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 px-1 py-6 text-sm font-bold text-slate-500" role="status">
        <Clock className="h-4 w-4 animate-pulse" aria-hidden="true" />
        Loading your work…
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="px-1 py-6 text-sm font-bold text-slate-500">{emptyMessage}</p>;
  }

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const selected = selectedId === item.sourceId;
        return (
          <li key={`${item.domain}:${item.sourceId}`}>
            <button
              type="button"
              onClick={() => onOpen(item)}
              aria-current={selected ? 'true' : undefined}
              className={[
                'w-full rounded-2xl border px-4 py-3 text-left transition',
                'hover:border-[#8da4cf] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eef3fb]',
                selected ? 'border-[#7890bc] ring-4 ring-[#eef3fb]' : URGENCY_TONE[item.urgency],
              ].join(' ')}
            >
              {/* Line 1: what kind of work, how urgent, and who the customer is. */}
              <span className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-black tracking-wide ${DOMAIN_TONE[item.domain]}`}
                >
                  {domainLabel(item)}
                </span>
                <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">
                  {item.eventDateEstimated ? 'Estimated · ' : ''}
                  {daysPhrase(item.daysRemaining)}
                </span>
                <span className="text-sm font-black text-slate-900">{item.customerName}</span>
              </span>

              {/* Line 2: which policy. */}
              <span className="mt-0.5 block text-xs font-bold text-slate-500">
                {item.carrier ?? 'Carrier not recorded'} · Policy {item.policyNumber}
                {item.eventDate === null ? '' : ` · ${shortDate(item.eventDate, businessDate)}`}
              </span>

              {/* Line 3: the one thing to do next (Requirement 6.4). */}
              <span className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                {item.nextAction === null ? (
                  <span className="text-sm font-black text-slate-500">
                    {item.waitingReason ?? 'No action required'}
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-sm font-black text-[#223f7a]">
                    <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    Next: {item.nextAction}
                  </span>
                )}
                <span className="text-xs font-bold text-slate-500">{item.normalizedStatus}</span>
              </span>

              {/* Line 4: the contact history and the due date, so the agent knows where they left off. */}
              <span className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-bold text-slate-500">
                <span>
                  Last contact: {shortDate(item.lastContactAt, businessDate)}
                </span>
                <span>
                  Next follow-up: {item.actionDueDate === null
                    ? EM_DASH
                    : shortDate(item.actionDueDate, businessDate)}
                </span>
                {item.waitingReason !== null && item.nextAction !== null ? (
                  <span>{item.waitingReason}</span>
                ) : null}
              </span>

              {/* Line 5, only when there is something wrong. Icon plus text, never colour alone. */}
              {item.criticalReasons.length > 0 || item.reviewRequired || item.communicationBlocked ? (
                <span className="mt-2 flex flex-wrap items-center gap-2">
                  {item.criticalReasons.map((reason) => (
                    <span
                      key={reason}
                      className="flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[11px] font-black text-rose-900"
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      {POLICY_CRITICAL_REASON_LABELS[reason]}
                    </span>
                  ))}
                  {item.reviewRequired ? (
                    <span className="flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-black text-amber-900">
                      <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                      Manager review required
                    </span>
                  ) : null}
                  {item.communicationBlocked ? (
                    <span className="flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-[11px] font-black text-slate-700">
                      <Lock className="h-3 w-3" aria-hidden="true" />
                      Automatic messaging held
                    </span>
                  ) : null}
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
