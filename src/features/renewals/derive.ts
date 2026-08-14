// Pure derived-value helpers for the Renewals tab of the Policy Follow-up workspace.
//
// This module is intentionally free of React, JSX, Supabase, network access, and the
// system clock. `currentBusinessDate` is the only function permitted to read the clock;
// every other function receives the business date as a parameter so tests can pin it
// (Requirement 3.6). Types are imported type-only so nothing from `api.ts` is pulled in
// at runtime.

import type { RenewalContact, RenewalEvent, RenewalRecord } from './api';
// `normalization.ts` is a pure leaf module with no imports of its own, so reaching for the shared
// operational vocabulary here adds no runtime dependency and no layering inversion. It is the one
// place the Spanish/carrier source values become operational terms (Requirement 1.2).
import { POLICY_SOURCE_STATE_LABELS } from '../policy-follow-up/normalization';

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------

/** Agency local time zone. Every calendar-date comparison resolves against it (Req 3.6). */
export const AGENCY_TIME_ZONE = 'America/New_York';

/** Effective search text is capped at this many characters (Req 4.5). */
export const MAX_SEARCH_LENGTH = 100;

/** Stored statuses that mean a final outcome of Renewed, Lost, or Cancelled was recorded (Req 3.5). */
export const RENEWAL_OUTCOME_STATUSES = ['renewed', 'lost', 'cancelled'] as const;

/** `renewal_events.event_type` values that count as requote activity entries (Req 5.2 Rules 3 and 4). */
export const REQUOTE_EVENT_TYPES = [
  'requote_intake_draft_created',
  'requote_intake_submitted',
  'requote_quote_created',
  'requote_created',
  'requote_work_item_created',
] as const;

export type RenewalSummaryFilterId =
  | 'overdue-follow-up'
  | 'follow-up-due-today'
  | 'due-within-3-days'
  | 'due-within-7-days'
  | 'due-within-15-days'
  | 'due-within-30-days'
  | 'no-contact-recorded'
  | 'waiting-on-customer'
  | 'requote-requested'
  | 'customer-decision-pending';

/** The ten summary filters in the order Requirement 3.1 fixes. */
export const RENEWAL_SUMMARY_FILTERS: readonly { id: RenewalSummaryFilterId; label: string }[] = [
  { id: 'overdue-follow-up', label: 'Overdue follow-up' },
  { id: 'follow-up-due-today', label: 'Follow-up due today' },
  { id: 'due-within-3-days', label: 'Due within 3 days' },
  { id: 'due-within-7-days', label: 'Due within 7 days' },
  { id: 'due-within-15-days', label: 'Due within 15 days' },
  { id: 'due-within-30-days', label: 'Due within 30 days' },
  { id: 'no-contact-recorded', label: 'No contact recorded' },
  { id: 'waiting-on-customer', label: 'Waiting on customer' },
  { id: 'requote-requested', label: 'Requote requested' },
  { id: 'customer-decision-pending', label: 'Customer decision pending' },
];

/**
 * The recommended next actions, used as their own display values.
 *
 * Six of them are the original Requirement 5.2 set. `Review renewal` is the seventh, added for
 * the Policy Follow-up assignment workflow: its Requirement 5.2 names a step between "the customer
 * has been contacted" and "a decision is ready" — the renewal terms still have to be looked at —
 * and there was no action naming it.
 *
 * `Review renewal` is reachable only for a record carrying a normalized collector source state
 * (`source_state_normalized`), which is what keeps the ladder's behaviour identical for every
 * record the legacy import created. See `NEXT_ACTION_RULES`.
 */
export type RenewalNextAction =
  | 'Make first contact'
  | 'Complete follow-up'
  | 'Review renewal'
  | 'Prepare requote'
  | 'Review requote'
  | 'Record customer decision'
  | 'Close renewal';

/**
 * The `renewal_records` fields these helpers read. A full `RenewalRecord` is assignable to
 * it; the optional half keeps test fixtures small.
 */
export type RenewalDeriveRecord =
  Pick<RenewalRecord, 'id' | 'status' | 'renewal_date' | 'customer_name' | 'policy_number'>
  & Partial<Pick<RenewalRecord,
    | 'carrier'
    | 'customer_phone'
    | 'customer_email'
    | 'premium_current'
    | 'premium_renewal'
    | 'next_follow_up_at'
    | 'requote_requested'
    | 'requote_sent_at'
    | 'requote_intake_id'
    | 'requote_work_item_id'
    | 'source_state_normalized'
  >>;

