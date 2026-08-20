'use client';

/**
 * The Carriers tab.
 *
 * A specialty quote is a case and each carrier is a workstream inside it, so this tab
 * has two levels: the marketing summary across every market, and one carrier's own
 * workspace. Selecting a carrier replaces the list with that carrier's full-width
 * workspace and puts its id in the URL, which means a manager can send a teammate a
 * link straight to "what Eastern asked for" rather than to the quote and a hunt.
 *
 * Every action here is available to every eligible team member. There is no
 * `assignee === me` check: `detail.can_edit` comes from the server, which decides it
 * from team membership, and `handled_by` on a market records who is working it without
 * restricting who may.
 */

import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Plus,
  Send,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import DatePicker from '../../nhwd-shared/DatePicker';
import DollarInput from '../../nhwd-shared/DollarInput';
import { ui } from '../../nhwd-shared/ui';
import {
  addCarrierMarket,
  addNote,
  createCarrier,
  getDocumentUrl,
  removeCarrierMarket,
  updateCarrierMarket,
} from '../api';
import {
  GenerateApplicationPanel,
  ReadinessPanel,
  SupplementalQuestions,
  UnderwritingResultsPanel,
} from '../market-directory/CarrierMarketExtensions';
import {
  CARRIER_STATUS_ORDER,
  carrierStatusRequires,
  carrierStatusTone,
  documentCategoryLabel,
  eventTone,
  formatFileSize,
  formatMoney,
  formatRelative,
} from '../status';
import { describeTimelineDetail } from '../timeline';
import type {
  CarrierMarket,
  CarrierMarketStatus,
  OpportunityDetail,
  TimelineEntry,
  WorkspaceContext,
} from '../types';
import {
  carrierGroup,
  carrierGroupLabel,
  carrierStatusLabel,
  quotedMarkets,
  tallyCarriers,
} from '../workflow';
import { Badge, Field, ReadRow, SectionCard, Stat, toneDotColour, type Runner } from './shared';

export default function CarriersPanel({
  detail,
  context,
  profileId,
  timeline,
  run,
  busy,
  selectedCarrierId,
  onSelectCarrier,
  setError,
}: {
  detail: OpportunityDetail;
  context: WorkspaceContext;
  profileId: string;
  timeline: TimelineEntry[];
  run: Runner;
  busy: boolean;
  selectedCarrierId: string | null;
  onSelectCarrier: (carrierMarketId: string | null) => void;
  setError: (message: string | null) => void;
}) {
  const selected = detail.carrier_markets.find((market) => market.id === selectedCarrierId) ?? null;

  if (selectedCarrierId && !selected) {
    // A stale link, or a market a teammate withdrew while this page was open.
    return (
      <div className="space-y-4">
        <button type="button" className={ui.btnGhost} onClick={() => onSelectCarrier(null)}>
          <ArrowLeft className="h-4 w-4" />
          All carriers
        </button>
        <p className={ui.empty}>That carrier is no longer on this quote.</p>
      </div>
    );
  }

  if (selected) {
    return (
      <CarrierWorkspace
        market={selected}
        detail={detail}
        profileId={profileId}
        timeline={timeline}
        run={run}
        busy={busy}
        onBack={() => onSelectCarrier(null)}
        setError={setError}
      />
    );
  }

  return (
    <CarrierList
      detail={detail}
      context={context}
      profileId={profileId}
      run={run}
      busy={busy}
      onSelectCarrier={onSelectCarrier}
    />
  );
}

// ── The marketing summary ────────────────────────────────────────────────────

