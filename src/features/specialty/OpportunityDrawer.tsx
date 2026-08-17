'use client';

/**
 * The specialty quote detail.
 *
 * A side drawer rather than a page: an employee opens a quote while the customer is
 * on the line, and losing the list behind them is a worse trade than a narrower
 * panel. `SideDrawer` is also the only focus-trapped overlay in the codebase, so it
 * is the accessible choice as well as the fast one.
 *
 * Above the fold, before any scrolling, the panel answers: who is this, what kind of
 * quote, who is accountable, what stage, what happens next, when is it due, what is
 * missing, and how far along the carriers are. The tabs below answer the rest.
 *
 * Every action here is available to every eligible team member. There is no
 * `assignee === me` check anywhere in this file; `detail.can_edit` comes from the
 * server, which decides it from team membership.
 */

import {
  AlertTriangle,
  ArrowRightLeft,
  Building2,
  CheckSquare,
  ClipboardList,
  DollarSign,
  FileText,
  Plus,
  RefreshCw,
  Send,
  Square,
  Trash2,
  Truck,
  Upload,
  UserPlus,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import DatePicker from '../nhwd-shared/DatePicker';
import DateTimePicker from '../nhwd-shared/DateTimePicker';
import DollarInput from '../nhwd-shared/DollarInput';
import { SideDrawer } from '../time-attendance/shared/SideDrawer';
import { ui } from '../nhwd-shared/ui';
import {
  AlreadyClaimedError,
  SpecialtyConflictError,
  addCarrierMarket,
  addChecklistItem,
  addInformationRequest,
  addNote,
  changeStage,
  claimOpportunity,
  clearResult,
  createCarrier,
  deleteDocument,
  getDocumentUrl,
  getOpportunityDetail,
  getTimeline,
  reassignOpportunity,
  recordPriceSent,
  recordResult,
  removeCarrierMarket,
  resolveInformationRequest,
  toggleChecklistItem,
  updateCarrierMarket,
  updateLinkedIntake,
  updateOpportunity,
  uploadDocument,
} from './api';
import {
  CARRIER_STATUS_ORDER,
  DOCUMENT_CATEGORIES,
  INFORMATION_SUGGESTIONS,
  LOST_REASONS,
  PRICE_METHODS,
  carrierStatusLabel,
  carrierStatusRequires,
  carrierStatusTone,
  documentCategoryLabel,
  eventLabel,
  eventTone,
  formatDue,
  formatFileSize,
  formatMoney,
  formatPhone,
  formatRelative,
  informationStatusLabel,
  informationStatusTone,
  isInformationOutstanding,
  lineLabel,
  lostReasonLabel,
  priceMethodLabel,
  stageLabel,
  stageMeaning,
  stageTone,
} from './status';
import type {
  CarrierMarket,
  CarrierMarketStatus,
  DocumentCategory,
  OpportunityDetail,
  PriceMethod,
  SpecialtyLostReason,
  SpecialtyStage,
  TimelineEntry,
  WorkspaceContext,
} from './types';

type Tab = 'overview' | 'customer' | 'carriers' | 'documents' | 'notes' | 'activity';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'customer', label: 'Customer & Intake' },
  { id: 'carriers', label: 'Carrier Markets' },
  { id: 'documents', label: 'Documents' },
  { id: 'notes', label: 'Notes & Tasks' },
  { id: 'activity', label: 'Activity' },
];

function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className={ui.label}>{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs font-semibold text-slate-400">{hint}</span> : null}
    </label>
  );
}

function ReadRow({ label, value }: { label: string; value: React.ReactNode }) {
  if (value === null || value === undefined || value === '' || value === '—') return null;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 py-2 last:border-0">
      <span className="text-xs font-black uppercase tracking-[0.1em] text-slate-400">{label}</span>
      <span className="text-sm font-bold text-slate-800">{value}</span>
    </div>
  );
}

export interface OpportunityDrawerProps {
  opportunityId: string;
  profileId: string;
  context: WorkspaceContext;
  onClose: () => void;
  /** Tells the list something changed, so it refetches rather than going stale. */
  onChanged: () => void;
}

