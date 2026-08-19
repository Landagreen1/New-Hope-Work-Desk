'use client';

import { Activity, ArrowRight, Clock, Shield, ShieldAlert, Timer, User, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { createClient } from '@/lib/supabase/client';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface QueueStatusEvent {
  id: string;
  profile_id: string;
  previous_status: string | null;
  new_status: string;
  previous_version: number | null;
  new_version: number;
  source: string;
  reason: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  cause_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface AgentQueueStatusHistoryProps {
  agentId: string | null;
  agentName: string | null;
  isOpen: boolean;
  onClose: () => void;
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const SOURCE_LABELS: Record<string, string> = {
  agent_manual: 'Agent Manual',
  manager_manual: 'Manager Override',
  attendance_break_start: 'Break Started',
  attendance_break_end: 'Break Ended',
  attendance_clock_out: 'Clocked Out',
  daily_reset: 'Daily Reset',
  system_migration: 'System Migration',
  system_recovery: 'System Recovery',
  user_deactivated: 'Account Deactivated',
};

const STATUS_LABELS: Record<string, string> = {
  available: 'Available',
  break: 'Break',
  unavailable: 'Unavailable',
};

function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

function statusLabel(status: string | null): string {
  if (!status) return '—';
  return STATUS_LABELS[status] ?? status;
}

/** Color for the timeline dot based on the source of the transition. */
function sourceColor(source: string): { dot: string; text: string } {
  switch (source) {
    case 'agent_manual':
      return { dot: 'bg-blue-500 ring-blue-100', text: 'text-blue-700' };
    case 'manager_manual':
      return { dot: 'bg-purple-600 ring-purple-100', text: 'text-purple-700' };
    case 'attendance_break_start':
      return { dot: 'bg-amber-500 ring-amber-100', text: 'text-amber-700' };
    case 'attendance_break_end':
      return { dot: 'bg-emerald-500 ring-emerald-100', text: 'text-emerald-700' };
    case 'attendance_clock_out':
      return { dot: 'bg-slate-600 ring-slate-100', text: 'text-slate-700' };
    case 'daily_reset':
      return { dot: 'bg-orange-500 ring-orange-100', text: 'text-orange-700' };
    case 'system_migration':
    case 'system_recovery':
      return { dot: 'bg-indigo-500 ring-indigo-100', text: 'text-indigo-700' };
    case 'user_deactivated':
      return { dot: 'bg-rose-600 ring-rose-100', text: 'text-rose-700' };
    default:
      return { dot: 'bg-slate-400 ring-slate-100', text: 'text-slate-600' };
  }
}

/** Icon for the source. */
function sourceIcon(source: string) {
  switch (source) {
    case 'agent_manual':
      return <User className="h-3.5 w-3.5" />;
    case 'manager_manual':
      return <Shield className="h-3.5 w-3.5" />;
    case 'attendance_break_start':
    case 'attendance_break_end':
      return <Clock className="h-3.5 w-3.5" />;
    case 'attendance_clock_out':
      return <Timer className="h-3.5 w-3.5" />;
    case 'daily_reset':
      return <Activity className="h-3.5 w-3.5" />;
    case 'user_deactivated':
      return <ShieldAlert className="h-3.5 w-3.5" />;
    default:
      return <Activity className="h-3.5 w-3.5" />;
  }
}

/** Status badge styling. */
function statusBadge(status: string | null): string {
  switch (status) {
    case 'available':
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    case 'break':
      return 'bg-amber-50 text-amber-700 ring-amber-200';
    case 'unavailable':
      return 'bg-slate-100 text-slate-700 ring-slate-200';
    default:
      return 'bg-slate-50 text-slate-500 ring-slate-200';
  }
}

/** Format timestamp to locale display. */
function formatEventTime(iso: string): string {
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${month}/${day}/${year} ${hour12}:${minutes}:${seconds} ${ampm}`;
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Agent Queue Status History — a diagnostic timeline modal for managers.
 *
 * Shows the full queue-status event history for a specific agent from the
 * `agent_queue_status_events` table. Each entry shows:
 * - Time, Source, Previous/New Status, Version, Changed By, Reason
 *
 * Designed to answer: WHAT changed? WHO changed it? WHEN? WHY? FROM WHAT? TO WHAT?
 */
export default function AgentQueueStatusHistory({
  agentId,
  agentName,
  isOpen,
  onClose,
}: AgentQueueStatusHistoryProps) {
  const [loading, setLoading] = useState(false);
  const [events, setEvents] = useState<QueueStatusEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !agentId) {
      setEvents([]);
      setError(null);
      return;
    }

    let cancelled = false;

    async function fetchHistory() {
      setLoading(true);
      setError(null);
      try {
        const supabase = createClient();
        const { data, error: rpcError } = await supabase.rpc(
          'get_agent_queue_status_history',
          { p_profile_id: agentId, p_limit: 200 },
        );

        if (rpcError) throw new Error(rpcError.message);
        if (!cancelled) {
          // The RPC returns a JSONB array
          const parsed = (typeof data === 'string' ? JSON.parse(data) : data) as QueueStatusEvent[];
          setEvents(parsed);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load queue status history');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchHistory();
    return () => { cancelled = true; };
  }, [isOpen, agentId]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[28px] border border-white/70 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-xl font-black tracking-tight text-slate-950">
              Queue Status History
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {agentName ? `${agentName} — ` : ''}Full event trail of every queue-status transition.
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Loading */}
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
              <span className="ml-3 text-sm font-semibold text-slate-500">Loading history…</span>
            </div>
          )}

          {/* Error */}
          {!loading && error && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
              {error}
            </div>
          )}

          {/* Empty */}
          {!loading && !error && events.length === 0 && (
            <div className="rounded-2xl bg-slate-50 p-8 text-center text-sm font-semibold text-slate-400">
              No queue status events have been recorded for this agent.
            </div>
          )}

          {/* Timeline */}
          {!loading && !error && events.length > 0 && (
            <div className="relative">
              {/* Vertical timeline line */}
              <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-slate-200" aria-hidden="true" />

              <ul className="relative space-y-3">
                {events.map((event) => {
                  const color = sourceColor(event.source);
                  const isRestorationSkipped =
                    event.source === 'attendance_break_end' &&
                    event.metadata?.action === 'restoration_skipped';

                  return (
                    <li key={event.id} className="relative pl-12">
                      {/* Timeline dot */}
                      <div
                        className={`absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full ring-4 ${color.dot}`}
                      >
                        <span className="text-white">{sourceIcon(event.source)}</span>
                      </div>

                      {/* Event card */}
                      <div className={`rounded-2xl border px-4 py-3 shadow-sm ${
                        isRestorationSkipped
                          ? 'border-amber-200 bg-amber-50/50'
                          : 'border-slate-200 bg-white'
                      }`}>
                        {/* Header: source + time */}
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={`text-xs font-black uppercase tracking-wide ${color.text}`}>
                            {sourceLabel(event.source)}
                            {isRestorationSkipped && (
                              <span className="ml-2 text-[10px] font-bold normal-case tracking-normal text-amber-600">
                                (skipped — version changed)
                              </span>
                            )}
                          </span>
                          <span className="text-xs font-semibold text-slate-400">
                            {formatEventTime(event.created_at)}
                          </span>
                        </div>

                        {/* Status transition */}
                        <div className="mt-2 flex items-center gap-2">
                          {event.previous_status && (
                            <>
                              <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-black ring-1 ${statusBadge(event.previous_status)}`}>
                                {statusLabel(event.previous_status)}
                              </span>
                              <ArrowRight className="h-3.5 w-3.5 text-slate-400" />
                            </>
                          )}
                          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-black ring-1 ${statusBadge(event.new_status)}`}>
                            {statusLabel(event.new_status)}
                          </span>
                          <span className="ml-auto text-[10px] font-bold text-slate-400">
                            v{event.previous_version ?? '?'} → v{event.new_version}
                          </span>
                        </div>

                        {/* Changed by + reason */}
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                          {event.changed_by_name && (
                            <span className="font-bold text-slate-700">
                              By: {event.changed_by_name}
                            </span>
                          )}
                          {event.reason && (
                            <span className="font-semibold text-slate-500">
                              {event.reason}
                            </span>
                          )}
                        </div>

                        {/* Metadata for restoration skipped events */}
                        {isRestorationSkipped && event.metadata && (
                          <div className="mt-2 rounded-xl bg-amber-100/50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                            Break-end restoration skipped because queue version changed during break
                            (v{String(event.metadata.version_at_break)} → v{String(event.metadata.current_version)}).
                            Would have restored to: {statusLabel(event.metadata.would_have_restored as string)}.
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
    </div>
  );
}