function CarrierList({
  detail,
  context,
  profileId,
  run,
  busy,
  onSelectCarrier,
}: {
  detail: OpportunityDetail;
  context: WorkspaceContext;
  profileId: string;
  run: Runner;
  busy: boolean;
  onSelectCarrier: (carrierMarketId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [carrierId, setCarrierId] = useState('');
  const [newCarrierName, setNewCarrierName] = useState('');

  const tally = useMemo(() => tallyCarriers(detail.carrier_markets), [detail.carrier_markets]);
  const quoted = useMemo(() => quotedMarkets(detail.carrier_markets), [detail.carrier_markets]);

  const alreadyUsed = new Set(detail.carrier_markets.map((market) => market.carrier_id));
  const available = context.carriers.filter((carrier) => !alreadyUsed.has(carrier.id));
  const canEdit = detail.can_edit && detail.opportunity.result === null;

  return (
    <div className="space-y-5">
      {/* Where the marketing stands, in five numbers. */}
      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div>
            <p className={ui.sectionTitle}>Carriers</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">
              One quote, many carriers. Any eligible teammate can work any of these.
            </p>
          </div>
          {canEdit ? (
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={() => setAdding((current) => !current)}
            >
              <Plus className="h-4 w-4" />
              Add carrier
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2.5 p-5 sm:grid-cols-3 lg:grid-cols-5 sm:p-6">
          <Stat label="Submitted" value={`${tally.submitted} / ${tally.total}`} />
          <Stat
            label={carrierGroupLabel('quoted')}
            value={tally.quoted}
            tone={tally.quoted > 0 ? 'success' : 'neutral'}
            hint={tally.bestPremium === null ? undefined : `best ${formatMoney(tally.bestPremium)}`}
          />
          <Stat
            label={carrierGroupLabel('blocked')}
            value={tally.blocked}
            tone={tally.blocked > 0 ? 'danger' : 'neutral'}
          />
          <Stat
            label={carrierGroupLabel('awaiting')}
            value={tally.awaiting}
            tone={tally.awaiting > 0 ? 'progress' : 'neutral'}
          />
          <Stat label={carrierGroupLabel('pending')} value={tally.pending} />
        </div>

        {adding ? (
          <div className="border-t border-slate-100 p-5 sm:p-6">
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
      </section>

      {/* Only the viable options, because that is what a comparison is. */}
      {quoted.length > 1 ? (
        <SectionCard
          title="Compare the options"
          description={`Sorted by premium. ${quoted.length} viable quotes.`}
          bodyClassName="overflow-x-auto"
        >
          <table className={ui.table}>
            <thead>
              <tr>
                <th className={ui.th}>Carrier</th>
                <th className={ui.th}>Annual</th>
                <th className={ui.th}>Down</th>
                <th className={ui.th}>Monthly</th>
                <th className={ui.th}>Terms</th>
                <th className={ui.th}>Deductible</th>
                <th className={ui.th}>Sent?</th>
              </tr>
            </thead>
            <tbody>
              {quoted.map((market, index) => (
                <tr key={market.id}>
                  <td className={ui.td}>
                    <span className="font-black text-slate-900">{market.carrier_name}</span>
                    {index === 0 ? (
                      <span className={`${ui.badge} ${ui.badgeTone.success} ml-2`}>Lowest</span>
                    ) : null}
                    {market.quote_number ? (
                      <p className="mt-0.5 text-xs font-bold text-slate-400">
                        Quote {market.quote_number}
                      </p>
                    ) : null}
                  </td>
                  <td className={ui.td}>
                    <span className="font-black">{formatMoney(market.premium)}</span>
                  </td>
                  <td className={ui.td}>{formatMoney(market.down_payment)}</td>
                  <td className={ui.td}>
                    {market.installment_amount !== null
                      ? `${formatMoney(market.installment_amount)}${
                          market.installment_count ? ` × ${market.installment_count}` : ''
                        }`
                      : '—'}
                  </td>
                  <td className={ui.td}>{market.payment_terms ?? '—'}</td>
                  <td className={ui.td}>{market.deductible ?? '—'}</td>
                  <td className={ui.td}>
                    {market.presented_at ? (
                      <Badge tone="cyan">{formatRelative(market.presented_at)}</Badge>
                    ) : (
                      <Badge tone="neutral">Not sent</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </SectionCard>
      ) : null}

      {detail.carrier_markets.length === 0 ? (
        <p className={ui.empty}>
          No carriers yet. Add the markets you plan to approach and each one keeps its own status,
          dates, premium and notes.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {detail.carrier_markets.map((market) => (
            <CarrierCard
              key={market.id}
              market={market}
              onOpen={() => onSelectCarrier(market.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One carrier, said the way an agent reads a submission log. */
function CarrierCard({ market, onOpen }: { market: CarrierMarket; onOpen: () => void }) {
  const group = carrierGroup(market.status);

  return (
    <section
      className={`rounded-[22px] border bg-white p-4 shadow-sm transition hover:shadow-md sm:p-5 ${
        group === 'blocked'
          ? 'border-rose-200'
          : group === 'quoted'
            ? 'border-emerald-200'
            : 'border-slate-200'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-black uppercase tracking-[0.06em] text-slate-900">
            {market.carrier_name}
          </p>
          <p className="mt-1 text-xs font-bold text-slate-400">
            {[
              market.submitted_at ? `Submitted ${formatRelative(market.submitted_at)}` : null,
              market.quote_received_at
                ? `Response ${formatRelative(market.quote_received_at)}`
                : null,
              market.follow_up_date ? `Follow up ${market.follow_up_date}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Not approached yet'}
          </p>
        </div>
        <Badge tone={carrierStatusTone(market.status)}>{carrierStatusLabel(market.status)}</Badge>
      </div>

      {market.premium !== null ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div>
            <p className={ui.statLabel}>Annual</p>
            <p className="text-base font-black text-slate-900">{formatMoney(market.premium)}</p>
          </div>
          <div>
            <p className={ui.statLabel}>Down</p>
            <p className="text-base font-black text-slate-900">
              {formatMoney(market.down_payment)}
            </p>
          </div>
          <div>
            <p className={ui.statLabel}>Monthly</p>
            <p className="text-base font-black text-slate-900">
              {market.installment_amount === null
                ? '—'
                : `${formatMoney(market.installment_amount)}${
                    market.installment_count ? ` × ${market.installment_count}` : ''
                  }`}
            </p>
          </div>
        </div>
      ) : null}

      {/* The one thing this carrier is waiting on, said plainly. */}
      {market.status === 'more_info_needed' && market.info_requested ? (
        <div className="mt-3 rounded-2xl border border-rose-100 bg-rose-50/70 px-4 py-3">
          <p className="text-xs font-black uppercase tracking-[0.1em] text-rose-700">
            Carrier requested
          </p>
          <p className="mt-1 text-sm font-bold text-rose-900">{market.info_requested}</p>
        </div>
      ) : null}
      {market.status === 'declined' && market.decline_reason ? (
        <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-xs font-black uppercase tracking-[0.1em] text-slate-500">Declined</p>
          <p className="mt-1 text-sm font-bold text-slate-700">{market.decline_reason}</p>
        </div>
      ) : null}
      {market.coverage_notes ? (
        <p className="mt-3 text-sm font-semibold text-slate-600">{market.coverage_notes}</p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="button" className={ui.btnSecondary} onClick={onOpen}>
          {market.status === 'more_info_needed' ? 'Provide information' : 'Open submission'}
          <ChevronRight className="h-4 w-4" />
        </button>
        {market.presented_at ? <Badge tone="cyan">Sent to customer</Badge> : null}
        {market.document_count > 0 ? (
          <Badge tone="neutral">
            {market.document_count} doc{market.document_count === 1 ? '' : 's'}
          </Badge>
        ) : null}
        {market.handled_by_name ? (
          <span className="text-xs font-bold text-slate-400">
            Worked by {market.handled_by_name}
          </span>
        ) : null}
      </div>
    </section>
  );
}

// ── One carrier's workspace ──────────────────────────────────────────────────

function CarrierWorkspace({
  market,
  detail,
  profileId,
  timeline,
  run,
  busy,
  onBack,
  setError,
}: {
  market: CarrierMarket;
  detail: OpportunityDetail;
  profileId: string;
  timeline: TimelineEntry[];
  run: Runner;
  busy: boolean;
  onBack: () => void;
  setError: (message: string | null) => void;
}) {
  const canEdit = detail.can_edit && detail.opportunity.result === null;

  const documents = detail.documents.filter(
    (document) => document.carrier_market_id === market.id,
  );
  const notes = detail.notes.filter((note) => note.carrier_market_id === market.id);
  const history = timeline.filter((entry) => entry.carrier_market_id === market.id);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={ui.btnGhost} onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          All carriers
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={carrierStatusTone(market.status)}>{carrierStatusLabel(market.status)}</Badge>
          {market.presented_at ? <Badge tone="cyan">Sent to customer</Badge> : null}
        </div>
      </div>

      <div>
        <h2 className="text-xl font-black tracking-tight text-slate-950">{market.carrier_name}</h2>
        <p className="mt-1 text-sm font-bold text-slate-500">
          A workstream inside {detail.opportunity.display_name} ·{' '}
          {detail.opportunity.reference}
        </p>
      </div>

      {/* What the carrier is asking for, above everything else. It is the reason
          this submission has stopped. */}
      {market.status === 'more_info_needed' && market.info_requested ? (
        <section className="rounded-[26px] border-2 border-rose-200 bg-rose-50/70 p-5 sm:p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-rose-700">
            {market.carrier_name} requested additional information
          </p>
          <p className="mt-2 text-lg font-black leading-snug text-rose-950">
            {market.info_requested}
          </p>
          <p className="mt-2 text-sm font-semibold text-rose-900">
            Record the answer as a note or a document, then move the status on so the quote stops
            reading as blocked.
          </p>
        </section>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          {/*
            Keyed on the carrier and its version, which is what keeps this form honest.

            The id half makes it structurally impossible for one carrier's half-typed
            premium to appear under another. The version half reseeds the form whenever the
            record it was read from actually changed — a teammate's edit arriving over
            realtime, or your own save completing.

            Without it, the fields are seeded once and `market.version` moves underneath
            them, so pressing Save sends stale values with a fresh version and the server
            accepts them: a silent overwrite of whatever the teammate just recorded. The
            cost of the key is that a teammate's change discards anything half-typed in
            this one form, which is the right way round — twelve short fields re-entered
            beats a premium quietly reverted.
          */}
          {canEdit ? (
            <CarrierEditor
              key={`${market.id}-${market.version}`}
              market={market}
              run={run}
              busy={busy}
            />
          ) : (
            <SectionCard title="Submission and pricing">
              <div>
                <ReadRow label="Status" value={carrierStatusLabel(market.status)} />
                <ReadRow label="Annual premium" value={formatMoney(market.premium)} />
                <ReadRow label="Down payment" value={formatMoney(market.down_payment)} />
                <ReadRow label="Payment terms" value={market.payment_terms} />
                <ReadRow label="Deductible" value={market.deductible} />
                <ReadRow label="Coverage differences" value={market.coverage_notes} />
                <ReadRow label="Quote number" value={market.quote_number} />
                <ReadRow label="Carrier notes" value={market.notes} />
              </div>
            </SectionCard>
          )}

          <CarrierNotes
            key={market.id}
            market={market}
            opportunityId={detail.opportunity.id}
            notes={notes}
            canEdit={canEdit}
            run={run}
            busy={busy}
          />

          {/* Readiness, supplemental questions, underwriting results and the
              generated application. Reused unchanged from the Market Directory. */}
          <div className="space-y-3">
            <ReadinessPanel
              carrierMarketId={market.id}
              marketDirectoryId={market.market_directory_id ?? null}
              lineOfBusiness={detail.opportunity.line_of_business}
            />
            <SupplementalQuestions
              carrierMarketId={market.id}
              marketDirectoryId={market.market_directory_id ?? null}
              lineOfBusiness={detail.opportunity.line_of_business}
              profileId={profileId}
            />
            <UnderwritingResultsPanel carrierMarketId={market.id} profileId={profileId} />
            <GenerateApplicationPanel
              carrierMarketId={market.id}
              opportunityId={detail.opportunity.id}
              marketDirectoryId={market.market_directory_id ?? null}
              lineOfBusiness={detail.opportunity.line_of_business}
              profileId={profileId}
            />
          </div>
        </div>

        <div className="space-y-5">
          <SectionCard title="Who and when">
            <div>
              <ReadRow label="Submitted" value={formatRelative(market.submitted_at)} />
              <ReadRow label="Submitted by" value={market.submitted_by_name} />
              <ReadRow label="Response" value={formatRelative(market.quote_received_at)} />
              <ReadRow label="Recorded by" value={market.quote_received_by_name} />
              <ReadRow
                label="Last update"
                value={`${market.last_action_by_name ?? '—'} · ${formatRelative(market.last_action_at)}`}
              />
              <ReadRow label="Working this market" value={market.handled_by_name} />
              <ReadRow label="Carrier follow-up" value={market.follow_up_date} />
              <ReadRow label="Sent to customer" value={formatRelative(market.presented_at)} />
            </div>
          </SectionCard>

          <SectionCard
            title="Carrier documents"
            description="Applications sent and anything the underwriter returned."
          >
            {documents.length === 0 ? (
              <p className={ui.empty}>Nothing attached to this carrier yet.</p>
            ) : (
              <ul className="space-y-2">
                {documents.map((document) => (
                  <li
                    key={document.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 truncate text-sm font-bold text-slate-800">
                        <FileText className="h-4 w-4 shrink-0 text-slate-400" />
                        {document.file_name}
                      </p>
                      <p className="mt-0.5 text-xs font-bold text-slate-400">
                        {documentCategoryLabel(document.category)} ·{' '}
                        {formatFileSize(document.file_size)} ·{' '}
                        {formatRelative(document.created_at)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={ui.btnGhost}
                      onClick={() => {
                        void getDocumentUrl(document)
                          .then((url) => window.open(url, '_blank', 'noopener,noreferrer'))
                          .catch((caught: unknown) =>
                            setError(
                              caught instanceof Error
                                ? caught.message
                                : 'That document could not be opened.',
                            ),
                          );
                      }}
                    >
                      Open
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Status history"
            description="Every change to this submission, from the quote's own timeline."
          >
            {history.length === 0 ? (
              <p className={ui.empty}>Nothing recorded against this carrier yet.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-slate-200 pl-5">
                {history.map((entry, index) => (
                  <li key={`${entry.occurred_at}-${index}`} className="relative">
                    <span
                      aria-hidden
                      className={`absolute -left-[1.4375rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white ${toneDotColour(
                        eventTone(entry.event_type),
                      )}`}
                    />
                    <p className="text-xs font-black text-slate-900">
                      {describeTimelineDetail(entry) ?? entry.event_type.replace(/_/g, ' ')}
                    </p>
                    <p className="text-xs font-bold text-slate-400">
                      {entry.actor_name} · {formatRelative(entry.occurred_at)}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      </div>
    </div>
  );
}

// ── The editable submission ──────────────────────────────────────────────────

function CarrierEditor({
  market,
  run,
  busy,
}: {
  market: CarrierMarket;
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
  const [installmentCount, setInstallmentCount] = useState<number | null>(
    market.installment_count ?? null,
  );
  const [installmentAmount, setInstallmentAmount] = useState<number | null>(
    market.installment_amount ?? null,
  );
  const [quoteNumber, setQuoteNumber] = useState(market.quote_number ?? '');

  // Mirrors the validation in `specialty_update_carrier_market`, so the form can name
  // what is missing before the round trip rather than surfacing a database error.
  const required = carrierStatusRequires(status);
  const missing = required.filter((field) => {
    if (field === 'premium') return premium === null;
    if (field === 'decline_reason') return declineReason.trim() === '';
    if (field === 'info_requested') return infoRequested.trim() === '';
    return false;
  });

  return (
    <SectionCard
      title="Submission and pricing"
      description="Saving is what advances the quote's own stage — a first submission moves it to Marketing and a received quote to Options Ready."
    >
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
        <Field label="Annual premium">
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
        <Field label="Installments">
          <input
            type="number"
            min="1"
            className={ui.input}
            value={installmentCount ?? ''}
            onChange={(event) =>
              setInstallmentCount(event.target.value === '' ? null : Number(event.target.value))
            }
            placeholder="e.g. 9"
          />
        </Field>
        <Field label="Installment amount">
          <DollarInput value={installmentAmount} onChange={setInstallmentAmount} />
        </Field>
        <Field label="Deductible">
          <input
            className={ui.input}
            value={deductible}
            onChange={(event) => setDeductible(event.target.value)}
          />
        </Field>
        <Field label="Quote number" hint="The carrier's own reference.">
          <input
            className={ui.input}
            value={quoteNumber}
            onChange={(event) => setQuoteNumber(event.target.value)}
            placeholder="e.g. QN-123456"
          />
        </Field>
        <Field label="Carrier follow-up date">
          <DatePicker value={followUp} onChange={setFollowUp} className="mt-2" />
        </Field>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
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
        <p className={`${ui.error} mt-4`}>
          {carrierStatusLabel(status)} needs: {missing.join(', ').replace(/_/g, ' ')}.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
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
                  installment_count: installmentCount,
                  installment_amount: installmentAmount,
                  quote_number: quoteNumber.trim() || null,
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
          <p className="text-xs font-semibold text-slate-400">
            Already submitted — set it to Withdrawn rather than removing it, so the marketing
            history is kept.
          </p>
        )}
      </div>
    </SectionCard>
  );
}

// ── Per-carrier notes ────────────────────────────────────────────────────────

function CarrierNotes({
  market,
  opportunityId,
  notes,
  canEdit,
  run,
  busy,
}: {
  market: CarrierMarket;
  /** A note belongs to the quote and points at the carrier, not the other way round. */
  opportunityId: string;
  notes: OpportunityDetail['notes'];
  canEdit: boolean;
  run: Runner;
  busy: boolean;
}) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    if (draft.trim() === '') return;
    void run(async () => {
      await addNote(opportunityId, draft.trim(), { carrierMarketId: market.id });
    }, 'Note added.').then((ok) => {
      if (ok) setDraft('');
    });
  };

  return (
    <SectionCard
      title="Carrier notes"
      description="What the underwriter said, and when. Notes cannot be edited or deleted afterwards."
    >
      {notes.length === 0 ? (
        <p className={ui.empty}>Nothing recorded for this carrier yet.</p>
      ) : (
        <div className="space-y-2">
          {notes.map((note) => (
            <div key={note.id} className="rounded-2xl bg-slate-50 px-4 py-3">
              <p className="whitespace-pre-wrap text-sm font-semibold text-slate-800">
                {note.content}
              </p>
              <p className="mt-1 text-xs font-bold text-slate-400">
                {note.author_name ?? 'Unknown'} · {formatRelative(note.created_at)}
                {note.is_cs_visible ? ' · shared with Customer Service' : ''}
              </p>
            </div>
          ))}
        </div>
      )}

      {canEdit ? (
        <div className="mt-3 flex gap-2">
          <input
            className={`${ui.input} mt-0 flex-1`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={`Add a note about ${market.carrier_name}…`}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submit();
            }}
          />
          <button
            type="button"
            className={ui.btnPrimary}
            disabled={busy || draft.trim() === ''}
            onClick={submit}
            aria-label="Add carrier note"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </SectionCard>
  );
}
