// src/features/time-attendance/shared/useAsyncResource.ts
// The module's one wrapper for a screen's data request, and therefore the one
// place its loading, empty, and failed states are decided.
//
// Requirement 22, criteria 14 through 16 ask every screen for three things: a
// loading state while a request is outstanding, an empty state that names the
// active filters, and a failed state carrying the reason and a retry control.
// Six screens implementing those three states independently is eighteen chances
// to get one wrong, and the legacy screens show how it goes — `TimeClock.tsx`,
// `PTORequests.tsx`, and `AttendanceReports.tsx` each hold a `loading` flag and
// an `error` string, none of them has an empty state that names anything, and the
// reason they display is whatever survived `new Error(b.error || 'Load failed.')`.
//
// Implemented once, a screen renders `status` and cannot invent a fourth state.
//
// ## The contract
//
// ```ts
// const records = useAsyncResource(
//   (signal) => attendanceJson<RecordPage>(`/api/attendance/records?${params}`, { signal }),
//   {
//     deps: [rangeStart, rangeEnd, department],
//     filters: [
//       { label: 'Dates', value: `${rangeStart} to ${rangeEnd}` },
//       { label: 'Department', value: department ?? 'All departments' },
//     ],
//     isEmpty: (page) => page.rows.length === 0,
//     subject: 'records',
//   },
// );
// ```
//
// `deps` identify the request. A change to any of them is a different question,
// so the held answer is dropped and the screen returns to `loading` rather than
// showing the previous filter's rows under the new filter's heading. `refresh`
// and the poll ask the *same* question again, so they keep the held answer and
// only raise `pending`.
//
// ## Why the caller supplies the filter words
//
// Criterion 15 asks the empty state to name the active filters, and only the
// screen knows what its own controls are called. A hook that tried to describe a
// `RecordQuery` would have to know that `savedFilter: 'missing_clock_out'` reads
// as "Missing clock-out" and that an absent `department` reads as "All
// departments" — screen vocabulary, in a hook shared by six screens. So the
// caller passes `{ label, value }` pairs and this module owns only the sentence
// they are assembled into, which is the part that has to be the same everywhere.
//
// ## Why a failure does not discard held data
//
// A poll failing on a screen that is already showing today's team is not a reason
// to blank it. `failure` is set, `status` stays `ready`, and the screen renders
// the reason and the retry control beside the rows it still holds, with
// `loadedAt` saying how old they are. Only a failure with nothing held reaches
// `status: 'failed'`, where the reason takes the place of the content. Either way
// the rule for a screen is the same: render `failure` whenever it is not null.
//
// Requirements: 5.19, 5.20, 22.14, 22.15, 22.16

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { asApiFailure, isAbortError, type ApiFailure } from './api-failure';
import { colorRoleToken, type ColorRole } from './tokens';

// ─── Active filters, in words ────────────────────────────────────────────────

/**
 * One active filter, as the reader sees it named on screen.
 *
 * Both halves are the screen's own words: `label` is what its control is called,
 * `value` is what the control is set to. A filter that is not narrowing anything
 * still belongs here when the screen shows it — "All departments" is information
 * the empty state should carry, because it tells the reader the emptiness is not
 * a department they forgot they had selected.
 */
export interface ActiveFilter {
  label: string;
  value: string;
}

const NO_FILTERS: readonly ActiveFilter[] = [];
const NO_DEPS: readonly unknown[] = [];

/**
 * The active filters as one phrase, or null when none are active.
 *
 * A filter with an empty value is dropped rather than rendered as a dangling
 * label, so a screen can build its list unconditionally and let an unset control
 * fall out.
 */
export function describeActiveFilters(filters: readonly ActiveFilter[]): string | null {
  const parts = filters
    .filter((filter) => filter.label.trim() !== '' && filter.value.trim() !== '')
    .map((filter) => `${filter.label}: ${filter.value}`);

  return parts.length === 0 ? null : parts.join(', ');
}

/**
 * The empty-state sentence: what was looked for, and under which filters.
 *
 * Requirements: 13.9, 22.15
 */
export function emptyStateMessage(subject: string, filters: readonly ActiveFilter[]): string {
  const summary = describeActiveFilters(filters);
  return summary === null
    ? `No ${subject} to show.`
    : `No ${subject} match the active filters — ${summary}.`;
}

// ─── State ───────────────────────────────────────────────────────────────────

/**
 * What a screen renders.
 *
 * - `idle` — the read is switched off: no employee picked yet, or a panel the
 *   caller has not enabled. Nothing is outstanding and nothing failed.
 * - `loading` — a first answer for the current question is outstanding.
 * - `ready` — an answer is held and it has content.
 * - `empty` — an answer is held and it has none. `emptyMessage` names the filters.
 * - `failed` — nothing is held and the last attempt failed. `failure` says why.
 *
 * A retry from `failed` stays `failed` with `pending` raised, rather than
 * flipping to `loading`: the reason the reader is looking at is still the last
 * thing that happened, and replacing it with a skeleton on every press hides
 * whether anything changed. The screen shows the retry as busy from `pending`.
 */
