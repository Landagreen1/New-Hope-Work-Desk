'use client';

/**
 * Quote Center — the one place to answer "what has happened with this customer?"
 *
 * It replaces the Quotes Database, the Intake Database, the CS Quote Intakes list
 * and the lookup half of the Sales Queue. Those four screens each held part of the
 * answer and none of them held all of it, so an employee on a call had to guess
 * which one to open. Here the search covers every lifecycle stage at once, and a
 * converted intake and the quote it became appear as one result rather than two.
 *
 * What it is not: a personal work queue. Things an employee has to *do* live on My
 * Desk. Quote Center is for finding information, which is why nothing here is
 * filtered to the viewer and why claiming and pricing send you to My Desk.
 */

import {
  ClipboardList,
  FilePlus2,
  Info,
  RefreshCw,
  Search,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AppRole } from '@/lib/types';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import { getStageCounts, searchJourneys } from './api';
import JourneyDrawer from './JourneyDrawer';
import { getQuoteCenterPermissions } from './permissions';
import {
  formatPhone,
  journeyDifferentiators,
  journeyReference,
  lineOfBusinessLabel,
  stageDescription,
  stageFilterLabel,
  stageTone,
  STAGE_FILTERS,
} from './status';
import type { JourneySearchRow, JourneyStage, StageFilter } from './types';

const PAGE_SIZE = 25;

/** Long enough that a fast typist issues one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

function formatRelative(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return `Today ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  }

  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

/**
 * One search result.
 *
 * Every card carries its differentiators, because three customers called Maria
 * Perez is a normal Tuesday and a name on its own is not an identity.
 */
