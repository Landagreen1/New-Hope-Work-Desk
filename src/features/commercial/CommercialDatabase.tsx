'use client';

import {
  AlertCircle,
  Archive,
  ChevronDown,
  ChevronUp,
  Eye,
  FileText,
  Filter,
  History,
  Paperclip,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import CommercialActivityLog from './CommercialActivityLog';
import CommercialAttachmentViewer from './CommercialAttachmentViewer';
import CommercialCardDetail from './CommercialCardDetail';
import type { BoardColumn, CardStatus, CommercialQuote, CoverageType, RiskLevel } from './types';
import {
  BOARD_COLUMNS,
  COMMISSION_STATUS_STYLES,
  COVERAGE_LABELS,
  RISK_STYLES,
  STATUS_STYLES,
} from './types';

interface CommercialDatabaseProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

type SortField = 'business_name' | 'board_column' | 'risk_level' | 'card_status' | 'created_at' | 'updated_at' | 'assigned_to';
type SortDirection = 'asc' | 'desc';

export default function CommercialDatabase({ initialProfile, embedded = false }: CommercialDatabaseProps) {
  const [quotes, setQuotes] = useState<CommercialQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Filters
  const [searchTerm, setSearchTerm] = useState('');
  const [filterColumn, setFilterColumn] = useState<BoardColumn | ''>('');
  const [filterRisk, setFilterRisk] = useState<RiskLevel | ''>('');
  const [filterStatus, setFilterStatus] = useState<CardStatus | ''>('');
  const [filterCoverage, setFilterCoverage] = useState<CoverageType | ''>('');
  const [showDeleted, setShowDeleted] = useState(false);

  // Sort
  const [sortField, setSortField] = useState<SortField>('updated_at');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  // Detail panels
  const [openDetailId, setOpenDetailId] = useState<string | null>(null);
  const [openActivityId, setOpenActivityId] = useState<string | null>(null);
  const [openAttachmentsId, setOpenAttachmentsId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  const isManager = initialProfile.role === 'manager';

  // ─── Data fetching ───────────────────────────────────────────────────────────
  const fetchQuotes = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (showDeleted) params.set('include_deleted', 'true');
      // Fetch ALL columns for database view (including archive)
      const res = await fetch(`/api/commercial-quotes?board_column=archive&${params.toString()}`);
      const resAll = await fetch(`/api/commercial-quotes?${params.toString()}`);

      if (!resAll.ok) {
        const body = await resAll.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load quotes.');
      }

      const bodyAll = await resAll.json();
      let allQuotes = bodyAll.quotes as CommercialQuote[];

      // Also fetch archived
      if (res.ok) {
        const bodyArchive = await res.json();
        const archivedQuotes = bodyArchive.quotes as CommercialQuote[];
        // Merge, avoiding duplicates
        const existingIds = new Set(allQuotes.map((q) => q.id));
        for (const aq of archivedQuotes) {
          if (!existingIds.has(aq.id)) allQuotes.push(aq);
        }
      }

      setQuotes(allQuotes);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load quotes.');
    } finally {
      setLoading(false);
    }
  }, [showDeleted]);

  useEffect(() => {
    void fetchQuotes();
  }, [fetchQuotes]);

  // ─── Filtered + Sorted data ─────────────────────────────────────────────────
  const filteredQuotes = useMemo(() => {
    let result = quotes;

    // Search
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (q) =>
          q.business_name.toLowerCase().includes(term) ||
          q.description?.toLowerCase().includes(term) ||
          q.policy_number?.toLowerCase().includes(term) ||
          q.profiles?.display_name.toLowerCase().includes(term),
      );
    }

    // Filters
    if (filterColumn) result = result.filter((q) => q.board_column === filterColumn);
    if (filterRisk) result = result.filter((q) => q.risk_level === filterRisk);
    if (filterStatus) result = result.filter((q) => q.card_status === filterStatus);
    if (filterCoverage) result = result.filter((q) => q.coverage_type === filterCoverage);

    // Sort
    result = [...result].sort((a, b) => {
      let aVal: string | number = '';
      let bVal: string | number = '';

      switch (sortField) {
        case 'business_name':
          aVal = a.business_name.toLowerCase();
          bVal = b.business_name.toLowerCase();
          break;
        case 'board_column':
          aVal = BOARD_COLUMNS.findIndex((c) => c.id === a.board_column);
          bVal = BOARD_COLUMNS.findIndex((c) => c.id === b.board_column);
          break;
        case 'risk_level':
          const riskOrder = { low: 0, medium: 1, high: 2 };
          aVal = riskOrder[a.risk_level];
          bVal = riskOrder[b.risk_level];
          break;
        case 'card_status':
          aVal = a.card_status;
          bVal = b.card_status;
          break;
        case 'created_at':
          aVal = new Date(a.created_at).getTime();
          bVal = new Date(b.created_at).getTime();
          break;
        case 'updated_at':
          aVal = new Date(a.updated_at).getTime();
          bVal = new Date(b.updated_at).getTime();
          break;
        case 'assigned_to':
          aVal = a.profiles?.display_name?.toLowerCase() ?? '';
          bVal = b.profiles?.display_name?.toLowerCase() ?? '';
          break;
      }

      if (aVal < bVal) return sortDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [quotes, searchTerm, filterColumn, filterRisk, filterStatus, filterCoverage, sortField, sortDir]);

  // ─── Handlers ───────────────────────────────────────────────────────────────
  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const handleDelete = async (quoteId: string) => {
    try {
      const res = await fetch(`/api/commercial-quotes/${quoteId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: deleteReason }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Delete failed.');
      }
      setDeleteConfirmId(null);
      setDeleteReason('');
      await fetchQuotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    }
  };

  const clearFilters = () => {
    setSearchTerm('');
    setFilterColumn('');
    setFilterRisk('');
    setFilterStatus('');
    setFilterCoverage('');
  };

  const hasActiveFilters = searchTerm || filterColumn || filterRisk || filterStatus || filterCoverage;

  // ─── Format helpers ─────────────────────────────────────────────────────────
  function formatDate(iso: string): string {
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field) return <ChevronDown className="h-3 w-3 text-slate-300" />;
    return sortDir === 'asc' ? (
      <ChevronUp className="h-3 w-3 text-[#223f7a]" />
    ) : (
      <ChevronDown className="h-3 w-3 text-[#223f7a]" />
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Header */}
      <div className="mb-5 flex flex-col gap-3 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
            {isManager ? 'Management Database' : 'Commercial Database'}
          </p>
          <h2 className={ui.pageTitle}>Quotes Database</h2>
          <p className={ui.pageSubtitle}>
            Complete list of all commercial quote cards with full history and actions.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {lastUpdated && (
            <p className="text-xs font-bold text-slate-400">
              {filteredQuotes.length} of {quotes.length} records
            </p>
          )}
          {isManager && (
            <button
              type="button"
              onClick={() => setShowDeleted(!showDeleted)}
              className={showDeleted ? ui.btnDanger + ' text-xs' : ui.btnSecondary + ' text-xs'}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {showDeleted ? 'Hide Deleted' : 'Show Deleted'}
            </button>
          )}
          <button type="button" onClick={() => void fetchQuotes()} className={ui.btnSecondary}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters Bar */}
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search business name, policy, agent..."
            className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm font-medium outline-none focus:border-[#7890bc] focus:ring-2 focus:ring-[#eef3fb]"
          />
        </div>

        {/* Column filter */}
        <select
          value={filterColumn}
          onChange={(e) => setFilterColumn(e.target.value as BoardColumn | '')}
          className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
        >
          <option value="">All Columns</option>
          {BOARD_COLUMNS.map((col) => (
            <option key={col.id} value={col.id}>{col.label}</option>
          ))}
        </select>

        {/* Risk filter */}
        <select
          value={filterRisk}
          onChange={(e) => setFilterRisk(e.target.value as RiskLevel | '')}
          className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
        >
          <option value="">All Risk</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>

        {/* Status filter */}
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value as CardStatus | '')}
          className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
        >
          <option value="">All Statuses</option>
          <option value="in_progress">In Progress</option>
          <option value="done">Done</option>
          <option value="blocked">Blocked</option>
          <option value="waiting">Waiting</option>
        </select>

        {/* Coverage filter */}
        <select
          value={filterCoverage}
          onChange={(e) => setFilterCoverage(e.target.value as CoverageType | '')}
          className="rounded-xl border border-slate-200 px-3 py-2.5 text-xs font-bold text-slate-700 outline-none focus:border-[#7890bc]"
        >
          <option value="">All Coverage</option>
          {Object.entries(COVERAGE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>

        {hasActiveFilters && (
          <button type="button" onClick={clearFilters} className="text-xs font-bold text-slate-500 hover:text-rose-600">
            <X className="inline h-3.5 w-3.5" /> Clear
          </button>
        )}
      </div>

      {/* Error */}
      {error && (
        <div className={ui.error + ' mb-4'}>
          <AlertCircle className="mr-2 inline h-4 w-4" />
          {error}
          <button type="button" onClick={() => setError(null)} className="ml-3 text-xs font-bold underline">
            Dismiss
          </button>
        </div>
      )}

      {/* Table */}
      {loading && quotes.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-sm font-semibold text-slate-500">Loading database...</span>
        </div>
      ) : filteredQuotes.length === 0 ? (
        <div className={ui.empty}>
          {hasActiveFilters ? 'No records match your filters.' : 'No commercial quotes yet.'}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th + ' cursor-pointer select-none'} onClick={() => handleSort('business_name')}>
                  <span className="flex items-center gap-1">Business <SortIcon field="business_name" /></span>
                </th>
                {isManager && (
                  <th className={ui.th + ' cursor-pointer select-none'} onClick={() => handleSort('assigned_to')}>
                    <span className="flex items-center gap-1">Agent <SortIcon field="assigned_to" /></span>
                  </th>
                )}
                <th className={ui.th + ' cursor-pointer select-none'} onClick={() => handleSort('board_column')}>
                  <span className="flex items-center gap-1">Column <SortIcon field="board_column" /></span>
                </th>
                <th className={ui.th + ' cursor-pointer select-none'} onClick={() => handleSort('risk_level')}>
                  <span className="flex items-center gap-1">Risk <SortIcon field="risk_level" /></span>
                </th>
                <th className={ui.th + ' cursor-pointer select-none'} onClick={() => handleSort('card_status')}>
                  <span className="flex items-center gap-1">Status <SortIcon field="card_status" /></span>
                </th>
                <th className={ui.th}>Coverage</th>
                <th className={ui.th}>Commission</th>
                <th className={ui.th + ' cursor-pointer select-none'} onClick={() => handleSort('updated_at')}>
                  <span className="flex items-center gap-1">Updated <SortIcon field="updated_at" /></span>
                </th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredQuotes.map((quote) => {
                const columnDef = BOARD_COLUMNS.find((c) => c.id === quote.board_column);
                const riskStyle = RISK_STYLES[quote.risk_level];
                const statusStyle = STATUS_STYLES[quote.card_status];
                const commStyle = quote.commission_status ? COMMISSION_STATUS_STYLES[quote.commission_status] : null;

                return (
                  <tr
                    key={quote.id}
                    className={`${ui.trHover} ${quote.is_deleted ? 'opacity-50 bg-rose-50/30' : ''}`}
                  >
                    <td className={ui.td}>
                      <div className="min-w-[140px]">
                        <p className="font-black text-slate-900 text-sm">{quote.business_name}</p>
                        {quote.policy_number && (
                          <p className="text-[10px] font-semibold text-slate-400 mt-0.5">#{quote.policy_number}</p>
                        )}
                        {quote.is_deleted && (
                          <span className="text-[10px] font-bold text-rose-600">(Deleted)</span>
                        )}
                      </div>
                    </td>
                    {isManager && (
                      <td className={ui.td}>
                        <span className="text-xs font-bold text-slate-700">
                          {quote.profiles?.display_name ?? '—'}
                        </span>
                      </td>
                    )}
                    <td className={ui.td}>
                      <span className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${columnDef?.color ?? 'bg-slate-400'}`} />
                        <span className="text-xs font-bold text-slate-700">{columnDef?.label ?? quote.board_column}</span>
                      </span>
                    </td>
                    <td className={ui.td}>
                      <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${riskStyle.bg} ${riskStyle.text}`}>
                        {riskStyle.label}
                      </span>
                    </td>
                    <td className={ui.td}>
                      <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${statusStyle.bg} ${statusStyle.text}`}>
                        {statusStyle.label}
                      </span>
                    </td>
                    <td className={ui.td}>
                      <span className="text-xs font-semibold text-slate-600">
                        {quote.coverage_type ? COVERAGE_LABELS[quote.coverage_type] ?? quote.coverage_type : '—'}
                      </span>
                    </td>
                    <td className={ui.td}>
                      {commStyle ? (
                        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-bold ${commStyle.bg} ${commStyle.text}`}>
                          {commStyle.label}
                        </span>
                      ) : (
                        <span className="text-[10px] text-slate-400">—</span>
                      )}
                    </td>
                    <td className={ui.td}>
                      <span className="text-xs font-semibold text-slate-500">{formatDate(quote.updated_at)}</span>
                    </td>
                    <td className={ui.td}>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setOpenDetailId(quote.id)}
                          className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-blue-50 hover:text-[#223f7a]"
                          title="Open card"
                        >
                          <Eye className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setOpenActivityId(quote.id)}
                          className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-violet-50 hover:text-violet-700"
                          title="Activity log"
                        >
                          <History className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setOpenAttachmentsId(quote.id)}
                          className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-amber-50 hover:text-amber-700"
                          title="Attachments"
                        >
                          <Paperclip className="h-3.5 w-3.5" />
                        </button>
                        {!quote.is_deleted && isManager && (
                          <button
                            type="button"
                            onClick={() => setDeleteConfirmId(quote.id)}
                            className="grid h-7 w-7 place-items-center rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                            title="Delete"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Card Detail Modal */}
      {openDetailId && (
        <CommercialCardDetail
          quoteId={openDetailId}
          onClose={() => setOpenDetailId(null)}
          onRefresh={fetchQuotes}
        />
      )}

      {/* Activity Log Modal */}
      {openActivityId && (
        <CommercialActivityLog
          quoteId={openActivityId}
          onClose={() => setOpenActivityId(null)}
        />
      )}

      {/* Attachment Viewer Modal */}
      {openAttachmentsId && (
        <CommercialAttachmentViewer
          quoteId={openAttachmentsId}
          onClose={() => setOpenAttachmentsId(null)}
        />
      )}

      {/* Delete Confirmation Dialog */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-black text-slate-900">Delete Card</h3>
            <p className="mt-2 text-sm font-medium text-slate-600">
              This will soft-delete the card. It can be restored by a manager later.
            </p>
            <div className="mt-4">
              <label className={ui.label}>Reason (optional)</label>
              <input
                type="text"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="Why is this being deleted?"
                className={ui.input}
              />
            </div>
            <div className="mt-5 flex items-center gap-3">
              <button
                type="button"
                onClick={() => void handleDelete(deleteConfirmId)}
                className={ui.btnDanger}
              >
                <Trash2 className="h-4 w-4" />
                Delete
              </button>
              <button
                type="button"
                onClick={() => { setDeleteConfirmId(null); setDeleteReason(''); }}
                className={ui.btnSecondary}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