export type AsyncResourceStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'failed';

/** The three states that need chrome of their own, plus the switched-off one. */
export type AsyncStateStatus = Exclude<AsyncResourceStatus, 'ready'>;

export interface AsyncResourceOptions<T> {
  /**
   * The values that identify the request. A change to any of them drops the held
   * answer and asks again. Primitives and plain serialisable objects only: they
   * are compared by a serialised key, not by identity, so an object rebuilt each
   * render is not a change.
   */
  deps?: readonly unknown[];
  /** The active filters, in the screen's own words, for the empty state. */
  filters?: readonly ActiveFilter[];
  /** What the collection is called: `records`, `requests`, `audit entries`. */
  subject?: string;
  /**
   * Whether a held answer counts as empty. The default recognises null,
   * undefined, and an empty array; a response object has to say what empty means
   * for it, because only the caller knows which of its fields carries the rows.
   */
  isEmpty?: (value: T) => boolean;
  /** False suspends the read entirely and reports `idle`. Defaults to true. */
  enabled?: boolean;
}

export interface AsyncResource<T> {
  /** The state to render. */
  status: AsyncResourceStatus;
  /** The held answer, or null before the first one arrives. */
  data: T | null;
  /**
   * A request is outstanding: the first one, a retry, or a poll. `status` is
   * `loading` only for the first; a refresh over held data leaves `status`
   * alone so the screen does not blank every minute.
   */
  pending: boolean;
  /**
   * The last failure, or null. Not null means: display the reason and offer the
   * retry control, wherever the screen puts them.
   */
  failure: ApiFailure | null;
  /** The empty-state sentence, naming the active filters. */
  emptyMessage: string;
  /** The active filters as passed, for a screen rendering them as its own chips. */
  activeFilters: readonly ActiveFilter[];
  /** The same filters as one phrase, or null when none are active. */
  filterSummary: string | null;
  /** When the held answer arrived, as epoch milliseconds. Null when none is held. */
  loadedAt: number | null;
  /** Ask the same question again, keeping the held answer while it is in flight. */
  refresh: () => void;
  /** The retry control of criterion 16. The same function as `refresh`. */
  retry: () => void;
  /**
   * Replace the held answer from a mutation's response, with no refetch.
   *
   * The write endpoints return the recomputed record, so a screen that has just
   * corrected a punch already holds the new truth and does not need to read it
   * back. Clears `failure`, since what is held is now fresh.
   */
  setData: (next: T | ((previous: T | null) => T)) => void;
}

/**
 * The held answer, and which request it answers.
 *
 * `key` is the question — the serialised dependencies — and `token` is the
 * refresh generation. Carrying both means "a request is outstanding" is something
 * this hook can *work out* rather than something it has to remember: the answer
 * is outstanding exactly when what is held does not match what is being asked
 * for. Nothing sets a `pending` flag, so nothing can leave one set.
 */
interface Snapshot<T> {
  key: string;
  token: number;
  data: T | null;
  failure: ApiFailure | null;
  loadedAt: number | null;
}

/** A generation no request can carry, so a fresh snapshot reads as outstanding. */
const UNANSWERED = -1;

function unanswered<T>(key: string): Snapshot<T> {
  return { key, token: UNANSWERED, data: null, failure: null, loadedAt: null };
}

/**
 * One dependency, as a string that changes when the value does.
 *
 * Serialised rather than compared by identity because callers build query objects
 * and filter arrays inline, so identity changes on every render while the
 * question does not. A value that cannot be serialised falls back to `String`,
 * which is enough for the shapes the screens pass and never throws.
 */
function keyPart(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return `s${value}`;
    case 'number':
    case 'boolean':
    case 'bigint':
      return `p${String(value)}`;
    case 'function':
    case 'symbol':
      return `x${String(value)}`;
    default:
      try {
        return `j${JSON.stringify(value)}`;
      } catch {
        return `x${String(value)}`;
      }
  }
}

/** The question the current dependencies describe. */
export function asQueryKey(deps: readonly unknown[]): string {
  return deps.map(keyPart).join('\u0000');
}

function defaultIsEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

// ─── The hook ────────────────────────────────────────────────────────────────

/**
 * A screen's data request, in three renderable states.
 *
 * The fetcher receives an `AbortSignal` and is expected to pass it to `fetch`.
 * It is aborted when the dependencies change, when the screen refreshes, and on
 * unmount, so a superseded answer can never overwrite a newer one — and the
 * answer is also gated on a run counter, so a fetcher that ignores its signal
 * still cannot.
 *
 * Requirements: 22.14, 22.15, 22.16
 */
