'use client';

/**
 * The sticky quote header.
 *
 * Compact on purpose. It answers who this is, what kind of quote, who is
 * accountable, where it stands and when it last moved — and then stops. Every other
 * intake field lives on the Application tab, because a header that grows to fifty
 * fields is the side panel this workspace replaced.
 *
 * The three actions an employee reaches for with a customer on the line are always
 * visible: Add Note, Upload, and the menu that holds the transitions. Anything that
 * does not apply right now is absent rather than disabled, which is what keeps the
 * bar readable on a closed quote.
 */

import {
  ArrowLeft,
  ArrowRightLeft,
  ChevronDown,
  ClipboardList,
  DollarSign,
  Flag,
  MessageSquarePlus,
  MoveRight,
  RefreshCw,
  RotateCcw,
  Send,
  Upload,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import { claimOpportunity, clearResult } from '../api';
import {
  formatDue,
  formatMoney,
  formatPhone,
  formatRelative,
  lineLabel,
  lostReasonLabel,
  stageTone,
} from '../status';
import type { OpportunityDetail } from '../types';
import {
  AddNoteDialog,
  NextActionDialog,
  PriceSentDialog,
  PriorityDialog,
  ResultDialog,
  StageDialog,
  TransferDialog,
  UploadDocumentDialog,
} from './HeaderActions';
import { Badge, type Runner } from './shared';

type Dialog =
  | 'note'
  | 'upload'
  | 'transfer'
  | 'stage'
  | 'next_action'
  | 'priority'
  | 'price_sent'
  | 'result'
  | null;

export default function QuoteHeader({
  detail,
  backHref,
  run,
  busy,
  onRefresh,
  onOpenLog,
}: {
  detail: OpportunityDetail;
  /** Where "Specialty Quotes" goes. Carries the list's filters when there are any. */
  backHref: string;
  run: Runner;
  busy: boolean;
  onRefresh: () => void;
  onOpenLog: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  const { opportunity } = detail;
  const canEdit = detail.can_edit;
  const isOpen = opportunity.result === null;

  useEffect(() => {
    if (!menuOpen) return;
    function handleDown(event: MouseEvent) {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  /** The line under the name: what kind of quote this is, in the trade's terms. */
  const identity =
    opportunity.line_of_business === 'trucking'
      ? [
          opportunity.dot_number ? `DOT ${opportunity.dot_number}` : null,
          opportunity.mc_number ? `MC ${opportunity.mc_number}` : null,
          [opportunity.customer_city, opportunity.customer_state].filter(Boolean).join(', ') || null,
        ]
      : [
          opportunity.property_address,
          [opportunity.customer_city, opportunity.customer_state].filter(Boolean).join(', ') || null,
        ];

  const menuItems: { label: string; icon: React.ReactNode; onSelect: () => void }[] = [];
  if (canEdit && isOpen) {
    menuItems.push({
      label: 'Move stage',
      icon: <MoveRight className="h-4 w-4" />,
      onSelect: () => setDialog('stage'),
    });
    menuItems.push({
      label: 'Set the next action',
      icon: <ClipboardList className="h-4 w-4" />,
      onSelect: () => setDialog('next_action'),
    });
    menuItems.push({
      label: 'Set priority',
      icon: <Flag className="h-4 w-4" />,
      onSelect: () => setDialog('priority'),
    });
    if (detail.carrier_markets.some((market) => market.premium !== null)) {
      menuItems.push({
        label: 'Record price sent',
        icon: <Send className="h-4 w-4" />,
        onSelect: () => setDialog('price_sent'),
      });
    }
    menuItems.push({
      label: 'Record the result',
      icon: <DollarSign className="h-4 w-4" />,
      onSelect: () => setDialog('result'),
    });
  }
  if (detail.can_reassign) {
    menuItems.push({
      label: 'Transfer responsibility',
      icon: <ArrowRightLeft className="h-4 w-4" />,
      onSelect: () => setDialog('transfer'),
    });
  }
  menuItems.push({
    label: 'Open the activity log',
    icon: <ClipboardList className="h-4 w-4" />,
    onSelect: onOpenLog,
  });
  if (!isOpen && detail.is_manager) {
    menuItems.push({
      label: 'Reopen the quote',
      icon: <RotateCcw className="h-4 w-4" />,
      onSelect: () =>
        void run(
          () => clearResult(opportunity.id, 'follow_up', 'Reopened by a manager'),
          'The quote is open again in Follow-Up.',
        ),
    });
  }
  menuItems.push({
    label: 'Refresh',
    icon: <RefreshCw className="h-4 w-4" />,
    onSelect: onRefresh,
  });

  return (
    <>
      <header className="sticky top-0 z-20 -mx-4 border-b border-[#dbe3f0] bg-white/95 px-4 py-3 backdrop-blur-xl sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <Link
          href={backHref}
          className="inline-flex items-center gap-1.5 text-xs font-black text-[#223f7a] hover:underline"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Specialty Quotes
        </Link>

        <div className="mt-2 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-black tracking-tight text-slate-950 sm:text-2xl">
                {opportunity.display_name}
              </h1>
              <Badge tone={stageTone(opportunity.stage)}>{opportunity.stage_label}</Badge>
              {opportunity.priority !== 'normal' ? (
                <Badge tone={opportunity.priority === 'urgent' ? 'danger' : 'progress'}>
                  {opportunity.priority === 'urgent' ? 'Urgent' : 'High priority'}
                </Badge>
              ) : null}
              {opportunity.legacy_commercial_quote_id ? (
                <Badge tone="violet">Migrated</Badge>
              ) : null}
              {!canEdit ? <Badge tone="neutral">Read only</Badge> : null}
            </div>

            <p className="mt-1 text-sm font-bold text-slate-500">
              {lineLabel(opportunity.line_of_business)}
              <span className="text-slate-300"> · </span>
              {opportunity.reference}
              <span className="text-slate-300"> · </span>
              {opportunity.team_name}
            </p>
            <p className="mt-0.5 text-xs font-bold text-slate-400">
              {[...identity, formatPhone(opportunity.customer_phone) || null]
                .filter(Boolean)
                .join(' · ')}
            </p>

            <dl className="mt-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs font-bold">
              <div>
                <dt className="inline text-slate-400">Assigned </dt>
                <dd className="inline text-slate-700">
                  {opportunity.assignee_name ?? 'Unclaimed'}
                </dd>
              </div>
              <div>
                <dt className="inline text-slate-400">Created </dt>
                <dd className="inline text-slate-700">{formatRelative(opportunity.created_at)}</dd>
              </div>
              <div>
                <dt className="inline text-slate-400">Last activity </dt>
                <dd className="inline text-slate-700">
                  {formatRelative(opportunity.last_activity_at)}
                </dd>
              </div>
              {opportunity.next_action ? (
                <div>
                  <dt className="inline text-slate-400">Next </dt>
                  <dd
                    className={`inline ${
                      opportunity.is_overdue
                        ? 'text-rose-600'
                        : opportunity.is_due_today
                          ? 'text-amber-600'
                          : 'text-slate-700'
                    }`}
                  >
                    {opportunity.next_action} · {formatDue(opportunity.next_action_due)}
                  </dd>
                </div>
              ) : null}
            </dl>

            {opportunity.result ? (
              <div className="mt-2">
                <p className="text-sm font-black text-slate-900">
                  {opportunity.result === 'sold'
                    ? `Sold · ${opportunity.bound_carrier_name ?? 'carrier not recorded'} · ${formatMoney(opportunity.sold_premium)}`
                    : `Not sold · ${lostReasonLabel(opportunity.lost_reason)}`}
                  <span className="ml-2 text-xs font-bold text-slate-400">
                    closed {formatRelative(opportunity.finalized_at)}
                  </span>
                </p>
                {/* The explanation someone typed when they closed it. The reason code is
                    what the lost-business report counts; this is what it meant. */}
                {opportunity.lost_reason_note ? (
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">
                    {opportunity.lost_reason_note}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {/*
              Offered on assignment alone, not on `can_edit`.

              Claiming is its own capability — `specialty_can_claim_opportunity` reads the
              team's `claim` flag, which is configured separately from `edit` — and the
              detail payload does not carry it. Gating on `can_edit` would hide the button
              from a member who is configured to claim but not to edit, which is a removal
              of access rather than a tidy-up. The server decides, as it did before.
            */}
            {opportunity.primary_assignee_id === null ? (
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
                Claim
              </button>
            ) : null}
            {canEdit ? (
              <>
                <button
                  type="button"
                  className={ui.btnSecondary}
                  onClick={() => setDialog('note')}
                >
                  <MessageSquarePlus className="h-4 w-4" />
                  Add Note
                </button>
                <button
                  type="button"
                  className={ui.btnSecondary}
                  onClick={() => setDialog('upload')}
                >
                  <Upload className="h-4 w-4" />
                  Upload
                </button>
              </>
            ) : null}

            <div className="relative" ref={menu}>
              <button
                type="button"
                className={ui.btnSecondary}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                onClick={() => setMenuOpen((current) => !current)}
              >
                More
                <ChevronDown className="h-4 w-4" />
              </button>
              {menuOpen ? (
                <div
                  role="menu"
                  className="absolute right-0 z-30 mt-1.5 w-64 overflow-hidden rounded-2xl border border-slate-200 bg-white py-1.5 shadow-xl"
                >
                  {menuItems.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      role="menuitem"
                      disabled={busy}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm font-bold text-slate-700 transition hover:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => {
                        setMenuOpen(false);
                        item.onSelect();
                      }}
                    >
                      <span className="text-slate-400">{item.icon}</span>
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>

      {dialog === 'note' ? (
        <AddNoteDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'upload' ? (
        <UploadDocumentDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'transfer' ? (
        <TransferDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'stage' ? (
        <StageDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'next_action' ? (
        <NextActionDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'priority' ? (
        <PriorityDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'price_sent' ? (
        <PriceSentDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'result' ? (
        <ResultDialog detail={detail} run={run} busy={busy} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}
