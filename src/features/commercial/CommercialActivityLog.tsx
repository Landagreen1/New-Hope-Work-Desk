'use client';

import {
  ArrowRight,
  CheckSquare,
  Clock,
  FileText,
  MessageSquare,
  Paperclip,
  RefreshCw,
  Shield,
  Trash2,
  UserCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';
import type { ActivityEventType, ActivityLogEntry } from './types';
import { ACTIVITY_EVENT_LABELS, BOARD_COLUMNS } from './types';

interface CommercialActivityLogProps {
  quoteId: string;
  onClose: () => void;
}

const EVENT_ICONS: Partial<Record<ActivityEventType, React.ComponentType<{ className?: string }>>> = {
  created: FileText,
  column_moved: ArrowRight,
  field_updated: FileText,
  comment_added: MessageSquare,
  attachment_uploaded: Paperclip,
  attachment_deleted: Trash2,
  checklist_created: CheckSquare,
  checklist_item_added: CheckSquare,
  checklist_item_toggled: CheckSquare,
  checklist_item_deleted: Trash2,
  checklist_deleted: Trash2,
  commission_approved: Shield,
  commission_denied: Shield,
  card_deleted: Trash2,
  card_restored: RefreshCw,
  card_archived: FileText,
  assigned_changed: UserCheck,
};

const EVENT_COLORS: Partial<Record<ActivityEventType, string>> = {
  created: 'bg-blue-100 text-blue-700',
  column_moved: 'bg-violet-100 text-violet-700',
  field_updated: 'bg-slate-100 text-slate-700',
  comment_added: 'bg-amber-100 text-amber-700',
  attachment_uploaded: 'bg-cyan-100 text-cyan-700',
  attachment_deleted: 'bg-rose-100 text-rose-600',
  checklist_created: 'bg-emerald-100 text-emerald-700',
  checklist_item_added: 'bg-emerald-100 text-emerald-700',
  checklist_item_toggled: 'bg-emerald-100 text-emerald-700',
  checklist_item_deleted: 'bg-rose-100 text-rose-600',
  checklist_deleted: 'bg-rose-100 text-rose-600',
  commission_approved: 'bg-green-100 text-green-700',
  commission_denied: 'bg-rose-100 text-rose-700',
  card_deleted: 'bg-rose-100 text-rose-700',
  card_restored: 'bg-blue-100 text-blue-700',
  card_archived: 'bg-slate-100 text-slate-600',
  assigned_changed: 'bg-indigo-100 text-indigo-700',
};

function formatDateTime(iso: string): string {
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

function getColumnLabel(colId: string): string {
  return BOARD_COLUMNS.find((c) => c.id === colId)?.label ?? colId;
}

function renderDetails(entry: ActivityLogEntry): string | null {
  if (!entry.details) return null;
  const d = entry.details;

  switch (entry.event_type) {
    case 'column_moved':
      return `${getColumnLabel(String(d.from_column ?? '—'))} → ${getColumnLabel(String(d.to_column ?? '—'))}`;
    case 'field_updated':
      return `${String(d.field_name ?? 'Field')}: "${String(d.old_value ?? '')}" → "${String(d.new_value ?? '')}"`;
    case 'commission_approved':
      return d.notes ? `Notes: ${String(d.notes)}` : null;
    case 'commission_denied':
      return `Reason: ${String(d.reason ?? 'No reason provided')}`;
    case 'card_deleted':
      return d.reason ? `Reason: ${String(d.reason)}` : null;
    case 'attachment_uploaded':
      return d.file_name ? String(d.file_name) : null;
    case 'attachment_deleted':
      return d.file_name ? `Removed: ${String(d.file_name)}` : null;
    case 'checklist_item_toggled':
      return d.label ? `${String(d.label)} — ${d.is_checked ? 'Checked' : 'Unchecked'}` : null;
    case 'assigned_changed':
      return `${String(d.from_agent ?? '—')} → ${String(d.to_agent ?? '—')}`;
    default:
      return null;
  }
}

export default function CommercialActivityLog({ quoteId, onClose }: CommercialActivityLogProps) {
  const [activity, setActivity] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivity = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}/activity`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load activity log.');
      }
      const body = await res.json();
      setActivity(body.activity as ActivityLogEntry[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed.');
    } finally {
      setLoading(false);
    }
  }, [quoteId]);

  useEffect(() => {
    void fetchActivity();
  }, [fetchActivity]);

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4">
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-[#223f7a]" />
            <h3 className="text-lg font-black text-slate-900">Activity Log</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 place-items-center rounded-xl text-slate-400 hover:bg-slate-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="max-h-[70vh] overflow-y-auto px-6 py-4">
          {error && (
            <div className={ui.error + ' mb-4'}>
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
              <span className="ml-2 text-sm font-semibold text-slate-500">Loading activity...</span>
            </div>
          ) : activity.length === 0 ? (
            <div className="py-12 text-center text-sm font-semibold text-slate-400">
              No activity recorded yet.
            </div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-4 top-2 bottom-2 w-px bg-slate-200" />

              <div className="space-y-4">
                {activity.map((entry) => {
                  const Icon = EVENT_ICONS[entry.event_type] ?? FileText;
                  const colorClass = EVENT_COLORS[entry.event_type] ?? 'bg-slate-100 text-slate-600';
                  const details = renderDetails(entry);

                  return (
                    <div key={entry.id} className="relative flex gap-3 pl-1">
                      {/* Icon dot */}
                      <div className={`relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full ${colorClass}`}>
                        <Icon className="h-3.5 w-3.5" />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0 pt-0.5">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="text-xs font-black text-slate-800">
                            {entry.profiles?.display_name ?? 'System'}
                          </span>
                          <span className="text-xs font-bold text-slate-500">
                            {ACTIVITY_EVENT_LABELS[entry.event_type] ?? entry.event_type}
                          </span>
                        </div>
                        {details && (
                          <p className="mt-0.5 text-xs font-medium text-slate-600 break-words">
                            {details}
                          </p>
                        )}
                        <p className="mt-1 text-[10px] font-semibold text-slate-400">
                          {formatDateTime(entry.created_at)}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
