'use client';

/**
 * The Overview.
 *
 * One question: what is happening with this quote and what does the agent need to do
 * next? Answerable in the first screenful, before any scrolling — the Next Action sits
 * at the top and everything below it is the supporting detail in the order somebody
 * with a customer on the line asks for it.
 *
 * Nothing here is a second copy of another tab. The carrier strip is a summary that
 * links into the Carriers tab, coverage is the requested limits and not the whole
 * application, and Recent Activity is the last few events with a way through to the
 * full timeline. Repeating a tab's contents here is what made the old side panel
 * unreadable.
 */

import { ArrowRight, ChevronRight, Plus, Sparkles, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import { addInformationRequest, claimOpportunity, resolveInformationRequest } from '../api';
import { requestedCoverage } from '../application';
import {
  INFORMATION_SUGGESTIONS,
  carrierStatusTone,
  eventTone,
  formatDue,
  formatMoney,
  formatRelative,
  informationStatusLabel,
  informationStatusTone,
  isInformationOutstanding,
  priceMethodLabel,
} from '../status';
import { describeTimelineDetail, timelineTitle } from '../timeline';
import type { OpportunityDetail, TimelineEntry } from '../types';
import {
  carrierStatusLabel,
  deriveNextAction,
  quoteHealth,
  tallyCarriers,
  type WorkspaceTab,
} from '../workflow';
import IntakeEditDialog from './IntakeEditDialog';
import { ChecklistCard, NotesCard } from './NotesChecklist';
import { Badge, MissingList, ReadRow, SectionCard, Stat, toneDotColour, type Runner } from './shared';

export default function OverviewPanel({
  detail,
  recentActivity,
  activityLoading,
  run,
  busy,
  onOpenTab,
  onOpenCarrier,
}: {
  detail: OpportunityDetail;
  recentActivity: TimelineEntry[];
  activityLoading: boolean;
  run: Runner;
  busy: boolean;
  onOpenTab: (tab: WorkspaceTab) => void;
  onOpenCarrier: (carrierMarketId: string) => void;
}) {
  const { opportunity } = detail;
  const [editingCoverage, setEditingCoverage] = useState(false);

  const state = useMemo(
    () => ({
      opportunity,
      carrier_markets: detail.carrier_markets,
      information_requests: detail.information_requests,
      has_intake: detail.intake !== null,
    }),
    [detail.carrier_markets, detail.information_requests, detail.intake, opportunity],
  );

  const nextAction = useMemo(() => deriveNextAction(state), [state]);
  const health = useMemo(() => quoteHealth(state), [state]);
  const tally = useMemo(() => tallyCarriers(detail.carrier_markets), [detail.carrier_markets]);
  const coverage = useMemo(
    () => requestedCoverage(opportunity.line_of_business, detail.intake),
    [detail.intake, opportunity.line_of_business],
  );

  const canEdit = detail.can_edit && opportunity.result === null;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        {/* ── A. Next action ─────────────────────────────────────────────── */}
        <section
          className={`rounded-[26px] border-2 p-5 shadow-sm sm:p-6 ${
            nextAction.tone === 'danger'
              ? 'border-rose-200 bg-rose-50/70'
              : nextAction.tone === 'success'
                ? 'border-emerald-200 bg-emerald-50/60'
                : nextAction.tone === 'violet'
                  ? 'border-violet-200 bg-violet-50/60'
                  : nextAction.tone === 'progress'
                    ? 'border-amber-200 bg-amber-50/60'
                    : nextAction.tone === 'cyan'
                      ? 'border-cyan-200 bg-cyan-50/60'
                      : 'border-slate-200 bg-white'
          }`}
        >
          <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.16em] text-slate-500">
            <Sparkles className="h-3.5 w-3.5" />
            Next action
          </p>
          <p className="mt-2 text-lg font-black leading-snug text-slate-950">
            {nextAction.headline}
          </p>
          {nextAction.detail ? (
            <p className="mt-1.5 text-sm font-semibold text-slate-600">{nextAction.detail}</p>
          ) : null}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/*
              The one action that is performed here rather than navigated to. Sending the
              reader to a tab to look for a Claim button would be a button that does
              nothing, which is worse than no button.
            */}
            {nextAction.key === 'unclaimed' ? (
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await claimOpportunity(opportunity.id);
                  }, 'You are now the primary assignee. Your teammates can still work it with you.')
                }
              >
                <UserPlus className="h-4 w-4" />
                Claim it
              </button>
            ) : (
              <button
                type="button"
                className={ui.btnPrimary}
                onClick={() => {
                  if (nextAction.carrierMarketId) onOpenCarrier(nextAction.carrierMarketId);
                  else onOpenTab(nextAction.tab);
                }}
              >
                {nextAction.actionLabel}
                <ArrowRight className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* What a teammate wrote by hand. Shown next to the derived reading rather
              than instead of it: the state machine does not know that Oscar promised
              the customer a call on Thursday. */}
          {opportunity.next_action ? (
            <div className="mt-4 rounded-2xl border border-slate-200 bg-white px-4 py-3">
              <p className={ui.statLabel}>Recorded by the team</p>
              <p className="mt-0.5 text-sm font-bold text-slate-800">{opportunity.next_action}</p>
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
          ) : null}
        </section>

        {/* ── C. Carrier progress ────────────────────────────────────────── */}
        <SectionCard
          title="Carriers"
          description={
            tally.total === 0
              ? 'No markets yet. One quote, many carriers — each keeps its own status and pricing.'
              : `${tally.submitted} of ${tally.total} submitted · ${tally.quoted} quoted`
          }
          actions={
            <button
              type="button"
              className={ui.btnSecondary}
              onClick={() => onOpenTab('carriers')}
            >
              Open Carriers
              <ChevronRight className="h-4 w-4" />
            </button>
          }
          bodyClassName={detail.carrier_markets.length === 0 ? 'p-5 sm:p-6' : 'divide-y divide-slate-100'}
        >
          {detail.carrier_markets.length === 0 ? (
            <p className={ui.empty}>
              Add the markets you plan to approach and each one keeps its own status, dates, premium
              and notes.
            </p>
          ) : (
            detail.carrier_markets.map((market) => (
              <button
                key={market.id}
                type="button"
                onClick={() => onOpenCarrier(market.id)}
                className="flex w-full flex-wrap items-center justify-between gap-3 px-5 py-3.5 text-left transition hover:bg-[#f8faff] sm:px-6"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-black text-slate-900">{market.carrier_name}</span>
                    <Badge tone={carrierStatusTone(market.status)}>
                      {carrierStatusLabel(market.status)}
                    </Badge>
                    {market.presented_at ? <Badge tone="cyan">Sent to customer</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs font-bold text-slate-400">
                    {[
                      market.submitted_at ? `Submitted ${formatRelative(market.submitted_at)}` : null,
                      market.quote_received_at
                        ? `Responded ${formatRelative(market.quote_received_at)}`
                        : market.status === 'submitted' || market.status === 'waiting'
                          ? 'Waiting for a response'
                          : null,
                      market.status === 'more_info_needed' ? market.info_requested : null,
                      market.status === 'declined' ? market.decline_reason : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Not approached yet'}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {market.premium !== null ? (
                    <div className="text-right">
                      <p className="text-sm font-black text-slate-900">
                        {formatMoney(market.premium)}
                      </p>
                      <p className="text-xs font-bold text-slate-400">annual</p>
                    </div>
                  ) : null}
                  <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
                </div>
              </button>
            ))
          )}
        </SectionCard>

        {/* ── D (part). The Information Needed loop, which is the actionable half
               of "what is missing". ─────────────────────────────────────── */}
        <InformationNeeded detail={detail} run={run} busy={busy} canEdit={canEdit} />

        {/* Notes and the checklist. Both answer "what is happening", so both live here
            rather than in a tab somebody has to remember to open. */}
        <NotesCard detail={detail} canEdit={canEdit} run={run} busy={busy} />
        <ChecklistCard detail={detail} canEdit={canEdit} run={run} busy={busy} />

        {/* ── E. Recent activity ────────────────────────────────────────── */}
        <SectionCard
          title="Recent activity"
          description="The last few things that happened, including the Customer Service intake's own history."
          actions={
            <button type="button" className={ui.btnSecondary} onClick={() => onOpenTab('activity')}>
              Full timeline
              <ChevronRight className="h-4 w-4" />
            </button>
          }
        >
          {activityLoading && recentActivity.length === 0 ? (
            <p className={ui.empty}>Loading activity…</p>
          ) : recentActivity.length === 0 ? (
            <p className={ui.empty}>Nothing has been recorded on this quote yet.</p>
          ) : (
            <ol className="relative space-y-3.5 border-l border-slate-200 pl-6">
              {recentActivity.map((entry, index) => {
                const carrier =
                  detail.carrier_markets.find((market) => market.id === entry.carrier_market_id)
                    ?.carrier_name ?? null;
                const description = describeTimelineDetail(entry);
                return (
                  <li key={`${entry.occurred_at}-${entry.event_type}-${index}`} className="relative">
                    <span
                      aria-hidden
                      className={`absolute -left-[1.6875rem] top-1.5 h-3 w-3 rounded-full ring-4 ring-white ${toneDotColour(
                        eventTone(entry.event_type),
                      )}`}
                    />
                    <p className="text-sm font-black text-slate-900">
                      {timelineTitle(entry, carrier)}
                    </p>
                    <p className="mt-0.5 text-xs font-bold text-slate-500">
                      {entry.actor_name} · {formatRelative(entry.occurred_at)}
                    </p>
                    {description ? (
                      <p className="mt-0.5 whitespace-pre-wrap text-sm font-semibold text-slate-600">
                        {description}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          )}
        </SectionCard>
      </div>

      {/* ── Secondary column ─────────────────────────────────────────────── */}
      <div className="space-y-5">
        {/* D. Quote health */}
        <SectionCard
          title="Quote health"
          description="What exists and what does not. No score — a percentage over a list nobody defined is not a measurement."
        >
          <div className="grid grid-cols-2 gap-2.5">
            <Stat
              label="Application"
              value={health.applicationComplete ? 'Complete' : 'Gaps'}
              tone={health.applicationComplete ? 'success' : 'danger'}
            />
            <Stat label="Documents" value={health.documentsCount} />
            <Stat
              label="Carriers"
              value={`${health.carriersSubmitted} / ${health.carriersTotal}`}
              hint="submitted"
            />
            <Stat
              label="Quotes"
              value={health.quotesReceived}
              hint={tally.bestPremium === null ? undefined : `best ${formatMoney(tally.bestPremium)}`}
              tone={health.quotesReceived > 0 ? 'success' : 'neutral'}
            />
          </div>
          <div className="mt-3">
            <MissingList items={health.missing} />
            {health.missing.length === 0 ? (
              <p className="rounded-2xl border border-emerald-100 bg-emerald-50/60 px-4 py-3 text-sm font-bold text-emerald-800">
                Nothing is outstanding.
              </p>
            ) : null}
          </div>
        </SectionCard>

        {/* B. Coverage summary */}
        <SectionCard
          title="Requested coverage"
          description="What the customer asked to be quoted."
          actions={
            canEdit && detail.intake ? (
              <button
                type="button"
                className={ui.btnSecondary}
                onClick={() => setEditingCoverage(true)}
              >
                Edit
              </button>
            ) : undefined
          }
        >
          {coverage.length === 0 ? (
            <p className={ui.empty}>
              {detail.intake
                ? 'No coverage recorded yet.'
                : 'This quote has no linked intake, so there is nothing to read.'}
            </p>
          ) : (
            <dl className="space-y-2.5">
              {coverage.map((line) => (
                <div
                  key={line.key}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 pb-2.5 last:border-0 last:pb-0"
                >
                  <dt className="text-xs font-black uppercase tracking-[0.1em] text-slate-400">
                    {line.label}
                  </dt>
                  <dd className="text-right">
                    <span
                      className={`text-sm font-black ${
                        line.value === null ? 'text-rose-600' : 'text-slate-900'
                      }`}
                    >
                      {line.value ?? 'Not recorded'}
                    </span>
                    {line.note ? (
                      <span className="block text-xs font-bold text-slate-400">{line.note}</span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </SectionCard>

        {/* What the customer has already been told. Append-only history. */}
        {detail.price_presentations.length > 0 ? (
          <SectionCard
            title="Sent to the customer"
            description="Frozen when it was recorded, so correcting a premium later cannot rewrite what was said."
          >
            <div className="space-y-3">
              {detail.price_presentations.map((presentation) => (
                <div key={presentation.id} className="rounded-2xl border border-slate-200 px-4 py-3">
                  <p className="text-sm font-black text-slate-900">
                    {presentation.presented_by_name} · {formatRelative(presentation.presented_at)}
                  </p>
                  <p className="text-xs font-bold text-slate-400">
                    {priceMethodLabel(presentation.method)}
                  </p>
                  <ul className="mt-2 space-y-1">
                    {presentation.options.map((option) => (
                      <li
                        key={option.carrier_market_id}
                        className="text-sm font-semibold text-slate-600"
                      >
                        {option.carrier_name} — {formatMoney(option.premium)}
                        {option.down_payment !== null
                          ? ` · ${formatMoney(option.down_payment)} down`
                          : ''}
                      </li>
                    ))}
                  </ul>
                  {presentation.note ? (
                    <p className="mt-2 text-sm font-semibold text-slate-500">{presentation.note}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </SectionCard>
        ) : null}

        {/* Who has actually done something, derived from activity rather than from
            the assignment. */}
        <SectionCard title="Who has worked this quote">
          {detail.contributors.length === 0 ? (
            <p className="text-sm font-semibold text-slate-500">Nothing recorded yet.</p>
          ) : (
            <ul className="space-y-2">
              {detail.contributors.map((contributor) => (
                <li
                  key={contributor.profile_id}
                  className="flex items-center gap-2"
                  title={`Last action ${formatRelative(contributor.last_action_at)}`}
                >
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#eef3fb] text-[10px] font-black text-[#223f7a]">
                    {contributor.initials}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-700">
                    {contributor.display_name}
                  </span>
                  {contributor.is_primary_assignee ? <Badge tone="violet">Primary</Badge> : null}
                  <Badge tone="neutral">{contributor.action_count}</Badge>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* The server-stamped clock. Used by the timing report, so it is worth
            being able to read here. */}
        <SectionCard title="Timeline of record">
          <div>
            <ReadRow label="Created" value={formatRelative(opportunity.created_at)} />
            <ReadRow
              label="Intake submitted"
              value={formatRelative(opportunity.intake_submitted_at)}
            />
            <ReadRow label="Claimed" value={formatRelative(opportunity.claimed_at)} />
            <ReadRow
              label="Ready to market"
              value={formatRelative(opportunity.ready_to_market_at)}
            />
            <ReadRow
              label="First submission"
              value={formatRelative(opportunity.first_submission_at)}
            />
            <ReadRow label="First quote" value={formatRelative(opportunity.first_quote_at)} />
            <ReadRow label="Price sent" value={formatRelative(opportunity.price_sent_at)} />
            <ReadRow label="Closed" value={formatRelative(opportunity.finalized_at)} />
            <ReadRow label="Intake taken by" value={opportunity.intake_created_by_name} />
          </div>
        </SectionCard>
      </div>

      {editingCoverage && detail.intake ? (
        <IntakeEditDialog
          section="coverage"
          sectionLabel="Coverage"
          line={opportunity.line_of_business}
          intake={detail.intake}
          opportunityId={opportunity.id}
          run={run}
          busy={busy}
          onClose={() => setEditingCoverage(false)}
        />
      ) : null}
    </div>
  );
}

// ── Information needed ───────────────────────────────────────────────────────

function InformationNeeded({
  detail,
  run,
  busy,
  canEdit,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
  canEdit: boolean;
}) {
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');
  const suggestions = INFORMATION_SUGGESTIONS[detail.opportunity.line_of_business] ?? [];
  const outstanding = detail.information_requests.filter((request) =>
    isInformationOutstanding(request.status),
  );

  return (
    <SectionCard
      title="Information needed"
      description="Anything shared with Customer Service shows on the customer's Quote Center journey, so a callback can be answered without asking the specialty team."
      actions={
        outstanding.length > 0 ? (
          <Badge tone="danger">
            {outstanding.length} outstanding
          </Badge>
        ) : (
          <Badge tone="success">Nothing outstanding</Badge>
        )
      }
    >
      <div className="space-y-2">
        {detail.information_requests.length === 0 ? (
          <p className={ui.empty}>Nothing recorded as missing.</p>
        ) : null}
        {detail.information_requests.map((request) => (
          <div
            key={request.id}
            className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border border-slate-200 px-4 py-3"
          >
            <div className="min-w-0">
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
              <Badge tone={informationStatusTone(request.status)}>
                {informationStatusLabel(request.status)}
              </Badge>
              {canEdit && isInformationOutstanding(request.status) ? (
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

      {canEdit ? (
        <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_1fr_auto]">
          <label className="block">
            <span className={ui.label}>What is missing?</span>
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
          </label>
          <label className="block">
            <span className={ui.label}>Detail (optional)</span>
            <input
              className={ui.input}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={busy || label.trim() === ''}
              onClick={() =>
                void run(async () => {
                  await addInformationRequest(detail.opportunity.id, label, {
                    note,
                    visibleToCs: true,
                  });
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
    </SectionCard>
  );
}
