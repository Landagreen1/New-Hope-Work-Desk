'use client';

// Renewals page container (Requirements 1.3, 1.5 to 1.10, 2.1, 2.4, 2.7, 3.2 to 3.4, 4.5, 4.6, 7.2).
//
// The only renewals surface that reads at page level, and it reads only through `api.ts`:
// `listRenewals`, `listRenewalAssignees`, `listRenewalAssignmentAliases`, `listRenewalImportRuns`,
// `listRenewalSyncExceptions`. No direct Supabase client, no renewal database function call (Req 7.2).
// Every value on screen is rendered by the four children it composes — `RenewalsSummaryBar`,
// `RenewalsTable`, `RenewalDrawer` (composer, timeline, and every write for the selected record),
// `RenewalManagerActions` (import wizard, absent outside Manager_Role, holding the collapsed-menu
// state of Req 6.3) — and derived by `derive.ts`; nothing is recomputed here.
//
// It owns the records, load/error/retry state, search text, the one active summary filter, the sort
// order, the selected record id, the page size, and the business date computed once per render pass
// (Req 3.6). A failed or 15-second query leaves the records, search text, filter, and sort untouched
// and retries with them (Req 1.7, 1.10); `PolicyFollowUpPage` seeds and is told the three Req 1.3
// values, so leaving the tab and returning restores them.

import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import {
  generateDueNotifications, listRenewalAssignees, listRenewalAssignmentAliases, listRenewalImportRuns,
  listRenewalSyncExceptions, listRenewals,
} from './api';
import type {
  RenewalAssignee, RenewalAssignmentAlias, RenewalImportRun, RenewalRecord, RenewalSyncException,
} from './api';
import RenewalDrawer from './RenewalDrawer';
import RenewalManagerActions from './RenewalManagerActions';
import RenewalsSummaryBar from './RenewalsSummaryBar';
import RenewalsTable from './RenewalsTable';
import type { RenewalTableRow } from './RenewalsTable';
import {
  MAX_SEARCH_LENGTH, RENEWAL_SUMMARY_FILTERS, compareRenewalRows, currentBusinessDate, daysRemaining,
  matchesSearch, matchesSummaryFilter, premiumChange, recommendedNextAction, summaryCounts,
} from './derive';
import type {
  RenewalContactIndex, RenewalRow, RenewalSortOrder, RenewalSummaryFilterId, RenewalsUiState,
} from './derive';
import { failureText } from './format';

/** Requirement 1.7: a query that has not returned by this point is treated as a failure. */
const QUERY_TIMEOUT_MS = 15_000;
/** Background refresh cadence, carried over unchanged from the pre-revision page (Req 2.4). */
const REFRESH_INTERVAL_MS = 60_000;
/** Requirement 1.5: the first page holds at most 50 records. */
const PAGE_SIZE = 50;
const LOAD_FAILURE = 'The renewal record query failed.';

/** The five container reads as one snapshot, replaced only by a query that returned (Req 1.7). */
interface RenewalsData {
  records: readonly RenewalRecord[];
  assignees: readonly RenewalAssignee[];
  aliases: readonly RenewalAssignmentAlias[];
  importRuns: readonly RenewalImportRun[];
  syncExceptions: readonly RenewalSyncException[];
}

const EMPTY_DATA: RenewalsData = { records: [], assignees: [], aliases: [], importRuns: [], syncExceptions: [] };

/**
 * `api.ts` reads contacts one record at a time (`listContacts`), which the drawer owns, so the list
 * surface hands the derived helpers an empty index: the No contact recorded count, Last contact, and
 * Next required action all read as no contact. Defect-logged, not worked around (Req 2.6, 3.9, 4.1).
 */
const NO_CONTACTS: RenewalContactIndex = new Map();
const NO_ROW_CONTACTS: RenewalRow['contacts'] = [];

/** A `RenewalRow` carrying the whole record, which the list cells need and `derive.ts` accepts. */
type OrderedRenewal = { record: RenewalRecord; contacts: RenewalRow['contacts'] };

/** Rejects at 15 seconds, so a hung query reaches the retry path instead of loading forever (Req 1.7). */
function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('It did not return within 15 seconds.')), QUERY_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** A supporting read degrades to zero rows; only the record query drives the failure state (Req 1.7). */
function optional<T>(work: Promise<readonly T[]>): Promise<readonly T[]> {
  return work.then((rows) => rows, () => []);
}

export interface RenewalsPageProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
  /**
   * Accepted so the existing call sites keep type-checking. The revised tab holds one list surface,
   * so neither value selects anything: `PolicyFollowUpPage` owns the tabs (Req 1.1) and
   * `RenewalManagerActions` reveals the import wizard by role on its own (Req 6.2, 6.3).
   */
  initialTab?: 'overview' | 'pipeline' | 'import';
  showImportTab?: boolean;
  /** Req 1.3: the values a tab return restores, absent on a page load with nothing retained yet. */
  initialUiState?: RenewalsUiState;
  /** Req 1.3: reports each change to the tab shell, which keeps them for the current page load. */
  onUiStateChange?: (next: RenewalsUiState) => void;
}