/** The `renewal_contacts` field these helpers read. */
export type RenewalDeriveContact = Pick<RenewalContact, 'occurred_at'>;

/** The `renewal_events` field these helpers read for requote activity. */
export type RenewalRequoteActivity = Pick<RenewalEvent, 'created_at'>;

/** Contact entries grouped by `renewal_records.id`. */
export type RenewalContactIndex = ReadonlyMap<string, readonly RenewalDeriveContact[]>;

/** One list row: the record plus the contact entries recorded on it. */
export interface RenewalRow {
  record: RenewalDeriveRecord;
  contacts: readonly RenewalDeriveContact[];
}

/** Signed premium movement (Req 4.4, 4.8). The component adds the sign characters. */
export interface RenewalPremiumChange {
  /** Renewal premium minus current premium, rounded to two decimal places. */
  amount: number;
  /** The same movement as a percentage of the current premium; `null` when that premium is zero. */
  percent: number | null;
}

export type RenewalSummaryCounts = Record<RenewalSummaryFilterId, number>;

/**
 * Requirement 4.2 fixes one total order over the filtered set, so the recommended order is the only
 * sort order there is. It is a named value because Requirements 1.7, 1.10, and 1.3 require the sort
 * order to survive a failed query, to be reused by the retry, and to be restored by the tab shell.
 */
export type RenewalSortOrder = 'recommended';

/**
 * The three values Requirement 1.3 retains per tab for the current page load, which are exactly the
 * three list inputs this module consumes: `matchesSearch`, `matchesSummaryFilter`, and the order
 * `compareRenewalRows` fixes. `PolicyFollowUpPage` holds one of these per tab.
 */
export interface RenewalsUiState {
  searchText: string;
  savedFilter: RenewalSummaryFilterId | null;
  sortOrder: RenewalSortOrder;
}

/**
 * Status-vocabulary bridge.
 *
 * Requirements 3.9 and 5.2 name three statuses — Waiting on customer, Requote requested,
 * and Customer decision pending — that `renewal_records` does not store under those names,
 * and Requirement 2.8 forbids adding or renaming columns. They resolve against the stored
 * workflow status and the stored `requote_requested` flag, in this precedence so that one
 * record lands in exactly one status-based filter:
 *
 *   1. `requote_sent`             -> Customer decision pending (the requote is with the customer)
 *   2. `requote_requested = true` -> Requote requested (flagged, requote not sent yet)
 *   3. `monitoring`               -> Waiting on customer (a follow-up is scheduled and pending)
 *
 * `imported`, `assigned`, and `in_progress` without the requote flag land in none of the three.
 */
type RenewalStatusFilterId = Extract<
  RenewalSummaryFilterId,
  'waiting-on-customer' | 'requote-requested' | 'customer-decision-pending'
>;

interface NextActionContext {
  record: RenewalDeriveRecord;
  contacts: readonly RenewalDeriveContact[];
  requotes: readonly RenewalRequoteActivity[];
}

const MILLISECONDS_PER_DAY = 86_400_000;
const EMPTY_CONTACTS: readonly RenewalDeriveContact[] = [];
const EMPTY_REQUOTES: readonly RenewalRequoteActivity[] = [];

// ---------------------------------------------------------------------------
// Internal date and text utilities
// ---------------------------------------------------------------------------

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days since the Unix epoch for a `YYYY-MM-DD` calendar date. */
function epochDay(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY;
}

/**
 * `YYYY-MM-DD` for the calendar date `days` after `date`. Exported because the drawer needs the
 * same arithmetic for the Requirement 5.10 follow-up range, and one implementation is enough.
 */
