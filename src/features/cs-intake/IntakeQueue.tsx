'use client';

import { CheckCircle2, Edit3, ExternalLink, Eye, FileText, RefreshCw, RotateCcw, Search, Trash2, UserCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabase, listActiveAgents } from '../nhwd-shared/client';
import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { csIntakeStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import { subscribeToRotationChanges } from '../notifications/api';
import IntakeEditForm from './IntakeEditForm';
import IntakeForm from './IntakeForm';
import QuoteActivityModal from './QuoteActivityModal';
import {
  claimIntake,
  claimRingcentralQueueIntake,
  convertIntake,
  deleteCustomerIntake,
  deleteLinkedWorkItem,
  getIntake,
  getLinkedQuoteStatuses,
  listAllIntakes,
  listQueue,
  managerAssignIntake,
  profileName,
  restoreCustomerIntake,
  returnIntake,
  type CsIntakeDriver,
  type CsIntakeSubmission,
  type CsIntakeVehicle,
} from './api';

type LoadedIntake = {
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
};

type ModalMode = 'view' | 'edit';

// Source display helper
function sourceLabel(row: CsIntakeSubmission, dealers: { id: string; name: string }[]): string {
  if (row.dealer_id) {
    const dealer = dealers.find((d) => d.id === row.dealer_id);
    return dealer ? dealer.name : 'Dealership';
  }
  // Fallback to line_of_business / generic source info
  if (row.business_name) return 'Commercial';
  return 'Direct';
}

function quoteStatusTone(status: string | undefined): string {
  switch (status) {
    case 'active': return ui.badgeTone.info;
    case 'price_sent': return ui.badgeTone.violet;
    case 'sold': return ui.badgeTone.success;
    case 'not_sold': return ui.badgeTone.danger;
    case 'completed': return ui.badgeTone.success;
    case 'cancelled': return ui.badgeTone.danger;
    default: return ui.badgeTone.neutral;
  }
}

function QueueModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <div className="mx-auto max-w-6xl rounded-[30px] bg-[#f3f5f9] p-3 shadow-2xl sm:p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-3 flex justify-end"><button className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button></div>
        {children}
      </div>
    </div>
  );
}