export default function RenewalsPage({
  initialProfile: profile, embedded = false, initialUiState, onUiStateChange,
}: RenewalsPageProps) {
  const manage = isBroadManagerRole(profile.role);
  const allowed = canAccessRenewals(profile.role);

  const [data, setData] = useState<RenewalsData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [searchText, setSearchText] = useState(initialUiState?.searchText ?? '');
  const [activeFilter, setActiveFilter] = useState<RenewalSummaryFilterId | null>(initialUiState?.savedFilter ?? null);
  const [sortOrder] = useState<RenewalSortOrder>(initialUiState?.sortOrder ?? 'recommended');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  /**
   * One load for the whole page. A failure leaves `data` untouched, so the records loaded before it
   * stay as they were, alongside the search text, filter, and sort order this function never writes
   * (Req 1.7). Every state write happens in a settled callback, so nothing cascades a render.
   */
  const load = useCallback(() => {
    // Requirement 2.9: a profile `canAccessRenewals` rejects reads zero renewal rows.
    if (!allowed) return;
    void withTimeout(Promise.all([
      listRenewals(),
      optional(listRenewalAssignees()),
      manage ? optional(listRenewalAssignmentAliases()) : [],
      manage ? optional(listRenewalImportRuns()) : [],
      manage ? optional(listRenewalSyncExceptions()) : [],
    ])).then(([records, assignees, aliases, importRuns, syncExceptions]) => {
      setData({ records, assignees, aliases, importRuns, syncExceptions });
      setError(null);
      setLastUpdated(new Date());
      setLoading(false);
      // Pre-revision behavior kept: a manager load also generates the due-renewal notifications,
      // through the existing renewal function `api.ts` calls unchanged (Req 2.4).
      if (manage) void generateDueNotifications().catch(() => undefined);
    }, (caught: unknown) => {
      setError(failureText(caught, LOAD_FAILURE));
      setLoading(false);
    });
  }, [allowed, manage]);

  /** The retry and the refresh control put the indicator back; a background refresh does not. */
  const reload = useCallback(() => { setLoading(true); load(); }, [load]);

  // `loading` starts true, so the first page shows the indicator until this query returns (Req 1.5).
  useEffect(() => { load(); }, [load]);

  // Req 1.3: the tab shell keeps these three for the page load and hands them back on a tab return.
  useEffect(() => { onUiStateChange?.({ searchText, savedFilter: activeFilter, sortOrder }); },
    [activeFilter, onUiStateChange, searchText, sortOrder]);

  // Freshness without a realtime subscription, because a subscription needs the Supabase client
  // this file is not allowed to hold (Req 7.2). A background refresh never clears the list.
  useEffect(() => {
    const refresh = () => load();
    const interval = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [load]);

  /** Computed once per render pass and handed to every child that compares dates (Req 3.6). */
  const businessDate = currentBusinessDate();

  /** All ten counts, each computed independently of the active filter (Req 3.3). */
  const counts = useMemo(
    () => summaryCounts(data.records, NO_CONTACTS, searchText, businessDate),
    [businessDate, data.records, searchText],
  );

  const nameById = useMemo(
    () => new Map(data.assignees.map((person) => [person.id, person.display_name])),
    [data.assignees],
  );

  /** A display name whenever somebody is assigned; `null` only when nobody is (Req 4.3). */
  const assignedName = useCallback((id: string | null): string | null => {
    if (!id) return null;
    return id === profile.id ? profile.display_name : (nameById.get(id) ?? 'Assigned employee');
  }, [nameById, profile.display_name, profile.id]);

  // Search text first, then the single active summary filter, then the five Requirement 4.2 sort
  // keys over the complete filtered set before any paging (Req 3.2, 4.5).
  const ordered = useMemo<OrderedRenewal[]>(() => data.records
    .filter((record) => matchesSearch(record, searchText)
      && (activeFilter === null || matchesSummaryFilter(record, NO_ROW_CONTACTS, activeFilter, businessDate)))
    .map((record) => ({ record, contacts: NO_ROW_CONTACTS }))
    .sort((left, right) => compareRenewalRows(left, right, businessDate)),
  [activeFilter, businessDate, data.records, searchText]);

  /** One page of already-derived cells; the table formats them and computes nothing (Req 4.1). */
  const rows = useMemo<RenewalTableRow[]>(() => ordered.slice(0, visibleCount).map(({ record }) => ({
    id: record.id,
    customerName: record.customer_name,
    policyNumber: record.policy_number,
    carrier: record.carrier,
    lineOfBusiness: record.line_of_business,
    renewalDate: record.renewal_date,
    daysRemaining: daysRemaining(record.renewal_date, businessDate),
    assignedEmployee: assignedName(record.assigned_to),
    currentPremium: record.premium_current,
    renewalPremium: record.premium_renewal,
    premiumChange: premiumChange(record.premium_current, record.premium_renewal),
    // No bulk contact source at list level; see `NO_CONTACTS`.
    lastContact: null,
    nextFollowUp: record.next_follow_up_at,
    status: record.status,
    nextRequiredAction: recommendedNextAction(record),
  })), [assignedName, businessDate, ordered, visibleCount]);

  const selected = data.records.find((record) => record.id === selectedId) ?? null;
  const filterLabel = RENEWAL_SUMMARY_FILTERS.find((filter) => filter.id === activeFilter)?.label ?? '';
  const effectiveSearch = searchText.trim().slice(0, MAX_SEARCH_LENGTH);
  /** Requirement 1.6 applies while either is set; Requirement 1.9 applies while neither is. */
  const narrowed = Boolean(filterLabel) || effectiveSearch.length > 0;

  if (!allowed) {
    return (
      <ModuleShell title="Renewals" subtitle="Policy follow-up" role={profile.role} embedded={embedded}>
        <div className={ui.error}>Your account does not have Renewals access.</div>
      </ModuleShell>
    );
  }

  return (
    <ModuleShell
      title="Renewals"
      subtitle="Pick a counter, open the record, log the contact with its proof, and set the next follow-up."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={reload}
      embedded={embedded}
    >
      <div className="space-y-4" data-sort-order={sortOrder}>
        {/* Req 1.7 and 1.10: the failure names the query, the retained records stay on screen below
            it, and the retry re-runs with the retained search text, filter, and sort. */}
        {error ? (
          <div className={`${ui.error} flex flex-wrap items-center justify-between gap-3`} role="alert">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </span>
            <button type="button" className={ui.btnSecondary} onClick={reload}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />Retry
            </button>
          </div>
        ) : null}

        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <label className="relative w-full lg:max-w-md">
            <span className="sr-only">Search renewals</span>
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              className="w-full rounded-xl border border-slate-200 bg-white py-2.5 pl-10 pr-3 text-sm font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]"
              value={searchText}
              maxLength={MAX_SEARCH_LENGTH}
              placeholder="Customer, policy number, carrier, phone, or email"
              onChange={(event) => { setSearchText(event.target.value); setVisibleCount(PAGE_SIZE); }}
            />
          </label>
          {/* Returns nothing at all outside Manager_Role, so no role check is needed here (Req 6.2). */}
          <RenewalManagerActions
            role={profile.role}
            records={data.records}
            aliases={data.aliases}
            assignees={data.assignees}
            importRuns={data.importRuns}
            selectedRecordId={selectedId}
            onChanged={() => load()}
          />
        </div>

        {/* Pre-revision each such row carried a badge; the fourteen Req 4.1 cells hold none (Req 2.4). */}
        {manage && data.syncExceptions.length ? (
          <p className={ui.info}>
            {data.syncExceptions.length} open {data.syncExceptions.length === 1 ? 'renewal is' : 'renewals are'} missing
            from the latest import file. Review unmatched assignments in the manager menu.
          </p>
        ) : null}

        <RenewalsSummaryBar
          counts={counts}
          activeFilter={activeFilter}
          loading={loading}
          onFilterChange={(next) => { setActiveFilter(next); setVisibleCount(PAGE_SIZE); }}
        />

        <section className={`${ui.card} overflow-hidden`}>
          <RenewalsTable rows={rows} selectedId={selectedId} loading={loading} onSelect={setSelectedId} />

          {!loading && !rows.length ? (
            <div className={ui.empty}>
              {narrowed ? (
                <>
                  <p>
                    No renewal records match
                    {filterLabel ? ` the ${filterLabel} filter` : ''}
                    {filterLabel && effectiveSearch ? ' and' : ''}
                    {effectiveSearch ? ` the search text \u201C${effectiveSearch}\u201D` : ''}.
                  </p>
                  <button
                    type="button"
                    className={`${ui.btnSecondary} mt-3`}
                    onClick={() => { setActiveFilter(null); setSearchText(''); setVisibleCount(PAGE_SIZE); }}
                  >
                    Clear the filter and the search text
                  </button>
                </>
              ) : (
                <p>This tab contains zero renewal records.</p>
              )}
            </div>
          ) : null}

          {!loading && ordered.length > rows.length ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
              <p className="text-xs font-bold text-slate-500">
                Showing {rows.length} of {ordered.length} renewals
              </p>
              <button
                type="button"
                className={ui.btnSecondary}
                onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
              >
                Show {PAGE_SIZE} more
              </button>
            </div>
          ) : null}
        </section>

        {/* Renders nothing while no row is selected; a successful write refreshes this container's
            reads without closing the drawer (Req 4.6, 5.5). */}
        <RenewalDrawer
          record={selected}
          businessDate={businessDate}
          assignees={data.assignees}
          canManage={manage}
          onClose={() => setSelectedId(null)}
          onRecordChanged={() => load()}
        />
      </div>
    </ModuleShell>
  );
}
