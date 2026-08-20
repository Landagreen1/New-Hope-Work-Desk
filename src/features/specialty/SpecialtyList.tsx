'use client';

/**
 * The Specialty Quotes list.
 *
 * Why a filtered, prioritised list rather than a nine-column board: the workflow has
 * nine stages, an employee works several lines at once, and the whole point of the
 * module is that a teammate's quote is as reachable as your own. Nine full-width
 * columns on a laptop cannot show a next action, a due date, an assignee and carrier
 * progress at the same time, and a board makes "what needs attention across every
 * stage" the hardest question to ask instead of the easiest. So stage is a filter and
 * a badge, the saved views are the prioritisation, and the row carries everything the
 * summary is required to make obvious.
 *
 * One list serves both the Work screen and the Quotes screen. They differ only in
 * their defaults — Work opens on the team's active work, Quotes opens on search
 * across everything including closed — because two implementations of the same table
 * would be two places for the same bug.
 */

import {
  AlertTriangle,
  ChevronDown,
  ClipboardList,
  Clock,
  RefreshCw,
  Search,
  UserPlus,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getSupabase } from '../nhwd-shared/client';
import { ui } from '../nhwd-shared/ui';
import {
  AlreadyClaimedError,
  claimOpportunity,
  countFor,
  getCounts,
  searchOpportunities,
} from './api';
import SpecialtyLogModal from './SpecialtyLogModal';
import {
  STAGE_ORDER,
  carrierSummary,
  formatDue,
  formatMoney,
  formatPhone,
  formatRelative,
  lineLabel,
  stageLabel,
  stageMeaning,
  stageTone,
  VIEWS,
  viewCountBucket,
  viewDescription,
  viewLabel,
} from './status';
import {
  defaultListState,
  type SpecialtyListMode,
  type SpecialtyListState,
  type SpecialtyResultFilter,
} from './list-state';
import { listNextAction } from './workflow';
import type {
  SpecialtyCount,
  SpecialtyLine,
  SpecialtyRow,
  SpecialtyStage,
  SpecialtyView,
  WorkspaceContext,
} from './types';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 250;
const REFRESH_INTERVAL_MS = 60_000;

/** The attention strip: the operational states worth surfacing without a search. */
const ATTENTION_CHIPS: { bucket: string; label: string; view: SpecialtyView }[] = [
  { bucket: 'unclaimed', label: 'Unclaimed', view: 'unclaimed' },
  { bucket: 'overdue', label: 'Overdue', view: 'overdue' },
  { bucket: 'due_today', label: 'Due today', view: 'due_today' },
  { bucket: 'waiting_on_carrier', label: 'Waiting on carrier', view: 'team' },
  { bucket: 'options_not_sent', label: 'Options not sent', view: 'team' },
  { bucket: 'stale', label: 'No recent activity', view: 'stale' },
];

export interface SpecialtyListProps {
  profileId: string;
  context: WorkspaceContext;
  /** Work opens on the team's active work; Quotes opens on search across everything. */
  mode: SpecialtyListMode;
  /**
   * Opens one quote.
   *
   * A navigation now, not a drawer: the parent decides where to. Kept as a callback
   * rather than a hard-coded `<Link>` because the two hosts pass different return
   * paths, and the row still needs the click target to be the whole row.
   */
  onOpen: (opportunityId: string) => void;
  /** Bumped by the parent after an action elsewhere, so the list reflects it. */
  refreshToken: number;
  /**
   * Where to start, when the host restores the reader's last list from the URL.
   *
   * Read once. The list owns its state from then on; a host that wants the URL to keep
   * up subscribes with `onStateChange` instead of pushing new values in.
   */
  initialState?: SpecialtyListState;
  /**
   * Called whenever the filters settle, so a host can mirror them into the URL.
   *
   * Optional on purpose. The routed `/specialty-quotes` page uses it so Back returns to
   * the same list; the copy mounted inside the Work Desk shell does not, because
   * rewriting that page's query string would re-run its server component on every
   * keystroke.
   */
  onStateChange?: (state: SpecialtyListState) => void;
}

