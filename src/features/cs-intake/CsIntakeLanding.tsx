'use client';

import { ClipboardList, Eye, FilePlus2, Pencil, RefreshCw, Search, Send, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSupabase } from '../nhwd-shared/client';
import type { ProfileLite } from '../nhwd-shared/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import { csIntakeStatusTone, statusLabel, ui } from '../nhwd-shared/ui';
import IntakeForm from './IntakeForm';
import {
  getIntake,
  listMyIntakes,
  submitIntake,
  type CsIntakeDriver,
  type CsIntakeSubmission,
  type CsIntakeVehicle,
} from './api';

type LoadedIntake = {
  submission: CsIntakeSubmission;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
};

/** Statuses that allow editing by the creating CS_User */
const EDITABLE_STATUSES = new Set(['draft', 'submitted', 'claimed', 'converted']);

/** Statuses that allow the Submit action */
const SUBMITTABLE_STATUSES = new Set(['draft']);

function IntakeModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6" onMouseDown={onClose}>
      <div className="mx-auto max-w-6xl rounded-[30px] bg-[#f3f5f9] p-3 shadow-2xl sm:p-5" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-3 flex justify-end"><button type="button" className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" />Close</button></div>
        {children}
      </div>
    </div>
  );
}

/**
 * CS Intake Landing — shows only intakes created by the viewing CS_User.
 *
 * Displays: customer name, source, submission date, status, assigned agent, linked quote ID.
 * Sorted: Drafts first, then by submitted_at descending.
 * Actions: View (all), Edit (Draft/Submitted/Waiting), Submit (Draft only).
 * No delete action available to CS_Users (Req 22.5).
 */
