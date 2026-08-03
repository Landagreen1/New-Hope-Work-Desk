// Pure derived-value helpers for the Cancellations tab of the Policy Follow-up workspace.
//
// Requirement 16 is the contract for the list surface and Requirement 17 criterion 4 for the one
// prominent action the drawer and the list must agree on:
// - 16.1        the thirteen row cells in one fixed order, days remaining from the current
//               business date, an em dash for an absent cancellation reason or amount due, and
//               `Unassigned` for a case with no assigned employee
// - 16.2        the fourteen saved filters, exactly one active, Needs Action until the user picks
// - 16.3        the list is the rows the profile may read under Requirement 22 that satisfy both
//               the saved filter and the active search text, with *active* meaning Case_Status is
//               Imported, Open, Payment Reported, Verification Pending, or Reinstatement Pending,
//               and search text of zero non-whitespace characters restricting nothing
// - 16.4        the search rule: trim, cap at 100 characters, case-insensitive substring over
//               customer name, policy number, carrier, Contact_Recipient phone and email —
//               invalid and suppressed contact rows included — and a digit-only comparison
//               against the phone where the search text carries at least one digit
// - 16.5        the four sort keys, in pages of at most 50 rows
// - 16.7 / 16.8 the matching rule of each of the fourteen filters
// - 16.9        the four derived cells, and the next required action naming the same action the
//               drawer makes primary
// - 17.4        the eight-step ordered primary action, each step also shown to the signed-in
//               profile under Requirement 17.10
//
// **Pure module.** No React, no Supabase client, no network, no file system, no clock, no
// randomness. The current business date is always a parameter — nothing here calls `new Date()` —
// so the same inputs always produce the same rows in the same order. A caller that needs the
// business date itself reads `currentBusinessDate` from `../renewals/derive`, which is the one
// clock read in the workspace (Requirement 3.6); this module never asks for it.
//
// **One definition per rule.** The four derived cells of Requirement 16.9 and the eight-step
// primary action of Requirement 17.4 already live in `./domain/communication-status`, which is
// what makes Requirements 16.9 and 16.10 hold: the list cell and the drawer's prominent control
// come from the same function, so they cannot name different actions. This module folds those
// results into the thirteen cells, adds the filters, the search, and the sort, and re-exports the
// shared derivations so a caller reaches exactly one of each. Contact validity and per-channel
// eligibility stay in `./domain/suppression`, escalation state in `./domain/escalation`, and the
// date, amount, and policy-number readers in `./import/fields`.
//
// **Readings recorded where a criterion leaves something open.** Each is repeated at the function
// that applies it, and collected here so a reviewer can find them in one place:
//
//  1. *Active is not open.* Requirement 16.3's *active* set has five members; Requirement 15.1's
//     *open* set has two (Imported, Open). Both are used below and they are not
//     interchangeable — `Messages Scheduled Today` reads the open set, the date windows read the
//     active set.
//  2. *`Messages Scheduled Today` is decided by the Touchpoint due dates alone.* Requirement
//     12.1 fixes the four due dates as the calendar dates 15, 10, 5, and 1 day before the
//     effective date, so a Touchpoint's scheduled send date equals the business date exactly
//     when days remaining is 15, 10, 5, or 1. Requirement 12.2's eligible-contact condition is
//     deliberately *not* added: a case with no eligible contact is what `Contact Missing` and
//     `Needs Action` are for, and folding eligibility in here would make one filter answer two
//     questions.
//  3. *A stored follow-up deadline is compared as its UTC calendar date.* Requirement 16.8 asks
//     whether the deadline is "earlier than or equal to the current business date", one a
//     `timestamptz` and the other a calendar date. `./domain/escalation` produces the deadline by
//     clamping at UTC midnight of the effective date (its reading 7), so reading the UTC calendar
//     date back is exactly the inverse of how the value was written.
//  4. *`Payment Verification Required` reads the stored next required action and the derived one,
//     from the unrestricted Manager_Role view.* Requirement 16.8's second clause is "the next
//     required action is Verify Payment". Requirement 17.10 hides Verify Payment from Agent_Role,
//     so deriving it through the caller's role would silently change a saved filter's meaning per
//     role; a filter answers a question about the case, and the read scope of Requirement 22 is
//     applied separately by `canReadCancellationCase`.
//  5. *The absent marker covers every text cell.* Requirement 16.1 names an em dash for the
//     cancellation reason and the amount due, and Requirement 16.9 for the last contact and a
//     cleared next required action. It says nothing about an absent customer name or carrier, and
//     a blank table cell is not a specified rendering either, so the same em dash is used — one
//     absent marker per row rather than two conventions.
//  6. *An assigned case whose employee row was not supplied reads as an em dash, not
//     `Unassigned`.* Requirement 16.1 fixes `Unassigned` for a case that *has* no assigned
//     employee. A case carrying `assigned_to` whose profile the caller did not join has an
//     assigned employee whose name is unknown, and calling it `Unassigned` would state something
//     false about the case.
//  7. *A fifth sort key breaks a remaining tie.* Requirement 16.5 requires the order of any two
//     rows to be fully determined, and its four keys do that for stored rows — Requirement 9.1
//     makes (normalized policy number, effective date) unique. The case id is compared last
//     anyway, so the comparator is a total order for any input a test can build.
//  8. *The digit-only phone comparison is an additional path, not a replacement.* Requirement
//     16.4 restricts the list to records whose phone "contains the search text as a substring",
//     then says to compare a search text carrying a digit against the phone with every non-digit
//     removed from both values. Both comparisons are made, so `+1305` and `(305)` each still find
//     the same row.

import { canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import {
  cellText,
  daysRemaining,
  deriveCaseCommunicationStatus,
  deriveEmailStatusCell,
  deriveLastContact,
  deriveNextRequiredAction,
  deriveSmsStatusCell,
  EM_DASH,
  hasContactableContact,
  isOpenCaseStatus,
  MANAGER_ONLY_ACTIONS,
  NEXT_REQUIRED_ACTIONS,
  type CaseCommunicationState,
  type CaseStatus,
  type CommunicationRecord,
  type CommunicationStatus,
  type NextRequiredAction,
} from './domain/communication-status';
import type { EscalationCase } from './domain/escalation';
import type { ChannelEligibilityContact } from './domain/suppression';
import { parseAmountDue, parseCancellationDate } from './import/fields';
import { TOUCHPOINTS, type AssignedEmployee } from './render/renderMessage';

// The shared derivations, re-exported so the list surface, the drawer, and their tests reach one
// definition of each. `deriveNextRequiredAction` is the eight-step rule `primaryAction` wraps;
// both are exported on purpose, and they return the same value for the same state.
export {
  cellText,
  daysRemaining,
  deriveCaseCommunicationStatus,
  deriveEmailStatusCell,
  deriveLastContact,
  deriveNextRequiredAction,
  deriveRowCells,
  deriveSmsStatusCell,
  EM_DASH,
  MANAGER_ONLY_ACTIONS,
  NEXT_REQUIRED_ACTIONS,
} from './domain/communication-status';
export type {
  CancellationRowCells as DerivedCancellationCells,
  CaseStatus,
  CommunicationStatus,
  NextRequiredAction,
} from './domain/communication-status';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Rendered when a Cancellation_Case has no assigned employee (Requirement 16.1). */
export const UNASSIGNED = 'Unassigned';

/** Effective search text is trimmed and capped at this many characters (Requirement 16.4). */
export const MAX_SEARCH_LENGTH = 100;

/** The list loads in the Requirement 16.5 order in pages of at most this many rows. */
export const CANCELLATION_PAGE_SIZE = 50;

/**
 * The five Case_Status values Requirement 16.3 calls an *active* Cancellation_Case. Not the two
 * *open* values of Requirement 15.1 (`isOpenCaseStatus`), which are a different set for a
 * different purpose — reading 1 of the file header.
 */
export const ACTIVE_CASE_STATUSES = [
  'Imported',
  'Open',
  'Payment Reported',
  'Verification Pending',
  'Reinstatement Pending',
] as const satisfies readonly CaseStatus[];

/** The three Case_Status values the Resolved filter matches (Requirement 16.8). */
export const RESOLVED_FILTER_CASE_STATUSES = [
  'Reinstated',
  'Cancelled',
  'Resolved',
] as const satisfies readonly CaseStatus[];

/** The two Case_Status values Requirement 16.8 sends to Payment Verification Required. */
export const PAYMENT_VERIFICATION_CASE_STATUSES = [
  'Payment Reported',
  'Verification Pending',
] as const satisfies readonly CaseStatus[];

/** The four Communication_Status values that alone put a case in Needs Action (Req 16.8). */
export const NEEDS_ACTION_COMMUNICATION_STATUSES = [
  'Partially Failed',
  'Failed',
  'Suppressed',
  'Manual Follow-up Required',
] as const satisfies readonly CommunicationStatus[];

/** The two Communication_Status values that alone match Communication Failed (Req 16.8). */
export const COMMUNICATION_FAILED_STATUSES = [
  'Partially Failed',
  'Failed',
] as const satisfies readonly CommunicationStatus[];

/** Days remaining at or below which Needs Action asks for a delivered record (Req 16.8). */
export const NEEDS_ACTION_DAYS_REMAINING = 1;

export type CancellationSavedFilterId =
  | 'needs-action'
  | 'cancellation-today'
  | 'next-3-days'
  | 'next-7-days'
  | 'next-15-days'
  | 'contact-missing'
  | 'messages-scheduled-today'
  | 'communication-failed'
  | 'customer-responded'
  | 'payment-verification-required'
  | 'reinstatement-pending'
  | 'no-successful-contact'
  | 'resolved'
  | 'all';

/** The fourteen saved filters in the order Requirement 16.2 lists them, with its labels. */
export const CANCELLATION_SAVED_FILTERS: readonly {
  id: CancellationSavedFilterId;
  label: string;
}[] = [
  { id: 'needs-action', label: 'Needs Action' },
  { id: 'cancellation-today', label: 'Cancellation Today' },
  { id: 'next-3-days', label: 'Next 3 Days' },
  { id: 'next-7-days', label: 'Next 7 Days' },
  { id: 'next-15-days', label: 'Next 15 Days' },
  { id: 'contact-missing', label: 'Contact Missing' },
  { id: 'messages-scheduled-today', label: 'Messages Scheduled Today' },
  { id: 'communication-failed', label: 'Communication Failed' },
  { id: 'customer-responded', label: 'Customer Responded' },
  { id: 'payment-verification-required', label: 'Payment Verification Required' },
  { id: 'reinstatement-pending', label: 'Reinstatement Pending' },
  { id: 'no-successful-contact', label: 'No Successful Contact' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

/** Active until the user selects a saved filter in the current session (Requirement 16.2). */
export const DEFAULT_CANCELLATION_FILTER: CancellationSavedFilterId = 'needs-action';

/**
 * Requirement 16.5 fixes one total order over the filtered set, so the recommended order is the
 * only sort order there is. Named because Requirement 1.3 retains the sort order per tab for the
 * page load.
 */
export type CancellationSortOrder = 'recommended';

/**
 * The three list inputs Requirement 1.3 retains per tab: the search text of Requirement 16.4, the
 * one active saved filter of Requirement 16.2, and the order of Requirement 16.5.
 */
export interface CancellationsUiState {
  searchText: string;
  savedFilter: CancellationSavedFilterId | null;
  sortOrder: CancellationSortOrder;
}

const ACTIVE_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>(ACTIVE_CASE_STATUSES);
const RESOLVED_FILTER_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>(RESOLVED_FILTER_CASE_STATUSES);
const PAYMENT_VERIFICATION_CASE_STATUS_SET: ReadonlySet<string> = new Set<string>(
  PAYMENT_VERIFICATION_CASE_STATUSES,
);
const NEEDS_ACTION_COMMUNICATION_STATUS_SET: ReadonlySet<string> = new Set<string>(
  NEEDS_ACTION_COMMUNICATION_STATUSES,
);
const COMMUNICATION_FAILED_STATUS_SET: ReadonlySet<string> = new Set<string>(COMMUNICATION_FAILED_STATUSES);
const MANAGER_ONLY_ACTION_SET: ReadonlySet<string> = new Set<string>(MANAGER_ONLY_ACTIONS);
const TOUCHPOINT_DUE_DAYS: readonly number[] = TOUCHPOINTS;

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const NON_DIGIT = /\D/g;
const DIGIT = /\d/;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * The `cancellation_cases` columns the list surface reads: the escalation case shape — itself the
 * status-derivation shape plus the four columns Requirement 20 adds — with the three display
 * columns of Requirement 16.1 that no derivation needed until now. One selected row therefore
 * satisfies the status derivation, the escalation evaluator, and the thirteen cells.
 */
export interface CancellationRowCase extends EscalationCase {
  carrier?: string | null;
  cancellation_reason?: string | null;
  /** `numeric(12,2)`, which arrives as a number or as a decimal string depending on the client. */
  amount_due?: number | string | null;
}

/**
 * A `cancellation_contacts` row as the list surface reads it: the eligibility columns of
 * `./domain/suppression` plus the segment as it appeared in the source cell, which Requirement
 * 16.4's search compares alongside the stored normalized value.
 */
export interface CancellationRowContact extends ChannelEligibilityContact {
  id?: string | null;
  case_id?: string | null;
  raw_segment?: string | null;
}

/** The assigned employee of a case, for the assigned-employee cell of Requirement 16.1. */
export interface CancellationRowAssignee extends AssignedEmployee {
  id?: string | null;
}

/**
 * Everything one cancellation row derives from: the state bundle the status derivations read —
 * case, contacts, communications, scheduled sends, escalations, responses, suppressions, business
 * date, viewer role — narrowed to the list's case and contact shapes and carrying the assigned
 * employee. A bundle built for the escalation evaluator satisfies it unchanged.
 *
 * Every field but `case` is optional, so a test fixture is as small as the rule under test.
 */
export interface CancellationRowState extends CaseCommunicationState {
  case: CancellationRowCase;
  contacts?: readonly CancellationRowContact[];
  assignedEmployee?: CancellationRowAssignee | null;
}

/**
 * The thirteen cells of one cancellation row, in the Requirement 16.1 order. Every value is
 * display text: an absent value already reads as an em dash and a case with no assigned employee
 * already reads `Unassigned`, so the table renders these as they stand.
 */
export interface CancellationRowCells {
  customerName: string;
  policyNumber: string;
  carrier: string;
  cancellationEffectiveDate: string;
  daysRemaining: string;
  cancellationReason: string;
  amountDue: string;
  assignedEmployee: string;
  smsStatus: string;
  emailStatus: string;
  lastContact: string;
  caseStatus: string;
  nextRequiredAction: string;
}

/** The thirteen cell keys in the order Requirement 16.1 fixes. */
export const CANCELLATION_ROW_CELL_ORDER = [
  'customerName',
  'policyNumber',
  'carrier',
  'cancellationEffectiveDate',
  'daysRemaining',
  'cancellationReason',
  'amountDue',
  'assignedEmployee',
  'smsStatus',
  'emailStatus',
  'lastContact',
  'caseStatus',
  'nextRequiredAction',
] as const satisfies readonly (keyof CancellationRowCells)[];

/** The signed-in profile, as the read scope of Requirement 22 tests it. */
export interface CancellationViewer {
  role: AppRole;
  profileId?: string | null;
}

export type CancellationFilterCounts = Record<CancellationSavedFilterId, number>;

// ---------------------------------------------------------------------------
// Internal text, number, and date utilities
// ---------------------------------------------------------------------------

/** Trimmed text, or `null` when the value is absent or holds only whitespace. */
function trimToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Ascending comparison of two values without case sensitivity, code unit by code unit. */
function compareTextInsensitive(left: string | null | undefined, right: string | null | undefined): number {
  const a = (left ?? '').toLowerCase();
  const b = (right ?? '').toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Every digit of a value, in order, with every other character removed (Requirement 16.4). */
export function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(NON_DIGIT, '');
}

/** The UTC calendar date of a stored timestamp as `YYYY-MM-DD`, or `null` when unreadable. */
function utcCalendarDate(value: string | null | undefined): string | null {
  const text = trimToNull(value);
  if (text === null) return null;
  const direct = parseCancellationDate(text);
  if (direct.ok) return direct.date;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

/** A stored `amount_due` as text `parseAmountDue` can read, or `null` when absent. */
function amountDueSource(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value.toFixed(2) : null;
  return value;
}

// ---------------------------------------------------------------------------
// Case-level reads
// ---------------------------------------------------------------------------

/**
 * The amount due in whole cents, or `null` where the case carries none (Requirements 16.1, 16.5).
 * Read through the import parser, so the stored column, a decimal string, and a value the
 * importer would have refused are all judged by one definition, and the sort key is an integer
 * rather than a float.
 */
export function amountDueCents(caseRow: Pick<CancellationRowCase, 'amount_due'>): number | null {
  const source = amountDueSource(caseRow.amount_due);
  if (source === null) return null;
  const parsed = parseAmountDue(source);
  return parsed.present ? parsed.cents : null;
}

/** The cancellation effective date as the canonical `YYYY-MM-DD`, or `null` when unreadable. */
export function effectiveCalendarDate(
  caseRow: Pick<CancellationRowCase, 'cancellation_effective_date'>,
): string | null {
  const parsed = parseCancellationDate(caseRow.cancellation_effective_date);
  return parsed.ok ? parsed.date : null;
}

/**
 * True for an *active* Cancellation_Case: Case_Status is Imported, Open, Payment Reported,
 * Verification Pending, or Reinstatement Pending (Requirement 16.3). Distinct from
 * `isOpenCaseStatus`, which is Requirement 15.1's two-value open set — reading 1.
 */
export function isActiveCancellationCase(caseRow: Pick<CancellationRowCase, 'case_status'>): boolean {
  return ACTIVE_CASE_STATUS_SET.has(caseRow.case_status);
}

/** Days remaining for one row, from the business date carried by the state bundle (Req 16.1). */
export function rowDaysRemaining(state: CancellationRowState): number | null {
  return daysRemaining(state.case.cancellation_effective_date, state.businessDate);
}

// ---------------------------------------------------------------------------
// The thirteen row cells (Requirements 16.1, 16.9)
// ---------------------------------------------------------------------------

/** Display text for a stored value, with an em dash where it is absent (reading 5). */
function textCell(value: string | null | undefined): string {
  return cellText(trimToNull(value));
}

/** The days remaining cell: a signed whole number, or an em dash where no date is readable. */
export function daysRemainingCell(state: CancellationRowState): string {
  const remaining = rowDaysRemaining(state);
  return remaining === null ? EM_DASH : String(remaining);
}

/** The amount due cell: US dollars, or an em dash where the amount is absent (Req 16.1). */
export function amountDueCell(caseRow: Pick<CancellationRowCase, 'amount_due'>): string {
  const cents = amountDueCents(caseRow);
  return cents === null ? EM_DASH : CURRENCY.format(cents / 100);
}

/**
 * The assigned employee cell: the employee's display name, `Unassigned` where the case has no
 * assigned employee, and an em dash where the case is assigned to a profile the caller did not
 * supply (Requirement 16.1, reading 6).
 */
export function assignedEmployeeCell(state: CancellationRowState): string {
  const name = trimToNull(state.assignedEmployee?.display_name);
  if (name !== null) return name;
  const assignedTo = trimToNull(state.case.assigned_to) ?? trimToNull(state.assignedEmployee?.id);
  return assignedTo === null ? UNASSIGNED : EM_DASH;
}

/**
 * The thirteen cells of one cancellation row (Requirements 16.1, 16.9, 16.10).
 *
 * The SMS status, email status, last contact, and next required action cells are the four
 * derivations of `./domain/communication-status`, unchanged: the last of them is the same
 * function the drawer asks for its prominent control, which is what makes the list cell and the
 * drawer name one action (Requirements 16.9, 17.4).
 */
export function cancellationRowCells(state: CancellationRowState): CancellationRowCells {
  const caseRow = state.case;
  return {
    customerName: textCell(caseRow.customer_name),
    policyNumber: textCell(caseRow.policy_number),
    carrier: textCell(caseRow.carrier),
    cancellationEffectiveDate: cellText(effectiveCalendarDate(caseRow)),
    daysRemaining: daysRemainingCell(state),
    cancellationReason: textCell(caseRow.cancellation_reason),
    amountDue: amountDueCell(caseRow),
    assignedEmployee: assignedEmployeeCell(state),
    smsStatus: deriveSmsStatusCell(state),
    emailStatus: deriveEmailStatusCell(state),
    lastContact: cellText(deriveLastContact(state)),
    caseStatus: caseRow.case_status,
    nextRequiredAction: cellText(deriveNextRequiredAction(state)),
  };
}

/** The thirteen cells as display text in the Requirement 16.1 order. */
export function cancellationRowCellValues(cells: CancellationRowCells): string[] {
  return CANCELLATION_ROW_CELL_ORDER.map((key) => cells[key]);
}

// ---------------------------------------------------------------------------
// The primary action (Requirements 17.4, 17.10, 16.9)
// ---------------------------------------------------------------------------

/** The eight steps of Requirement 17.4, labelled as that criterion labels them. */
export type PrimaryActionStep = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h';

export interface PrimaryActionStepDescriptor {
  step: PrimaryActionStep;
  action: NextRequiredAction;
  /** The criterion's own condition, for a reviewer and for a test name. */
  condition: string;
  /** True where Requirement 17.10 hides this step's control from Agent_Role. */
  managerOnly: boolean;
}

/**
 * The eight steps of Requirement 17.4 in order, as data. The eight actions are distinct, so the
 * action a state resolves to identifies the step that produced it (`primaryActionStep`), and this
 * array is the criterion's order written down rather than restated as branches.
 */
export const PRIMARY_ACTION_STEPS = [
  {
    step: 'a',
    action: 'Verify Payment',
    condition: 'Case_Status is Payment Reported or Verification Pending',
    managerOnly: true,
  },
  {
    step: 'b',
    action: 'Confirm Reinstatement',
    condition: 'Case_Status is Reinstatement Pending',
    managerOnly: true,
  },
  {
    step: 'c',
    action: 'Add Contact Information',
    condition: 'zero valid Contact_Recipient rows whose authorization status permits contact',
    managerOnly: false,
  },
  {
    step: 'd',
    action: 'Retry Failed Communication',
    condition: 'Communication_Status is Failed or Partially Failed',
    managerOnly: true,
  },
  {
    step: 'e',
    action: 'Call Customer',
    condition: 'Communication_Status is Manual Follow-up Required',
    managerOnly: false,
  },
  {
    step: 'f',
    action: 'Send Reminder Now',
    condition: 'Case_Status is Imported or Open and no record exists for the current Touchpoint',
    managerOnly: false,
  },
  {
    step: 'g',
    action: 'Mark Resolved',
    condition: 'Case_Status is Reinstated, Cancelled, Invalid, or Duplicate',
    managerOnly: false,
  },
  {
    step: 'h',
    action: 'Record Customer Response',
    condition: 'every remaining case',
    managerOnly: false,
  },
] as const satisfies readonly PrimaryActionStepDescriptor[];

const STEP_BY_ACTION: ReadonlyMap<string, PrimaryActionStep> = new Map<string, PrimaryActionStep>(
  PRIMARY_ACTION_STEPS.map((entry) => [entry.action, entry.step] as const),
);

/**
 * True where a control is shown to a role (Requirement 17.10). The four manager-only controls —
 * Verify Payment, Confirm Reinstatement, Confirm Cancellation, Retry Failed Communication — are
 * hidden from Agent_Role and shown to `manager` and `super_admin` alike; every other control is
 * shown to every role. An absent role reads as the unrestricted Manager_Role view.
 */
export function isActionVisibleToRole(
  action: NextRequiredAction,
  role: AppRole | null | undefined,
): boolean {
  if (!MANAGER_ONLY_ACTION_SET.has(action)) return true;
  return isBroadManagerRole(role ?? 'manager');
}

/** The controls of Requirement 17.3 a role is shown, in the order that criterion lists them. */
export function visibleCancellationActions(role: AppRole | null | undefined): NextRequiredAction[] {
  return NEXT_REQUIRED_ACTIONS.filter((action) => isActionVisibleToRole(action, role));
}

/**
 * The one prominent action of Requirement 17.4: the first of the eight steps that is shown to the
 * signed-in profile under Requirement 17.10 and whose condition holds, or `null` where the next
 * required action has been cleared (Requirement 16.9).
 *
 * Role visibility is applied *first*, per step: a step whose control the caller's role cannot see
 * is skipped and the next step is considered, so an agent looking at a Partially Failed case is
 * offered Call Customer or Send Reminder Now rather than a Retry Failed Communication control
 * that is not on their screen. `super_admin` sees everything `manager` sees.
 *
 * The whole ladder lives in `./domain/communication-status`, which is what makes the list cell of
 * Requirement 16.9 and the drawer's prominent control the same value: there is one
 * implementation, called twice. `viewerRole` overrides the role carried by the state bundle;
 * absent from both, the unrestricted Manager_Role view applies.
 *
 * `null` comes back where the next required action has been cleared, which under Requirement 16.9
 * is a case whose stored `next_required_action` is null *and* whose Case_Status is Reinstated,
 * Cancelled, or Resolved — the three statuses Requirements 19.3, 19.7, and 19.8 clear it in. Such
 * a case does not reach step (g): it has no primary action at all, and the cell reads an em dash.
 * An Invalid or Duplicate case is never cleared, so it does reach step (g).
 */
export function primaryAction(
  state: CancellationRowState,
  viewerRole?: AppRole | null,
): NextRequiredAction | null {
  return deriveNextRequiredAction(viewerRole === undefined ? state : { ...state, viewerRole });
}

/**
 * Which of the eight steps of Requirement 17.4 supplied the primary action, or `null` where the
 * next required action has been cleared. The eight actions are distinct, so this is a lookup over
 * `primaryAction` rather than a second evaluation of the ladder.
 */
export function primaryActionStep(
  state: CancellationRowState,
  viewerRole?: AppRole | null,
): PrimaryActionStep | null {
  const action = primaryAction(state, viewerRole);
  return action === null ? null : STEP_BY_ACTION.get(action) ?? null;
}

// ---------------------------------------------------------------------------
// Communication-record reads used by the filters
// ---------------------------------------------------------------------------

/** True when at least one record of the case carries a delivered result (Requirement 16.8). */
function hasDeliveredRecord(communications: readonly CommunicationRecord[]): boolean {
  return communications.some((row) => row.delivery_result === 'Delivered');
}

/** True when at least one record of the case was sent or delivered (Requirement 16.8). */
function hasSentOrDeliveredRecord(communications: readonly CommunicationRecord[]): boolean {
  return communications.some(
    (row) => row.delivery_result === 'Sent' || row.delivery_result === 'Delivered',
  );
}

/**
 * True when the most recent record of at least one Touchpoint and channel of the case failed
 * (Requirement 16.8).
 *
 * Records are grouped by Touchpoint and channel; within a group the latest parsed `send_time`
 * wins, with stored input order breaking a tie and standing in for an absent or unreadable time,
 * which is the ordering rule Requirement 17.7 fixes for the timeline. `unique (case_id,
 * contact_id, touchpoint, channel)` means a group holds one row per Contact_Recipient, so this
 * answers "did the latest attempt on that Touchpoint and channel fail".
 */
function latestRecordFailed(communications: readonly CommunicationRecord[]): boolean {
  const latest = new Map<string, { row: CommunicationRecord; at: number }>();
  for (const row of communications) {
    const key = `${row.touchpoint}|${row.channel}`;
    const parsed =
      row.send_time === null || row.send_time === undefined ? Number.NaN : Date.parse(row.send_time);
    const at = Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
    const held = latest.get(key);
    if (held === undefined || at >= held.at) latest.set(key, { row, at });
  }
  for (const entry of latest.values()) {
    if (entry.row.delivery_result === 'Failed') return true;
  }
  return false;
}

/**
 * True where a stored follow-up deadline is earlier than or equal to the current business date
 * (Requirement 16.8). Reading 3: the deadline is a `timestamptz` written by clamping at UTC
 * midnight of the effective date, so its UTC calendar date is what compares against the business
 * date.
 */
export function followUpDeadlinePassed(
  caseRow: Pick<CancellationRowCase, 'follow_up_deadline'>,
  businessDate: string | null | undefined,
): boolean {
  const deadline = utcCalendarDate(caseRow.follow_up_deadline);
  const today = utcCalendarDate(businessDate);
  if (deadline === null || today === null) return false;
  return deadline <= today;
}

/**
 * True where at least one Touchpoint of the case has a scheduled send date equal to the current
 * business date (Requirements 16.7, 12.1). Reading 2: the four Touchpoint due dates are the
 * calendar dates 15, 10, 5, and 1 day before the effective date, so this holds exactly when days
 * remaining is one of those four numbers.
 */
export function hasTouchpointDueToday(state: CancellationRowState): boolean {
  const remaining = rowDaysRemaining(state);
  return remaining !== null && TOUCHPOINT_DUE_DAYS.includes(remaining);
}

/**
 * True where the next required action of the case is Verify Payment (Requirement 16.8). Reading
 * 4: both the stored column and the action derived from the unrestricted Manager_Role view are
 * read, so the filter answers a question about the case rather than about the caller's role.
 */
function verifyPaymentRequired(state: CancellationRowState): boolean {
  if (state.case.next_required_action === 'Verify Payment') return true;
  return primaryAction(state, 'manager') === 'Verify Payment';
}

// ---------------------------------------------------------------------------
// Saved filters (Requirements 16.2, 16.7, 16.8)
// ---------------------------------------------------------------------------

/** Days remaining inside the inclusive window 0 through `days` (Requirement 16.7). */
function withinDaysRemaining(state: CancellationRowState, days: number): boolean {
  const remaining = rowDaysRemaining(state);
  return remaining !== null && remaining >= 0 && remaining <= days;
}

/**
 * The Needs Action rule (Requirement 16.8): an active case for which at least one of four
 * conditions holds — a Communication_Status of Partially Failed, Failed, Suppressed, or Manual
 * Follow-up Required; no valid authorized contact detail; one day or less remaining with nothing
 * delivered; or a stored follow-up deadline that has arrived.
 */
function matchesNeedsAction(state: CancellationRowState): boolean {
  const communications = state.communications ?? [];
  if (NEEDS_ACTION_COMMUNICATION_STATUS_SET.has(deriveCaseCommunicationStatus(state))) return true;
  if (!hasContactableContact(state.contacts ?? [])) return true;

  const remaining = rowDaysRemaining(state);
  if (
    remaining !== null &&
    remaining <= NEEDS_ACTION_DAYS_REMAINING &&
    !hasDeliveredRecord(communications)
  ) {
    return true;
  }
  return followUpDeadlinePassed(state.case, state.businessDate);
}

/**
 * Whether one Cancellation_Case matches one saved filter (Requirements 16.7, 16.8).
 *
 * Eight of the fourteen filters are restricted to an *active* case — Case_Status Imported, Open,
 * Payment Reported, Verification Pending, or Reinstatement Pending (Requirement 16.3). The other
 * six are not: Messages Scheduled Today reads Requirement 15.1's two open values, Communication
 * Failed, Payment Verification Required, Reinstatement Pending, and Resolved read Case_Status or
 * Communication_Status directly, and All matches every row.
 *
 * `businessDate` overrides the date carried by the state bundle; absent from both, the four date
 * windows and both date-driven clauses of Needs Action match nothing rather than guessing a date.
 */
export function matchesSavedFilter(
  state: CancellationRowState,
  filterId: CancellationSavedFilterId,
  businessDate?: string | null,
): boolean {
  const row: CancellationRowState = businessDate === undefined ? state : { ...state, businessDate };
  const caseRow = row.case;
  const active = isActiveCancellationCase(caseRow);

  switch (filterId) {
    case 'needs-action':
      return active && matchesNeedsAction(row);
    case 'cancellation-today':
      return active && rowDaysRemaining(row) === 0;
    case 'next-3-days':
      return active && withinDaysRemaining(row, 3);
    case 'next-7-days':
      return active && withinDaysRemaining(row, 7);
    case 'next-15-days':
      return active && withinDaysRemaining(row, 15);
    case 'contact-missing':
      return active && !hasContactableContact(row.contacts ?? []);
    case 'messages-scheduled-today':
      return isOpenCaseStatus(caseRow.case_status) && hasTouchpointDueToday(row);
    case 'communication-failed':
      return (
        COMMUNICATION_FAILED_STATUS_SET.has(deriveCaseCommunicationStatus(row)) ||
        latestRecordFailed(row.communications ?? [])
      );
    case 'customer-responded':
      return active && (row.responses ?? []).length > 0;
    case 'payment-verification-required':
      return PAYMENT_VERIFICATION_CASE_STATUS_SET.has(caseRow.case_status) || verifyPaymentRequired(row);
    case 'reinstatement-pending':
      return caseRow.case_status === 'Reinstatement Pending';
    case 'no-successful-contact':
      return (
        active &&
        !hasSentOrDeliveredRecord(row.communications ?? []) &&
        (row.responses ?? []).length === 0
      );
    case 'resolved':
      return RESOLVED_FILTER_CASE_STATUS_SET.has(caseRow.case_status);
    case 'all':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Search (Requirement 16.4)
// ---------------------------------------------------------------------------

/**
 * The effective search text: the entered text with leading and trailing whitespace removed and
 * truncated to its first 100 characters, lower-cased for comparison (Requirement 16.4). An
 * effective text of zero characters restricts nothing (Requirement 16.3).
 */
export function effectiveSearchText(searchText: string | null | undefined): string {
  return (searchText ?? '').trim().slice(0, MAX_SEARCH_LENGTH).toLowerCase();
}

/**
 * Case-insensitive substring match over customer name, policy number, carrier, Contact_Recipient
 * phone, and Contact_Recipient email (Requirement 16.4).
 *
 * Every contact row of the case is searched, including rows whose validation status is invalid
 * and rows carrying SMS or email suppression: the criterion says so, and a suppressed customer is
 * exactly the one an agent looks up by phone number. Both the stored normalized value and the
 * segment as it appeared in the source file are compared, so a number found in the report reads
 * back.
 *
 * Where the search text carries at least one digit, phone rows are compared again with every
 * non-digit character removed from both values, so `(305) 555-1234`, `305-555-1234`, and
 * `+13055551234` all find the same row. Reading 8: that comparison is added to the substring
 * comparison rather than replacing it.
 */
export function matchesSearch(
  state: Pick<CancellationRowState, 'case' | 'contacts'>,
  searchText: string | null | undefined,
): boolean {
  const needle = effectiveSearchText(searchText);
  if (needle.length === 0) return true;

  const caseRow = state.case;
  const caseValues = [caseRow.customer_name, caseRow.policy_number, caseRow.carrier];
  if (caseValues.some((value) => (value ?? '').toLowerCase().includes(needle))) return true;

  const digits = DIGIT.test(needle) ? digitsOnly(needle) : '';
  for (const contact of state.contacts ?? []) {
    for (const value of [contact.normalized_value, contact.raw_segment]) {
      const text = value ?? '';
      if (text.toLowerCase().includes(needle)) return true;
      if (digits.length > 0 && contact.channel === 'phone' && digitsOnly(text).includes(digits)) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Read scope (Requirement 22)
// ---------------------------------------------------------------------------

/**
 * Whether the signed-in profile may read a Cancellation_Case (Requirements 22.1, 22.3, 22.12).
 *
 * `manager` and `super_admin` read every case (Requirement 22.3). `customer_service` and
 * `sales_supervisor` read every case as well and are limited only on writes (Requirement 22.12).
 * `agent` reads a case assigned to that profile and a case with no assigned employee
 * (Requirement 22.1). A role with no access to the workspace at all reads nothing.
 *
 * This is the user-interface half of the rule. Row level security and the server-side checks of
 * Requirement 22.9 remain the enforcement; nothing here is a substitute for them.
 */
export function canReadCancellationCase(
  viewer: CancellationViewer,
  caseRow: Pick<CancellationRowCase, 'assigned_to'>,
): boolean {
  if (!canAccessRenewals(viewer.role)) return false;
  if (isBroadManagerRole(viewer.role)) return true;
  if (viewer.role !== 'agent') return true;
  const assignedTo = trimToNull(caseRow.assigned_to);
  if (assignedTo === null) return true;
  return assignedTo === trimToNull(viewer.profileId);
}

// ---------------------------------------------------------------------------
// Sort order (Requirement 16.5)
// ---------------------------------------------------------------------------

/**
 * The four sort keys of Requirement 16.5 in order: cancellation effective date ascending, amount
 * due descending with an absent amount ordered after every present amount, customer name
 * ascending without case sensitivity, policy number ascending without case sensitivity. The case
 * id is compared last so the comparator is a total order for any input (reading 7).
 *
 * An unreadable or absent effective date orders after every readable one, the same way an absent
 * amount due does: a row that cannot be placed on the timeline belongs at the end of it.
 */
export function compareCancellationRows(a: CancellationRowState, b: CancellationRowState): number {
  const leftDate = effectiveCalendarDate(a.case);
  const rightDate = effectiveCalendarDate(b.case);
  if (leftDate !== rightDate) {
    if (leftDate === null) return 1;
    if (rightDate === null) return -1;
    return leftDate < rightDate ? -1 : 1;
  }

  const leftAmount = amountDueCents(a.case);
  const rightAmount = amountDueCents(b.case);
  if (leftAmount !== rightAmount) {
    if (leftAmount === null) return 1;
    if (rightAmount === null) return -1;
    return rightAmount - leftAmount;
  }

  const byName = compareTextInsensitive(a.case.customer_name, b.case.customer_name);
  if (byName !== 0) return byName;

  const byPolicy = compareTextInsensitive(a.case.policy_number, b.case.policy_number);
  if (byPolicy !== 0) return byPolicy;

  return compareTextInsensitive(a.case.id, b.case.id);
}

/** The rows in the Requirement 16.5 order, as a new array; the input is left unchanged. */
export function sortCancellationRows(rows: readonly CancellationRowState[]): CancellationRowState[] {
  return [...rows].sort(compareCancellationRows);
}

// ---------------------------------------------------------------------------
// The list (Requirement 16.3) and the filter counts (Requirement 16.2)
// ---------------------------------------------------------------------------

/** The inputs of one list read: the read scope, the one active saved filter, and the search. */
export interface CancellationListQuery {
  filterId?: CancellationSavedFilterId;
  searchText?: string | null;
  businessDate?: string | null;
  viewer?: CancellationViewer | null;
}

/** The rows the signed-in profile may read (Requirements 22.1, 22.3, 22.12). */
export function readableCancellationRows(
  rows: readonly CancellationRowState[],
  viewer: CancellationViewer | null | undefined,
): CancellationRowState[] {
  if (viewer === null || viewer === undefined) return [...rows];
  return rows.filter((row) => canReadCancellationCase(viewer, row.case));
}

/**
 * The cancellation list (Requirement 16.3): the rows the profile may read that satisfy both the
 * matching rule of the active saved filter and the active search text, in the Requirement 16.5
 * order. The saved filter defaults to Needs Action, which is what is active until the user picks
 * another in the session (Requirement 16.2); search text of zero non-whitespace characters
 * restricts nothing.
 */
export function filterCancellationRows(
  rows: readonly CancellationRowState[],
  query: CancellationListQuery = {},
): CancellationRowState[] {
  const filterId = query.filterId ?? DEFAULT_CANCELLATION_FILTER;
  return sortCancellationRows(
    readableCancellationRows(rows, query.viewer).filter(
      (row) =>
        matchesSavedFilter(row, filterId, query.businessDate) && matchesSearch(row, query.searchText),
    ),
  );
}

/**
 * All fourteen saved filter counts (Requirement 16.2). Every count is computed independently of
 * which filter is active, over the rows the profile may read that match the active search text,
 * and one case is counted in every filter whose rule it satisfies.
 */
export function cancellationFilterCounts(
  rows: readonly CancellationRowState[],
  query: Omit<CancellationListQuery, 'filterId'> = {},
): CancellationFilterCounts {
  const counts = {} as CancellationFilterCounts;
  for (const filter of CANCELLATION_SAVED_FILTERS) counts[filter.id] = 0;

  for (const row of readableCancellationRows(rows, query.viewer)) {
    if (!matchesSearch(row, query.searchText)) continue;
    for (const filter of CANCELLATION_SAVED_FILTERS) {
      if (matchesSavedFilter(row, filter.id, query.businessDate)) counts[filter.id] += 1;
    }
  }
  return counts;
}