export function addDays(date: string, days: number): string {
  const shifted = new Date((epochDay(date) + days) * MILLISECONDS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The whole calendar date of a stored value, disregarding time of day (Req 3.6).
 * `date` columns are already calendar dates and are returned unchanged; timestamps are
 * resolved in `timeZone`.
 */
function calendarDate(value: string | null | undefined, timeZone: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (DATE_ONLY.test(text)) return text;
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return DATE_ONLY.test(text.slice(0, 10)) ? text.slice(0, 10) : null;
  return currentBusinessDate(new Date(parsed), timeZone);
}

/** Epoch milliseconds of a stored timestamp, or `null` when it is absent or unparseable. */
function timeValue(value: string | null | undefined): number | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Half-away-from-zero rounding to two decimal places, without a negative zero result. */
function roundToCents(value: number): number {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  if (rounded === 0) return 0;
  return value < 0 ? -rounded : rounded;
}

function effectiveSearchText(searchText: string | null | undefined): string {
  return (searchText ?? '').trim().slice(0, MAX_SEARCH_LENGTH).toLowerCase();
}

/** Character-by-character ascending comparison without case sensitivity (Req 4.2 key 5). */
function compareTextInsensitive(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** `true` sorts before `false`. */
function compareFlagFirst(left: boolean, right: boolean): number {
  if (left === right) return 0;
  return left ? -1 : 1;
}

function emptySummaryCounts(): RenewalSummaryCounts {
  const counts = {} as RenewalSummaryCounts;
  for (const filter of RENEWAL_SUMMARY_FILTERS) counts[filter.id] = 0;
  return counts;
}

function statusFilterId(record: RenewalDeriveRecord): RenewalStatusFilterId | null {
  if (record.status === 'requote_sent') return 'customer-decision-pending';
  if (record.requote_requested) return 'requote-requested';
  if (record.status === 'monitoring') return 'waiting-on-customer';
  return null;
}

function hasRequoteActivity(
  record: RenewalDeriveRecord,
  requotes: readonly RenewalRequoteActivity[],
): boolean {
  if (requotes.length > 0) return true;
  return Boolean(record.requote_sent_at || record.requote_intake_id || record.requote_work_item_id);
}

/** Epoch milliseconds of the most recent requote activity entry, or `null` when none carries a time. */
function latestRequoteActivityAt(
  record: RenewalDeriveRecord,
  requotes: readonly RenewalRequoteActivity[],
): number | null {
  let latest: number | null = null;
  for (const entry of requotes) {
    const at = timeValue(entry.created_at);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  const sentAt = timeValue(record.requote_sent_at);
  if (sentAt !== null && (latest === null || sentAt > latest)) latest = sentAt;
  return latest;
}

/** Renewal date inside the inclusive window from the business date to business date + `days` (Req 3.8). */
function withinRenewalWindow(renewalDate: string | null, businessDate: string, days: number): boolean {
  if (!renewalDate) return false;
  return renewalDate >= businessDate && renewalDate <= addDays(businessDate, days);
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * The current business date as `YYYY-MM-DD`: the calendar date in the agency local time
 * zone at the moment of evaluation (Req 3.6). The only function in this module that reads
 * the clock.
 */
export function currentBusinessDate(now: Date = new Date(), timeZone: string = AGENCY_TIME_ZONE): string {
  if (Number.isNaN(now.getTime())) throw new Error('currentBusinessDate requires a valid date.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value ?? '';
  const month = parts.find((part) => part.type === 'month')?.value ?? '';
  const day = parts.find((part) => part.type === 'day')?.value ?? '';
  return `${year}-${month}-${day}`;
}

/**
 * Whole calendar days from the business date to the renewal date (Req 4.7): `0` on the
 * business date, negative when the renewal date precedes it, `null` when either date is
 * absent or unreadable.
 */
export function daysRemaining(
  renewalDate: string | null | undefined,
  businessDate: string,
  timeZone: string = AGENCY_TIME_ZONE,
): number | null {
  const target = calendarDate(renewalDate, timeZone);
  const from = calendarDate(businessDate, timeZone);
  if (!target || !from) return null;
  return Math.round(epochDay(target) - epochDay(from));
}

/**
 * Signed premium movement (Req 4.4, 4.8): `null` when either premium is absent, otherwise
 * the renewal premium minus the current premium rounded to two decimal places plus the
 * same movement as a percentage.
 */
export function premiumChange(
  current: number | null | undefined,
  renewal: number | null | undefined,
): RenewalPremiumChange | null {
  if (current === null || current === undefined || renewal === null || renewal === undefined) return null;
  if (!Number.isFinite(current) || !Number.isFinite(renewal)) return null;
  const difference = renewal - current;
  return {
    amount: roundToCents(difference),
    percent: current === 0 ? null : roundToCents((difference / current) * 100),
  };
}

/** A record is open while no outcome of Renewed, Lost, or Cancelled is recorded (Req 3.5). */
export function isOpenRenewal(record: Pick<RenewalDeriveRecord, 'status'>): boolean {
  return record.status !== 'renewed' && record.status !== 'lost' && record.status !== 'cancelled';
}

/**
 * One record's contact history as the bulk summary read reports it (Requirements 5.4, 15.1).
 *
 * The list surface cannot afford one `renewal_contacts` query per row, and it does not need the
 * rows: `renewal_contact_summaries` returns the count and the latest occurrence per record in one
 * round trip.
 */
export interface RenewalContactSummary {
  record_id: string;
  contact_count: number;
  last_contact_at: string | null;
  last_outcome: string | null;
}

/**
 * The contact entries a summary stands for, as the derivations here read them (Requirement 5.4).
 *
 * Every derivation in this module reads exactly two things from a contact list: whether it is
 * empty (`no-contact-recorded`, `Make first contact`) and the latest `occurred_at` (`Review
 * requote`, the Last contact cell). A one-element list carrying the latest occurrence is therefore
 * *behaviourally identical* to the full history for all of them, which is what lets the list
 * surface use the summary read instead of the empty placeholder it used to pass.
 *
 * The count is still carried in the summary and displayed; it is only the derivations that do not
 * need it. A summary reporting contacts but no readable timestamp still yields a non-empty list, so
 * `Make first contact` correctly stops firing — the absent timestamp is the unknown, not the
 * contact.
 */
export function renewalContactsFromSummary(
  summary: Pick<RenewalContactSummary, 'contact_count' | 'last_contact_at'> | null | undefined,
): readonly RenewalDeriveContact[] {
  if (!summary || summary.contact_count <= 0) return EMPTY_CONTACTS;
  return [{ occurred_at: summary.last_contact_at ?? '' }];
}

/** A `RenewalContactIndex` built from the bulk summary read (Requirements 5.4, 15.1). */
export function renewalContactIndexFromSummaries(
  summaries: readonly RenewalContactSummary[],
): RenewalContactIndex {
  const index = new Map<string, readonly RenewalDeriveContact[]>();
  for (const summary of summaries) {
    index.set(summary.record_id, renewalContactsFromSummary(summary));
  }
  return index;
}

/**
 * Counting rule of one summary filter (Req 3.7 to 3.9). Records that are not open match no
 * filter (Req 3.5). A record with no next follow-up date falls out of both follow-up
 * filters and stays eligible for the rest; the four renewal-date windows are inclusive on
 * both bounds and cumulative.
 */
export function matchesSummaryFilter(
  record: RenewalDeriveRecord,
  contacts: readonly RenewalDeriveContact[],
  filterId: RenewalSummaryFilterId,
  businessDate: string,
  timeZone: string = AGENCY_TIME_ZONE,
): boolean {
  if (!isOpenRenewal(record)) return false;
  const today = calendarDate(businessDate, timeZone);
  if (!today) return false;

  const followUp = calendarDate(record.next_follow_up_at, timeZone);
  const renewal = calendarDate(record.renewal_date, timeZone);

  switch (filterId) {
    case 'overdue-follow-up':
      return followUp !== null && followUp < today;
    case 'follow-up-due-today':
      return followUp !== null && followUp === today;
    case 'due-within-3-days':
      return withinRenewalWindow(renewal, today, 3);
    case 'due-within-7-days':
      return withinRenewalWindow(renewal, today, 7);
    case 'due-within-15-days':
      return withinRenewalWindow(renewal, today, 15);
    case 'due-within-30-days':
      return withinRenewalWindow(renewal, today, 30);
    case 'no-contact-recorded':
      return contacts.length === 0;
    case 'waiting-on-customer':
    case 'requote-requested':
    case 'customer-decision-pending':
      return statusFilterId(record) === filterId;
    default:
      return false;
  }
}

/**
 * Case-insensitive substring match over customer name, policy number, carrier, customer
 * phone, and customer email (Req 4.5). The effective search text is the entered text
 * trimmed and limited to its first 100 characters; an effective text of zero characters
 * matches every record.
 */
export function matchesSearch(record: RenewalDeriveRecord, searchText: string | null | undefined): boolean {
  const needle = effectiveSearchText(searchText);
  if (!needle) return true;
  const haystack = [
    record.customer_name,
    record.policy_number,
    record.carrier,
    record.customer_phone,
    record.customer_email,
  ];
  return haystack.some((value) => (value ?? '').toLowerCase().includes(needle));
}

/**
 * All ten summary filter counts (Req 3.3). Every count is computed independently of which
 * filter is active, is restricted to open records matching the active search text, and one
 * record is counted in every filter whose rule it satisfies.
 */
export function summaryCounts(
  records: readonly RenewalDeriveRecord[],
  contactIndex: RenewalContactIndex,
  searchText: string | null | undefined,
  businessDate: string,
  timeZone: string = AGENCY_TIME_ZONE,
): RenewalSummaryCounts {
  const counts = emptySummaryCounts();
  for (const record of records) {
    if (!isOpenRenewal(record)) continue;
    if (!matchesSearch(record, searchText)) continue;
    const contacts = contactIndex.get(record.id) ?? EMPTY_CONTACTS;
    for (const filter of RENEWAL_SUMMARY_FILTERS) {
      if (matchesSummaryFilter(record, contacts, filter.id, businessDate, timeZone)) {
        counts[filter.id] += 1;
      }
    }
  }
  return counts;
}

/**
 * The five sort keys of Requirement 4.2 in order: rows counted in Overdue follow-up first,
 * renewal date ascending, rows counted in No contact recorded first, customer name
 * ascending without case sensitivity, policy number ascending character by character
 * without case sensitivity. Record id breaks a remaining tie so the comparator is a total
 * order.
 */
export function compareRenewalRows(
  a: RenewalRow,
  b: RenewalRow,
  businessDate: string,
  timeZone: string = AGENCY_TIME_ZONE,
): number {
  const counted = (row: RenewalRow, filterId: RenewalSummaryFilterId) =>
    matchesSummaryFilter(row.record, row.contacts, filterId, businessDate, timeZone);

  const byOverdue = compareFlagFirst(counted(a, 'overdue-follow-up'), counted(b, 'overdue-follow-up'));
  if (byOverdue !== 0) return byOverdue;

  const leftDate = calendarDate(a.record.renewal_date, timeZone);
  const rightDate = calendarDate(b.record.renewal_date, timeZone);
  if (leftDate !== rightDate) {
    if (!leftDate) return 1;
    if (!rightDate) return -1;
    return leftDate < rightDate ? -1 : 1;
  }

  const byNoContact = compareFlagFirst(counted(a, 'no-contact-recorded'), counted(b, 'no-contact-recorded'));
  if (byNoContact !== 0) return byNoContact;

  const byName = (a.record.customer_name ?? '').toLocaleLowerCase()
    .localeCompare((b.record.customer_name ?? '').toLocaleLowerCase());
  if (byName !== 0) return byName;

  const byPolicy = compareTextInsensitive(a.record.policy_number ?? '', b.record.policy_number ?? '');
  if (byPolicy !== 0) return byPolicy;

  return compareTextInsensitive(a.record.id ?? '', b.record.id ?? '');
}

/** Statuses at which the renewal terms have not yet been taken to the customer for review. */
const PRE_REVIEW_STATUSES: ReadonlySet<string> = new Set(['imported', 'assigned', 'in_progress']);

/**
 * The operational status of one renewal, in the language an agent reads (Requirements 1.2, 6.3).
 *
 * A Carrier Non-Renewal record reads `Carrier Non-Renewal / Requote Required` whatever its stored
 * workflow status is, because that is the fact the agent has to act on and Requirement 7.2 requires
 * it be prominent. Every other record reads a plain-English rendering of its workflow status.
 * Neither is the raw stored enum and neither is Spanish.
 *
 * Lives here rather than in the shared projection so the Renewal drawer, the list, and the shared
 * My Work view all read one definition without the drawer having to depend on the cancellations
 * module.
 */
export function renewalNormalizedStatus(record: RenewalDeriveRecord): string {
  if (isCarrierNonRenewalRecord(record)) return POLICY_SOURCE_STATE_LABELS.carrier_nonrenewal;
  if (record.source_state_normalized === 'review_required') {
    return POLICY_SOURCE_STATE_LABELS.review_required;
  }

  switch (record.status) {
    case 'imported': return 'Imported — not yet assigned';
    case 'assigned': return 'Assigned — contact required';
    case 'in_progress': return 'Customer contacted';
    case 'monitoring': return 'Waiting on customer';
    case 'requote_sent': return 'Requote with customer';
    case 'renewed': return 'Renewed';
    case 'lost': return 'Lost';
    case 'cancelled': return 'Cancelled';
    default: return 'Open';
  }
}

/**
 * Why a renewal is waiting rather than owed an action, or `null` (Requirement 6.2).
 *
 * Only the two statuses that genuinely record a dependency qualify. `monitoring` means a follow-up
 * is scheduled and the customer has not come back; `requote_sent` means the requote is with the
 * customer. An `assigned` record with no contact is not waiting — it is work nobody has started.
 */
export function renewalWaitingReason(record: RenewalDeriveRecord): string | null {
  if (record.status === 'requote_sent') return 'Requote is with the customer';
  if (record.status === 'monitoring') return 'Waiting on the customer';
  return null;
}

/**
 * True where the record's normalized collector source state is Carrier Non-Renewal, which
 * Requirement 7.2 requires force a requote ahead of every ordinary renewal action.
 *
 * Reads the stored normalized value rather than the raw Spanish `TipoRegistro`: the interpretation
 * belongs to `policy-follow-up/normalization.ts`, and this module consumes its result.
 */
export function isCarrierNonRenewalRecord(record: RenewalDeriveRecord): boolean {
  return record.source_state_normalized === 'carrier_nonrenewal';
}

/**
 * The rules of Requirement 5.2 as one ordered array of `{ action, when }` predicates. The first
 * rule whose condition holds supplies the recommended next action.
 *
 * Two rules changed for the Policy Follow-up assignment workflow, both additively:
 *
 *   * `Prepare requote` now also fires for a Carrier Non-Renewal record with no requote activity.
 *     A carrier declining to renew is exactly the case Requirement 7.2 says must show
 *     `Prepare Requote` ahead of ordinary renewal work, and the legacy `requote_requested` flag is
 *     not set on a collector row. `Review requote` still outranks it, so a non-renewal whose
 *     requote is already out reads `Review requote` — the requote has been prepared.
 *
 *   * `Review renewal` was inserted between `Make first contact` and `Complete follow-up`, gated on
 *     the record carrying a normalized collector source state. A record with no source state — every
 *     record the legacy Power BI / HawkSoft import created — cannot reach it, so the ladder is
 *     unchanged for them and every pre-existing expectation of `Complete follow-up` still holds.
 *     The gate is not a hedge: "the customer was contacted but the renewal terms have not been
 *     reviewed" is only answerable for a record whose renewal premium and record type came from a
 *     source that reports them.
 */
const NEXT_ACTION_RULES: readonly { action: RenewalNextAction; when: (context: NextActionContext) => boolean }[] = [
  {
    action: 'Close renewal',
    when: ({ record }) => !isOpenRenewal(record),
  },
  {
    action: 'Record customer decision',
    when: ({ record }) => statusFilterId(record) === 'customer-decision-pending',
  },
  {
    action: 'Review requote',
    when: ({ record, contacts, requotes }) => {
      if (!hasRequoteActivity(record, requotes)) return false;
      const latest = latestRequoteActivityAt(record, requotes);
      if (latest === null) return true;
      return !contacts.some((contact) => {
        const at = timeValue(contact.occurred_at);
        return at !== null && at > latest;
      });
    },
  },
  {
    action: 'Prepare requote',
    when: ({ record, requotes }) =>
      (statusFilterId(record) === 'requote-requested' || isCarrierNonRenewalRecord(record))
      && !hasRequoteActivity(record, requotes),
  },
  {
    action: 'Make first contact',
    when: ({ contacts }) => contacts.length === 0,
  },
  {
    action: 'Review renewal',
    when: ({ record }) =>
      record.source_state_normalized === 'renewal'
      && PRE_REVIEW_STATUSES.has(record.status)
      && !record.next_follow_up_at,
  },
  {
    action: 'Complete follow-up',
    when: () => true,
  },
];

/** The single recommended next action for a record (Req 5.2). */
export function recommendedNextAction(
  record: RenewalDeriveRecord,
  contacts: readonly RenewalDeriveContact[] = EMPTY_CONTACTS,
  requotes: readonly RenewalRequoteActivity[] = EMPTY_REQUOTES,
): RenewalNextAction {
  const context: NextActionContext = { record, contacts, requotes };
  const rule = NEXT_ACTION_RULES.find((candidate) => candidate.when(context));
  return rule ? rule.action : 'Complete follow-up';
}