export default function IntakeQueue({
  initialProfile: profile,
  embedded = false,
}: {
  initialProfile: ProfileLite;
  embedded?: boolean;
}) {
  const [agents, setAgents] = useState<ProfileLite[]>([]);
  const [rows, setRows] = useState<CsIntakeSubmission[]>([]);
  const [selected, setSelected] = useState<LoadedIntake | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>('view');
  const [search, setSearch] = useState('');
  const [coverage, setCoverage] = useState('all');
  const [priority, setPriority] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // RingCentral rotation state
  const [rcTurnHolderId, setRcTurnHolderId] = useState<string | null>(null);
  const [quoteStatuses, setQuoteStatuses] = useState<Map<string, string>>(new Map());

  // Quote Activity Modal state
  const [selectedQuoteWorkItemId, setSelectedQuoteWorkItemId] = useState<string | null>(null);
  const [isQuoteActivityOpen, setIsQuoteActivityOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const [queueRows, activeAgents] = await Promise.all([
        listAllIntakes(),
        listActiveAgents(),
      ]);
      setRows(queueRows);
      setAgents(activeAgents);
      setLastUpdated(new Date());

      // Fetch quote statuses for converted rows
      const convertedWorkItemIds = queueRows
        .filter(r => r.status === 'converted' && r.work_item_id)
        .map(r => r.work_item_id!);
      if (convertedWorkItemIds.length) {
        const statuses = await getLinkedQuoteStatuses(convertedWorkItemIds);
        setQuoteStatuses(statuses);
      } else {
        setQuoteStatuses(new Map());
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the Sales Intake Queue.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Load current rotation state on mount
  useEffect(() => {
    async function loadRotation() {
      try {
        const supabase = getSupabase();
        const { data } = await supabase
          .from('rotation_state')
          .select('current_profile_id')
          .eq('kind', 'ringcentral')
          .maybeSingle();
        if (data?.current_profile_id) {
          setRcTurnHolderId(data.current_profile_id);
        }
      } catch {
        // Rotation state may not exist yet — non-blocking
      }
    }
    void loadRotation();
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Real-time: queue updates
  // Task 6.4: The refresh() function atomically fetches both intake data and quote statuses
  // for converted rows, so any subscription that triggers refresh() will update quote visibility.
  // We also subscribe to work_items changes so quote status updates (e.g., active → price_sent)
  // from the Sales side are reflected promptly without waiting for the 60s polling interval.
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('sales-intake-queue-v1')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cs_intake_submissions' }, () => void refresh())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'customer_intakes' }, () => void refresh())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'work_items' }, () => void refresh())
      .subscribe();
    const interval = window.setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      void supabase.removeChannel(channel);
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // Real-time: rotation state changes
  useEffect(() => {
    const channel = subscribeToRotationChanges((newState) => {
      if (newState.kind === 'ringcentral') {
        setRcTurnHolderId(newState.current_profile_id);
      }
    });
    return () => {
      void getSupabase().removeChannel(channel);
    };
  }, []);

  // Determine if current user is the RC turn holder or a Manager
  const isCurrentRcAgent = profile.id === rcTurnHolderId;
  const isManager = profile.role === 'manager';
  const canClaimRc = isCurrentRcAgent;

  // Resolve RC turn holder display name
  const rcTurnHolderName = useMemo(() => {
    if (!rcTurnHolderId) return 'Not assigned';
    const found = agents.find((a) => a.id === rcTurnHolderId);
    return found?.display_name ?? 'Loading…';
  }, [rcTurnHolderId, agents]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      const matchesSearch = !needle || [row.insured_first_name, row.insured_last_name, row.business_name, row.insured_phone_primary, row.dot_number].some((value) => value?.toLowerCase().includes(needle));
      const matchesCoverage = coverage === 'all'
        || (coverage === 'personal_auto' && ['auto', 'personal_auto'].includes(row.line_of_business))
        || row.line_of_business === coverage;
      const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
      return matchesSearch && matchesCoverage && matchesStatus && (priority === 'all' || row.priority === priority);
    });
  }, [coverage, priority, rows, search, statusFilter]);

  async function show(row: CsIntakeSubmission) {
    try {
      const detail = await getIntake(row.id);
      if (detail) {
        setSelected({ submission: detail.submission, drivers: detail.drivers, vehicles: detail.vehicles });
        setModalMode('view');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open the intake.');
    }
  }

  async function action(id: string, task: () => Promise<void>, success: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(success);
      setSelected(null);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The action could not be completed. Another agent may have claimed the intake first.');
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function handleClaimRc(row: CsIntakeSubmission) {
    await action(row.id, async () => {
      await claimRingcentralQueueIntake(row.id);
    }, 'RingCentral intake claimed. Your active quote was created and the turn advanced.');
  }

  async function handleClaimGeneral(row: CsIntakeSubmission) {
    await action(row.id, () => claimIntake(row.id), 'Intake claimed. Review and convert it to create the quote.');
  }

  async function handleCreateQuote(row: CsIntakeSubmission) {
    if (isRingcentralSource(row) && row.claimed_by === profile.id) {
      await handleClaimRc(row);
      return;
    }

    await action(
      row.id,
      async () => { await convertIntake(row.id); },
      'Quote created in the Work Desk.',
    );
  }

  async function assign(row: CsIntakeSubmission, agentId: string) {
    if (!agentId) return;
    await action(row.id, () => managerAssignIntake(row.id, agentId), `Intake assigned to ${profileName(agents, agentId)}.`);
  }

  async function requestReturn(row: CsIntakeSubmission) {
    if (!profile) return;
    const reason = window.prompt('What information must Customer Service correct or complete?');
    if (!reason?.trim()) return;
    await action(row.id, () => returnIntake(row.id, profile.id, reason.trim()), 'Intake returned to Customer Service.');
  }

  // ─── Manager-specific actions ──────────────────────────────────────────────

  async function handleDelete(row: CsIntakeSubmission) {
    const reason = window.prompt('Provide a reason for deleting this intake (min 5 characters):');
    if (!reason?.trim() || reason.trim().length < 5) {
      if (reason !== null) setError('Delete reason must be at least 5 characters.');
      return;
    }
    await action(row.id, async () => {
      await deleteCustomerIntake(row.id, reason.trim());
    }, 'Intake deleted.');
  }

  async function handleRestore(row: CsIntakeSubmission) {
    const reason = window.prompt('Provide a reason for restoring this intake:');
    if (!reason?.trim()) return;
    await action(row.id, async () => {
      await restoreCustomerIntake(row.id, reason.trim());
    }, 'Intake restored to its previous status.');
  }

  async function handleDeleteQuote(row: CsIntakeSubmission) {
    if (!row.work_item_id) return;
    const reason = window.prompt('Provide a reason for deleting this linked quote (min 5 characters):');
    if (!reason?.trim() || reason.trim().length < 5) {
      if (reason !== null) setError('Delete reason must be at least 5 characters.');
      return;
    }
    await action(row.id, async () => {
      await deleteLinkedWorkItem(row.work_item_id!, reason.trim());
    }, 'Linked quote cancelled successfully.');
  }

  async function handleEdit(row: CsIntakeSubmission) {
    try {
      const detail = await getIntake(row.id);
      if (detail) {
        setSelected({ submission: detail.submission, drivers: detail.drivers, vehicles: detail.vehicles });
        setModalMode('edit');
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open the intake for editing.');
    }
  }

  function handleOpenLinkedQuote(row: CsIntakeSubmission) {
    // The converted_at field indicates a linked quote exists.
    // Navigate to the quotes detail page using the intake ID as reference.
    if (row.converted_at) {
      window.location.href = `/tools/quotes?intake=${row.id}`;
    }
  }

  function closeModal() {
    setSelected(null);
    setModalMode('view');
  }

  // Determine if a row is RingCentral-sourced
  function isRingcentralSource(row: CsIntakeSubmission): boolean {
    // Legacy Customer Service submissions are RingCentral queue items by default.
    // Manager-assigned records are explicitly marked as manual by the migration.
    return row.intake_channel !== 'manual';
  }

  if (loading) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">Loading Sales Intake Queue…</div>;
  if (!['agent', 'manager'].includes(profile.role)) return <div className="grid min-h-screen place-items-center bg-[#f3f5f9]"><div className={ui.error}>The Sales Intake Queue is available to Agents and Managers.</div></div>;

  return (
    <ModuleShell
      title="Sales Intake Queue"
      subtitle="Claim a complete Customer Service intake or let a Manager assign it directly. Converting the intake creates the quote and makes the Sales Agent the owner."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void refresh()}
      embedded={embedded}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}
      {notice ? <div className={`${ui.success} mb-5`}>{notice}</div> : null}

      {/* RC Turn Holder Banner */}
      <section className="mb-5 rounded-2xl border border-blue-200 bg-blue-50 px-5 py-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-wide text-blue-600">RingCentral Turn</p>
            <p className="mt-0.5 text-sm font-bold text-blue-900">
              {isCurrentRcAgent ? (
                <>It&apos;s your turn — you can claim RingCentral intakes</>
              ) : (
                <>Current turn: <span className="font-black">{rcTurnHolderName}</span></>
              )}
            </p>
          </div>
          {isCurrentRcAgent && (
            <span className={`${ui.badge} ${ui.badgeTone.success}`}>Your Turn</span>
          )}
        </div>
      </section>

      <section className={`${ui.card} mt-5 overflow-hidden`}>
        <div className={ui.cardHeader}>
          <div><p className={ui.sectionTitle}>Shared Queue</p><h2 className="mt-1 text-xl font-black">Customer Service submissions</h2><p className="mt-1 text-sm font-semibold text-slate-500">Claiming is atomic—only one Agent can win when multiple people click at the same time.</p></div>
          <button type="button" className={ui.btnSecondary} onClick={() => void refresh()}><RefreshCw className="h-4 w-4" />Refresh</button>
        </div>
        <div className={`grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[1fr_180px_180px_180px]`}>
          <label className="relative"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-semibold outline-none focus:border-[#7890bc]" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search customer, business, phone or DOT" /></label>
          <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={coverage} onChange={(event) => setCoverage(event.target.value)}><option value="all">All coverage types</option><option value="personal_auto">Personal Auto</option><option value="commercial_auto">Commercial Auto</option></select>
          <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
            <option value="all">All statuses</option>
            <option value="submitted">Submitted</option>
            <option value="claimed">Claimed</option>
            <option value="converted">Converted</option>
            <option value="returned">Returned</option>
            {isManager && <option value="draft">Draft</option>}
            {isManager && <option value="rejected">Rejected</option>}
            {isManager && <option value="deleted">Deleted</option>}
          </select>
          <select className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" value={priority} onChange={(event) => setPriority(event.target.value)}><option value="all">All priorities</option><option value="urgent">Urgent</option><option value="high">High</option><option value="normal">Normal</option></select>
        </div>
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Source</th>
                <th className={ui.th}>Customer Name</th>
                <th className={ui.th}>Submitted</th>
                <th className={ui.th}>Status</th>
                <th className={ui.th}>Quote Status</th>
                <th className={ui.th}>Agent</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const customer = row.business_name || `${row.insured_first_name} ${row.insured_last_name}`.trim();
                const isMine = row.claimed_by === profile.id;
                const canConvert = isMine || isManager;
                const isRc = isRingcentralSource(row);
                const isDeleted = row.status === 'deleted';
                const hasLinkedQuote = Boolean(row.converted_at);
                // Req 24.6: If intake already has a linked quote, don't allow duplicate assignment
                const canAssign = isManager && row.status === 'submitted' && !hasLinkedQuote;

                return (
                  <tr key={row.id} className={`hover:bg-[#f8faff] ${isDeleted ? 'opacity-60' : ''}`}>
                    {/* Source */}
                    <td className={ui.td}>
                      <p className="font-bold text-slate-800">
                        {isRc ? 'RingCentral' : row.line_of_business === 'commercial_auto' ? 'Commercial' : 'Personal'}
                      </p>
                      {row.dealer_id && <p className="mt-0.5 text-xs text-slate-400">Dealership</p>}
                    </td>

                    {/* Customer Name */}
                    <td className={ui.td}>
                      <p className="font-black text-slate-900">{customer || 'Unnamed intake'}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-400">{row.insured_phone_primary || 'No phone'}{row.dot_number ? ` · DOT ${row.dot_number}` : ''}</p>
                    </td>

                    {/* Submission Date */}
                    <td className={ui.td}>
                      <p className="text-xs font-bold text-slate-600">
                        {row.submitted_at
                          ? new Date(row.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                          : 'Not submitted'}
                      </p>
                      {row.submitted_at && (
                        <p className="mt-0.5 text-xs text-slate-400">
                          {new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
                            -Math.max(0, Math.round((Date.now() - new Date(row.submitted_at).getTime()) / 3_600_000)),
                            'hour',
                          )}
                        </p>
                      )}
                    </td>

                    {/* Status */}
                    <td className={ui.td}>
                      <div className="flex flex-wrap gap-2">
                        <span className={`${ui.badge} ${ui.badgeTone[csIntakeStatusTone[row.status] || 'neutral']}`}>{statusLabel(row.status)}</span>
                        <span className={`${ui.badge} ${row.priority === 'urgent' ? ui.badgeTone.danger : row.priority === 'high' ? ui.badgeTone.progress : ui.badgeTone.neutral}`}>{statusLabel(row.priority)}</span>
                      </div>
                    </td>

                    {/* Quote Status (only for converted rows with linked work item) */}
                    <td className={ui.td}>
                      {hasLinkedQuote && row.work_item_id ? (
                        <span className={`${ui.badge} ${quoteStatusTone(quoteStatuses.get(row.work_item_id))}`}>
                          {statusLabel(quoteStatuses.get(row.work_item_id) ?? 'unknown')}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>

                    {/* Agent (who claimed or is assigned) */}
                    <td className={ui.td}>
                      {row.claimed_by ? (
                        <p className="font-bold text-slate-700">{profileName(agents, row.claimed_by)}</p>
                      ) : isRc && row.status === 'submitted' ? (
                        <div>
                          <p className="font-bold text-slate-700">{rcTurnHolderName}</p>
                          {isCurrentRcAgent && (
                            <p className="mt-0.5 text-xs text-emerald-600 font-semibold">Your turn</p>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-400">Unassigned</p>
                      )}
                    </td>

                    {/* Actions */}
                    <td className={ui.td}>
                      <div className="flex min-w-[260px] flex-wrap gap-2">
                        <button type="button" className={ui.btnSecondary} onClick={() => void show(row)}><Eye className="h-4 w-4" />View</button>

                        {/* Log: visible for converted rows with linked work item — all roles */}
                        {hasLinkedQuote && row.work_item_id ? (
                          <button
                            type="button"
                            className={ui.btnSecondary}
                            onClick={() => {
                              setSelectedQuoteWorkItemId(row.work_item_id);
                              setIsQuoteActivityOpen(true);
                            }}
                          >
                            <FileText className="h-4 w-4" />Log
                          </button>
                        ) : null}

                        {/* Delete Quote: Manager only */}
                        {isManager && hasLinkedQuote && row.work_item_id ? (
                          <button
                            type="button"
                            className={ui.btnDanger}
                            disabled={busyId === row.id}
                            onClick={() => void handleDeleteQuote(row)}
                          >
                            <Trash2 className="h-4 w-4" />Delete Quote
                          </button>
                        ) : null}

                        {/* Edit: Manager can always edit; agent who created can edit if not yet assigned to another agent */}
                        {!isDeleted && (
                          isManager
                          || (profile.role === 'agent' && row.created_by === profile.id && (!row.claimed_by || row.claimed_by === profile.id))
                        ) ? (
                          <button type="button" className={ui.btnSecondary} disabled={busyId === row.id} onClick={() => void handleEdit(row)}>
                            <Edit3 className="h-4 w-4" />Edit
                          </button>
                        ) : null}

                        {/* RingCentral-sourced unclaimed: claim only if current RC agent or manager */}
                        {isRc && row.status === 'submitted' && canClaimRc && !isDeleted ? (
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            disabled={busyId === row.id}
                            onClick={() => void handleClaimRc(row)}
                          >
                            <UserCheck className="h-4 w-4" />Claim
                          </button>
                        ) : null}

                        {/* RingCentral-sourced unclaimed but NOT current agent: show disabled with tooltip */}
                        {isRc && row.status === 'submitted' && !canClaimRc && !isManager ? (
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            disabled
                            title={`Only ${rcTurnHolderName} can claim RingCentral intakes right now`}
                          >
                            <UserCheck className="h-4 w-4" />Claim
                          </button>
                        ) : null}

                        {/* Non-RingCentral unclaimed: any agent can claim */}
                        {!isRc && row.status === 'submitted' && profile.role === 'agent' ? (
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            disabled={busyId === row.id}
                            onClick={() => void handleClaimGeneral(row)}
                          >
                            <UserCheck className="h-4 w-4" />Claim
                          </button>
                        ) : null}

                        {canConvert && row.status === 'claimed' && !isDeleted ? (
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            disabled={busyId === row.id}
                            onClick={() => void handleCreateQuote(row)}
                          >
                            <CheckCircle2 className="h-4 w-4" />Create Quote
                          </button>
                        ) : null}

                        {/* Manager: Assign */}
                        {canAssign ? (
                          <select className="rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a]" defaultValue="" onChange={(event) => void assign(row, event.target.value)}>
                            <option value="" disabled>Assign to…</option>
                            {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name}</option>)}
                          </select>
                        ) : null}

                        {/* Return button (not for deleted intakes) */}
                        {!isDeleted && (row.status === 'submitted' || canConvert) ? (
                          <button type="button" className={ui.btnDanger} disabled={busyId === row.id} onClick={() => void requestReturn(row)}>Return</button>
                        ) : null}

                        {/* Manager: Delete intake */}
                        {isManager && !isDeleted ? (
                          <button type="button" className={ui.btnDanger} disabled={busyId === row.id} onClick={() => void handleDelete(row)}>
                            <Trash2 className="h-4 w-4" />Delete
                          </button>
                        ) : null}

                        {/* Manager: Restore (only for deleted intakes) */}
                        {isManager && isDeleted ? (
                          <button type="button" className={ui.btnSecondary} disabled={busyId === row.id} onClick={() => void handleRestore(row)}>
                            <RotateCcw className="h-4 w-4" />Restore
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length ? <div className={ui.empty}>No intakes match the current filters.</div> : null}
        </div>
      </section>

      <QueueModal open={Boolean(selected)} onClose={closeModal}>
        {selected ? (
          <div className="space-y-4">
            {/* View mode: read-only intake form */}
            {modalMode === 'view' && (
              <>
                <IntakeForm profileId={profile.id} initial={selected} readOnly onDone={closeModal} />
                <div className="sticky bottom-4 flex flex-wrap justify-end gap-2 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl">
                  {/* RC claim in modal */}
                  {isRingcentralSource(selected.submission) && selected.submission.status === 'submitted' && canClaimRc ? (
                    <button className={ui.btnPrimary} disabled={busyId === selected.submission.id} onClick={() => void handleClaimRc(selected.submission)}><UserCheck className="h-4 w-4" />Claim RingCentral Intake</button>
                  ) : null}
                  {/* General claim in modal */}
                  {!isRingcentralSource(selected.submission) && selected.submission.status === 'submitted' && profile.role === 'agent' ? (
                    <button className={ui.btnPrimary} disabled={busyId === selected.submission.id} onClick={() => void handleClaimGeneral(selected.submission)}><UserCheck className="h-4 w-4" />Claim Intake</button>
                  ) : null}
                  {(selected.submission.claimed_by === profile.id || isManager) && selected.submission.status === 'claimed' ? (
                    <button className={ui.btnPrimary} disabled={busyId === selected.submission.id} onClick={() => void handleCreateQuote(selected.submission)}><CheckCircle2 className="h-4 w-4" />Create Quote</button>
                  ) : null}
                  {/* Manager: Open Linked Quote from modal */}
                  {isManager && selected.submission.converted_at ? (
                    <button className={ui.btnSecondary} onClick={() => handleOpenLinkedQuote(selected.submission)}>
                      <ExternalLink className="h-4 w-4" />Open Linked Quote
                    </button>
                  ) : null}
                </div>
              </>
            )}

            {/* Edit mode: IntakeEditForm */}
            {modalMode === 'edit' && (
              <IntakeEditForm
                intake={selected.submission}
                drivers={selected.drivers}
                vehicles={selected.vehicles}
                profile={profile}
                onSave={() => { closeModal(); void refresh(); }}
                onCancel={closeModal}
              />
            )}
          </div>
        ) : null}
      </QueueModal>

      <QuoteActivityModal
        workItemId={selectedQuoteWorkItemId}
        isOpen={isQuoteActivityOpen}
        onClose={() => {
          setIsQuoteActivityOpen(false);
          setSelectedQuoteWorkItemId(null);
        }}
      />
    </ModuleShell>
  );
}