export function useAsyncResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  options: AsyncResourceOptions<T> = {},
): AsyncResource<T> {
  const { deps = NO_DEPS, filters = NO_FILTERS, subject = 'records', enabled = true } = options;
  const isEmpty = options.isEmpty ?? (defaultIsEmpty as (value: T) => boolean);

  const key = asQueryKey(deps);

  const [refreshToken, setRefreshToken] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => unanswered<T>(key));

  // Declared before the read effect so the ref holds this render's fetcher by the
  // time the read effect runs: effects fire in declaration order.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  // Which run is current. A resolved fetcher from an earlier run is discarded
  // even if it never saw its abort signal.
  const runRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    const run = runRef.current + 1;
    runRef.current = run;

    void (async () => {
      try {
        const value = await fetcherRef.current(controller.signal);
        if (run !== runRef.current || controller.signal.aborted) return;
        setSnapshot({ key, token: refreshToken, data: value, failure: null, loadedAt: Date.now() });
      } catch (error) {
        if (run !== runRef.current || controller.signal.aborted || isAbortError(error)) return;
        const failure = asApiFailure(error);
        // A failure over a held answer keeps the answer: a poll that fails is no
        // reason to blank a panel that is already showing today's team.
        setSnapshot((previous) =>
          previous.key === key
            ? { ...previous, token: refreshToken, failure }
            : { key, token: refreshToken, data: null, failure, loadedAt: null },
        );
      }
    })();

    return () => controller.abort();
  }, [key, enabled, refreshToken]);

  const refresh = useCallback(() => {
    setRefreshToken((token) => token + 1);
  }, []);

  const setData = useCallback(
    (next: T | ((previous: T | null) => T)) => {
      // What arrives from a mutation is newer than any read still in flight, so
      // that read's answer is discarded rather than allowed to land on top of it.
      runRef.current += 1;

      setSnapshot((previous) => {
        const held = previous.key === key ? previous.data : null;
        const value = typeof next === 'function' ? (next as (p: T | null) => T)(held) : next;
        return { key, token: refreshToken, data: value, failure: null, loadedAt: Date.now() };
      });
    },
    [key, refreshToken],
  );

  // A snapshot answering an earlier question is not this screen's content, so it
  // reads as the start of the current one. Computed rather than reset in an
  // effect, so the render that changes a filter already shows `loading`.
  const answersThisQuestion = snapshot.key === key;
  const current = answersThisQuestion ? snapshot : unanswered<T>(key);

  // Outstanding exactly when what is held is not what is being asked for: either
  // a different question, or the same one asked again.
  const pending = enabled && !(answersThisQuestion && snapshot.token === refreshToken);

  const status: AsyncResourceStatus = !enabled
    ? 'idle'
    : current.data !== null && current.data !== undefined
      ? isEmpty(current.data)
        ? 'empty'
        : 'ready'
      : current.failure !== null
        ? 'failed'
        : 'loading';

  return {
    status,
    data: current.data,
    pending,
    failure: current.failure,
    emptyMessage: emptyStateMessage(subject, filters),
    activeFilters: filters,
    filterSummary: describeActiveFilters(filters),
    loadedAt: current.loadedAt,
    refresh,
    retry: refresh,
    setData,
  };
}

// ─── How the four non-content states look ────────────────────────────────────

/**
 * The colour, glyph, and heading of one non-content state.
 *
 * Here rather than in each screen for the same reason the status pill exists: a
 * failed read on Today and a failed read on Review are the same event and have
 * to look like it. The classes come from `tokens.ts`, so this table picks a role
 * and never a palette.
 */
export interface AsyncStateToken {
  status: AsyncStateStatus;
  role: ColorRole;
  /** A glyph name registered in `shared/StatusIcon.tsx`. */
  icon: string;
  /** A short heading. The detail is `emptyMessage` or `failure.reason`. */
  title: string;
  surface: string;
  text: string;
  border: string;
}

/** One state's presentation, with its classes taken from the palette. */
function stateToken(
  status: AsyncStateStatus,
  role: ColorRole,
  icon: string,
  title: string,
): AsyncStateToken {
  const token = colorRoleToken(role);
  return {
    status,
    role,
    icon,
    title,
    surface: token.surface,
    text: token.text,
    border: token.border,
  };
}

/**
 * The role each state is rendered in.
 *
 * Requirement 22, criterion 5 assigns its six roles to attendance meanings —
 * staffing levels, payroll-blocking records, items awaiting review — and a screen
 * that cannot load is none of those. Rather than invent a seventh role, the two
 * quiet states borrow Neutral and the failure borrows Critical, which is the
 * module's alarm colour and reads as one. Criterion 6 is satisfied the same way
 * it is for a status: each state carries a glyph and a heading in text, so the
 * colour is never the only thing saying what happened.
 */
export const ASYNC_STATE_TOKENS: Readonly<Record<AsyncStateStatus, AsyncStateToken>> = {
  idle: stateToken('idle', 'neutral', 'Hourglass', 'Nothing selected yet'),
  loading: stateToken('loading', 'neutral', 'Hourglass', 'Loading'),
  empty: stateToken('empty', 'neutral', 'ListOrdered', 'Nothing to show'),
  failed: stateToken('failed', 'critical', 'TriangleAlert', 'Could not load'),
};

/**
 * How to render a state, or null for `ready` — which has content of its own and
 * needs no chrome.
 *
 * Requirements: 22.5, 22.6
 */
export function asyncStateToken(status: AsyncResourceStatus): AsyncStateToken | null {
  return status === 'ready' ? null : ASYNC_STATE_TOKENS[status];
}
