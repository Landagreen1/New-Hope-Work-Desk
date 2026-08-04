/**
 * The only place the Sales Reporting Center reads or writes the query string.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 9.6, 9.7, 9.10
 *
 * Pure. No React, no router, no Supabase. The shell owns the router; this module owns
 * the encoding, which is what makes the round trip testable.
 *
 * Every value is validated against the closed sets in `definitions.ts`. A value this
 * build does not offer is dropped and reported, so a shared link naming a retired
 * filter degrades to a default rather than erroring — a manager who pastes last
 * quarter's link should see this quarter's report, not a stack trace.
 */

import {
  AFTER_HOURS_DIMENSIONS,
  HOURS_SEGMENTS,
  REPORT_MODES,
  REPORT_VIEWS,
} from './definitions';
import type {
  AfterHoursDimension,
  HoursSegment,
  QuoteDecisionValue,
  ReportFilters,
  ReportMode,
  ReportView,
} from './types';

/** Sort keys the record drawer and the tables accept. */
export const SORT_KEYS = [
  'created_at_desc',
  'created_at_asc',
  'finalized_at_desc',
  'pricing_at_desc',
  'customer_asc',
] as const;

export const DEFAULT_PAGE_SIZE = 50;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Today's calendar date in the business timezone.
 *
 * The default window must not be "today according to the reader's laptop": an agent in
 * Ecuador and a manager in New York have to see the same default report.
 */
export function businessToday(
  now: Date = new Date(),
  timeZone = 'America/New_York',
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  // en-CA formats as YYYY-MM-DD.
  return parts;
}

