// src/features/time-attendance/timeoff/RequestComposer.tsx
// The employee's own half of Time Off & Coverage: what they have left, what a
// request would cost them, and what has been answered.
//
// This is the seam `TimeOffCoverageScreen` calls `renderComposer`, rendered above
// the Request_Inbox in the left pane for every role — an administrator has leave of
// their own to ask for, and Requirement 11 belongs to whoever is signed in. It
// answers Requirement 11 and the vocabulary half of Requirement 10:
//
// | shown                                     | read from                              | criterion |
// | ----------------------------------------- | -------------------------------------- | --------- |
// | type, first day, last day, reason         | the form below                          | 11.1      |
// | only the types the database accepts       | `requestTypes`, from the response       | 10.20     |
// | remaining balance for each type           | `remainingBalanceFor` over `/api/pto/balance` | 11.3 |
// | the working days a request would cost     | `buildSubmissionDisclosure.workingDays` | 11.2      |
// | the shortfall, with submission still offered | `exceedsBalance`, `shortfallDays`    | 11.4      |
// | the short-notice condition                | `shortNotice`, `noticeDays`             | 11.5      |
// | own requests in all five states           | this pane's own `/api/pto` read          | 11.6      |
// | the reviewer's response on each           | `row.reviewerResponse`                  | 11.7      |
// | withdraw, for pending and waitlisted      | `canCancelRequest`                      | 11.8      |
//
// ## It decides neither figure
//
// The working-day count, the shortfall, and the short-notice condition all come
// from `buildSubmissionDisclosure` — the same function `submitRequest` calls on the
// server before it writes `working_days` and `short_notice` to the row. So the cost
// this pane previews as an employee picks dates is the cost that gets stored, and
// the count a decision debits is the count they were shown (Correctness Property
// 18). What comes back from the write replaces the preview, because the server
// recomputed it against the stored closed dates and its own clock.
//
// One difference is worth naming: the preview has no closed-date list to work from.
// No read carries `attendance_closed_dates`, so a range covering a company holiday
// previews one day more than the server stores. The pane says so beside the count
// rather than presenting the figure as final.
//
// ## Nothing here refuses a request
//
// Requirement 11, criterion 4 allows a submission that exceeds the balance with the
// shortfall disclosed, and criterion 5 records short notice rather than refusing
// it. Both are therefore notices beside an enabled submit control, not guards in
// front of a disabled one — and `SubmissionDisclosure.accepted` is `true` by
// construction, so there is no branch here that could quietly become a refusal.
// The inherited screen warned about the fortnight and let the request through
// anyway while the server stored nothing about it; here the condition is computed
// once and kept on the row.
//
// ## Why this pane reads its own requests
//
// The screen hands it `ownRequests`: the rows of the inbox's current page that
// belong to the signed-in employee. That page is filtered and paged by the inbox's
// own controls, so on its own it cannot answer criterion 6 — a status filter set to
// approved would empty the list of everything else, and an administrator's own
// requests may be on page three of the team's queue. So this pane reads
// `/api/pto?profile_id=<me>` with no other filter, and merges the screen's rows
// over the top: both come from the same endpoint and the same builder, so they
// cannot disagree about content, only about age, and the screen's copy is the one
// that has just been replaced from a write.
//
// ## Requirement 11, criterion 11 is the calendar's
//
// Other employees' approved absences reach a reader through the Coverage_Calendar
// and its date drawer, gated on `employeeNamesVisible` — the shared absence
// calendar permission of Requirement 8, criterion 13, which the Coverage_Service
// takes as an input because no such grant exists in the schema yet. Until it does,
// a non-administrator's coverage scope is their own row, so there are no other
// absences for this pane to display and duplicating that read here would only
// produce a projection over a roster of one. The criterion is met where the data
// is, in the centre pane.
//
// Requirements: 10.20, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9,
// 11.10, 11.11, 22.6, 22.7, 22.12, 22.14, 22.15, 22.16

'use client';

