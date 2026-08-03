'use client';

// Cancellations page container — task 16.12
// (Requirements 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.10, 16.2, 16.3, 16.5, 16.6, 17.1, 17.8, 17.9).
//
// The cancellations twin of `../renewals/RenewalsPage`, and the only cancellations surface that
// reads at page level. Every read goes through `./api`; there is no `getSupabase()` call and no
// `.rpc(...)` call here.
//
// **What it owns.** The loaded case window, the load, error, and retry state, the search text, the
// one active saved filter, the sort order, the zero-based page index, the selected case id, the
// note draft, and the business date computed once per render pass (Requirement 3.6). It recomputes
// none of the values on screen: `./derive` filters, searches, sorts, and counts, `./CancellationsT
// able` renders the thirteen cells `cancellationsTableRow` derived, and `./CancellationsSummaryBar`
// owns the search field, the fourteen filters, and both empty-state variants.
//
// **What it composes.** The summary bar, the table, `./CancellationDrawer` — which owns its own
// detail reads and hosts the contact panel, the payment report, and the verification panel itself,
// so those three are not composed here — and `./CancellationManagerActions`, which renders zero
// nodes outside Manager_Role. The one surface built here is the note composer of Requirements 17.8
// and 17.9, handed to the drawer through its `noteComposer` slot.
//
// **Readings recorded where a criterion leaves something open.**
//
//  1. *The loaded window is every case page the cap allows, not one page.* Requirement 16.2 wants
//     all fourteen counts computed independently of the active filter and Requirement 16.3 wants
//     the list to be every readable row matching the filter and the search, in the one Requirement
//     16.5 order. Neither is answerable from a single 50-row database page, and neither filter nor
//     search can be pushed into the query: both read contacts, communications, responses, and
//     escalations. So `listCancellationCases` is followed while it reports more rows, up to
//     `MAX_LOADED_PAGES`, and the filtering, counting, sorting, and paging all happen over that
//     window. Reaching the cap is stated on screen rather than passed off as the whole list.
//  2. *Six reads decide the failure state; the configuration reads degrade.* The cases, contacts,
//     communications, responses, escalations, and suppressions are what Requirement 16.3's list is
//     made of, so a failure in any of them is the failed query of Requirement 1.7: the message and
//     the retry appear and the previously loaded window, search text, filter, and sort stay exactly
//     as they were. Assignees, settings, import runs, templates, the assignment mapping, and the
//     actor read degrade to nothing instead, because a missing employee name must not blank a list
//     that loaded.
//  3. *The business date is read once per render pass and handed down.* `currentBusinessDate` from
//     `../renewals/derive` is the one clock read in the workspace (Requirement 3.6). The drawer
//     takes the same value, so its Touchpoint schedule and the list's days-remaining, SMS status,
//     and email status cells cannot disagree about what day it is.
//  4. *The Touchpoint schedule is derived per row, and the pending count comes from it.*
//     Requirement 12.1 fixes a Touchpoint's scheduled date as the calendar date that many days
//     before the cancellation effective date and Requirement 12.2 schedules a channel only where it
//     has an eligible recipient; `cancellation_cases` stores neither. `cancellationScheduledSends`
//     from `./CancellationDrawer` derives both from the effective date, the contact rows, and the
//     active suppressions, and is reused rather than restated — `scheduler/run.scheduledSendsFor` is
//     the same rule but constructs a service-role client and reads the cron secret, so it may not
//     enter a browser bundle. Supplying the schedule is what makes a scheduled, unsent case read
//     `Scheduled` in the two status cells and match the Communication_Status-driven filters instead
//     of `Not Scheduled`, which a missing schedule would silently produce. The drawer derives the
//     pending-send count the contact panel, the payment report, and the verification panel need
//     with the same function over its own detail reads, and withholds it where no effective date is
//     readable rather than passing a zero.
//  5. *The clearing control of Requirement 1.6 clears to All.* `CLEARED_CANCELLATION_FILTER` is
//     `'all'`, not `DEFAULT_CANCELLATION_FILTER`: clearing back to Needs Action would leave the
//     list narrowed and land the reader on the same empty state. The constant is imported from the
//     bar so the handler and the bar's own narrowing test agree on one meaning.
//  6. *The note draft lives here, keyed by the selected case.* Requirement 17.8 retains the entered
//     text through a rejection and Requirement 17.9 leaves the note unsaved, so text, attachments,
//     the rejection, and the success notice are container state: they survive both the drawer's own
//     refresh and the remount below, and a different cancellation starts from a blank composer
//     without an effect resetting anything.
//  7. *Limits are checked before anything is uploaded.* The 1-to-4,000-character range, the 10-file
//     count, and the 100 MB per-file size are tested here before `addCancellationNote` is called,
//     which is itself the second check of the same three limits ahead of its first upload. A
//     rejected submission therefore stores no note and no evidence file (Requirements 17.8, 17.9).
//  8. *A saved note remounts the drawer.* The drawer reads its own notes, keyed by `caseId`, and
//     refreshes them only after a write of its own. A note written from this composer is shown by
//     changing the drawer's React key, which re-runs its detail reads; focus returns to the row
//     button and then into the panel, so it stays inside the drawer. The composer's notice is not
//     lost because reading 6 keeps it out of the remounted subtree's state.
//  9. *An owed escalation re-evaluation refreshes the reads.* A write reports
//     `escalationReevaluationDue`, and the evaluator's writes belong to the scheduler
//     (`POST /api/cancellations/scheduler`), not to a browser session. The container re-reads the
//     escalation rows so the list shows whatever has been raised; it raises nothing itself.
// 10. *Freshness without a timer.* The renewals container polls every 60 seconds; one cancellations
//     load is six reads over up to a thousand cases, so this one refreshes when the window regains
//     focus, when the browser comes back online, and when the reader asks — no interval, and no
//     realtime subscription, which would need the Supabase client this file may not hold.