function ResultCard({
  row,
  onOpen,
}: {
  row: JourneySearchRow;
  onOpen: () => void;
}) {
  const differentiators = journeyDifferentiators(row);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="block w-full rounded-[22px] border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-[#7890bc] hover:bg-[#f8faff] focus:outline-none focus:ring-4 focus:ring-[#eef3fb] sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-lg font-black tracking-tight text-slate-950">
            {row.customer_name}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-xs font-black uppercase tracking-wider text-slate-500">
              {lineOfBusinessLabel(row.line_of_business, row.work_type)}
            </span>
            <span className="text-slate-300">·</span>
            <span className={`${ui.badge} ${ui.badgeTone[stageTone(row.stage, row.decision)]}`}>
              {row.stage_label}
            </span>
            {row.has_intake && row.has_quote ? (
              <span className="text-[11px] font-bold text-slate-400">Started as CS intake</span>
            ) : null}
            {row.possible_duplicate ? (
              <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Possible duplicate</span>
            ) : null}
            {row.is_voided ? (
              <span className={`${ui.badge} ${ui.badgeTone.danger}`}>Voided</span>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-xs font-black text-slate-400">{journeyReference(row)}</p>
          <p className="mt-1 text-xs font-semibold text-slate-400">
            {formatRelative(row.last_activity_at)}
          </p>
        </div>
      </div>

      {differentiators.length ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm font-semibold text-slate-600">
          {differentiators.map((part, index) => (
            <span key={`${part}-${index}`} className="flex items-center gap-3">
              {index > 0 ? <span className="text-slate-300">·</span> : null}
              {part}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-slate-400">
        {row.started_by_name ? <span>Started by {row.started_by_name}</span> : null}
        {row.completed_by_name && row.completed_by_name !== row.started_by_name ? (
          <span>Completed by {row.completed_by_name}</span>
        ) : null}
        {row.price_sent_at ? <span>Price sent {formatRelative(row.price_sent_at)}</span> : null}
        {row.finalized_at ? <span>Closed {formatRelative(row.finalized_at)}</span> : null}
      </div>
    </button>
  );
}

export interface QuoteCenterProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
  /** Opens the intake form for a new intake. */
  onNewIntake?: () => void;
  /** Opens the intake form on an existing continuable draft. */
  onContinueIntake?: (intakeId: string) => void;
  /** Sends the employee to My Desk, where queue-governed actions live. */
  onGoToMyDesk?: () => void;
}

export default function QuoteCenter({
  initialProfile,
  embedded = false,
  onNewIntake,
  onContinueIntake,
  onGoToMyDesk,
}: QuoteCenterProps) {
  const role = initialProfile.role as AppRole;
  const permissions = useMemo(() => getQuoteCenterPermissions(role), [role]);

  const [rawQuery, setRawQuery] = useState('');
  const [stage, setStage] = useState<StageFilter>('all');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<JourneySearchRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [counts, setCounts] = useState<Partial<Record<JourneyStage, number>>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [openJourneyKey, setOpenJourneyKey] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (searchQuery: string, searchStage: StageFilter, searchPage: number) => {
      setLoading(true);
      setError(null);
      try {
        const [result, stageCounts] = await Promise.all([
          searchJourneys({
            query: searchQuery,
            stage: searchStage,
            limit: PAGE_SIZE,
            offset: searchPage * PAGE_SIZE,
          }),
          getStageCounts(searchQuery),
        ]);
        setRows(result.rows);
        setTotalCount(result.totalCount);
        setCounts(
          stageCounts.reduce<Partial<Record<JourneyStage, number>>>((acc, entry) => {
            acc[entry.stage] = entry.journey_count;
            return acc;
          }, {}),
        );
        setLastUpdated(new Date());
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Unable to search quotes.');
        setRows([]);
        setTotalCount(0);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  /**
   * One effect owns "when the inputs settle, fetch".
   *
   * Debouncing the text means a typed phone number is one query rather than ten, and
   * running the fetch inside the timer keeps the effect body free of synchronous
   * state updates. An earlier version used two effects — one to debounce into a
   * `query` state, one to react to it — which cost an extra render per keystroke and
   * set state during the effect body.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      void load(rawQuery.trim(), stage, page);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load, page, rawQuery, stage]);

  if (!permissions.viewQuoteCenter) {
    return (
      <div className="grid min-h-[40vh] place-items-center p-6">
        <div className={ui.error}>Quote Center is not available for your role.</div>
      </div>
    );
  }

  const allCount = Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);
  const pageStart = totalCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min((page + 1) * PAGE_SIZE, totalCount);
  const hasMore = pageEnd < totalCount;

  return (
    <ModuleShell
      title="Quote Center"
      subtitle="Find any customer's quote journey — drafts, submitted intakes, active quotes, price sent, sold and not sold — from one search."
      role={role}
      lastUpdated={lastUpdated}
      onRefresh={() => void load(rawQuery.trim(), stage, page)}
      embedded={embedded}
    >
      {error ? <div className={`${ui.error} mb-5`}>{error}</div> : null}

      {/* Search. First thing on the screen, because the customer is already waiting. */}
      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              ref={searchInputRef}
              value={rawQuery}
              onChange={(event) => setRawQuery(event.target.value)}
              placeholder="Search by phone, name, business, email, city, dealer, VIN, DOT or record number"
              aria-label="Search quotes and intakes"
              className="w-full rounded-2xl border border-slate-200 bg-white py-3.5 pl-12 pr-11 text-base font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]"
            />
            {rawQuery ? (
              <button
                type="button"
                onClick={() => {
                  setRawQuery('');
                  searchInputRef.current?.focus();
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
                aria-label="Clear search"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {permissions.createIntake ? (
            <button type="button" className={`${ui.btnPrimary} shrink-0`} onClick={onNewIntake}>
              <FilePlus2 className="h-4 w-4" /> New Intake
            </button>
          ) : null}
        </div>

        <p className="mt-2.5 flex items-center gap-1.5 text-xs font-semibold text-slate-400">
          <Info className="h-3.5 w-3.5" />
          Phone numbers match in any format — 7045551212 finds (704) 555-1212.
        </p>

        {/* Stage filters. Plain words, not database statuses. */}
        <div className="mt-4 flex flex-wrap gap-2">
          {STAGE_FILTERS.map((filter) => {
            const isActive = stage === filter;
            const count = filter === 'all' ? allCount : (counts[filter] ?? 0);
            return (
              <button
                key={filter}
                type="button"
                title={filter === 'all' ? 'Every stage' : stageDescription(filter)}
                onClick={() => {
                  setStage(filter);
                  setPage(0);
                }}
                className={
                  isActive
                    ? 'rounded-xl bg-[#223f7a] px-4 py-2.5 text-xs font-black text-white shadow-sm'
                    : 'rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-black text-slate-600 transition hover:bg-slate-200'
                }
              >
                {stageFilterLabel(filter)}
                <span className={isActive ? 'ml-2 text-white/70' : 'ml-2 text-slate-400'}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Results */}
      <section className="mt-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-sm font-bold text-slate-500">
            {loading
              ? 'Searching…'
              : totalCount === 0
                ? 'No matching records'
                : `Showing ${pageStart}–${pageEnd} of ${totalCount} ${totalCount === 1 ? 'journey' : 'journeys'}`}
          </p>
          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin text-slate-400" aria-hidden />
          ) : null}
        </div>

        {!loading && rows.length === 0 ? (
          <div className={ui.empty}>
            {rawQuery.trim()
              ? 'Nothing matched that search. Try the phone number, or a different spelling of the name.'
              : 'Search for a customer to see their whole quote history.'}
          </div>
        ) : null}

        {rows.map((row) => (
          <ResultCard
            key={row.journey_key}
            row={row}
            onOpen={() => setOpenJourneyKey(row.journey_key)}
          />
        ))}

        {/* Server-side paging. The browser never holds more than one page. */}
        {totalCount > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              type="button"
              className={ui.btnSecondary}
              disabled={page === 0 || loading}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              Previous
            </button>
            <p className="text-xs font-black text-slate-400">
              Page {page + 1} of {Math.max(1, Math.ceil(totalCount / PAGE_SIZE))}
            </p>
            <button
              type="button"
              className={ui.btnSecondary}
              disabled={!hasMore || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </section>

      {/* What belongs here, and what belongs on My Desk. */}
      <section className="mt-6 flex flex-col gap-3 rounded-[22px] border border-[#c9d5e9] bg-[#f8faff] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-[#223f7a]" />
          <p className="text-sm font-semibold text-slate-600">
            Quote Center answers <strong className="text-[#223f7a]">where is this customer</strong>.
            Work you need to do — intakes to take, pricing to send, follow-ups — is on My Desk.
          </p>
        </div>
        {onGoToMyDesk ? (
          <button type="button" className={`${ui.btnSecondary} shrink-0`} onClick={onGoToMyDesk}>
            <ClipboardList className="h-4 w-4" /> Go to My Desk
          </button>
        ) : null}
      </section>

      {openJourneyKey ? (
        <JourneyDrawer
          journeyKey={openJourneyKey}
          role={role}
          onClose={() => {
            setOpenJourneyKey(null);
            // A note added in the drawer changes the journey's last activity, so the
            // list behind it is refreshed rather than left stale.
            void load(rawQuery.trim(), stage, page);
          }}
          onContinueIntake={(intakeId) => {
            setOpenJourneyKey(null);
            onContinueIntake?.(intakeId);
          }}
          onGoToMyDesk={onGoToMyDesk}
        />
      ) : null}
    </ModuleShell>
  );
}

/** Re-exported so callers can format a phone the same way the cards do. */
export { formatPhone };