import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { statusLabel, ui } from '../../nhwd-shared/ui';
import {
  CANCELLABLE_STATUSES,
  PTO_TYPE_TO_BALANCE_FIELD,
  REQUEST_PAGE_LIMIT,
  SHORT_NOTICE_DAYS,
  buildSubmissionDisclosure,
  canCancelRequest,
  compareRequestRows,
  reasonWithContent,
  remainingBalanceFor,
  type BalanceField,
  type PTOBalanceRow,
  type SubmissionDisclosure,
} from '../domain/pto';
import type { DateRange } from '../domain/types';
import { addCalendarDays, workDateOf } from '../domain/work-date';
import type { RequestRow, SubmissionResult } from '../server/pto-service';
import { asApiFailure, attendanceJson, jsonRequest, type ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { NO_VALUE, formatDays, formatInstantDate, formatWorkDate } from '../shared/format';
import { requestQueryUrl } from '../shared/request-query';
import { StatusIcon } from '../shared/StatusIcon';
import { StatusPill } from '../shared/StatusPill';
import { colorRoleToken, type ColorRole } from '../shared/tokens';
import { useAsyncResource } from '../shared/useAsyncResource';
import { PTO_TYPE_LABELS, type PTOType } from '../types';
import type { ComposerPaneContext, RequestInboxResponse } from './TimeOffCoverageScreen';

const FALLBACK_TIME_ZONE = 'UTC';

/** What `/api/pto` answers a cancellation with. */
interface CancelResponse {
  request: RequestRow;
}

/** What `/api/pto/balance` answers with. Read defensively; see `readBalanceRow`. */
interface BalanceResponse {
  balance?: unknown;
}

// ─── Sentences the reader sees ───────────────────────────────────────────────

/**
 * The two statuses a request can be withdrawn from, in the reader's words.
 *
 * Read off `CANCELLABLE_STATUSES` rather than written out, so the sentence and the
 * rule cannot come apart: adding a third cancellable status changes both at once.
 *
 * Requirements: 11.8
 */
const WITHDRAWABLE_PHRASE = CANCELLABLE_STATUSES.map((status) => statusLabel(status))
  .join(' and ')
  .toLowerCase();

const NO_ACCEPTED_TYPES =
  'This deployment reported no request types, so there is nothing to ask for yet.';

const CLOSED_DATES_NOTE =
  'Weekends are already excluded. Dates the organisation is closed are excluded too, and the server applies that when the request is submitted \u2014 the count it stores is the count a decision debits.';

const NO_WORKING_DAYS_NOTE =
  'These dates cover no working day, so the request costs nothing against your balance.';

// ─── Calendar and body reading ───────────────────────────────────────────────

/**
 * Today in a named zone, falling back to UTC for a zone this runtime cannot read.
 *
 * Through `workDateOf`, the module's one instant-to-work-date mapping (Requirement
 * 19, criterion 10). The zone is the employee's own, because that is the zone
 * `submitRequest` resolves the submission date in — so the notice figure previewed
 * here is the notice figure the server computes.
 *
 * The clock read stays in the component: `domain/` takes a submission date as an
 * argument and never reads one, which is what makes the disclosure a function of
 * its inputs.
 */
function todayIn(timeZone: string): string {
  const now = new Date();
  try {
    return workDateOf(now, timeZone);
  } catch {
    return workDateOf(now, FALLBACK_TIME_ZONE);
  }
}

/** The four-digit year of a date this module can step, or null. */
function yearOf(date: string): string | null {
  if (date === '') return null;
  try {
    return addCalendarDays(date, 0).slice(0, 4);
  } catch {
    return null;
  }
}

/** A stored numeric column, or zero when the body carried nothing readable. */
function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * One `pto_balances` row as the domain reads it, or null.
 *
 * Fields are checked rather than cast, because the body is untrusted input and a
 * balance built out of `undefined` would be rendered as a figure. `/api/pto/balance`
 * predates this module's response contract and answers with the row as the table
 * holds it, including a default allocation where no row is stored — so what the
 * figures below report is that endpoint's answer, put through the module's one
 * remaining-balance rule rather than through arithmetic of this file's own.
 *
 * Requirements: 11.3
 */
function readBalanceRow(value: unknown): PTOBalanceRow | null {
  if (typeof value !== 'object' || value === null) return null;
  const source = value as Record<string, unknown>;

  return {
    year: numberOf(source.year),
    vacation_days: numberOf(source.vacation_days),
    sick_days: numberOf(source.sick_days),
    personal_days: numberOf(source.personal_days),
    vacation_used: numberOf(source.vacation_used),
    sick_used: numberOf(source.sick_used),
    personal_used: numberOf(source.personal_used),
  };
}

/**
 * The remaining balance for one type, or null when there is no row to read it from.
 *
 * Null rather than zero: an unread balance is unknown, and reporting it as none
 * left would invent a shortfall the employee does not have.
 *
 * Requirements: 11.3
 */
function remainingFor(balance: PTOBalanceRow | null, ptoType: PTOType): number | null {
  if (balance === null) return null;
  try {
    return remainingBalanceFor(balance, ptoType);
  } catch {
    // A type outside the accepted set, which `requestTypes` cannot contain: the
    // route builds that list from the same map this function looks up.
    return null;
  }
}

/**
 * The signed-in employee's requests, from the two sources that hold them.
 *
 * Keyed by request identifier with the screen's rows applied last, because those
 * are the ones a write has just replaced. Ordered by `compareRequestRows`, the
 * inbox's own order, so the merged list reads the way the queue below it does:
 * waiting first, longest waiting at the top.
 *
 * Requirements: 11.6
 */
function mergeOwnRows(
  read: readonly RequestRow[],
  held: readonly RequestRow[],
  profileId: string,
): RequestRow[] {
  const byId = new Map<string, RequestRow>();
  for (const row of read) {
    if (row.profileId === profileId) byId.set(row.requestId, row);
  }
  for (const row of held) {
    if (row.profileId === profileId) byId.set(row.requestId, row);
  }
  return [...byId.values()].sort(compareRequestRows);
}

/** The notice figure in words. A start already past reads as that, not as `-3`. */
function noticePhrase(days: number): string {
  if (days < 0) return 'the first day has passed';
  if (days === 0) return 'today';
  return `${days} calendar ${days === 1 ? 'day' : 'days'}`;
}

// ─── Presentational pieces ───────────────────────────────────────────────────

/** One labelled figure: a small caption over the value. */
function Figure({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-[5rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className={`text-[13px] font-black ${muted ? 'text-slate-400' : 'text-slate-900'}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One thing the reader is told: a glyph, a heading, and the sentences under it.
 *
 * The colour is a role from the token table and never a palette chosen here, and
 * the heading is real text beside the glyph — so what is being said survives
 * without colour (Requirement 22, criteria 6 and 7).
 */
function Notice({
  role,
  icon,
  title,
  live = 'status',
  children,
}: {
  role: ColorRole;
  icon: string;
  title: string;
  live?: 'status' | 'alert';
  children: ReactNode;
}) {
  const token = colorRoleToken(role);

  return (
    <div
      role={live}
      className={`flex items-start gap-2 rounded-xl border px-3 py-2.5 ${token.surface} ${token.text} ${token.border}`}
    >
      <StatusIcon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <p className="text-[11px] font-black uppercase tracking-wider">{title}</p>
        <div className="space-y-1 text-[12px] font-semibold">{children}</div>
      </div>
    </div>
  );
}

// ─── One of the employee's own requests ──────────────────────────────────────

/**
 * One request of the signed-in employee's, with its outcome and its withdrawal.
 *
 * Requirements: 11.6, 11.7, 11.8
 */
function OwnRequestRow({
  row,
  timeZone,
  busy,
  failure,
  onCancel,
  onReload,
}: {
  row: RequestRow;
  timeZone: string;
  busy: boolean;
  failure: ApiFailure | null;
  onCancel: (row: RequestRow) => void;
  onReload: () => void;
}) {
  // The row carries the server's answer to the same question — `row.profile_id ===
  // actor.id && canCancelRequest(status)` — so the two cannot disagree about what
  // is withdrawable, and neither of them is this component's own idea of it
  // (Correctness Property 25).
  const withdrawable = row.cancellable && canCancelRequest(row.status);
  const warning = colorRoleToken('warning');

  return (
    <li className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block text-[13px] font-black text-slate-900">
            {PTO_TYPE_LABELS[row.ptoType]}
          </span>
          <span className="block text-[11px] font-semibold text-slate-500">
            {formatWorkDate(row.startDate)} {'\u2013'} {formatWorkDate(row.endDate)}
            {' \u00b7 '}
            {formatDays(row.workingDays)}
          </span>
        </div>
        <StatusPill status={row.status} />
      </div>

      {/* The stored short-notice condition of criterion 5, as the reviewer sees it. */}
      {row.shortNotice && (
        <p className={`mt-1 text-[11px] font-bold ${warning.text}`}>
          Submitted on short notice
        </p>
      )}

      <p className="mt-1.5 text-[11px] font-semibold text-slate-400">
        Submitted {formatInstantDate(row.submittedAt, timeZone)}
        {row.reviewedAt === null
          ? ''
          : ` \u00b7 answered ${formatInstantDate(row.reviewedAt, timeZone)}`}
      </p>

      {row.reason !== null && (
        <p className="mt-1 text-[12px] font-semibold text-slate-600">
          <span className="text-slate-400">You wrote: </span>
          {row.reason}
        </p>
      )}

      {/* Criterion 7. Said for a waiting request too, so silence reads as "not yet
          answered" rather than as a field that failed to render. */}
      <div className="mt-1.5">
        <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
          Reviewer response
        </p>
        <p className="text-[12px] font-semibold text-slate-600">
          {row.reviewerResponse ??
            (row.pending
              ? 'Nobody has answered this yet.'
              : 'No response was recorded with the decision.')}
        </p>
      </div>

      {/* Criterion 8: offered for the two statuses `CANCELLABLE_STATUSES` names and
          for no others, which is criterion 10 read from the same rule. */}
      {withdrawable && (
        <button
          type="button"
          onClick={() => onCancel(row)}
          disabled={busy}
          className={`${ui.btnSecondary} mt-2 px-3 py-1.5 text-[12px]`}
        >
          {busy ? 'Withdrawing\u2026' : 'Withdraw this request'}
        </button>
      )}

      {failure !== null && (
        <div className="mt-2">
          <Notice role="critical" icon="TriangleAlert" title="Not withdrawn" live="alert">
            <p>{failure.reason}</p>
            <button
              type="button"
              onClick={onReload}
              className="rounded-lg border border-current/20 bg-white/70 px-2.5 py-1.5 text-[11px] font-black transition hover:bg-white"
            >
              Reload my requests
            </button>
          </Notice>
        </div>
      )}
    </li>
  );
}

// ─── The pane ────────────────────────────────────────────────────────────────

/**
 * What the composer takes: the pane context the screen hands it, plus the one fact
 * the screen has no reason to hold.
 *
 * `ComposerPaneContext` is extended rather than restated, so the seam's contract is
 * checked by the compiler: a field added there arrives here without an edit, and a
 * field renamed there stops this file compiling rather than arriving as
 * `undefined`. The import is type-only, so the screen still does not import the
 * composer.
 */
export interface RequestComposerProps extends ComposerPaneContext {
  /**
   * The zone to fall back to when the employee's own `profiles.timezone` has not
   * been read yet: the business timezone.
   */
  timeZone?: string;
}

/**
 * The employee's request composer.
 *
 * Requirements: 10.20, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10
 */
export function RequestComposer({
  profileId,
  requestTypes,
  ownRequests,
  onCommitted,
  timeZone = FALLBACK_TIME_ZONE,
}: RequestComposerProps) {
  const [chosenType, setChosenType] = useState<PTOType | null>(null);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [submitted, setSubmitted] = useState<SubmissionDisclosure | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [withdrawFailure, setWithdrawFailure] = useState<{
    requestId: string;
    failure: ApiFailure;
  } | null>(null);

  /**
   * The type the form is composing.
   *
   * The first accepted type until one is picked, and the picked one only while the
   * response still offers it — so a deployment that stops accepting a type cannot
   * leave the form holding it (Requirement 10, criterion 20). Resolved during
   * render rather than in an effect, so the first paint already has a type.
   */
  const ptoType =
    chosenType !== null && requestTypes.includes(chosenType)
      ? chosenType
      : requestTypes.length === 0
        ? null
        : requestTypes[0];

  // ── The two reads ──────────────────────────────────────────────────────────

  // The employee's own requests, in every state, under no filter but their own
  // identity. Criterion 6 asks for all five states, and the inbox's page cannot
  // promise them: its filters and its paging are the reader's to change.
  const ownRead = useMemo(
    () =>
      requestQueryUrl('/api/pto', {
        profileIds: [profileId],
        page: 1,
        limit: REQUEST_PAGE_LIMIT,
      }),
    [profileId],
  );

  const mine = useAsyncResource(
    (signal) => attendanceJson<RequestInboxResponse>(ownRead.url, { signal }),
    {
      deps: [ownRead.url],
      subject: 'requests of your own',
      isEmpty: (response) => response.rows.length === 0,
    },
  );

  const rows = useMemo(
    () => mergeOwnRows(mine.data?.rows ?? [], ownRequests, profileId),
    [mine.data, ownRequests, profileId],
  );

  // The employee's own zone, for the dates their own instants are read in and for
  // the submission date the notice figure is measured from — the same zone
  // `submitRequest` resolves it in.
  const ownZone =
    mine.data?.employees.find((employee) => employee.profileId === profileId)?.timezone ??
    timeZone;
  const today = useMemo(() => todayIn(ownZone), [ownZone]);

  /**
   * The year the balance is read for: the year the requested dates start in.
   *
   * `pto_balances` holds one row per employee per calendar year, and
   * `submitRequest` measures the balance in the year the request starts in. Reading
   * a different year here would show a figure the shortfall was not computed
   * against.
   */
  const balanceYear = useMemo(() => yearOf(startDate) ?? today.slice(0, 4), [startDate, today]);

  const balanceUrl = `/api/pto/balance?profile_id=${encodeURIComponent(profileId)}&year=${balanceYear}`;

  const balances = useAsyncResource(
    (signal) => attendanceJson<BalanceResponse>(balanceUrl, { signal }),
    {
      deps: [balanceUrl],
      subject: 'your leave balances',
      // A balance is one row, never a list: there is no empty state for it, only a
      // row that reports no allocation.
      isEmpty: () => false,
    },
  );

  const balanceRow = useMemo(() => readBalanceRow(balances.data?.balance), [balances.data]);

  // ── The figures ────────────────────────────────────────────────────────────

  /**
   * Criterion 3: the remaining balance for every type the form offers.
   *
   * One entry per accepted type, each from `remainingBalanceFor` — the module's one
   * remaining-balance rule, and the same one the inbox row and the decision drawer
   * report. The inherited screen had three readings of this figure and a gap where
   * sick leave should have been.
   */
  const remainingByType = useMemo(() => {
    const byType = new Map<PTOType, number | null>();
    for (const type of requestTypes) byType.set(type, remainingFor(balanceRow, type));
    return byType;
  }, [balanceRow, requestTypes]);

  const remaining = ptoType === null ? null : (remainingByType.get(ptoType) ?? null);

  /**
   * Which types share one allocation, said rather than left to be noticed.
   *
   * `PTO_TYPE_TO_BALANCE_FIELD` maps bereavement and unpaid onto the personal
   * column because `pto_balances` carries none of their own, so three of the five
   * figures move together. Derived from the map, so a schema change that gives them
   * a column of their own removes the sentence without an edit here.
   */
  const sharedAllocationNote = useMemo(() => {
    const byField = new Map<BalanceField, PTOType[]>();
    for (const type of requestTypes) {
      const field = PTO_TYPE_TO_BALANCE_FIELD[type];
      if (field === undefined) continue;
      byField.set(field, [...(byField.get(field) ?? []), type]);
    }

    const shared = [...byField.values()]
      .filter((types) => types.length > 1)
      .map((types) => types.map((type) => PTO_TYPE_LABELS[type]).join(', '));

    return shared.length === 0
      ? null
      : `${shared.join('; ')} draw on one allocation, so those figures move together.`;
  }, [requestTypes]);

  const range = useMemo<DateRange | null>(
    () => (startDate === '' || endDate === '' ? null : { from: startDate, to: endDate }),
    [startDate, endDate],
  );

  const backwards = range !== null && range.from > range.to;

  /**
   * Criteria 2, 4, and 5 previewed: the cost, the shortfall, and the notice.
   *
   * The same function the server calls, over the same arguments less the closed
   * dates no read carries — so the figures move as the employee picks dates and
   * are replaced by the server's own disclosure once the request is stored.
   */
  const preview = useMemo<SubmissionDisclosure | null>(() => {
    if (ptoType === null || range === null || backwards) return null;
    try {
      return buildSubmissionDisclosure({
        ptoType,
        range,
        // An unread balance is passed as none, and every figure derived from it is
        // displayed as unknown below rather than as a shortfall nobody has evidence
        // for.
        remainingBalance: remaining ?? 0,
        submissionDate: today,
      });
    } catch {
      // A bound the date control should never produce. No preview rather than a
      // pane that throws on a keystroke.
      return null;
    }
  }, [backwards, ptoType, range, remaining, today]);

  /**
   * What is still missing, or null.
   *
   * An affordance, not the rule: the route validates the type against
   * `PTO_TYPES` and the dates through `assertRange`, and refuses the same shapes
   * with the same reasons. A span longer than the service accepts is left to it,
   * because the limit is the service's to state.
   */
  const missing = useMemo<string | null>(() => {
    if (ptoType === null) return NO_ACCEPTED_TYPES;
    if (range === null) return 'Name the first and the last day you will be away.';
    if (backwards) return 'The last day falls before the first.';
    return null;
  }, [backwards, ptoType, range]);

  // ── Committing ─────────────────────────────────────────────────────────────

  const heldPage = mine.data;
  const setMine = mine.setData;
  const refreshMine = mine.refresh;

  /**
   * One affected request, applied everywhere it is held.
   *
   * The write endpoints answer with the row rebuilt from stored data, so the row in
   * front of the reader moves without a read: it replaces its held self, or is
   * added when it is new, and the read is refreshed behind it because a submission
   * or a withdrawal also changes what the query would return. The screen is told
   * too, so the inbox and the coverage projection beside it move with it.
   */
  const applyCommitted = useCallback(
    (committed: RequestRow) => {
      if (heldPage !== null) {
        const known = heldPage.rows.some((row) => row.requestId === committed.requestId);
        setMine({
          ...heldPage,
          rows: known
            ? heldPage.rows.map((row) =>
                row.requestId === committed.requestId ? committed : row,
              )
            : [committed, ...heldPage.rows],
          total: known ? heldPage.total : heldPage.total + 1,
        });
      }
      refreshMine();
      onCommitted(committed);
    },
    [heldPage, onCommitted, refreshMine, setMine],
  );

  /** A change to what is being asked for retires the last answer about it. */
  const clearNotices = useCallback(() => {
    setBlocker(null);
    setFailure(null);
    setSubmitted(null);
  }, []);

  const changeStart = useCallback(
    (next: string) => {
      clearNotices();
      setStartDate(next);
      // A single day is the common request, and a last day before the first is not a
      // request at all: the end follows the start until the reader moves it.
      setEndDate((current) => (current === '' || current < next ? next : current));
    },
    [clearNotices],
  );

  const submit = useCallback(() => {
    if (busy) return;
    if (ptoType === null || range === null || missing !== null) {
      setBlocker(missing ?? NO_ACCEPTED_TYPES);
      return;
    }

    // No day count and no balance figure: both are the server's to compute from
    // stored rows, which is the whole reason this endpoint replaced the inherited
    // one (Requirement 11, criterion 2).
    const body: Record<string, unknown> = {
      action: 'submit',
      pto_type: ptoType,
      start_date: range.from,
      end_date: range.to,
    };

    const stated = reasonWithContent(reason);
    if (stated !== null) body.reason = stated;

    setBusy(true);
    setBlocker(null);
    setFailure(null);
    setSubmitted(null);

    void (async () => {
      try {
        const result = await attendanceJson<SubmissionResult>(
          '/api/pto',
          jsonRequest('POST', body),
        );

        // The server's disclosure, not the preview's: it was computed against the
        // stored closed dates and written to the row.
        setSubmitted(result.disclosure);
        setStartDate('');
        setEndDate('');
        setReason('');
        applyCommitted(result.request);
      } catch (error) {
        setFailure(asApiFailure(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [applyCommitted, busy, missing, ptoType, range, reason]);

  /**
   * Withdraw one request.
   *
   * Neither eligible status has ever moved a balance — a pending request was never
   * debited and a waitlisting leaves the balance unchanged — so the figures above
   * do not move and are not re-read. A request that changed under the reader is
   * refused with the reason the service wrote, which names the status it now holds.
   *
   * Requirements: 11.9, 11.10
   */
  const withdraw = useCallback(
    (row: RequestRow) => {
      if (withdrawingId !== null) return;

      setWithdrawingId(row.requestId);
      setWithdrawFailure(null);

      void (async () => {
        try {
          const result = await attendanceJson<CancelResponse>(
            '/api/pto',
            jsonRequest('POST', { action: 'cancel', request_id: row.requestId }),
          );
          applyCommitted(result.request);
        } catch (error) {
          setWithdrawFailure({ requestId: row.requestId, failure: asApiFailure(error) });
        } finally {
          setWithdrawingId(null);
        }
      })();
    },
    [applyCommitted, withdrawingId],
  );

  // ── Rendering ──────────────────────────────────────────────────────────────

  const critical = colorRoleToken('critical');
  const balanceKnown = balanceRow !== null;

  return (
    <section
      aria-labelledby="request-composer-heading"
      className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
    >
      <div className="border-b border-slate-100 px-4 py-4">
        <h2
          id="request-composer-heading"
          className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
        >
          Request time off
        </h2>
        <p className="mt-0.5 text-[12px] font-semibold text-slate-500">
          What you have left, what a request would cost, and what has been answered.
        </p>
      </div>

      <div className="space-y-3 px-4 py-4">
        {/* Criterion 3: the remaining balance for each type the form offers. */}
        <section
          aria-labelledby="request-composer-balance-heading"
          className="rounded-2xl bg-slate-50 px-3.5 py-3"
        >
          <h3
            id="request-composer-balance-heading"
            className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400"
          >
            Balance left in {balanceYear}
          </h3>

          <AsyncStateBlock
            status={balances.status}
            failure={balances.failure}
            pending={balances.pending}
            onRetry={balances.retry}
            subject="your leave balances"
            className="mt-2"
          />

          {requestTypes.length > 0 && (
            <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
              {requestTypes.map((type) => {
                const left = remainingByType.get(type) ?? null;
                return (
                  <Figure
                    key={type}
                    label={PTO_TYPE_LABELS[type]}
                    value={formatDays(left)}
                    muted={left === null}
                  />
                );
              })}
            </dl>
          )}

          {sharedAllocationNote !== null && (
            <p className="mt-1.5 text-[11px] font-semibold text-slate-500">
              {sharedAllocationNote}
            </p>
          )}

          <p className="mt-1 text-[11px] font-semibold text-slate-400">
            {balanceKnown
              ? 'Balances are held per calendar year, and this is the year your dates start in. Approving a request is what moves one.'
              : 'No balance has been read yet, so what a request would leave you with is not shown.'}
          </p>
        </section>

        {/* Criterion 1, and Requirement 10 criterion 20: the types are the ones the
            response reported the database accepts, never a list of this file's own. */}
        <div className="space-y-2.5">
          <label className="block">
            <span className={ui.label}>Type</span>
            <select
              value={ptoType ?? ''}
              disabled={busy || requestTypes.length === 0}
              onChange={(event) => {
                clearNotices();
                setChosenType(event.target.value as PTOType);
              }}
              className={`${ui.select} mt-1 py-1.5 text-[13px] disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400`}
            >
              {requestTypes.length === 0 && <option value="">No type is available</option>}
              {requestTypes.map((type) => (
                <option key={type} value={type}>
                  {PTO_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-2">
            <label className="block min-w-[9rem] flex-1">
              <span className={ui.label}>First day away</span>
              <input
                type="date"
                value={startDate}
                disabled={busy}
                onChange={(event) => changeStart(event.target.value)}
                className={`${ui.input} mt-1 py-1.5 text-[13px]`}
              />
            </label>
            <label className="block min-w-[9rem] flex-1">
              <span className={ui.label}>Last day away</span>
              <input
                type="date"
                value={endDate}
                min={startDate === '' ? undefined : startDate}
                disabled={busy}
                onChange={(event) => {
                  clearNotices();
                  setEndDate(event.target.value);
                }}
                className={`${ui.input} mt-1 py-1.5 text-[13px]`}
              />
            </label>
          </div>

          <label className="block">
            <span className={ui.label}>Reason (optional)</span>
            <textarea
              value={reason}
              rows={2}
              disabled={busy}
              onChange={(event) => {
                clearNotices();
                setReason(event.target.value);
              }}
              className={`${ui.textarea} mt-1 py-1.5 text-[13px]`}
              placeholder="Whoever reviews this will read it."
            />
          </label>
        </div>

        {/* Criteria 2, 4, and 5, before the request is submitted. */}
        {preview !== null && (
          <div className="space-y-2 rounded-2xl border border-slate-200 px-3.5 py-3">
            <dl className="flex flex-wrap gap-x-4 gap-y-2">
              <Figure label="Working days" value={formatDays(preview.workingDays)} />
              <Figure
                label="Balance left"
                value={balanceKnown ? formatDays(preview.remainingBalance) : NO_VALUE}
                muted={!balanceKnown}
              />
              <Figure
                label="After this"
                value={balanceKnown ? formatDays(preview.balanceAfter) : NO_VALUE}
                muted={!balanceKnown}
              />
              <Figure label="Notice" value={noticePhrase(preview.noticeDays)} />
            </dl>

            {preview.workingDays === 0 && (
              <p className="text-[12px] font-semibold text-slate-600">{NO_WORKING_DAYS_NOTE}</p>
            )}

            {/* Criterion 4: the shortfall is disclosed, and the submission is still
                offered. Nothing below refuses it. */}
            {balanceKnown && preview.exceedsBalance && (
              <Notice role="warning" icon="TriangleAlert" title="More than you have left">
                <p>
                  {`This asks for ${formatDays(preview.workingDays)} against a ${PTO_TYPE_LABELS[preview.ptoType]} balance of ${formatDays(preview.remainingBalance)} \u2014 ${formatDays(preview.shortfallDays)} beyond it.`}
                </p>
                <p>You can still submit it. The shortfall is shown to whoever reviews it.</p>
              </Notice>
            )}

            {/* Criterion 5: disclosed here and recorded on the row by the server. */}
            {preview.shortNotice && (
              <Notice role="warning" icon="CalendarClock" title="Short notice">
                <p>
                  {`Fewer than ${SHORT_NOTICE_DAYS} calendar days between today and the first day away: ${noticePhrase(preview.noticeDays)}.`}
                </p>
                <p>You can still submit it. The condition is recorded on the request.</p>
              </Notice>
            )}

            <p className="text-[11px] font-semibold text-slate-400">{CLOSED_DATES_NOTE}</p>
          </div>
        )}

        {blocker !== null && (
          <p role="alert" className={`text-[12px] font-bold ${critical.text}`}>
            {blocker}
          </p>
        )}

        {failure !== null && (
          <Notice role="critical" icon="TriangleAlert" title="Not submitted" live="alert">
            <p>{failure.reason}</p>
            <p>Nothing was stored, so nothing has been asked for.</p>
          </Notice>
        )}

        {/* What the server actually recorded, which supersedes the preview above. */}
        {submitted !== null && (
          <Notice role="healthy" icon="CircleCheck" title="Submitted">
            <p>
              {`${PTO_TYPE_LABELS[submitted.ptoType]}, ${formatWorkDate(submitted.range.from)} to ${formatWorkDate(submitted.range.to)}, stored as ${formatDays(submitted.workingDays)}.`}
            </p>
            {submitted.exceedsBalance && (
              <p>{`${formatDays(submitted.shortfallDays)} beyond your balance, disclosed on the request.`}</p>
            )}
            {submitted.shortNotice && (
              <p>{`Recorded as short notice: ${noticePhrase(submitted.noticeDays)} of notice.`}</p>
            )}
            <p>{`It is waiting for a decision, and you can withdraw it below while it is ${statusLabel('pending').toLowerCase()}.`}</p>
          </Notice>
        )}

        <button
          type="button"
          onClick={submit}
          disabled={busy || requestTypes.length === 0}
          className={`${ui.btnPrimary} px-3 py-1.5 text-[13px]`}
        >
          {busy ? 'Submitting\u2026' : 'Submit request'}
        </button>

        {/* A disabled control with no stated reason reads as a fault. The types come
            from the response, so an empty list is a deployment that reported none
            rather than a form that failed to render. */}
        {requestTypes.length === 0 && (
          <p className="text-[11px] font-semibold text-slate-400">{NO_ACCEPTED_TYPES}</p>
        )}
      </div>

      {/* Criteria 6, 7, and 8: every request of the reader's own, whatever state it
          is in, with what a reviewer answered and the withdrawal where it applies. */}
      <section
        aria-labelledby="request-composer-mine-heading"
        className="space-y-2 border-t border-slate-100 px-4 py-4"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3
            id="request-composer-mine-heading"
            className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
          >
            Requests you have submitted
          </h3>
          <span className="text-[11px] font-semibold text-slate-400">
            {rows.length} {rows.length === 1 ? 'request' : 'requests'}
          </span>
        </div>

        <p className="text-[12px] font-semibold text-slate-500">
          {`Waiting, approved, denied, waitlisted, and cancelled alike${
            mine.data === null
              ? ''
              : `, ${formatWorkDate(mine.data.range.from)} to ${formatWorkDate(mine.data.range.to)}`
          }. A request can be withdrawn while it is ${WITHDRAWABLE_PHRASE}.`}
        </p>

        <AsyncStateBlock
          // Rows the screen supplied that this read has not returned are still
          // content, so the empty state is only shown when there is nothing at all.
          status={rows.length > 0 ? 'ready' : mine.status}
          failure={mine.failure}
          pending={mine.pending}
          onRetry={mine.retry}
          subject="requests of your own"
          message={mine.emptyMessage}
        />

        {rows.length > 0 && (
          <ul className="space-y-2">
            {rows.map((row) => (
              <OwnRequestRow
                key={row.requestId}
                row={row}
                timeZone={ownZone}
                busy={withdrawingId === row.requestId}
                failure={
                  withdrawFailure !== null && withdrawFailure.requestId === row.requestId
                    ? withdrawFailure.failure
                    : null
                }
                onCancel={withdraw}
                onReload={refreshMine}
              />
            ))}
          </ul>
        )}

        {mine.data !== null && mine.data.hasMore && (
          <p className="text-[11px] font-semibold text-slate-400">
            {`You have more requests in this window than one page carries, so these are the first ${mine.data.limit}. The inbox below pages through the rest.`}
          </p>
        )}
      </section>
    </section>
  );
}

/**
 * The composer as `TimeOffCoverageScreen`'s `renderComposer` seam expects it: a
 * function of the pane context.
 *
 * The screen places the pane above the inbox and passes it the context it needs; it
 * does not import the composer, so a screen with no composer simply offers no
 * submission. This is the adapter that plugs one in:
 *
 * ```tsx
 * <TimeOffCoverageScreen
 *   initialProfile={profile}
 *   renderCoverage={renderCoveragePane({ timeZone: policy.businessTimezone })}
 *   renderDecision={renderDecisionPane({ profile, timeZone: policy.businessTimezone })}
 *   renderComposer={renderComposerPane({ timeZone: policy.businessTimezone })}
 * />
 * ```
 *
 * `timeZone` is a parameter rather than a field of the context because it is a fact
 * about the organisation rather than about the reader's own requests, and the screen
 * has no reason to hold it.
 *
 * Requirements: 11.1, 11.3
 */
export function renderComposerPane(
  options: { timeZone?: string } = {},
): (context: ComposerPaneContext) => ReactNode {
  return function ComposerPane(context: ComposerPaneContext) {
    return <RequestComposer {...context} {...options} />;
  };
}

export default RequestComposer;