export function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map((part) => Number.parseInt(part, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function defaultFilters(today = businessToday()): ReportFilters {
  return {
    view: 'overview',
    mode: 'activity',
    startDate: addDays(today, -6),
    endDate: today,
    compareToPreviousPeriod: false,
    hoursSegment: 'all',
    afterHoursDimensions: [],
    agentProfileIds: [],
    teamIds: [],
    dealerIds: [],
    salespersonIds: [],
    channels: [],
    quoteKinds: [],
    assignmentMethods: [],
    statuses: [],
    outcomes: [],
    sortColumn: null,
    sortDirection: 'desc',
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
  };
}

/** The eight window presets of Requirement 9.1. */
export type WindowPreset =
  | 'today'
  | 'yesterday'
  | 'last_7_days'
  | 'current_week'
  | 'previous_week'
  | 'current_month'
  | 'previous_month'
  | 'custom';

export const WINDOW_PRESETS: ReadonlyArray<{ id: WindowPreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_7_days', label: 'Last 7 days' },
  { id: 'current_week', label: 'Current week' },
  { id: 'previous_week', label: 'Previous week' },
  { id: 'current_month', label: 'Current month' },
  { id: 'previous_month', label: 'Previous month' },
  { id: 'custom', label: 'Custom range' },
];

/**
 * Resolve a preset to a window. Weeks start Monday, matching how the agency reads a
 * work week; a Sunday-start week would put Saturday and Sunday in different weeks and
 * Saturday is a working day here.
 */
export function resolvePreset(
  preset: WindowPreset,
  today = businessToday(),
): { startDate: string; endDate: string } {
  const [year, month, day] = today.split('-').map((part) => Number.parseInt(part, 10));
  const asUtc = new Date(Date.UTC(year, month - 1, day));
  const dayOfWeek = asUtc.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  switch (preset) {
    case 'today':
      return { startDate: today, endDate: today };
    case 'yesterday': {
      const yesterday = addDays(today, -1);
      return { startDate: yesterday, endDate: yesterday };
    }
    case 'last_7_days':
      return { startDate: addDays(today, -6), endDate: today };
    case 'current_week':
      return { startDate: addDays(today, mondayOffset), endDate: today };
    case 'previous_week': {
      const thisMonday = addDays(today, mondayOffset);
      return { startDate: addDays(thisMonday, -7), endDate: addDays(thisMonday, -1) };
    }
    case 'current_month':
      return { startDate: `${today.slice(0, 8)}01`, endDate: today };
    case 'previous_month': {
      const firstOfThisMonth = `${today.slice(0, 8)}01`;
      const lastOfPrevious = addDays(firstOfThisMonth, -1);
      return { startDate: `${lastOfPrevious.slice(0, 8)}01`, endDate: lastOfPrevious };
    }
    case 'custom':
    default:
      return { startDate: addDays(today, -6), endDate: today };
  }
}

function readList(params: URLSearchParams, key: string): string[] {
  const raw = params.get(key);
  if (raw === null || raw.trim().length === 0) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function inSet<T extends string>(
  value: string | null,
  allowed: readonly T[],
): T | undefined {
  if (value === null) return undefined;
  return allowed.includes(value as T) ? (value as T) : undefined;
}

export interface ParsedReportUrl {
  filters: ReportFilters;
  /** Keys whose value this build does not offer and therefore dropped. */
  droppedKeys: string[];
}

/**
 * Read a filter set out of the query string.
 *
 * Every unrecognised value is dropped and named, never thrown. Requirement 9.10.
 */
export function parseReportUrl(
  params: URLSearchParams,
  today = businessToday(),
): ParsedReportUrl {
  const filters = defaultFilters(today);
  const dropped: string[] = [];

  const view = inSet(params.get('view'), REPORT_VIEWS);
  if (params.has('view') && view === undefined) dropped.push('view');
  if (view !== undefined) filters.view = view as ReportView;

  const mode = inSet(params.get('mode'), REPORT_MODES);
  if (params.has('mode') && mode === undefined) dropped.push('mode');
  if (mode !== undefined) filters.mode = mode as ReportMode;

  const segment = inSet(params.get('hours'), HOURS_SEGMENTS);
  if (params.has('hours') && segment === undefined) dropped.push('hours');
  if (segment !== undefined) filters.hoursSegment = segment as HoursSegment;

  const start = params.get('start');
  if (start !== null) {
    if (ISO_DATE.test(start)) filters.startDate = start;
    else dropped.push('start');
  }
  const end = params.get('end');
  if (end !== null) {
    if (ISO_DATE.test(end)) filters.endDate = end;
    else dropped.push('end');
  }
  // A reversed range is a mistake, not an empty report.
  if (filters.endDate < filters.startDate) {
    const swap = filters.startDate;
    filters.startDate = filters.endDate;
    filters.endDate = swap;
  }

  if (params.get('compare') === '1') filters.compareToPreviousPeriod = true;

  const dims = readList(params, 'ahd');
  const validDims = dims.filter((value) =>
    (AFTER_HOURS_DIMENSIONS as readonly string[]).includes(value),
  ) as AfterHoursDimension[];
  if (dims.length !== validDims.length) dropped.push('ahd');
  filters.afterHoursDimensions = validDims;

  const uuidList = (key: string): string[] => {
    const values = readList(params, key);
    const valid = values.filter((value) => UUID.test(value));
    if (values.length !== valid.length) dropped.push(key);
    return valid;
  };
  filters.agentProfileIds = uuidList('agents');
  filters.dealerIds = uuidList('sources');
  filters.salespersonIds = uuidList('salespeople');
  filters.teamIds = uuidList('teams');

  filters.channels = readList(params, 'channels');

  const kinds = readList(params, 'kinds').filter(
    (value) => value === 'new_quote' || value === 'requote',
  ) as Array<'new_quote' | 'requote'>;
  filters.quoteKinds = kinds;

  filters.assignmentMethods = readList(params, 'methods');

  filters.statuses = readList(params, 'statuses').filter((value) =>
    ['active', 'pending_pricing', 'finalized'].includes(value),
  );

  filters.outcomes = readList(params, 'outcomes').filter(
    (value) => value === 'sold' || value === 'not_sold',
  ) as QuoteDecisionValue[];

  const sort = inSet(params.get('sort'), SORT_KEYS);
  if (params.has('sort') && sort === undefined) dropped.push('sort');
  if (sort !== undefined) filters.sortColumn = sort;

  const page = Number.parseInt(params.get('page') ?? '1', 10);
  filters.page = Number.isFinite(page) && page > 0 ? page : 1;

  const pageSize = Number.parseInt(params.get('size') ?? '', 10);
  filters.pageSize =
    Number.isFinite(pageSize) && pageSize > 0 && pageSize <= 500
      ? pageSize
      : DEFAULT_PAGE_SIZE;

  return { filters, droppedKeys: dropped };
}

/**
 * Encode a filter set into a query string.
 *
 * Keys are emitted in a fixed order and defaults are omitted, so two identical states
 * produce one identical URL. Without that, Back would sometimes replay a state that
 * only differed in key order.
 */
export function writeReportUrl(filters: ReportFilters, today = businessToday()): string {
  const defaults = defaultFilters(today);
  const params = new URLSearchParams();

  const setIf = (key: string, value: string, fallback: string) => {
    if (value !== fallback) params.set(key, value);
  };
  const setList = (key: string, values: readonly string[]) => {
    if (values.length > 0) params.set(key, values.join(','));
  };

  setIf('view', filters.view, defaults.view);
  setIf('mode', filters.mode, defaults.mode);
  setIf('start', filters.startDate, defaults.startDate);
  setIf('end', filters.endDate, defaults.endDate);
  if (filters.compareToPreviousPeriod) params.set('compare', '1');
  setIf('hours', filters.hoursSegment, defaults.hoursSegment);
  setList('ahd', filters.afterHoursDimensions);
  setList('agents', filters.agentProfileIds);
  setList('teams', filters.teamIds);
  setList('sources', filters.dealerIds);
  setList('salespeople', filters.salespersonIds);
  setList('channels', filters.channels);
  setList('kinds', filters.quoteKinds);
  setList('methods', filters.assignmentMethods);
  setList('statuses', filters.statuses);
  setList('outcomes', filters.outcomes);
  if (filters.sortColumn !== null) params.set('sort', filters.sortColumn);
  if (filters.page > 1) params.set('page', String(filters.page));
  if (filters.pageSize !== defaults.pageSize) params.set('size', String(filters.pageSize));

  return params.toString();
}

/** The jsonb payload every reporting RPC takes. */
export function toFilterPayload(filters: ReportFilters): Record<string, unknown> {
  return {
    mode: filters.mode,
    start_date: filters.startDate,
    end_date: filters.endDate,
    compare: filters.compareToPreviousPeriod,
    hours_segment: filters.hoursSegment,
    after_hours_dimensions: filters.afterHoursDimensions,
    agent_profile_ids: filters.agentProfileIds,
    dealer_ids: filters.dealerIds,
    salesperson_ids: filters.salespersonIds,
    channels: filters.channels,
    quote_kinds: filters.quoteKinds,
    assignment_methods: filters.assignmentMethods,
    statuses: filters.statuses,
    outcomes: filters.outcomes,
  };
}

/** True when no dimension filter is active. Drives the "clear filters" control. */
export function hasActiveDimensionFilters(filters: ReportFilters): boolean {
  return (
    filters.agentProfileIds.length > 0 ||
    filters.teamIds.length > 0 ||
    filters.dealerIds.length > 0 ||
    filters.salespersonIds.length > 0 ||
    filters.channels.length > 0 ||
    filters.quoteKinds.length > 0 ||
    filters.assignmentMethods.length > 0 ||
    filters.statuses.length > 0 ||
    filters.outcomes.length > 0 ||
    filters.afterHoursDimensions.length > 0 ||
    filters.hoursSegment !== 'all'
  );
}

export function clearDimensionFilters(filters: ReportFilters): ReportFilters {
  return {
    ...filters,
    agentProfileIds: [],
    teamIds: [],
    dealerIds: [],
    salespersonIds: [],
    channels: [],
    quoteKinds: [],
    assignmentMethods: [],
    statuses: [],
    outcomes: [],
    afterHoursDimensions: [],
    hoursSegment: 'all',
    page: 1,
  };
}