import { AlertTriangle, ChevronLeft, ChevronRight, FileUp, Paperclip, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import { currentBusinessDate } from '../renewals/derive';
import { failureText, megabytes } from '../renewals/format';
import {
  MAX_EVIDENCE_FILES,
  MAX_EVIDENCE_SIZE_BYTES,
  MAX_NOTE_LENGTH,
  MIN_NOTE_LENGTH,
  addCancellationNote,
  getCancellationActor,
  getCancellationSettings,
  listCancellationAssignees,
  listCancellationCases,
  listCancellationImportRuns,
  listCancellationTemplates,
  listCommunicationsForCases,
  listContactsForCases,
  listCustomerResponsesForCases,
  listEscalationsForCases,
  listSuppressions,
  type CancellationActor,
  type CancellationAssignee,
  type CancellationCase,
  type CancellationCommunication,
  type CancellationContact,
  type CancellationCustomerResponse,
  type CancellationEscalation,
  type CancellationImportRun,
  type CancellationSettings,
  type CancellationSuppression,
  type CancellationTemplateWithVersions,
} from './api';
import CancellationDrawer, { cancellationScheduledSends } from './CancellationDrawer';
import CancellationManagerActions from './CancellationManagerActions';
import CancellationsSummaryBar, {
  CLEARED_CANCELLATION_FILTER,
  resolveCancellationFilter,
} from './CancellationsSummaryBar';
import CancellationsTable, { cancellationsTableRow } from './CancellationsTable';
import {
  CANCELLATION_PAGE_SIZE,
  cancellationFilterCounts,
  filterCancellationRows,
  type CancellationRowState,
  type CancellationSavedFilterId,
  type CancellationSortOrder,
  type CancellationViewer,
  type CancellationsUiState,
} from './derive';
import {
  fetchProducerAssignmentMapping,
  type ProducerAssignmentEntry,
} from './import/loader';

/** Requirement 1.7: a query that has not returned by this point is treated as a failure. */
const QUERY_TIMEOUT_MS = 15_000;

/** Reading 1: at most this many 50-row case pages are followed in one load. */
const MAX_LOADED_PAGES = 20;

const LOAD_FAILURE = 'The cancellation record query failed.';
const NOTE_FAILURE = 'The note could not be saved.';

/** The six reads Requirement 16.3's list is made of, plus the reads that may degrade (reading 2). */
interface CancellationsData {
  cases: readonly CancellationCase[];
  contacts: readonly CancellationContact[];
  communications: readonly CancellationCommunication[];
  responses: readonly CancellationCustomerResponse[];
  escalations: readonly CancellationEscalation[];
  suppressions: readonly CancellationSuppression[];
  assignees: readonly CancellationAssignee[];
  /** Absent outside Manager_Role, which is what lets the manager surface read its own (reading 2). */
  importRuns: readonly CancellationImportRun[] | undefined;
  templates: readonly CancellationTemplateWithVersions[] | undefined;
  /** Absent where the manager-only mapping read was refused or is not this profile's to read. */
  assignments: readonly ProducerAssignmentEntry[] | undefined;
  settings: CancellationSettings | null;
  /** The signed-in profile as `api.ts` reads it, so the controls match what a write will allow. */
  actor: CancellationActor | null;
  /** Rows the database reports in the profile's scope, which may exceed the loaded window. */
  total: number;
  /** True where `MAX_LOADED_PAGES` stopped the load before the source was exhausted (reading 1). */
  truncated: boolean;
}

const EMPTY_DATA: CancellationsData = {
  cases: [],
  contacts: [],
  communications: [],
  responses: [],
  escalations: [],
  suppressions: [],
  assignees: [],
  importRuns: undefined,
  templates: undefined,
  assignments: undefined,
  settings: null,
  actor: null,
  total: 0,
  truncated: false,
};

/** The note draft of one cancellation (reading 6). */
interface NoteDraft {
  key: string;
  text: string;
  files: readonly File[];
  error: string | null;
  notice: string | null;
}

const BLANK_NOTE: NoteDraft = { key: '', text: '', files: [], error: null, notice: null };

/** Rejects at 15 seconds, so a hung query reaches the retry path instead of loading forever. */
function withTimeout<T>(work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('It did not return within 15 seconds.')), QUERY_TIMEOUT_MS);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** A supporting read degrades to zero rows; only the six list reads fail the load (reading 2). */
function optional<T>(work: Promise<readonly T[]>): Promise<readonly T[]> {
  return work.then((rows) => rows, () => []);
}