export default function OpportunityDrawer({
  opportunityId,
  profileId,
  context,
  onClose,
  onChanged,
}: OpportunityDrawerProps) {
  const [detail, setDetail] = useState<OpportunityDetail | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      setError(null);
      try {
        setDetail(await getOpportunityDetail(opportunityId));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That quote could not be opened.');
      } finally {
        setLoading(false);
      }
    },
    [opportunityId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'activity' || !detail) return;
    void getTimeline(opportunityId).then(setTimeline).catch(() => setTimeline([]));
  }, [detail, opportunityId, tab]);

  /**
   * Runs one action, then reloads from the server.
   *
   * A concurrency refusal is surfaced as a conflict banner rather than an error,
   * because the answer is "look at the latest version", not "try again". The reload
   * happens either way, so the panel is never left showing the data that was
   * rejected.
   */
  const run = useCallback(
    async (action: () => Promise<void>, success: string) => {
      if (busy) return false;
      setBusy(true);
      setError(null);
      setNotice(null);
      setConflict(null);
      try {
        await action();
        setNotice(success);
        await load(true);
        onChanged();
        return true;
      } catch (caught) {
        if (caught instanceof SpecialtyConflictError) {
          setConflict(caught.message);
          await load(true);
        } else if (caught instanceof AlreadyClaimedError) {
          setNotice(`${caught.message} It is still open for you to work.`);
          await load(true);
        } else {
          setError(caught instanceof Error ? caught.message : 'That action could not be completed.');
        }
        onChanged();
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, load, onChanged],
  );

  const opportunity = detail?.opportunity;
  const canEdit = detail?.can_edit ?? false;
  const outstanding = useMemo(
    () => (detail?.information_requests ?? []).filter((request) => isInformationOutstanding(request.status)),
    [detail?.information_requests],
  );

  return (
    <SideDrawer
      open
      onClose={onClose}
      title={opportunity?.display_name ?? 'Specialty quote'}
      subtitle={
        opportunity
          ? `${lineLabel(opportunity.line_of_business)} · ${opportunity.reference} · ${opportunity.team_name}`
          : undefined
      }
    >
      {loading && !detail ? <p className={ui.empty}>Loading quote…</p> : null}

      {error ? <div className={`${ui.error} mb-4`}>{error}</div> : null}
      {conflict ? (
        <div className={`${ui.info} mb-4 flex items-start gap-2`}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" />
          <span>
            {conflict} The latest version is shown below — your change was not saved, and nothing
            your teammate did was lost.
          </span>
        </div>
      ) : null}
      {notice ? <div className={`${ui.success} mb-4`}>{notice}</div> : null}

      {detail && opportunity ? (
        <div className="space-y-5">
          {/* ── Above the fold ───────────────────────────────────────────────── */}
          <section className="rounded-[22px] border border-[#c9d5e9] bg-[#f8faff] p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`${ui.badge} ${ui.badgeTone[stageTone(opportunity.stage)]}`}>
                {opportunity.stage_label}
              </span>
              {opportunity.priority !== 'normal' ? (
                <span
                  className={`${ui.badge} ${
                    opportunity.priority === 'urgent' ? ui.badgeTone.danger : ui.badgeTone.progress
                  }`}
                >
                  {opportunity.priority === 'urgent' ? 'Urgent' : 'High priority'}
                </span>
              ) : null}
              {opportunity.legacy_commercial_quote_id ? (
                <span className={`${ui.badge} ${ui.badgeTone.violet}`}>
                  Migrated from the Commercial Board
                </span>
              ) : null}
              {!canEdit ? (
                <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>Read only</span>
              ) : null}
            </div>

            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className={ui.statLabel}>Primary assignee</p>
                <p className="mt-0.5 text-sm font-black text-slate-900">
                  {opportunity.assignee_name ?? 'Unclaimed'}
                </p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">
                  Accountability, not ownership — every eligible teammate can work this quote.
                </p>
              </div>
              <div>
                <p className={ui.statLabel}>Next action</p>
                <p className="mt-0.5 text-sm font-black text-slate-900">
                  {opportunity.next_action ?? 'Not set'}
                </p>
                <p
                  className={`mt-0.5 text-xs font-black ${
                    opportunity.is_overdue
                      ? 'text-rose-600'
                      : opportunity.is_due_today
                        ? 'text-amber-600'
                        : 'text-slate-400'
                  }`}
                >
                  {formatDue(opportunity.next_action_due)}
                </p>
              </div>
              <div>
                <p className={ui.statLabel}>Missing information</p>
                <p
                  className={`mt-0.5 text-sm font-black ${
                    outstanding.length > 0 ? 'text-rose-600' : 'text-emerald-700'
                  }`}
                >
                  {outstanding.length === 0
                    ? 'Nothing outstanding'
                    : outstanding.map((request) => request.label).join(', ')}
                </p>
              </div>
              <div>
                <p className={ui.statLabel}>Carrier progress</p>
                <p className="mt-0.5 text-sm font-black text-slate-900">
                  {opportunity.markets_total === 0
                    ? 'No carriers yet'
                    : `${opportunity.markets_submitted}/${opportunity.markets_total} submitted · ${opportunity.markets_quoted} quoted`}
                </p>
                {opportunity.best_premium !== null ? (
                  <p className="mt-0.5 text-xs font-black text-slate-500">
                    Best quote {formatMoney(opportunity.best_premium)}
                  </p>
                ) : null}
              </div>
            </div>

            {opportunity.result ? (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <p className="text-sm font-black text-slate-900">
                  {opportunity.result === 'sold'
                    ? `Sold · ${opportunity.bound_carrier_name ?? 'carrier not recorded'} · ${formatMoney(opportunity.sold_premium)}`
                    : `Not sold · ${lostReasonLabel(opportunity.lost_reason)}`}
                </p>
                {opportunity.lost_reason_note ? (
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {opportunity.lost_reason_note}
                  </p>
                ) : null}
                <p className="mt-1 text-xs font-bold text-slate-400">
                  Closed {formatRelative(opportunity.finalized_at)}
                </p>
              </div>
            ) : null}

            {/* Context-aware actions. Everything that does not apply right now is
                absent rather than disabled, so the bar stays readable. */}
            <div className="mt-4 flex flex-wrap gap-2">
              {opportunity.primary_assignee_id === null ? (
                <button
                  type="button"
                  className={ui.btnPrimary}
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await claimOpportunity(opportunityId);
                    }, 'You are now the primary assignee. Your teammates can still work it with you.')
                  }
                >
                  <UserPlus className="h-4 w-4" />
                  Claim
                </button>
              ) : null}
              {detail.can_reassign ? <TransferControl detail={detail} run={run} busy={busy} /> : null}
              {canEdit && !opportunity.result ? (
                <>
                  <StageControl detail={detail} run={run} busy={busy} />
                  <NextActionControl detail={detail} run={run} busy={busy} />
                  <button type="button" className={ui.btnSecondary} onClick={() => setTab('carriers')}>
                    <Building2 className="h-4 w-4" />
                    Carriers
                  </button>
                  {detail.carrier_markets.some((market) => market.premium !== null) ? (
                    <PriceSentControl detail={detail} run={run} busy={busy} />
                  ) : null}
                  <ResultControl detail={detail} run={run} busy={busy} />
                </>
              ) : null}
              {opportunity.result && detail.is_manager ? (
                <button
                  type="button"
                  className={ui.btnGhost}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => clearResult(opportunityId, 'follow_up', 'Reopened by a manager'),
                      'The quote is open again in Follow-Up.',
                    )
                  }
                >
                  Reopen
                </button>
              ) : null}
              <button type="button" className={ui.btnGhost} onClick={() => void load()}>
                <RefreshCw className="h-4 w-4" />
                Refresh
              </button>
            </div>
          </section>

          {/* ── Tabs ─────────────────────────────────────────────────────────── */}
          <nav aria-label="Quote sections" className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1.5">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                aria-current={tab === entry.id ? 'page' : undefined}
                className={`rounded-xl px-3.5 py-2 text-xs font-black transition ${
                  tab === entry.id ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
                }`}
              >
                {entry.label}
                {entry.id === 'carriers' && opportunity.markets_total > 0
                  ? ` (${opportunity.markets_total})`
                  : entry.id === 'documents' && opportunity.documents_count > 0
                    ? ` (${opportunity.documents_count})`
                    : entry.id === 'notes' && opportunity.notes_count > 0
                      ? ` (${opportunity.notes_count})`
                      : ''}
              </button>
            ))}
          </nav>

          {tab === 'overview' ? (
            <OverviewTab detail={detail} run={run} busy={busy} />
          ) : null}
          {tab === 'customer' ? (
            <CustomerTab detail={detail} run={run} busy={busy} />
          ) : null}
          {tab === 'carriers' ? (
            <CarriersTab
              detail={detail}
              context={context}
              profileId={profileId}
              run={run}
              busy={busy}
            />
          ) : null}
          {tab === 'documents' ? (
            <DocumentsTab detail={detail} run={run} busy={busy} setError={setError} />
          ) : null}
          {tab === 'notes' ? <NotesTab detail={detail} run={run} busy={busy} /> : null}
          {tab === 'activity' ? <ActivityTab timeline={timeline} detail={detail} /> : null}
        </div>
      ) : null}
    </SideDrawer>
  );
}

type Runner = (action: () => Promise<void>, success: string) => Promise<boolean>;

// ── Header controls ──────────────────────────────────────────────────────────