export default function SpecialtyList({
  profileId,
  context,
  mode,
  onOpen,
  refreshToken,
  initialState,
  onStateChange,
}: SpecialtyListProps) {
  /**
   * Where this mount starts.
   *
   * A ref, read once on the first render. The host may re-render with a newer
   * `initialState` — the routed page recomputes it from the query string every render —
   * and adopting it would fight the reader: they type into the search box, the host
   * mirrors it to the URL, and a new "initial" value would arrive and reset the box.
   * A host that genuinely wants to restore a different list remounts with a new `key`.
   */
  const [start] = useState<SpecialtyListState>(() => initialState ?? defaultListState(mode));

  const [rawQuery, setRawQuery] = useState(start.query);
  const [view, setView] = useState<SpecialtyView>(start.view);
  const [line, setLine] = useState<SpecialtyLine | 'all'>(start.line);
  const [stage, setStage] = useState<SpecialtyStage | 'all'>(start.stage);
  const [assignee, setAssignee] = useState<string>(start.assignee);
  const [carrierId, setCarrierId] = useState<string>(start.carrierId);
  const [result, setResult] = useState<SpecialtyResultFilter>(start.result);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [page, setPage] = useState(start.page);

  const [rows, setRows] = useState<SpecialtyRow[]>([]);
  const [counts, setCounts] = useState<SpecialtyCount[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<SpecialtyRow | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);
  /** Guards against a slow earlier response overwriting a newer one. */
  const requestToken = useRef(0);

  const availableLines = useMemo(
    () => Array.from(new Set(context.lines_of_business.map((route) => route.line_of_business))),
    [context.lines_of_business],
  );

  const load = useCallback(
    async (silent = false) => {
      const token = ++requestToken.current;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const [searchResult, countResult] = await Promise.all([
          searchOpportunities({
            query: rawQuery.trim(),
            lineOfBusiness: line,
            stage,
            assignee: assignee === 'all' ? null : assignee,
            view,
            carrierId: carrierId === 'all' ? null : carrierId,
            result,
            limit: PAGE_SIZE,
            offset: page * PAGE_SIZE,
          }),
          getCounts(rawQuery.trim(), line, assignee === 'all' ? null : assignee),
        ]);
        if (token !== requestToken.current) return;
        setRows(searchResult.rows);
        setTotalCount(searchResult.totalCount);
        setCounts(countResult);
      } catch (caught) {
        if (token !== requestToken.current) return;
        setError(caught instanceof Error ? caught.message : 'Specialty quotes could not be loaded.');
        setRows([]);
        setTotalCount(0);
      } finally {
        if (token === requestToken.current) setLoading(false);
      }
    },
    [assignee, carrierId, line, page, rawQuery, result, stage, view],
  );

  /** One effect owns "when the inputs settle, fetch". */
  useEffect(() => {
    const timer = setTimeout(() => void load(), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [load]);

  /**
   * Tells the host what the reader is looking at, on the same settle as the fetch.
   *
   * Debounced with the search for the same reason: a host that writes this into the URL
   * would otherwise add a history entry per keystroke, and Back would walk the reader
   * letter by letter through their own search term.
   */
  useEffect(() => {
    if (!onStateChange) return;
    const timer = setTimeout(
      () =>
        onStateChange({
          query: rawQuery,
          view,
          line,
          stage,
          assignee,
          carrierId,
          result,
          page,
        }),
      SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [assignee, carrierId, line, onStateChange, page, rawQuery, result, stage, view]);

  useEffect(() => {
    if (refreshToken === 0) return;
    void load(true);
    // load is intentionally omitted: this effect exists to react to the parent's
    // signal, not to re-run whenever a filter changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  /**
   * Teammates work the same records, so a change one of them makes has to arrive here
   * without a manual reload. Realtime is a notification to refetch, never a source of
   * data: the row the server returns has already been through the team boundary and a
   * payload has not.
   */
  useEffect(() => {
    const supabase = getSupabase();
    const channel = supabase
      .channel('specialty-quotes-list-v1')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'specialty_opportunities' },
        () => void load(true),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'specialty_carrier_markets' },
        () => void load(true),
      )
      .subscribe();

    const interval = window.setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    const onFocus = () => void load(true);
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
  }, [load]);

  const handleClaim = useCallback(
    async (row: SpecialtyRow) => {
      if (busyId) return;
      setBusyId(row.id);
      setError(null);
      setNotice(null);
      try {
        const claim = await claimOpportunity(row.id);
        setNotice(
          claim.already_mine
            ? `${row.display_name} is already assigned to you.`
            : `You are now the primary assignee for ${row.display_name}. Your teammates can still work it with you.`,
        );
        await load(true);
      } catch (caught) {
        if (caught instanceof AlreadyClaimedError) {
          // Losing the race is normal, not an error state. The quote stays fully
          // visible and editable either way, which is what the message says.
          setNotice(`${caught.message} It is still open for you to work.`);
          await load(true);
        } else {
          setError(caught instanceof Error ? caught.message : 'That quote could not be claimed.');
        }
      } finally {
        setBusyId(null);
      }
    },
    [busyId, load],
  );

  const defaults = useMemo(() => defaultListState(mode), [mode]);

  const resetFilters = useCallback(() => {
    setRawQuery(defaults.query);
    setView(defaults.view);
    setLine(defaults.line);
    setStage(defaults.stage);
    setAssignee(defaults.assignee);
    setCarrierId(defaults.carrierId);
    setResult(defaults.result);
    setPage(0);
  }, [defaults]);

  const pageStart = totalCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const pageEnd = Math.min((page + 1) * PAGE_SIZE, totalCount);
  const filtersActive =
    rawQuery.trim() !== '' ||
    view !== defaults.view ||
    line !== defaults.line ||
    stage !== defaults.stage ||
    assignee !== defaults.assignee ||
    carrierId !== defaults.carrierId ||
    result !== defaults.result;

  return (
    <div className="space-y-5">
      {error ? <div className={ui.error}>{error}</div> : null}
      {notice ? <div className={ui.success}>{notice}</div> : null}

      {/* Attention strip. What needs a person today, without searching for it. */}
      {mode === 'work' ? (
        <section className={`${ui.card} ${ui.cardPad}`}>
          <div className="flex flex-wrap items-center gap-2">
            <p className={`${ui.sectionTitle} mr-1`}>Needs attention</p>
            {ATTENTION_CHIPS.map((chip) => {
              const count = countFor(counts, 'attention', chip.bucket);
              const isZero = count === 0;
              return (
                <button
                  key={chip.bucket}
                  type="button"
                  disabled={isZero}
                  onClick={() => {
                    setView(chip.view);
                    setResult('open');
                    if (chip.bucket === 'waiting_on_carrier') setStage('marketing');
                    else if (chip.bucket === 'options_not_sent') setStage('options_ready');
                    else setStage('all');
                    setPage(0);
                  }}
                  className={
                    isZero
                      ? 'cursor-default rounded-xl bg-slate-50 px-3.5 py-2 text-xs font-black text-slate-300'
                      : `rounded-xl px-3.5 py-2 text-xs font-black transition ${
                          chip.bucket === 'overdue'
                            ? 'bg-rose-50 text-rose-700 hover:bg-rose-100'
                            : chip.bucket === 'unclaimed'
                              ? 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                        }`
                  }
                >
                  {chip.label}
                  <span className="ml-2 opacity-70">{count}</span>
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      {/* Search and the primary filters. */}
      <section className={`${ui.card} ${ui.cardPad}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
            <input
              ref={searchInputRef}
              value={rawQuery}
              onChange={(event) => {
                setRawQuery(event.target.value);
                setPage(0);
              }}
              placeholder="Search by customer, business, phone, DOT, MC, property address, carrier or quote number"
              aria-label="Search specialty quotes"
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

          {/* Line filter, offered only for the lines this employee may work. A member
              of one team never sees a filter for the other team's line. */}
          {availableLines.length > 1 ? (
            <div className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1.5">
              {(['all', ...availableLines] as (SpecialtyLine | 'all')[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setLine(option);
                    setPage(0);
                  }}
                  aria-current={line === option ? 'true' : undefined}
                  className={`rounded-xl px-4 py-2 text-xs font-black transition ${
                    line === option
                      ? 'bg-[#223f7a] text-white shadow-sm'
                      : 'text-slate-600 hover:bg-white'
                  }`}
                >
                  {option === 'all' ? 'All lines' : lineLabel(option)}
                  {option !== 'all' ? (
                    <span className={line === option ? 'ml-2 text-white/70' : 'ml-2 text-slate-400'}>
                      {countFor(counts, 'lob', option)}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {/* Saved views. All Team Work leads; Assigned to Me is a filter beside it. */}
        <div className="mt-4 flex flex-wrap gap-2">
          {VIEWS.map((option) => {
            const bucket = viewCountBucket(option);
            const count = bucket ? countFor(counts, 'attention', bucket) : null;
            const isActive = view === option;
            return (
              <button
                key={option}
                type="button"
                title={viewDescription(option)}
                onClick={() => {
                  setView(option);
                  setResult(option === 'closed' ? 'all' : defaults.result);
                  setPage(0);
                }}
                className={
                  isActive
                    ? 'rounded-xl bg-[#223f7a] px-4 py-2.5 text-xs font-black text-white shadow-sm'
                    : 'rounded-xl bg-slate-100 px-4 py-2.5 text-xs font-black text-slate-600 transition hover:bg-slate-200'
                }
              >
                {viewLabel(option)}
                {count !== null ? (
                  <span className={isActive ? 'ml-2 text-white/70' : 'ml-2 text-slate-400'}>
                    {count}
                  </span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setShowMoreFilters((current) => !current)}
            className="inline-flex items-center gap-1.5 rounded-xl bg-white px-3.5 py-2.5 text-xs font-black text-slate-500 ring-1 ring-slate-200 transition hover:bg-slate-50"
            aria-expanded={showMoreFilters}
          >
            More filters
            <ChevronDown
              className={`h-3.5 w-3.5 transition ${showMoreFilters ? 'rotate-180' : ''}`}
            />
          </button>
          {filtersActive ? (
            <button type="button" onClick={resetFilters} className={ui.btnGhost}>
              Reset
            </button>
          ) : null}
        </div>

        {/* Secondary filters stay behind a control so the default screen is readable. */}
        {showMoreFilters ? (
          <div className="mt-4 grid gap-3 border-t border-slate-100 pt-4 md:grid-cols-4">
            <label className="block">
              <span className={ui.label}>Stage</span>
              <select
                className={ui.select}
                value={stage}
                onChange={(event) => {
                  setStage(event.target.value as SpecialtyStage | 'all');
                  setPage(0);
                }}
              >
                <option value="all">Every stage</option>
                {STAGE_ORDER.map((option) => (
                  <option key={option} value={option} title={stageMeaning(option)}>
                    {stageLabel(option)} ({countFor(counts, 'stage', option)})
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={ui.label}>Assigned to</span>
              <select
                className={ui.select}
                value={assignee}
                onChange={(event) => {
                  setAssignee(event.target.value);
                  setPage(0);
                }}
              >
                <option value="all">Anyone</option>
                {context.teammates.map((mate) => (
                  <option key={mate.profile_id} value={mate.profile_id}>
                    {mate.display_name}
                    {mate.profile_id === profileId ? ' (you)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={ui.label}>Carrier</span>
              <select
                className={ui.select}
                value={carrierId}
                onChange={(event) => {
                  setCarrierId(event.target.value);
                  setPage(0);
                }}
              >
                <option value="all">Any carrier</option>
                {context.carriers.map((carrier) => (
                  <option key={carrier.id} value={carrier.id}>
                    {carrier.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className={ui.label}>Result</span>
              <select
                className={ui.select}
                value={result}
                onChange={(event) => {
                  setResult(event.target.value as SpecialtyResultFilter);
                  setPage(0);
                }}
              >
                <option value="all">Any result</option>
                <option value="open">Still open</option>
                <option value="sold">Sold</option>
                <option value="not_sold">Not sold</option>
              </select>
            </label>
          </div>
        ) : null}
      </section>

      {/* Results */}
      <section className={ui.card}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
          <p className="text-sm font-bold text-slate-500">
            {loading
              ? 'Loading…'
              : totalCount === 0
                ? 'No matching quotes'
                : `Showing ${pageStart}–${pageEnd} of ${totalCount} ${totalCount === 1 ? 'quote' : 'quotes'}`}
          </p>
          <div className="flex items-center gap-3">
            {loading ? (
              <RefreshCw className="h-4 w-4 animate-spin text-slate-400" aria-hidden />
            ) : null}
            <button type="button" className={ui.btnSecondary} onClick={() => void load()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        {!loading && rows.length === 0 ? (
          <div className="p-5 sm:p-6">
            <div className={ui.empty}>
              {filtersActive
                ? 'Nothing matches the current search and filters. Reset them to see the whole team\u2019s work.'
                : 'No specialty quotes yet. A Trucking or Homeowners intake submitted by Customer Service will appear here for the team to claim.'}
            </div>
          </div>
        ) : null}

        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Customer / Business</th>
                  <th className={ui.th}>Stage</th>
                  <th className={ui.th}>Assigned</th>
                  <th className={ui.th}>Next action</th>
                  <th className={ui.th}>Carriers</th>
                  <th className={ui.th}>Last activity</th>
                  <th className={ui.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className={ui.trHover} onClick={() => onOpen(row.id)}>
                    <td className={ui.td}>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-black text-slate-900">{row.display_name}</span>
                        <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
                          {lineLabel(row.line_of_business)}
                        </span>
                        {row.priority !== 'normal' ? (
                          <span
                            className={`${ui.badge} ${
                              row.priority === 'urgent' ? ui.badgeTone.danger : ui.badgeTone.progress
                            }`}
                          >
                            {row.priority === 'urgent' ? 'Urgent' : 'High'}
                          </span>
                        ) : null}
                        {row.legacy_commercial_quote_id ? (
                          <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Migrated</span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-xs font-bold text-slate-400">
                        {[
                          row.reference,
                          formatPhone(row.customer_phone),
                          row.line_of_business === 'trucking'
                            ? [
                                row.dot_number ? `DOT ${row.dot_number}` : null,
                                row.mc_number ? `MC ${row.mc_number}` : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')
                            : row.property_address,
                          [row.customer_city, row.customer_state].filter(Boolean).join(', '),
                        ]
                          .filter((part) => part)
                          .join(' · ')}
                      </p>
                    </td>

                    <td className={ui.td}>
                      <span className={`${ui.badge} ${ui.badgeTone[stageTone(row.stage)]}`}>
                        {row.stage_label}
                      </span>
                      {row.open_information_count > 0 ? (
                        <p
                          className="mt-1.5 flex items-start gap-1 text-xs font-bold text-rose-600"
                          title={row.open_information_labels ?? undefined}
                        >
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          {row.open_information_count} item
                          {row.open_information_count === 1 ? '' : 's'} missing
                        </p>
                      ) : null}
                      {row.result === 'sold' && row.sold_premium !== null ? (
                        <p className="mt-1.5 text-xs font-black text-emerald-700">
                          {formatMoney(row.sold_premium)}
                          {row.bound_carrier_name ? ` · ${row.bound_carrier_name}` : ''}
                        </p>
                      ) : null}
                    </td>

                    <td className={ui.td}>
                      {row.primary_assignee_id ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="grid h-7 w-7 place-items-center rounded-lg bg-[#eef3fb] text-[10px] font-black text-[#223f7a]">
                            {row.assignee_initials ?? '—'}
                          </span>
                          <span className="font-bold text-slate-700">{row.assignee_name}</span>
                        </span>
                      ) : (
                        <span className={`${ui.badge} ${ui.badgeTone.info}`}>Unclaimed</span>
                      )}
                    </td>

                    {/*
                      Never blank. What a teammate recorded wins; otherwise the row shows
                      the same reading the workspace derives, so scanning the list answers
                      "what needs doing" without opening anything.
                    */}
                    <td className={ui.td}>
                      <p
                        className={`font-bold ${
                          row.next_action ? 'text-slate-700' : 'text-slate-500'
                        }`}
                      >
                        {listNextAction(row)}
                      </p>
                      {row.next_action ? (
                        <p
                          className={`mt-1 flex items-center gap-1 text-xs font-black ${
                            row.is_overdue
                              ? 'text-rose-600'
                              : row.is_due_today
                                ? 'text-amber-600'
                                : 'text-slate-400'
                          }`}
                        >
                          <Clock className="h-3.5 w-3.5" />
                          {formatDue(row.next_action_due)}
                        </p>
                      ) : null}
                    </td>

                    <td className={ui.td}>
                      <p className="font-bold text-slate-700">{carrierSummary(row)}</p>
                      <p className="mt-1 text-xs font-bold text-slate-400">
                        {[
                          row.markets_waiting > 0 ? `${row.markets_waiting} waiting` : null,
                          row.markets_info_needed > 0
                            ? `${row.markets_info_needed} need info`
                            : null,
                          row.markets_declined > 0 ? `${row.markets_declined} declined` : null,
                          row.best_premium !== null ? `best ${formatMoney(row.best_premium)}` : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </p>
                    </td>

                    <td className={ui.td}>
                      <p className={`font-bold ${row.is_stale ? 'text-amber-600' : 'text-slate-600'}`}>
                        {formatRelative(row.last_activity_at)}
                      </p>
                      <p className="mt-1 text-xs font-bold text-slate-400">
                        {row.notes_count} note{row.notes_count === 1 ? '' : 's'} ·{' '}
                        {row.documents_count} doc{row.documents_count === 1 ? '' : 's'}
                      </p>
                    </td>

                    <td className={ui.td} onClick={(event) => event.stopPropagation()}>
                      <div className="flex min-w-[240px] flex-wrap gap-2">
                        <button type="button" className={ui.btnPrimary} onClick={() => onOpen(row.id)}>
                          Open
                        </button>
                        {/* Every quote list carries a Log action. */}
                        <button
                          type="button"
                          className={ui.btnSecondary}
                          onClick={() => setLogFor(row)}
                        >
                          <ClipboardList className="h-4 w-4" />
                          Log
                        </button>
                        {row.is_unclaimed ? (
                          <button
                            type="button"
                            className={ui.btnSecondary}
                            disabled={busyId === row.id}
                            onClick={() => void handleClaim(row)}
                          >
                            <UserPlus className="h-4 w-4" />
                            {busyId === row.id ? 'Claiming…' : 'Claim'}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {/* Server-side paging. The browser never holds more than one page. */}
        {totalCount > PAGE_SIZE ? (
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-4 sm:px-6">
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
              disabled={pageEnd >= totalCount || loading}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </section>

      <SpecialtyLogModal
        opportunityId={logFor?.id ?? null}
        reference={logFor?.reference ?? null}
        displayName={logFor?.display_name ?? null}
        isOpen={logFor !== null}
        onClose={() => setLogFor(null)}
      />
    </div>
  );
}