/** A supporting single-value read degrades to `null` (reading 2). */
function optionalValue<T>(work: Promise<T | null>): Promise<T | null> {
  return work.then((value) => value, () => null);
}

/** The case window: every page the source offers, up to the cap of reading 1. */
async function fetchCaseWindow(): Promise<Pick<CancellationsData, 'cases' | 'total' | 'truncated'>> {
  const cases: CancellationCase[] = [];
  let page = 0;
  let total = 0;
  let hasMore = true;

  while (hasMore && page < MAX_LOADED_PAGES) {
    const result = await listCancellationCases({ page, pageSize: CANCELLATION_PAGE_SIZE });
    cases.push(...result.rows);
    total = result.total;
    hasMore = result.hasMore;
    page += 1;
  }

  return { cases, total: Math.max(total, cases.length), truncated: hasMore };
}

/** The assignment mapping, or `undefined` where the manager-only read was refused (reading 2). */
async function fetchAssignments(): Promise<readonly ProducerAssignmentEntry[] | undefined> {
  try {
    const result = await fetchProducerAssignmentMapping();
    return result.ok ? result.mapping.entries : undefined;
  } catch {
    return undefined;
  }
}

/** One whole page load. The six list reads reject; every other read degrades (reading 2). */
async function fetchCancellations(manage: boolean): Promise<CancellationsData> {
  const [caseWindow, actor] = await Promise.all([
    fetchCaseWindow(),
    optionalValue(getCancellationActor()),
  ]);
  const caseIds = caseWindow.cases.map((row) => row.id);

  const [contacts, communications, responses, escalations, assignees, settings, importRuns, templates] =
    await Promise.all([
      listContactsForCases(caseIds),
      listCommunicationsForCases(caseIds),
      listCustomerResponsesForCases(caseIds),
      listEscalationsForCases(caseIds),
      optional(listCancellationAssignees()),
      optionalValue(getCancellationSettings()),
      manage ? optional(listCancellationImportRuns()) : undefined,
      manage ? optional(listCancellationTemplates()) : undefined,
    ]);

  // Keyed by normalized contact value rather than by case, so one opt-out reaches every case
  // holding that value including a contact a later import created (Requirements 21.3, 21.4).
  const suppressions = await listSuppressions([
    ...new Set(contacts.map((contact) => contact.normalized_value)),
  ]);

  return {
    ...caseWindow,
    contacts,
    communications,
    responses,
    escalations,
    suppressions,
    assignees,
    settings,
    importRuns,
    templates,
    assignments: manage ? await fetchAssignments() : undefined,
    actor,
  };
}