function TransferControl({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');

  if (!open) {
    return (
      <button type="button" className={ui.btnSecondary} onClick={() => setOpen(true)}>
        <ArrowRightLeft className="h-4 w-4" />
        Transfer
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4">
      <p className={ui.sectionTitle}>Transfer primary responsibility</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">
        The previous assignee, the new assignee, who changed it and when are all recorded.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Assign to">
          <select className={ui.select} value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Choose an employee</option>
            {detail.assignable_members.map((member) => (
              <option key={member.profile_id} value={member.profile_id}>
                {member.display_name}
              </option>
            ))}
            <option value="__unassign">Leave unassigned</option>
          </select>
        </Field>
        <Field label="Reason (optional)">
          <input
            className={ui.input}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. covering while out of office"
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={busy || target === ''}
          onClick={() =>
            void run(
              () =>
                reassignOpportunity(
                  detail.opportunity.id,
                  target === '__unassign' ? null : target,
                  reason,
                ),
              'The transfer was recorded.',
            ).then((ok) => {
              if (ok) setOpen(false);
            })
          }
        >
          Transfer
        </button>
        <button type="button" className={ui.btnGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function StageControl({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<SpecialtyStage>(detail.opportunity.stage);
  const [note, setNote] = useState('');

  // Sold and Not Sold are absent: they carry a carrier, a premium or a reason, so
  // they are recorded through Record Result rather than picked from a list.
  const options = detail.workflow_stages.filter((entry) => !entry.is_terminal);

  if (!open) {
    return (
      <button type="button" className={ui.btnSecondary} onClick={() => setOpen(true)}>
        Move stage
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4">
      <p className={ui.sectionTitle}>Move stage</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Stage" hint={stageMeaning(stage)}>
          <select
            className={ui.select}
            value={stage}
            onChange={(event) => setStage(event.target.value as SpecialtyStage)}
          >
            {options.map((entry) => (
              <option key={entry.stage_key} value={entry.stage_key}>
                {entry.label}
                {entry.requires_next_action ? ' (needs a next action)' : ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input className={ui.input} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={busy}
          onClick={() =>
            void run(
              () => changeStage(detail.opportunity.id, stage, detail.opportunity.version, note),
              `Moved to ${stageLabel(stage)}.`,
            ).then((ok) => {
              if (ok) setOpen(false);
            })
          }
        >
          Move
        </button>
        <button type="button" className={ui.btnGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function NextActionControl({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [action, setAction] = useState(detail.opportunity.next_action ?? '');
  const [due, setDue] = useState(
    detail.opportunity.next_action_due ? detail.opportunity.next_action_due.slice(0, 16) : '',
  );

  if (!open) {
    return (
      <button type="button" className={ui.btnSecondary} onClick={() => setOpen(true)}>
        <ClipboardList className="h-4 w-4" />
        Next action
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4">
      <p className={ui.sectionTitle}>What needs to happen next?</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field
          label="Next action"
          hint="e.g. Request loss runs, Submit Progressive, Follow up with Canal, Call customer"
        >
          <input className={ui.input} value={action} onChange={(event) => setAction(event.target.value)} />
        </Field>
        {/* mt-2 because DateTimePicker, unlike ui.input, carries no top margin. */}
        <Field label="Due">
          <DateTimePicker value={due} onChange={setDue} className="mt-2" />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await updateOpportunity(
                detail.opportunity.id,
                {
                  next_action: action.trim() || null,
                  next_action_due: due ? new Date(due).toISOString() : null,
                },
                detail.opportunity.version,
              );
            }, 'The next action was saved.').then((ok) => {
              if (ok) setOpen(false);
            })
          }
        >
          Save
        </button>
        <button type="button" className={ui.btnGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function PriceSentControl({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [method, setMethod] = useState<PriceMethod | ''>('');
  const [note, setNote] = useState('');

  const quotable = detail.carrier_markets.filter((market) => market.premium !== null);

  if (!open) {
    return (
      <button type="button" className={ui.btnSecondary} onClick={() => setOpen(true)}>
        <Send className="h-4 w-4" />
        Record price sent
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4">
      <p className={ui.sectionTitle}>Which options went to the customer?</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">
        Receiving a carrier quote is not the same as sending a price. What you tick here is frozen as
        the record of what the customer was told.
      </p>
      <div className="mt-3 space-y-2">
        {quotable.map((market) => (
          <label key={market.id} className={ui.checkboxRow}>
            <input
              type="checkbox"
              checked={selected.includes(market.id)}
              onChange={(event) =>
                setSelected((current) =>
                  event.target.checked
                    ? [...current, market.id]
                    : current.filter((id) => id !== market.id),
                )
              }
            />
            <span>
              <strong>{market.carrier_name}</strong> · {formatMoney(market.premium)}
              {market.down_payment !== null ? ` · ${formatMoney(market.down_payment)} down` : ''}
              {market.payment_terms ? ` · ${market.payment_terms}` : ''}
            </span>
          </label>
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="How was it delivered?">
          <select
            className={ui.select}
            value={method}
            onChange={(event) => setMethod(event.target.value as PriceMethod | '')}
          >
            <option value="">Not recorded</option>
            {PRICE_METHODS.map((option) => (
              <option key={option} value={option}>
                {priceMethodLabel(option)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note (optional)">
          <input className={ui.input} value={note} onChange={(event) => setNote(event.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={busy || selected.length === 0}
          onClick={() =>
            void run(async () => {
              await recordPriceSent(detail.opportunity.id, selected, detail.opportunity.version, {
                method: method || null,
                note,
              });
            }, 'Recorded as sent to the customer.').then((ok) => {
              if (ok) setOpen(false);
            })
          }
        >
          Record
        </button>
        <button type="button" className={ui.btnGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function ResultControl({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<'sold' | 'not_sold'>('sold');
  const [boundMarketId, setBoundMarketId] = useState('');
  const [premium, setPremium] = useState<number | null>(null);
  const [lostReason, setLostReason] = useState<SpecialtyLostReason | ''>('');
  const [lostNote, setLostNote] = useState('');

  if (!open) {
    return (
      <button type="button" className={ui.btnSecondary} onClick={() => setOpen(true)}>
        <DollarSign className="h-4 w-4" />
        Record result
      </button>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white p-4">
      <p className={ui.sectionTitle}>Record the result</p>
      <div className="mt-3 flex gap-1 rounded-2xl bg-slate-100 p-1.5">
        {(['sold', 'not_sold'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setResult(option)}
            className={`flex-1 rounded-xl px-4 py-2 text-xs font-black transition ${
              result === option ? 'bg-[#223f7a] text-white shadow-sm' : 'text-slate-600 hover:bg-white'
            }`}
          >
            {option === 'sold' ? 'Sold' : 'Not sold'}
          </button>
        ))}
      </div>

      {result === 'sold' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Bound with">
            <select
              className={ui.select}
              value={boundMarketId}
              onChange={(event) => {
                setBoundMarketId(event.target.value);
                const market = detail.carrier_markets.find((entry) => entry.id === event.target.value);
                // Default the sold premium to what that carrier quoted; the employee can
                // still correct it if the bound figure differs.
                if (market?.premium !== null && market?.premium !== undefined) {
                  setPremium(market.premium);
                }
              }}
            >
              <option value="">Choose the carrier</option>
              {detail.carrier_markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.carrier_name}
                  {market.premium !== null ? ` · ${formatMoney(market.premium)}` : ''}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Sold premium">
            <DollarInput value={premium} onChange={setPremium} />
          </Field>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Reason" hint="A blank reason is not accepted — the lost-business report depends on it.">
            <select
              className={ui.select}
              value={lostReason}
              onChange={(event) => setLostReason(event.target.value as SpecialtyLostReason | '')}
            >
              <option value="">Choose a reason</option>
              {LOST_REASONS.map((option) => (
                <option key={option} value={option}>
                  {lostReasonLabel(option)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Explanation (optional)">
            <input
              className={ui.input}
              value={lostNote}
              onChange={(event) => setLostNote(event.target.value)}
            />
          </Field>
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={ui.btnPrimary}
          disabled={
            busy ||
            (result === 'sold' ? boundMarketId === '' || premium === null : lostReason === '')
          }
          onClick={() =>
            void run(
              () =>
                recordResult(
                  detail.opportunity.id,
                  result === 'sold'
                    ? { result: 'sold', boundMarketId, soldPremium: premium }
                    : { result: 'not_sold', lostReason: lostReason || null, lostReasonNote: lostNote },
                  detail.opportunity.version,
                ),
              result === 'sold' ? 'Recorded as sold.' : 'Recorded as not sold.',
            ).then((ok) => {
              if (ok) setOpen(false);
            })
          }
        >
          Record
        </button>
        <button type="button" className={ui.btnGhost} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Tabs ─────────────────────────────────────────────────────────────────────

function OverviewTab({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const { opportunity } = detail;
  const suggestions = INFORMATION_SUGGESTIONS[opportunity.line_of_business] ?? [];

  return (
    <div className="space-y-5">
      {/* Information Needed loop */}
      <section className={`${ui.card} ${ui.cardPad}`}>
        <p className={ui.sectionTitle}>Information needed</p>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          Anything shared with Customer Service shows on the customer&rsquo;s Quote Center journey, so a
          callback can be answered without asking the specialty team.
        </p>

        <div className="mt-3 space-y-2">
          {detail.information_requests.length === 0 ? (
            <p className={ui.empty}>Nothing recorded as missing.</p>
          ) : null}
          {detail.information_requests.map((request) => (
            <div
              key={request.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 px-4 py-3"
            >
              <div>
                <p className="text-sm font-black text-slate-900">{request.label}</p>
                <p className="mt-0.5 text-xs font-bold text-slate-400">
                  {request.requested_by_name
                    ? `Asked by ${request.requested_by_name} · ${formatRelative(request.requested_at)}`
                    : formatRelative(request.requested_at)}
                  {request.resolved_by_name
                    ? ` · resolved by ${request.resolved_by_name} ${formatRelative(request.resolved_at)}`
                    : ''}
                  {request.visible_to_cs ? ' · shared with Customer Service' : ' · internal'}
                </p>
                {request.note ? (
                  <p className="mt-1 text-sm font-semibold text-slate-600">{request.note}</p>
                ) : null}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`${ui.badge} ${ui.badgeTone[informationStatusTone(request.status)]}`}>
                  {informationStatusLabel(request.status)}
                </span>
                {detail.can_edit && isInformationOutstanding(request.status) ? (
                  <>
                    <button
                      type="button"
                      className={ui.btnSecondary}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => resolveInformationRequest(request.id, 'received'),
                          `${request.label} marked received.`,
                        )
                      }
                    >
                      Received
                    </button>
                    <button
                      type="button"
                      className={ui.btnGhost}
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => resolveInformationRequest(request.id, 'waived'),
                          `${request.label} waived.`,
                        )
                      }
                    >
                      Waive
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>

        {detail.can_edit && !opportunity.result ? (
          <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="What is missing?">
              <input
                className={ui.input}
                list="specialty-information-suggestions"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="e.g. Loss runs"
              />
              <datalist id="specialty-information-suggestions">
                {suggestions.map((suggestion) => (
                  <option key={suggestion} value={suggestion} />
                ))}
              </datalist>
            </Field>
            <Field label="Detail (optional)">
              <input className={ui.input} value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
            <div className="flex items-end">
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy || label.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    await addInformationRequest(opportunity.id, label, { note, visibleToCs: true });
                  }, 'Added to the missing-information list.').then((ok) => {
                    if (ok) {
                      setLabel('');
                      setNote('');
                    }
                  })
                }
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {/* Contributors — derived from what people did, not from the assignment. */}
      <section className={`${ui.card} ${ui.cardPad}`}>
        <p className={ui.sectionTitle}>Who has worked this quote</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {detail.contributors.length === 0 ? (
            <p className="text-sm font-semibold text-slate-500">Nothing recorded yet.</p>
          ) : null}
          {detail.contributors.map((contributor) => (
            <span
              key={contributor.profile_id}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 px-3 py-2"
              title={`Last action ${formatRelative(contributor.last_action_at)}`}
            >
              <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#eef3fb] text-[10px] font-black text-[#223f7a]">
                {contributor.initials}
              </span>
              <span className="text-sm font-bold text-slate-700">{contributor.display_name}</span>
              <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
                {contributor.action_count} action{contributor.action_count === 1 ? '' : 's'}
              </span>
              {contributor.is_primary_assignee ? (
                <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Primary</span>
              ) : null}
            </span>
          ))}
        </div>
      </section>

      {/* Pricing history */}
      {detail.price_presentations.length > 0 ? (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <p className={ui.sectionTitle}>What the customer has been sent</p>
          <div className="mt-3 space-y-3">
            {detail.price_presentations.map((presentation) => (
              <div key={presentation.id} className="rounded-2xl border border-slate-200 px-4 py-3">
                <p className="text-sm font-black text-slate-900">
                  {presentation.presented_by_name} · {formatRelative(presentation.presented_at)} ·{' '}
                  {priceMethodLabel(presentation.method)}
                </p>
                <ul className="mt-2 space-y-1">
                  {presentation.options.map((option) => (
                    <li key={option.carrier_market_id} className="text-sm font-semibold text-slate-600">
                      {option.carrier_name} — {formatMoney(option.premium)}
                      {option.down_payment !== null ? ` · ${formatMoney(option.down_payment)} down` : ''}
                      {option.payment_terms ? ` · ${option.payment_terms}` : ''}
                      {option.deductible ? ` · ${option.deductible} deductible` : ''}
                    </li>
                  ))}
                </ul>
                {presentation.note ? (
                  <p className="mt-2 text-sm font-semibold text-slate-500">{presentation.note}</p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Timing, as recorded by the server. */}
      <section className={`${ui.card} ${ui.cardPad}`}>
        <p className={ui.sectionTitle}>Timeline of record</p>
        <div className="mt-2">
          <ReadRow label="Created" value={formatRelative(opportunity.created_at)} />
          <ReadRow label="Intake submitted" value={formatRelative(opportunity.intake_submitted_at)} />
          <ReadRow label="Claimed" value={formatRelative(opportunity.claimed_at)} />
          <ReadRow label="Ready to market" value={formatRelative(opportunity.ready_to_market_at)} />
          <ReadRow label="First carrier submission" value={formatRelative(opportunity.first_submission_at)} />
          <ReadRow label="First carrier quote" value={formatRelative(opportunity.first_quote_at)} />
          <ReadRow label="Price sent" value={formatRelative(opportunity.price_sent_at)} />
          <ReadRow label="Closed" value={formatRelative(opportunity.finalized_at)} />
          <ReadRow label="Intake taken by" value={opportunity.intake_created_by_name} />
        </div>
      </section>
    </div>
  );
}

function CustomerTab({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const intake = detail.intake;
  const [editing, setEditing] = useState(false);
  const [patch, setPatch] = useState<Record<string, string>>({});

  const setValue = (key: string, value: string) =>
    setPatch((current) => ({ ...current, [key]: value }));

  if (!intake) {
    return (
      <section className={`${ui.card} ${ui.cardPad}`}>
        <p className={ui.sectionTitle}>Customer</p>
        <p className="mt-2 text-sm font-semibold text-slate-600">
          This quote was migrated from the Commercial Board and has no linked intake. The original
          card&rsquo;s customer detail was preserved as the first note under Notes &amp; Tasks.
        </p>
      </section>
    );
  }

  const isTrucking = detail.opportunity.line_of_business === 'trucking';

  /** The fields a specialty member may correct, by line of business. */
  const editable: { key: string; label: string; type?: string }[] = [
    { key: 'insured_first_name', label: 'First name' },
    { key: 'insured_last_name', label: 'Last name' },
    { key: 'insured_phone_primary', label: 'Phone' },
    { key: 'insured_phone_alt', label: 'Alternate phone' },
    { key: 'insured_email', label: 'Email' },
    { key: 'current_carrier', label: 'Current carrier' },
    { key: 'current_premium', label: 'Current premium', type: 'number' },
    ...(isTrucking
      ? [
          { key: 'business_name', label: 'Business name' },
          { key: 'business_type', label: 'Type of operation' },
          { key: 'dot_number', label: 'DOT number' },
          { key: 'mc_number', label: 'MC number' },
          { key: 'cargo_type', label: 'Cargo type' },
          { key: 'power_unit_count', label: 'Power units', type: 'number' },
          { key: 'operating_radius_miles', label: 'Radius (miles)', type: 'number' },
          { key: 'states_of_operation', label: 'States of operation' },
          { key: 'years_in_business', label: 'Years in business', type: 'number' },
        ]
      : [
          { key: 'property_address_street', label: 'Property street' },
          { key: 'property_address_city', label: 'Property city' },
          { key: 'property_address_state', label: 'Property state' },
          { key: 'property_address_zip', label: 'Property ZIP' },
          { key: 'dwelling_type', label: 'Dwelling type' },
          { key: 'year_built', label: 'Year built', type: 'number' },
          { key: 'square_footage', label: 'Square footage', type: 'number' },
          { key: 'roof_type', label: 'Roof type' },
          { key: 'roof_age', label: 'Roof age (years)', type: 'number' },
          { key: 'coverage_amount', label: 'Coverage amount', type: 'number' },
        ]),
  ];

  return (
    <div className="space-y-5">
      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className={ui.sectionTitle}>Customer information</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              Read live from the Customer Service intake — there is no second copy here. Corrections
              you make are written to that intake, so Customer Service and the specialty team never
              disagree about a phone number.
            </p>
          </div>
          {detail.can_edit ? (
            <button
              type="button"
              className={ui.btnSecondary}
              onClick={() => {
                setEditing((current) => !current);
                setPatch({});
              }}
            >
              {editing ? 'Cancel' : 'Correct information'}
            </button>
          ) : null}
        </div>

        {editing ? (
          <>
            <div className={`${ui.fieldRow} mt-4`}>
              {editable.map((field) => (
                <Field key={field.key} label={field.label}>
                  <input
                    className={ui.input}
                    type={field.type ?? 'text'}
                    value={
                      patch[field.key] ??
                      String((intake as unknown as Record<string, unknown>)[field.key] ?? '')
                    }
                    onChange={(event) => setValue(field.key, event.target.value)}
                  />
                </Field>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy || Object.keys(patch).length === 0}
                onClick={() =>
                  void run(async () => {
                    const cleaned: Record<string, unknown> = {};
                    for (const [key, value] of Object.entries(patch)) {
                      const trimmed = value.trim();
                      const field = editable.find((entry) => entry.key === key);
                      cleaned[key] =
                        trimmed === ''
                          ? null
                          : field?.type === 'number'
                            ? Number(trimmed)
                            : trimmed;
                    }
                    await updateLinkedIntake(
                      detail.opportunity.id,
                      cleaned,
                      intake.version,
                    );
                  }, 'The customer information was corrected on the intake.').then((ok) => {
                    if (ok) {
                      setEditing(false);
                      setPatch({});
                    }
                  })
                }
              >
                Save to the intake
              </button>
            </div>
          </>
        ) : (
          <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
            <div>
              <ReadRow
                label="Name"
                value={[intake.insured_first_name, intake.insured_middle_name, intake.insured_last_name]
                  .filter(Boolean)
                  .join(' ')}
              />
              <ReadRow label="Phone" value={formatPhone(intake.insured_phone_primary)} />
              <ReadRow label="Alt phone" value={formatPhone(intake.insured_phone_alt)} />
              <ReadRow label="Email" value={intake.insured_email} />
              <ReadRow
                label="Address"
                value={[intake.addr_street, intake.addr_city, `${intake.addr_state ?? ''} ${intake.addr_zip ?? ''}`]
                  .filter((part) => part && part.trim())
                  .join(', ')}
              />
              <ReadRow label="Language" value={intake.preferred_language} />
              <ReadRow label="Current carrier" value={intake.current_carrier} />
              <ReadRow label="Current premium" value={formatMoney(intake.current_premium)} />
              <ReadRow label="Expires" value={intake.current_expiration} />
            </div>
            <div>
              {isTrucking ? (
                <>
                  <ReadRow label="Business" value={intake.business_name} />
                  <ReadRow label="Operation" value={intake.business_type} />
                  <ReadRow label="DOT" value={intake.dot_number} />
                  <ReadRow label="MC" value={intake.mc_number} />
                  <ReadRow label="MCS-150" value={intake.mcs150_date} />
                  <ReadRow label="Cargo" value={intake.cargo_type} />
                  <ReadRow label="Power units" value={intake.power_unit_count} />
                  <ReadRow label="Radius" value={intake.operating_radius_miles ? `${intake.operating_radius_miles} mi` : null} />
                  <ReadRow label="States" value={intake.states_of_operation} />
                  <ReadRow label="Years in business" value={intake.years_in_business} />
                </>
              ) : (
                <>
                  <ReadRow
                    label="Property"
                    value={[
                      intake.property_address_street,
                      intake.property_address_city,
                      `${intake.property_address_state ?? ''} ${intake.property_address_zip ?? ''}`,
                    ]
                      .filter((part) => part && part.trim())
                      .join(', ')}
                  />
                  <ReadRow label="Dwelling" value={intake.dwelling_type} />
                  <ReadRow label="Year built" value={intake.year_built} />
                  <ReadRow label="Square footage" value={intake.square_footage} />
                  <ReadRow label="Roof" value={intake.roof_type} />
                  <ReadRow label="Roof age" value={intake.roof_age ? `${intake.roof_age} yrs` : null} />
                  <ReadRow label="Coverage amount" value={formatMoney(intake.coverage_amount)} />
                  <ReadRow label="Prior claims" value={intake.prior_claims ? 'Yes' : 'No'} />
                  <ReadRow label="Claims detail" value={intake.prior_claims_detail} />
                </>
              )}
              <ReadRow label="Intake taken by" value={intake.created_by_name} />
              <ReadRow label="CSR notes" value={intake.csr_notes} />
            </div>
          </div>
        )}
      </section>

      {intake.vehicles.length > 0 ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>
              <Truck className="mr-1.5 inline h-4 w-4" />
              Units ({intake.vehicles.length})
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>#</th>
                  <th className={ui.th}>Year</th>
                  <th className={ui.th}>Make</th>
                  <th className={ui.th}>Model</th>
                  <th className={ui.th}>VIN</th>
                  <th className={ui.th}>Ownership</th>
                </tr>
              </thead>
              <tbody>
                {intake.vehicles.map((vehicle) => (
                  <tr key={vehicle.id ?? vehicle.position}>
                    <td className={ui.td}>{vehicle.position}</td>
                    <td className={ui.td}>{vehicle.year ?? '—'}</td>
                    <td className={ui.td}>{vehicle.make ?? '—'}</td>
                    <td className={ui.td}>{vehicle.model ?? '—'}</td>
                    <td className={ui.td}>{vehicle.vin ?? (vehicle.vin_pending ? 'Pending' : '—')}</td>
                    <td className={ui.td}>{vehicle.ownership ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {intake.drivers.length > 0 ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>Drivers ({intake.drivers.length})</p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>#</th>
                  <th className={ui.th}>Name</th>
                  <th className={ui.th}>DOB</th>
                  <th className={ui.th}>Licence</th>
                  <th className={ui.th}>State</th>
                  <th className={ui.th}>Years</th>
                </tr>
              </thead>
              <tbody>
                {intake.drivers.map((driver) => (
                  <tr key={driver.id ?? driver.position}>
                    <td className={ui.td}>{driver.position}</td>
                    <td className={ui.td}>
                      {driver.first_name} {driver.last_name}
                    </td>
                    <td className={ui.td}>{driver.dob ?? '—'}</td>
                    <td className={ui.td}>{driver.license_number ?? '—'}</td>
                    <td className={ui.td}>{driver.license_state ?? '—'}</td>
                    <td className={ui.td}>{driver.years_licensed ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function CarriersTab({
  detail,
  context,
  profileId,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  context: WorkspaceContext;
  profileId: string;
  run: Runner;
  busy: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [carrierId, setCarrierId] = useState('');
  const [newCarrierName, setNewCarrierName] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const alreadyUsed = new Set(detail.carrier_markets.map((market) => market.carrier_id));
  const available = context.carriers.filter((carrier) => !alreadyUsed.has(carrier.id));
  const quoted = detail.carrier_markets.filter(
    (market) => market.status === 'quote_received' && market.premium !== null,
  );

  return (
    <div className="space-y-5">
      {/* Comparison. Only the viable options, because that is what a comparison is. */}
      {quoted.length > 1 ? (
        <section className={ui.card}>
          <div className={ui.cardHeader}>
            <p className={ui.sectionTitle}>Compare the options</p>
            <p className="text-xs font-semibold text-slate-500">
              Sorted by premium. {quoted.length} viable quote{quoted.length === 1 ? '' : 's'}.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Carrier</th>
                  <th className={ui.th}>Premium</th>
                  <th className={ui.th}>Down</th>
                  <th className={ui.th}>Terms</th>
                  <th className={ui.th}>Deductible</th>
                  <th className={ui.th}>Coverage notes</th>
                  <th className={ui.th}>Sent?</th>
                </tr>
              </thead>
              <tbody>
                {[...quoted]
                  .sort((a, b) => (a.premium ?? 0) - (b.premium ?? 0))
                  .map((market, index) => (
                    <tr key={market.id}>
                      <td className={ui.td}>
                        <span className="font-black text-slate-900">{market.carrier_name}</span>
                        {index === 0 ? (
                          <span className={`${ui.badge} ${ui.badgeTone.success} ml-2`}>Lowest</span>
                        ) : null}
                      </td>
                      <td className={ui.td}>
                        <span className="font-black">{formatMoney(market.premium)}</span>
                      </td>
                      <td className={ui.td}>{formatMoney(market.down_payment)}</td>
                      <td className={ui.td}>{market.payment_terms ?? '—'}</td>
                      <td className={ui.td}>{market.deductible ?? '—'}</td>
                      <td className={ui.td}>{market.coverage_notes ?? '—'}</td>
                      <td className={ui.td}>
                        {market.presented_at ? (
                          <span className={`${ui.badge} ${ui.badgeTone.cyan}`}>
                            {formatRelative(market.presented_at)}
                          </span>
                        ) : (
                          <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>Not sent</span>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div>
            <p className={ui.sectionTitle}>Carrier markets</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              One quote, many carriers. Any eligible teammate can work any of these.
            </p>
          </div>
          {detail.can_edit && !detail.opportunity.result ? (
            <button type="button" className={ui.btnPrimary} onClick={() => setAdding((c) => !c)}>
              <Plus className="h-4 w-4" />
              Add carrier
            </button>
          ) : null}
        </div>

        {adding ? (
          <div className="border-b border-slate-100 p-5 sm:p-6">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto]">
              <Field label="Carrier">
                <select
                  className={ui.select}
                  value={carrierId}
                  onChange={(event) => setCarrierId(event.target.value)}
                >
                  <option value="">Choose a carrier</option>
                  {available.map((carrier) => (
                    <option key={carrier.id} value={carrier.id}>
                      {carrier.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Or add one we have not used before">
                <input
                  className={ui.input}
                  value={newCarrierName}
                  onChange={(event) => setNewCarrierName(event.target.value)}
                  placeholder="Carrier name"
                />
              </Field>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  className={ui.btnPrimary}
                  disabled={busy || (carrierId === '' && newCarrierName.trim() === '')}
                  onClick={() =>
                    void run(async () => {
                      let id = carrierId;
                      if (id === '') {
                        const created = await createCarrier(
                          newCarrierName,
                          [detail.opportunity.line_of_business],
                          profileId,
                        );
                        id = created.id;
                      }
                      await addCarrierMarket(detail.opportunity.id, id, 'not_started');
                    }, 'The carrier was added to this quote.').then((ok) => {
                      if (ok) {
                        setCarrierId('');
                        setNewCarrierName('');
                        setAdding(false);
                      }
                    })
                  }
                >
                  Add
                </button>
                <button type="button" className={ui.btnGhost} onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {detail.carrier_markets.length === 0 ? (
          <div className="p-5 sm:p-6">
            <p className={ui.empty}>
              No carriers yet. Add the markets you plan to approach and each one keeps its own status,
              dates, premium and notes.
            </p>
          </div>
        ) : null}

        <div className="divide-y divide-slate-100">
          {detail.carrier_markets.map((market) => (
            <CarrierMarketRow
              key={market.id}
              market={market}
              detail={detail}
              expanded={expanded === market.id}
              onToggle={() => setExpanded((current) => (current === market.id ? null : market.id))}
              run={run}
              busy={busy}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function CarrierMarketRow({
  market,
  detail,
  expanded,
  onToggle,
  run,
  busy,
}: {
  market: CarrierMarket;
  detail: OpportunityDetail;
  expanded: boolean;
  onToggle: () => void;
  run: Runner;
  busy: boolean;
}) {
  const [status, setStatus] = useState<CarrierMarketStatus>(market.status);
  const [premium, setPremium] = useState<number | null>(market.premium);
  const [downPayment, setDownPayment] = useState<number | null>(market.down_payment);
  const [terms, setTerms] = useState(market.payment_terms ?? '');
  const [deductible, setDeductible] = useState(market.deductible ?? '');
  const [coverageNotes, setCoverageNotes] = useState(market.coverage_notes ?? '');
  const [declineReason, setDeclineReason] = useState(market.decline_reason ?? '');
  const [infoRequested, setInfoRequested] = useState(market.info_requested ?? '');
  const [notes, setNotes] = useState(market.notes ?? '');
  const [followUp, setFollowUp] = useState(market.follow_up_date ?? '');

  // Mirrors the server's validation, so the form can name what is missing before the
  // round trip rather than surfacing a constraint violation.
  const required = carrierStatusRequires(status);
  const missing = required.filter((field) => {
    if (field === 'premium') return premium === null;
    if (field === 'decline_reason') return declineReason.trim() === '';
    if (field === 'info_requested') return infoRequested.trim() === '';
    return false;
  });

  return (
    <div className="px-5 py-4 sm:px-6">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-3 text-left"
        aria-expanded={expanded}
      >
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-black text-slate-900">{market.carrier_name}</span>
          <span className={`${ui.badge} ${ui.badgeTone[carrierStatusTone(market.status)]}`}>
            {carrierStatusLabel(market.status)}
          </span>
          {market.premium !== null ? (
            <span className="text-sm font-black text-slate-900">{formatMoney(market.premium)}</span>
          ) : null}
          {market.presented_at ? (
            <span className={`${ui.badge} ${ui.badgeTone.cyan}`}>Sent to customer</span>
          ) : null}
        </div>
        <p className="text-xs font-bold text-slate-400">
          {[
            market.submitted_by_name ? `Submitted by ${market.submitted_by_name}` : null,
            market.submitted_at ? formatRelative(market.submitted_at) : null,
            market.follow_up_date ? `Follow up ${market.follow_up_date}` : null,
            market.document_count > 0 ? `${market.document_count} doc(s)` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </button>

      {!expanded ? (
        <p className="mt-1 text-sm font-semibold text-slate-500">
          {market.decline_reason
            ? `Declined: ${market.decline_reason}`
            : market.info_requested
              ? `Needs: ${market.info_requested}`
              : market.notes ?? ''}
        </p>
      ) : null}

      {expanded ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-[#f8faff] p-4">
          <div className="mb-3">
            <ReadRow label="Last update" value={`${market.last_action_by_name ?? '—'} · ${formatRelative(market.last_action_at)}`} />
            <ReadRow label="Quote received" value={market.quote_received_at ? `${market.quote_received_by_name ?? '—'} · ${formatRelative(market.quote_received_at)}` : null} />
            <ReadRow label="Working this market" value={market.handled_by_name} />
          </div>

          {detail.can_edit && !detail.opportunity.result ? (
            <>
              <div className={ui.fieldRow}>
                <Field label="Status">
                  <select
                    className={ui.select}
                    value={status}
                    onChange={(event) => setStatus(event.target.value as CarrierMarketStatus)}
                  >
                    {CARRIER_STATUS_ORDER.map((option) => (
                      <option key={option} value={option}>
                        {carrierStatusLabel(option)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Premium">
                  <DollarInput value={premium} onChange={setPremium} />
                </Field>
                <Field label="Down payment">
                  <DollarInput value={downPayment} onChange={setDownPayment} />
                </Field>
                <Field label="Payment terms">
                  <input
                    className={ui.input}
                    value={terms}
                    onChange={(event) => setTerms(event.target.value)}
                    placeholder="e.g. 20% down, 9 payments"
                  />
                </Field>
                <Field label="Deductible">
                  <input
                    className={ui.input}
                    value={deductible}
                    onChange={(event) => setDeductible(event.target.value)}
                  />
                </Field>
                <Field label="Carrier follow-up date">
                  <DatePicker value={followUp} onChange={setFollowUp} className="mt-2" />
                </Field>
              </div>

              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {status === 'declined' ? (
                  <Field label="Decline reason" hint="Required — the carrier report depends on it.">
                    <input
                      className={ui.input}
                      value={declineReason}
                      onChange={(event) => setDeclineReason(event.target.value)}
                    />
                  </Field>
                ) : null}
                {status === 'more_info_needed' ? (
                  <Field label="What is the carrier asking for?" hint="Required.">
                    <input
                      className={ui.input}
                      value={infoRequested}
                      onChange={(event) => setInfoRequested(event.target.value)}
                    />
                  </Field>
                ) : null}
                <Field label="Coverage differences">
                  <input
                    className={ui.input}
                    value={coverageNotes}
                    onChange={(event) => setCoverageNotes(event.target.value)}
                  />
                </Field>
                <Field label="Carrier notes">
                  <textarea
                    className={ui.textarea}
                    rows={2}
                    value={notes}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                </Field>
              </div>

              {missing.length > 0 ? (
                <p className={`${ui.error} mt-3`}>
                  {carrierStatusLabel(status)} needs: {missing.join(', ').replace(/_/g, ' ')}.
                </p>
              ) : null}

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={ui.btnPrimary}
                  disabled={busy || missing.length > 0}
                  onClick={() =>
                    void run(async () => {
                      await updateCarrierMarket(
                        market.id,
                        {
                          status,
                          premium,
                          down_payment: downPayment,
                          payment_terms: terms.trim() || null,
                          deductible: deductible.trim() || null,
                          coverage_notes: coverageNotes.trim() || null,
                          decline_reason: declineReason.trim() || null,
                          info_requested: infoRequested.trim() || null,
                          notes: notes.trim() || null,
                          follow_up_date: followUp || null,
                        },
                        market.version,
                      );
                    }, `${market.carrier_name} was updated.`)
                  }
                >
                  Save
                </button>
                {market.submitted_at === null ? (
                  <button
                    type="button"
                    className={ui.btnDanger}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => removeCarrierMarket(market.id),
                        `${market.carrier_name} was removed.`,
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                    Remove
                  </button>
                ) : (
                  <p className="self-center text-xs font-semibold text-slate-400">
                    Already submitted — set it to Withdrawn rather than removing it, so the marketing
                    history is kept.
                  </p>
                )}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DocumentsTab({
  detail,
  run,
  busy,
  setError,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
  setError: (message: string | null) => void;
}) {
  const [category, setCategory] = useState<DocumentCategory>('other');
  const [marketId, setMarketId] = useState('');

  const openDocument = useCallback(
    async (document: { storage_bucket: string; storage_path: string }) => {
      try {
        const url = await getDocumentUrl(document);
        window.open(url, '_blank', 'noopener,noreferrer');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That document could not be opened.');
      }
    },
    [setError],
  );

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div>
          <p className={ui.sectionTitle}>Documents</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            Loss runs, declarations, registrations, licences, carrier proposals and photos.
          </p>
        </div>
      </div>

      {detail.can_edit ? (
        <div className="grid gap-3 border-b border-slate-100 p-5 sm:grid-cols-3 sm:p-6">
          <Field label="Category">
            <select
              className={ui.select}
              value={category}
              onChange={(event) => setCategory(event.target.value as DocumentCategory)}
            >
              {DOCUMENT_CATEGORIES.map((option) => (
                <option key={option} value={option}>
                  {documentCategoryLabel(option)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Attach to a carrier (optional)">
            <select
              className={ui.select}
              value={marketId}
              onChange={(event) => setMarketId(event.target.value)}
            >
              <option value="">The quote itself</option>
              {detail.carrier_markets.map((market) => (
                <option key={market.id} value={market.id}>
                  {market.carrier_name}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <label className={`${ui.btnSecondary} cursor-pointer`}>
              <Upload className="h-4 w-4" />
              Choose a file
              <input
                type="file"
                className="hidden"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  void run(async () => {
                    await uploadDocument(detail.opportunity.id, file, {
                      category,
                      carrierMarketId: marketId || null,
                    });
                  }, `${file.name} was uploaded.`);
                }}
              />
            </label>
          </div>
        </div>
      ) : null}

      {detail.documents.length === 0 ? (
        <div className="p-5 sm:p-6">
          <p className={ui.empty}>No documents yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>File</th>
                <th className={ui.th}>Category</th>
                <th className={ui.th}>Carrier</th>
                <th className={ui.th}>Uploaded</th>
                <th className={ui.th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {detail.documents.map((document) => (
                <tr key={document.id}>
                  <td className={ui.td}>
                    <span className="inline-flex items-center gap-2 font-bold text-slate-800">
                      <FileText className="h-4 w-4 text-slate-400" />
                      {document.file_name}
                    </span>
                    <p className="mt-0.5 text-xs font-bold text-slate-400">
                      {formatFileSize(document.file_size)}
                      {document.is_legacy ? ' · migrated from the Commercial Board' : ''}
                    </p>
                  </td>
                  <td className={ui.td}>{documentCategoryLabel(document.category)}</td>
                  <td className={ui.td}>
                    {detail.carrier_markets.find((market) => market.id === document.carrier_market_id)
                      ?.carrier_name ?? '—'}
                  </td>
                  <td className={ui.td}>
                    {document.uploaded_by_name ?? '—'}
                    <p className="mt-0.5 text-xs font-bold text-slate-400">
                      {formatRelative(document.created_at)}
                    </p>
                  </td>
                  <td className={ui.td}>
                    <div className="flex min-w-[180px] flex-wrap gap-2">
                      <button
                        type="button"
                        className={ui.btnSecondary}
                        onClick={() => void openDocument(document)}
                      >
                        Open
                      </button>
                      {detail.can_edit && !document.is_legacy ? (
                        <button
                          type="button"
                          className={ui.btnDanger}
                          disabled={busy}
                          onClick={() =>
                            void run(() => deleteDocument(document), `${document.file_name} was removed.`)
                          }
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function NotesTab({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const [note, setNote] = useState('');
  const [shared, setShared] = useState(false);
  const [taskLabel, setTaskLabel] = useState('');
  const [taskCategory, setTaskCategory] = useState('Other');

  // Grouped by category so the checklist reads as the process it came from rather than
  // as one long list.
  const grouped = useMemo(() => {
    const map = new Map<string, OpportunityDetail['checklist']>();
    for (const item of detail.checklist) {
      const list = map.get(item.category) ?? [];
      list.push(item);
      map.set(item.category, list);
    }
    return Array.from(map.entries());
  }, [detail]);

  return (
    <div className="space-y-5">
      <section className={`${ui.card} ${ui.cardPad}`}>
        <p className={ui.sectionTitle}>Notes</p>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          Anyone on the team can add a note to any of the team&rsquo;s quotes. Notes cannot be edited or
          deleted afterwards, including by a manager.
        </p>

        {detail.can_edit ? (
          <div className="mt-3">
            <textarea
              className={ui.textarea}
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What happened?"
            />
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className={ui.checkboxRow}>
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(event) => setShared(event.target.checked)}
                />
                Share with Customer Service
              </label>
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy || note.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    await addNote(detail.opportunity.id, note, { csVisible: shared });
                  }, 'The note was added.').then((ok) => {
                    if (ok) {
                      setNote('');
                      setShared(false);
                    }
                  })
                }
              >
                Add note
              </button>
            </div>
          </div>
        ) : null}

        <div className="mt-4 space-y-3">
          {detail.notes.length === 0 ? <p className={ui.empty}>No notes yet.</p> : null}
          {detail.notes.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-slate-200 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#eef3fb] text-[10px] font-black text-[#223f7a]">
                  {entry.author_initials ?? '—'}
                </span>
                <span className="text-sm font-black text-slate-900">{entry.author_name}</span>
                <span className="text-xs font-bold text-slate-400">
                  {formatRelative(entry.created_at)}
                </span>
                {entry.is_cs_visible ? (
                  <span className={`${ui.badge} ${ui.badgeTone.info}`}>Shared with CS</span>
                ) : null}
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm font-semibold text-slate-700">
                {entry.content}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className={ui.sectionTitle}>Checklist</p>
          <p className="text-xs font-bold text-slate-400">
            {detail.opportunity.checklist_done} of {detail.opportunity.checklist_total} done
          </p>
        </div>
        <p className="mt-1 text-xs font-semibold text-slate-500">
          Created from the {lineLabel(detail.opportunity.line_of_business)} workflow template when the
          quote arrived. Add your own items as needed.
        </p>

        <div className="mt-3 space-y-4">
          {grouped.map(([category, items]) => (
            <div key={category}>
              <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                {category}
              </p>
              <ul className="mt-1.5 space-y-1">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      disabled={!detail.can_edit || busy}
                      onClick={() =>
                        void run(
                          () => toggleChecklistItem(item.id, !item.is_checked),
                          item.is_checked ? `${item.label} unticked.` : `${item.label} ticked.`,
                        )
                      }
                      className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left transition hover:bg-slate-50 disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      {item.is_checked ? (
                        <CheckSquare className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      ) : (
                        <Square className="mt-0.5 h-4 w-4 shrink-0 text-slate-300" />
                      )}
                      <span
                        className={`text-sm font-semibold ${
                          item.is_checked ? 'text-slate-400 line-through' : 'text-slate-700'
                        }`}
                      >
                        {item.label}
                        {item.is_required && !item.is_checked ? (
                          <span className="ml-1.5 text-xs font-black text-rose-500">required</span>
                        ) : null}
                        {item.is_checked && item.checked_by_name ? (
                          <span className="ml-1.5 text-xs font-bold text-slate-400">
                            {item.checked_by_name} · {formatRelative(item.checked_at)}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {detail.can_edit ? (
          <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="Category">
              <input
                className={ui.input}
                value={taskCategory}
                onChange={(event) => setTaskCategory(event.target.value)}
              />
            </Field>
            <Field label="New checklist item">
              <input
                className={ui.input}
                value={taskLabel}
                onChange={(event) => setTaskLabel(event.target.value)}
              />
            </Field>
            <div className="flex items-end">
              <button
                type="button"
                className={ui.btnSecondary}
                disabled={busy || taskLabel.trim() === ''}
                onClick={() =>
                  void run(async () => {
                    await addChecklistItem(detail.opportunity.id, taskCategory, taskLabel);
                  }, 'The checklist item was added.').then((ok) => {
                    if (ok) setTaskLabel('');
                  })
                }
              >
                <Plus className="h-4 w-4" />
                Add
              </button>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ActivityTab({
  timeline,
  detail,
}: {
  timeline: TimelineEntry[];
  detail: OpportunityDetail;
}) {
  return (
    <section className={`${ui.card} ${ui.cardPad}`}>
      <p className={ui.sectionTitle}>Everything that has happened</p>
      <p className="mt-1 text-xs font-semibold text-slate-500">
        Includes the Customer Service intake&rsquo;s own history, so the story starts where the customer
        did. Every entry names the employee who actually acted.
      </p>

      {timeline.length === 0 ? (
        <p className={`${ui.empty} mt-4`}>Loading activity…</p>
      ) : (
        <ol className="relative mt-4 space-y-4 border-l border-slate-200 pl-6">
          {timeline.map((entry, index) => {
            const tone = eventTone(entry.event_type);
            const carrier = detail.carrier_markets.find(
              (market) => market.id === entry.carrier_market_id,
            );
            return (
              <li key={`${entry.occurred_at}-${index}`} className="relative">
                <span
                  className={`absolute -left-[1.6875rem] top-1.5 h-3.5 w-3.5 rounded-full ring-4 ring-white ${
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
                <p className="text-sm font-black text-slate-900">
                  {eventLabel(entry.event_type)}
                  {carrier ? ` — ${carrier.carrier_name}` : ''}
                </p>
                <p className="mt-0.5 text-xs font-bold text-slate-500">
                  {entry.actor_name} · {formatRelative(entry.occurred_at)}
                  {entry.origin === 'intake' ? ' · from the intake' : ''}
                </p>
                {entry.detail && typeof entry.detail.note === 'string' ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-slate-600">
                    {entry.detail.note}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
