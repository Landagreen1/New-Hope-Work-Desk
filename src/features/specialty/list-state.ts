/**
 * The Specialty Quotes list, expressed as a URL.
 *
 * Opening a quote is now a navigation, so coming back has to land on the list the
 * reader left — same search, same view, same filters, same page. The way to get that
 * for free from the browser is to put the list's state in the query string, which is
 * what this module serialises.
 *
 * Deliberately opt-in. `SpecialtyList` still owns its own React state and only
 * publishes it when a parent asks for it, because the list is also mounted inside the
 * Work Desk shell at `/`, and rewriting that page's query string on every keystroke
 * would re-run its server component and its dashboard query. On the routed
 * `/specialty-quotes` page there is no such cost, so that page opts in.
 *
 * Short parameter names with an `sq` prefix: they share a query string with whatever
 * else a host page reads, and `q` on its own is the kind of name two features fight
 * over.
 */

import type { SpecialtyLine, SpecialtyStage, SpecialtyView } from './types';
import { STAGE_ORDER, VIEWS } from './status';

export type SpecialtyResultFilter = 'all' | 'open' | 'sold' | 'not_sold';

export type SpecialtyListMode = 'work' | 'quotes';

export interface SpecialtyListState {
  query: string;
  view: SpecialtyView;
  line: SpecialtyLine | 'all';
  stage: SpecialtyStage | 'all';
  /** A profile id, or `all`. */
  assignee: string;
  /** A carrier id, or `all`. */
  carrierId: string;
  result: SpecialtyResultFilter;
  /** Zero-based, as the RPC's offset expects. */
  page: number;
}

const RESULTS: readonly SpecialtyResultFilter[] = ['all', 'open', 'sold', 'not_sold'];

const LINES: readonly SpecialtyLine[] = ['trucking', 'homeowners', 'commercial_gl'];

/**
 * The defaults each destination opens on.
 *
 * Work opens on the team's active work; Quotes opens on search across everything,
 * closed included. This is the one behavioural difference between the two, and keeping
 * it here means the URL and the component cannot disagree about it.
 */
export function defaultListState(mode: SpecialtyListMode): SpecialtyListState {
  return {
    query: '',
    view: 'team',
    line: 'all',
    stage: 'all',
    assignee: 'all',
    carrierId: 'all',
    result: mode === 'work' ? 'open' : 'all',
    page: 0,
  };
}

function readOne(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  return value === null || value === '' ? null : value;
}

/** Reads a list state out of a query string, ignoring anything it does not recognise. */
export function parseListState(
  params: URLSearchParams,
  mode: SpecialtyListMode,
): SpecialtyListState {
  const defaults = defaultListState(mode);

  const view = VIEWS.find((candidate) => candidate === readOne(params, 'sqView'));
  const line = LINES.find((candidate) => candidate === readOne(params, 'sqLine'));
  const stage = STAGE_ORDER.find((candidate) => candidate === readOne(params, 'sqStage'));
  const result = RESULTS.find((candidate) => candidate === readOne(params, 'sqResult'));

  const rawPage = Number(readOne(params, 'sqPage') ?? '');
  const page = Number.isInteger(rawPage) && rawPage > 0 ? rawPage : 0;

  return {
    query: readOne(params, 'sqQ') ?? defaults.query,
    view: view ?? defaults.view,
    line: line ?? defaults.line,
    stage: stage ?? defaults.stage,
    assignee: readOne(params, 'sqAssignee') ?? defaults.assignee,
    carrierId: readOne(params, 'sqCarrier') ?? defaults.carrierId,
    result: result ?? defaults.result,
    page,
  };
}

/**
 * Serialises a list state, omitting anything that is already the default.
 *
 * A URL that carries only what the reader actually changed is one they can look at,
 * and one that does not grow a parameter every time a default is renamed.
 */
export function listStateToParams(
  state: SpecialtyListState,
  mode: SpecialtyListMode,
): URLSearchParams {
  const defaults = defaultListState(mode);
  const params = new URLSearchParams();

  if (state.query.trim() !== '') params.set('sqQ', state.query.trim());
  if (state.view !== defaults.view) params.set('sqView', state.view);
  if (state.line !== defaults.line) params.set('sqLine', state.line);
  if (state.stage !== defaults.stage) params.set('sqStage', state.stage);
  if (state.assignee !== defaults.assignee) params.set('sqAssignee', state.assignee);
  if (state.carrierId !== defaults.carrierId) params.set('sqCarrier', state.carrierId);
  if (state.result !== defaults.result) params.set('sqResult', state.result);
  if (state.page !== 0) params.set('sqPage', String(state.page));

  return params;
}

/**
 * `/specialty-quotes` with the reader's list state on it.
 *
 * The destination rides along as `section`, because Team Work and All Quotes are two
 * different lists with two different defaults and a back link has to return to the one
 * the reader was actually on.
 */
export function specialtyListHref(
  state: SpecialtyListState,
  mode: SpecialtyListMode,
): string {
  const params = listStateToParams(state, mode);
  if (mode === 'quotes') params.set('section', 'quotes');
  const suffix = params.toString();
  return suffix === '' ? '/specialty-quotes' : `/specialty-quotes?${suffix}`;
}

/** `/specialty-quotes/<id>`, carrying where to come back to. */
export function specialtyQuoteHref(
  opportunityId: string,
  options: { backTo?: string; tab?: string; carrierId?: string } = {},
): string {
  const params = new URLSearchParams();
  if (options.tab) params.set('tab', options.tab);
  if (options.carrierId) params.set('carrier', options.carrierId);
  if (options.backTo) params.set('back', options.backTo);
  const suffix = params.toString();
  return suffix === ''
    ? `/specialty-quotes/${opportunityId}`
    : `/specialty-quotes/${opportunityId}?${suffix}`;
}

/**
 * Where the workspace's back link should go.
 *
 * `?back=` is read from the URL, so it is untrusted input: an absolute URL here would
 * turn the back button into an open redirect off the Work Desk. Only a same-origin
 * path is accepted, and anything else falls back to the list.
 */
export function safeBackHref(raw: string | null | undefined): string {
  if (!raw) return '/specialty-quotes';
  // Must be a root-relative path, and must not be protocol-relative (`//host`).
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/specialty-quotes';
  // A backslash is treated as a slash by some browsers, so `/\evil.com` would escape.
  if (raw.includes('\\')) return '/specialty-quotes';
  return raw;
}