/**
 * Why a note submission is refused, or `null` where it may be attempted (Requirements 17.8, 17.9).
 *
 * All three limits are tested here, before anything is uploaded — reading 7. `api.addCancellation`
 * `Note` tests the same three again ahead of its first upload, so a submission that reached it
 * anyway still stores no note and no evidence file; this function is what puts the limit on screen
 * without a round trip. The length is measured after trimming and the range is stated in the
 * message, and the message never claims a partial save.
 */
export function noteRejection(text: string, files: readonly File[]): string | null {
  const trimmed = text.trim().length;
  if (trimmed < MIN_NOTE_LENGTH || trimmed > MAX_NOTE_LENGTH) {
    return `A note must be ${MIN_NOTE_LENGTH} to ${MAX_NOTE_LENGTH.toLocaleString('en-US')} characters after leading and trailing whitespace is removed; this one is ${trimmed.toLocaleString('en-US')}. Nothing was saved.`;
  }
  if (files.length > MAX_EVIDENCE_FILES) {
    return `At most ${MAX_EVIDENCE_FILES} evidence files may be attached to one note; this submission has ${files.length}. No evidence file was stored and the note was not saved.`;
  }
  const oversized = files.find((file) => file.size > MAX_EVIDENCE_SIZE_BYTES);
  if (oversized !== undefined) {
    return `"${oversized.name}" is ${megabytes(oversized.size)}, over the ${megabytes(MAX_EVIDENCE_SIZE_BYTES)} evidence limit. No evidence file was stored and the note was not saved.`;
  }
  return null;
}

/** Rows of one table grouped by their `case_id`, so each bundle is assembled in one pass. */
function groupByCase<T extends { case_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const held = grouped.get(row.case_id);
    if (held === undefined) grouped.set(row.case_id, [row]);
    else held.push(row);
  }
  return grouped;
}

/**
 * One `CancellationRowState` per loaded case: the facts `derive.ts` filters, searches, sorts,
 * counts, and derives the thirteen cells from, with the Touchpoint schedule of reading 4 supplied
 * so no derivation has to guess it.
 */
function buildRowStates(
  data: CancellationsData,
  businessDate: string,
  viewerRole: AppRole,
): CancellationRowState[] {
  const contactsByCase = groupByCase(data.contacts);
  const communicationsByCase = groupByCase(data.communications);
  const responsesByCase = groupByCase(data.responses);
  const escalationsByCase = groupByCase(data.escalations);
  const assigneeById = new Map(data.assignees.map((person) => [person.id, person]));

  return data.cases.map((caseRow) => {
    const contacts = contactsByCase.get(caseRow.id) ?? [];
    return {
      case: caseRow,
      contacts,
      communications: communicationsByCase.get(caseRow.id) ?? [],
      responses: responsesByCase.get(caseRow.id) ?? [],
      escalations: escalationsByCase.get(caseRow.id) ?? [],
      suppressions: data.suppressions,
      scheduledSends:
        cancellationScheduledSends(caseRow, contacts, data.suppressions, businessDate) ?? [],
      businessDate,
      assignedEmployee:
        caseRow.assigned_to === null ? null : assigneeById.get(caseRow.assigned_to) ?? null,
      viewerRole,
    };
  });
}

export interface CancellationsPageProps {
  initialProfile: ProfileLite;
  /** Set when a surrounding workspace already draws the page chrome, as `PolicyFollowUpPage` does. */
  embedded?: boolean;
  /** Req 1.3: the values a tab return restores, absent on a page load with nothing retained yet. */
  initialUiState?: CancellationsUiState;
  /** Req 1.3: reports each change to the tab shell, which keeps them for the current page load. */
  onUiStateChange?: (next: CancellationsUiState) => void;
}