export default function CsIntakeLanding({
  initialProfile: profile,
  embedded = false,
}: {
  initialProfile: ProfileLite;
  embedded?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [rows, setRows] = useState<CsIntakeSubmission[]>([]);
  const [selected, setSelected] = useState<LoadedIntake | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoOpened, setAutoOpened] = useState(false);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listMyIntakes(profile.id);
      setRows(data);
      setLastUpdated(new Date());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to load quote intakes.');
    } finally {
      setLoading(false);
    }
  }, [profile.id]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Real-time subscription for intake updates
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('cs-intake-landing-cs')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cs_intake_submissions' }, () => void refresh())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [refresh]);

  // Auto-open intake when navigating with ?edit=<id>
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (!profile || !editId || autoOpened) return;
    setAutoOpened(true);
    getIntake(editId)
      .then((data) => {
        if (data) setSelected({ submission: data.submission, drivers: data.drivers, vehicles: data.vehicles });
        else setError('The linked intake could not be found.');
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : 'Unable to open the linked intake.'));
  }, [autoOpened, profile, searchParams]);

  // Sort: Drafts first, then by submitted_at descending
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aDraft = a.status === 'draft' ? 0 : 1;
      const bDraft = b.status === 'draft' ? 0 : 1;
      if (aDraft !== bDraft) return aDraft - bDraft;
      // Both drafts or both non-drafts: sort by submitted_at descending, fallback to updated_at
      const aDate = a.submitted_at || a.updated_at;
      const bDate = b.submitted_at || b.updated_at;
      return new Date(bDate).getTime() - new Date(aDate).getTime();
    });
  }, [rows]);

  // Filter by search and status
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sorted.filter((row) => {
      const matchesStatus = statusFilter === 'all' || row.status === statusFilter;
      const customerName = row.business_name || `${row.insured_first_name ?? ''} ${row.insured_last_name ?? ''}`.trim();
      const matchesSearch = !needle || customerName.toLowerCase().includes(needle);
      return matchesStatus && matchesSearch;
    });
  }, [sorted, search, statusFilter]);

  async function openExisting(row: CsIntakeSubmission) {
    try {
      setError(null);
      const data = await getIntake(row.id);
      if (data) setSelected({ submission: data.submission, drivers: data.drivers, vehicles: data.vehicles });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to open the intake.');
    }
  }

  async function handleSubmit(row: CsIntakeSubmission) {
    try {
      setSubmitting(row.id);
      setError(null);
      await submitIntake(row.id);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to submit the intake.');
    } finally {
      setSubmitting(null);
    }
  }

  function closeForm() {
    setCreating(false);
    setSelected(null);
    void refresh();
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f3f5f9] font-black text-slate-500">
        Loading Quote Intake...
      </div>
    );
  }

  if (!['customer_service', 'manager', 'agent'].includes(profile.role)) {
    return (
      <div className="grid min-h-screen place-items-center bg-[#f3f5f9] p-6">
        <div className={ui.error}>This view is not available for your role.</div>
      </div>
    );
  }

  const drafts = rows.filter((row) => row.status === 'draft').length;
  const submitted = rows.filter((row) => ['submitted', 'claimed'].includes(row.status)).length;
  const converted = rows.filter((row) => row.status === 'converted').length;

  return (
    <ModuleShell
      title="Customer Service Quote Intake"
      subtitle="Create, edit, and track your quote intakes. Submit completed intakes to the Sales team for processing."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void refresh()}
      embedded={embedded}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}

      {/* Summary stats */}
      <section className="grid gap-4 sm:grid-cols-3">
        <div className={ui.stat}>
          <p className={ui.statLabel}>Drafts</p>
          <p className={ui.statValue}>{drafts}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">Ready for your attention</p>
        </div>
        <div className={ui.stat}>
          <p className={ui.statLabel}>Submitted / Claimed</p>
          <p className={ui.statValue}>{submitted}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">In the queue for Sales</p>
        </div>
        <div className={ui.stat}>
          <p className={ui.statLabel}>Converted to Quotes</p>
          <p className={ui.statValue}>{converted}</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">Successfully claimed by an Agent</p>
        </div>
      </section>

      {/* Intake table section */}
      <section className={`${ui.card} mt-5 overflow-hidden`}>
        <div className={ui.cardHeader}>
          <div>
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
              <ClipboardList className="h-4 w-4" /> My Intakes
            </div>
            <h2 className="mt-1 text-xl font-black">My Quote Intakes</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Drafts can be edited and submitted. Claimed and converted intakes remain visible for follow-up.
            </p>
          </div>
          <button type="button" className={ui.btnPrimary} onClick={() => setCreating(true)}>
            <FilePlus2 className="h-4 w-4" /> New Quote Intake
          </button>
        </div>

        {/* Filters */}
        <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-[1fr_220px_auto] sm:p-5">
          <label className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 text-sm font-semibold outline-none focus:border-[#7890bc]"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by customer name"
            />
          </label>
          <select
            className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="claimed">Claimed</option>
            <option value="converted">Converted</option>
          </select>
          <button type="button" className={ui.btnSecondary} onClick={() => void refresh()}>
            <RefreshCw className="h-4 w-4" />Refresh
          </button>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Customer Name</th>
                <th className={ui.th}>Source</th>
                <th className={ui.th}>Submission Date</th>
                <th className={ui.th}>Status</th>
                <th className={ui.th}>Assigned Agent</th>
                <th className={ui.th}>Linked Quote</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const customerName = row.business_name || `${row.insured_first_name ?? ''} ${row.insured_last_name ?? ''}`.trim() || 'Unnamed';
                const source = row.line_of_business === 'commercial_auto' ? 'Commercial Auto' : 'Personal Auto';
                const submissionDate = row.submitted_at
                  ? new Date(row.submitted_at).toLocaleDateString()
                  : row.status === 'draft' ? 'Not submitted' : new Date(row.created_at).toLocaleDateString();
                const isEditable = EDITABLE_STATUSES.has(row.status);
                const isSubmittable = SUBMITTABLE_STATUSES.has(row.status);
                const assignedAgent = row.claimed_by ? 'Assigned' : 'Unassigned';
                const linkedQuote = (row as unknown as Record<string, unknown>).converted_quote_id as string | null;

                return (
                  <tr key={row.id} className="hover:bg-[#f8faff]">
                    <td className={ui.td}>
                      <p className="font-black text-slate-900">{customerName}</p>
                    </td>
                    <td className={ui.td}>
                      <p className="font-bold">{source}</p>
                    </td>
                    <td className={ui.td}>
                      <p className="text-sm font-semibold text-slate-600">{submissionDate}</p>
                    </td>
                    <td className={ui.td}>
                      <span className={`${ui.badge} ${ui.badgeTone[csIntakeStatusTone[row.status] || 'neutral']}`}>
                        {statusLabel(row.status)}
                      </span>
                    </td>
                    <td className={ui.td}>
                      <p className="text-sm font-semibold text-slate-600">{assignedAgent}</p>
                    </td>
                    <td className={ui.td}>
                      {linkedQuote ? (
                        <button
                          type="button"
                          className="text-sm font-bold text-[#223f7a] hover:underline"
                          onClick={() => router.push(`/tools/quotes/${linkedQuote}`)}
                        >
                          View Quote
                        </button>
                      ) : (
                        <span className="text-sm text-slate-400">—</span>
                      )}
                    </td>
                    <td className={ui.td}>
                      <div className="flex items-center gap-2">
                        {/* View action — always available */}
                        <button
                          type="button"
                          className={ui.btnSecondary}
                          onClick={() => void openExisting(row)}
                          title="View intake"
                        >
                          <Eye className="h-3.5 w-3.5" />View
                        </button>

                        {/* Edit action — Draft, Submitted, Waiting statuses */}
                        {isEditable && (
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            onClick={() => void openExisting(row)}
                            title="Edit intake"
                          >
                            <Pencil className="h-3.5 w-3.5" />Edit
                          </button>
                        )}

                        {/* Submit action — Draft only */}
                        {isSubmittable && (
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            disabled={submitting === row.id}
                            onClick={() => void handleSubmit(row)}
                            title="Submit intake to Sales"
                          >
                            <Send className="h-3.5 w-3.5" />
                            {submitting === row.id ? 'Submitting...' : 'Submit'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Empty state */}
          {!visible.length && !loading && (
            <div className="flex flex-col items-center gap-4 rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-16 text-center">
              <ClipboardList className="h-10 w-10 text-slate-300" />
              <div>
                <p className="text-base font-black text-slate-700">No intakes yet</p>
                <p className="mt-1 max-w-md text-sm font-semibold text-slate-500">
                  You haven&apos;t created any quote intakes. Click &quot;New Quote Intake&quot; above to start collecting customer information for the Sales team.
                </p>
              </div>
              <button type="button" className={ui.btnPrimary} onClick={() => setCreating(true)}>
                <FilePlus2 className="h-4 w-4" /> Create Your First Intake
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Intake form modal */}
      <IntakeModal open={creating || Boolean(selected)} onClose={closeForm}>
        {creating ? <IntakeForm profileId={profile.id} onDone={closeForm} /> : null}
        {selected ? (
          <IntakeForm
            profileId={profile.id}
            initial={selected}
            readOnly={!EDITABLE_STATUSES.has(selected.submission.status)}
            onDone={closeForm}
          />
        ) : null}
      </IntakeModal>
    </ModuleShell>
  );
}