export default function CancellationsPage({
  initialProfile: profile,
  embedded = false,
  initialUiState,
  onUiStateChange,
}: CancellationsPageProps) {
  const allowed = canAccessRenewals(profile.role);

  const [data, setData] = useState<CancellationsData>(EMPTY_DATA);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [searchText, setSearchText] = useState(initialUiState?.searchText ?? '');
  const [savedFilter, setSavedFilter] = useState<CancellationSavedFilterId | null>(
    initialUiState?.savedFilter ?? null,
  );
  const [sortOrder] = useState<CancellationSortOrder>(initialUiState?.sortOrder ?? 'recommended');
  const [page, setPage] = useState(0);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [noteState, setNoteState] = useState<NoteDraft | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [showImportWizard, setShowImportWizard] = useState(false);
  /** Bumped whenever the attachments are dropped, so the file field clears its own selection. */
  const [noteResetKey, setNoteResetKey] = useState(0);
  /** Reading 8: bumped by a saved note so the drawer re-reads its own notes. Nothing else bumps it. */
  const [drawerKey, setDrawerKey] = useState(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * One load for the whole page. A failure leaves `data` untouched, so the window loaded before it
   * stays as it was, alongside the search text, filter, sort order, and page index this function
   * never writes (Requirement 1.7).
   */
  const load = useCallback(() => {
    // Requirement 22: a profile the workspace gate rejects reads zero cancellation rows.
    if (!allowed) return;
    void withTimeout(fetchCancellations(isBroadManagerRole(profile.role))).then(
      (next) => {
        if (!mounted.current) return;
        setData(next);
        setError(null);
        setLastUpdated(new Date());
        setLoading(false);
      },
      (caught: unknown) => {
        if (!mounted.current) return;
        setError(failureText(caught, LOAD_FAILURE));
        setLoading(false);
      },
    );
  }, [allowed, profile.role]);

  /** Requirement 1.10: the retry and the refresh control put the indicator back and re-run. */
  const reload = useCallback(() => {
    setLoading(true);
    load();
  }, [load]);

  // `loading` starts true, so the first page shows the indicator until this query returns (Req 1.5).
  useEffect(() => {
    load();
  }, [load]);

  // Req 1.3: the tab shell keeps these three for the page load and hands them back on a tab return.
  useEffect(() => {
    onUiStateChange?.({ searchText, savedFilter, sortOrder });
  }, [onUiStateChange, savedFilter, searchText, sortOrder]);

  // Reading 10: freshness without an interval and without a realtime subscription.
  useEffect(() => {
    const refresh = () => load();
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [load]);

  /** Reading 3: one clock read per render pass, handed to every child that compares dates. */
  const businessDate = currentBusinessDate();

  /**
   * The role the controls are drawn from: the profile `api.ts` will check when a write runs, which
   * is read per load so a role change takes effect without a reload, falling back to the profile the
   * route resolved. `super_admin` holds every `manager` permission, so the manager gate is
   * `isBroadManagerRole` and never a bare `role === 'manager'`.
   */
  const viewerRole: AppRole = data.actor?.role ?? profile.role;
  const viewer = useMemo<CancellationViewer>(
    () => ({ role: viewerRole, profileId: profile.id }),
    [profile.id, viewerRole],
  );

  const rowStates = useMemo(
    () => buildRowStates(data, businessDate, viewerRole),
    [businessDate, data, viewerRole],
  );

  /** All fourteen counts, each computed independently of the active filter (Requirement 16.2). */
  const counts = useMemo(
    () => cancellationFilterCounts(rowStates, { searchText, businessDate, viewer }),
    [businessDate, rowStates, searchText, viewer],
  );

  /** The list of Requirement 16.3, in the one Requirement 16.5 order, before paging. */
  const listed = useMemo(
    () =>
      filterCancellationRows(rowStates, {
        filterId: resolveCancellationFilter(savedFilter),
        searchText,
        businessDate,
        viewer,
      }),
    [businessDate, rowStates, savedFilter, searchText, viewer],
  );

  /** Requirement 16.5: pages of at most 50 rows over the whole filtered set. */
  const pageCount = Math.max(1, Math.ceil(listed.length / CANCELLATION_PAGE_SIZE));
  const activePage = Math.min(page, pageCount - 1);
  const firstRow = activePage * CANCELLATION_PAGE_SIZE;
  const rows = useMemo(
    () => listed.slice(firstRow, firstRow + CANCELLATION_PAGE_SIZE).map(cancellationsTableRow),
    [firstRow, listed],
  );

  /** Requirement 1.6: the clearing control clears the filter to All and the search text — reading 5. */
  const clearFilterAndSearch = useCallback(() => {
    setSavedFilter(CLEARED_CANCELLATION_FILTER);
    setSearchText('');
    setPage(0);
  }, []);

  const note = noteState?.key === (selectedCaseId ?? '') ? noteState : BLANK_NOTE;
  const setNote = useCallback(
    (next: Omit<NoteDraft, 'key'>) => setNoteState({ key: selectedCaseId ?? '', ...next }),
    [selectedCaseId],
  );

  /**
   * Requirements 17.8 and 17.9. `noteRejection` is applied before `addCancellationNote` is called,
   * so a rejected submission uploads nothing and stores nothing, and the entered text and the
   * attached files stay on screen — reading 7.
   */
  const submitNote = useCallback(async () => {
    if (selectedCaseId === null) return;

    const rejection = noteRejection(note.text, note.files);
    if (rejection !== null) {
      setNote({ text: note.text, files: note.files, notice: null, error: rejection });
      return;
    }

    setNoteBusy(true);
    try {
      const stored = await addCancellationNote({
        caseId: selectedCaseId,
        note: note.text,
        files: note.files,
      });
      if (!mounted.current) return;
      setNote({
        text: '',
        files: [],
        error: null,
        notice: `The note was saved with ${stored.evidence.length === 1 ? '1 evidence file' : `${stored.evidence.length} evidence files`}.`,
      });
      setNoteResetKey((current) => current + 1);
      // Reading 8: the drawer re-reads its own notes, and the list picks up the new timeline entry.
      setDrawerKey((current) => current + 1);
      load();
    } catch (caught) {
      if (!mounted.current) return;
      setNote({
        text: note.text,
        files: note.files,
        notice: null,
        error: failureText(caught, NOTE_FAILURE),
      });
    } finally {
      if (mounted.current) setNoteBusy(false);
    }
  }, [load, note.files, note.text, selectedCaseId, setNote]);

  const resolveProfileName = useCallback(
    (profileId: string): string | null | undefined => {
      if (profileId === profile.id) return profile.display_name;
      return data.assignees.find((person) => person.id === profileId)?.display_name;
    },
    [data.assignees, profile.display_name, profile.id],
  );

  if (!allowed) {
    return (
      <ModuleShell
        title="Pending Cancellations"
        subtitle="Policy follow-up"
        role={profile.role}
        embedded={embedded}
      >
        <div className={ui.error}>Your account does not have Cancellations access.</div>
      </ModuleShell>
    );
  }

  return (
    <ModuleShell
      title="Pending Cancellations"
      subtitle="Pick a counter, open the case, contact the customer with proof, and record what came back."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={reload}
      embedded={embedded}
    >
      <div className="space-y-4" data-sort-order={sortOrder}>
        {/* Req 1.7 and 1.10: the failure names the query, the window loaded before it stays on
            screen below, and the retry re-runs with the retained search text, filter, and sort. */}
        {error ? (
          <div className={`${ui.error} flex flex-wrap items-center justify-between gap-3`} role="alert">
            <span className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
              {error}
            </span>
            <button type="button" className={ui.btnSecondary} onClick={reload}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Retry
            </button>
          </div>
        ) : null}

        {/* Returns zero nodes outside Manager_Role, so no role check is needed here (Req 22.3). */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {/* REQ-4.3: Visible Import button for managers in the header area */}
          {isBroadManagerRole(viewerRole) ? (
            <button
              type="button"
              className={ui.btnPrimary}
              onClick={() => setShowImportWizard(true)}
              disabled={loading}
            >
              <FileUp className="h-4 w-4" aria-hidden="true" />
              Import Cancellations
            </button>
          ) : null}
          <CancellationManagerActions
            role={viewerRole}
            cases={data.cases}
            assignees={data.assignees}
            importRuns={data.importRuns}
            templates={data.templates}
            settings={data.settings}
            assignments={data.assignments}
            selectedCaseId={selectedCaseId}
            resolveProfileName={resolveProfileName}
            onChanged={() => load()}
            disabled={loading}
            importWizardOpen={showImportWizard}
            onImportWizardClose={() => setShowImportWizard(false)}
          />
        </div>

        {/* Reading 1: the window is stated rather than presented as the whole list. */}
        {data.truncated ? (
          <p className={ui.info}>
            The {data.cases.length.toLocaleString('en-US')} cancellations closest to their effective
            date are loaded, of {data.total.toLocaleString('en-US')} in your view. Narrow the list with
            a saved filter or the search field to reach the rest.
          </p>
        ) : null}

        {/* Owns the search field, the fourteen filters, and both empty-state variants (Req 1.6, 1.9). */}
        <CancellationsSummaryBar
          counts={counts}
          activeFilter={savedFilter}
          onFilterChange={(next) => {
            setSavedFilter(next);
            setPage(0);
          }}
          searchText={searchText}
          onSearchTextChange={(next) => {
            setSearchText(next);
            setPage(0);
          }}
          rowCount={rows.length}
          onClearFilterAndSearch={clearFilterAndSearch}
          loading={loading}
        />

        <section className={`${ui.card} overflow-hidden`} aria-busy={loading}>
          <CancellationsTable
            rows={rows}
            page={activePage}
            selectedCaseId={selectedCaseId}
            onRowClick={setSelectedCaseId}
            loading={loading}
          />

          {!loading && listed.length > CANCELLATION_PAGE_SIZE ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3">
              <p className="text-xs font-bold text-slate-500">
                Showing {(firstRow + 1).toLocaleString('en-US')} to{' '}
                {(firstRow + rows.length).toLocaleString('en-US')} of{' '}
                {listed.length.toLocaleString('en-US')} cancellations
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={ui.btnSecondary}
                  disabled={activePage === 0}
                  onClick={() => setPage(Math.max(0, activePage - 1))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" />
                  Previous {CANCELLATION_PAGE_SIZE}
                </button>
                <button
                  type="button"
                  className={ui.btnSecondary}
                  disabled={activePage >= pageCount - 1}
                  onClick={() => setPage(Math.min(pageCount - 1, activePage + 1))}
                >
                  Next {CANCELLATION_PAGE_SIZE}
                  <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {/* Renders nothing while no row is selected, so at most one drawer is displayed (Req 16.6).
            It owns its detail reads and hosts the contact panel, the payment report, and the
            verification panel itself; the note composer is this container's (Req 17.8, 17.9). */}
        <CancellationDrawer
          key={`${selectedCaseId ?? 'none'}:${drawerKey}`}
          caseId={selectedCaseId}
          businessDate={businessDate}
          role={viewerRole}
          assignees={data.assignees}
          settings={data.settings}
          noteComposer={
            selectedCaseId === null ? null : (
              <CancellationNoteComposer
                text={note.text}
                files={note.files}
                error={note.error}
                notice={note.notice}
                busy={noteBusy}
                resetKey={noteResetKey}
                onTextChange={(next) =>
                  setNote({ text: next, files: note.files, error: note.error, notice: null })
                }
                onFilesChange={(next) =>
                  setNote({ text: note.text, files: next, error: null, notice: null })
                }
                onDropFiles={() => {
                  setNote({ text: note.text, files: [], error: null, notice: null });
                  setNoteResetKey((current) => current + 1);
                }}
                onSubmit={() => void submitNote()}
              />
            )
          }
          onClose={() => setSelectedCaseId(null)}
          /* Reading 9: a drawer write refreshes this container's reads; the drawer stays open. */
          onCaseChanged={() => load()}
        />
      </div>
    </ModuleShell>
  );
}

// ---------------------------------------------------------------------------
// The note composer (Requirements 17.8, 17.9)
// ---------------------------------------------------------------------------

interface CancellationNoteComposerProps {
  text: string;
  files: readonly File[];
  /** The rejection, announced and wired to both fields it can be about (Requirement 17.8). */
  error: string | null;
  notice: string | null;
  busy: boolean;
  /** Changes when the container drops the attachments, which is what clears the file field. */
  resetKey: number;
  onTextChange: (next: string) => void;
  onFilesChange: (next: File[]) => void;
  onDropFiles: () => void;
  onSubmit: () => void;
}

/**
 * The note field, the evidence field, and the one control that saves them.
 *
 * Stateless by design: every value is the container's (reading 6), so a rejection leaves the text
 * and the attachments exactly where the reader left them and the drawer remount of reading 8
 * discards neither. The required range and both evidence limits are stated before a submission is
 * attempted, not only after one is refused.
 */
function CancellationNoteComposer({
  text,
  files,
  error,
  notice,
  busy,
  resetKey,
  onTextChange,
  onFilesChange,
  onDropFiles,
  onSubmit,
}: CancellationNoteComposerProps) {
  const baseId = useId();
  const noteId = `${baseId}-note`;
  const filesId = `${baseId}-evidence`;
  const rangeId = `${baseId}-range`;
  const limitsId = `${baseId}-limits`;
  const errorId = `${baseId}-error`;
  const noticeId = `${baseId}-notice`;

  const trimmed = text.trim().length;
  const outOfRange = trimmed < MIN_NOTE_LENGTH || trimmed > MAX_NOTE_LENGTH;

  return (
    <form
      className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <p className={ui.sectionTitle}>Add a note</p>

      <label className={`${ui.label} mt-3 block`} htmlFor={noteId}>
        Note
      </label>
      <textarea
        id={noteId}
        className={ui.textarea}
        rows={3}
        value={text}
        disabled={busy}
        aria-invalid={error !== null && outOfRange}
        aria-describedby={`${rangeId}${error === null ? '' : ` ${errorId}`}`}
        placeholder="What happened, what was agreed, and what happens next."
        onChange={(event) => onTextChange(event.target.value)}
      />
      <p id={rangeId} className="mt-1 text-xs font-semibold text-slate-500">
        {MIN_NOTE_LENGTH} to {MAX_NOTE_LENGTH.toLocaleString('en-US')} characters after leading and
        trailing whitespace is removed. {trimmed.toLocaleString('en-US')} entered.
      </p>

      <label className={`${ui.label} mt-4 block`} htmlFor={filesId}>
        Evidence files
      </label>
      <input
        id={filesId}
        type="file"
        multiple
        disabled={busy}
        // A file field's selection cannot be written from React, so the container bumps `resetKey`
        // when it drops the attachments and the field is replaced with an empty one. A saved note
        // therefore starts the next one from an empty field rather than re-offering stored files.
        key={resetKey}
        className="mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-700 outline-none transition file:mr-3 file:rounded-lg file:border-0 file:bg-[#eef3fb] file:px-3 file:py-1.5 file:text-xs file:font-black file:text-[#223f7a] focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]"
        aria-invalid={error !== null && !outOfRange}
        aria-describedby={`${limitsId}${error === null ? '' : ` ${errorId}`}`}
        onChange={(event) => onFilesChange(Array.from(event.target.files ?? []))}
      />
      <p id={limitsId} className="mt-1 text-xs font-semibold text-slate-500">
        At most {MAX_EVIDENCE_FILES} files, {megabytes(MAX_EVIDENCE_SIZE_BYTES)} each. A submission
        over either limit stores no file and leaves the note unsaved.
        {files.length > 0
          ? ` ${files.length === 1 ? '1 file' : `${files.length} files`} attached: ${files
              .map((file) => `${file.name} (${megabytes(file.size)})`)
              .join(', ')}.`
          : ''}
      </p>

      {error !== null ? (
        <p id={errorId} role="alert" className={`${ui.error} mt-3`}>
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </span>
        </p>
      ) : null}
      {notice !== null ? (
        <p id={noticeId} role="status" className={`${ui.success} mt-3`}>
          {notice}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" className={ui.btnPrimary} disabled={busy}>
          {busy ? (
            <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-4 w-4" aria-hidden="true" />
          )}
          {busy ? 'Saving the note…' : 'Save the note'}
        </button>
        {files.length > 0 ? (
          <button type="button" className={ui.btnSecondary} disabled={busy} onClick={onDropFiles}>
            <Paperclip className="h-4 w-4" aria-hidden="true" />
            Remove the attachments
          </button>
        ) : null}
      </div>
    </form>
  );
}
