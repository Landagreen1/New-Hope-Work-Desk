/**
 * Named capabilities for the quote lifecycle.
 *
 * The rest of the app tests role names inline (`role === 'manager' || ...`),
 * which is how the walk-in gate and the note role list ended up disagreeing with
 * each other. These helpers give each capability one definition, so a change is
 * made once and the reasoning is written down next to it.
 *
 * Every one of these mirrors a database check. The client helpers decide what to
 * render; the database decides what is allowed. A user who defeats the UI still
 * hits `can_view_quote_center()`, `can_edit_cs_intake()`, `add_quote_note()` or
 * `cs_intake_add_note()`, all of which re-derive the same answer server-side.
 */

import type { AppRole } from '@/lib/types';
import {
  canManageCustomerService,
  canManageSales,
  isBroadManagerRole,
} from '@/lib/permissions';

/**
 * The roles that can access Quote Center.
 *
 * Commercial roles were added so they can look up customer quote journeys when
 * supporting customers, even though their primary workflow remains the
 * Commercial Board.
 */
const QUOTE_ROLES: readonly AppRole[] = [
  'agent',
  'customer_service',
  'commercial',
  'commercial_supervisor',
  'sales_supervisor',
  'customer_service_supervisor',
  'manager',
  'super_admin',
];

function isQuoteRole(role: AppRole): boolean {
  return QUOTE_ROLES.includes(role);
}

/**
 * Can open Quote Center at all.
 *
 * Mirrors `public.can_view_quote_center()`.
 */
export function viewQuoteCenter(role: AppRole): boolean {
  return isQuoteRole(role);
}

/**
 * Can start a new intake.
 *
 * Commercial roles keep this: they create their own commercial intakes through
 * the Customer Service module, which is unchanged.
 */
export function createIntake(role: AppRole): boolean {
  return isQuoteRole(role) || role === 'commercial' || role === 'commercial_supervisor';
}

/**
 * Can open and continue somebody else's unfinished draft.
 *
 * This is the shared-draft rule: an unfinished intake is company work, so any
 * quote-related employee may finish it. Mirrors the `draft`/`returned` grant in
 * `public.can_edit_cs_intake()`.
 */
export function editSharedDraft(role: AppRole): boolean {
  return isQuoteRole(role);
}

/**
 * Can add a note to any intake or quote, owned or not.
 *
 * Ownership governs who is responsible for working the quote. It must never
 * govern whether a conversation can be written down — that is how customer
 * history gets lost. Mirrors the role lists in `add_quote_note()` and
 * `cs_intake_add_note()`.
 */
export function addQuoteNote(role: AppRole): boolean {
  return isQuoteRole(role);
}

/**
 * Can take submitted intake work from the queue.
 *
 * Being able to *see* an available intake in Quote Center is not permission to
 * take it: the RingCentral turn, walk-in authorisation and claim eligibility are
 * all still decided by the existing RPCs. This only decides whether a Take action
 * is worth showing.
 */
export function takeIntakeWork(role: AppRole): boolean {
  return role === 'agent' || role === 'sales_supervisor' || isBroadManagerRole(role);
}

/** Can reassign a quote or assign an intake to a specific agent. */
export function manageQuoteAssignments(role: AppRole): boolean {
  return canManageSales(role) || canManageCustomerService(role);
}

/** Can delete, void, or resolve duplicates on quote records. */
export function manageQuoteRecords(role: AppRole): boolean {
  return canManageSales(role);
}

/** Can see agency-wide sales reporting rather than only personal performance. */
export function viewSalesReporting(role: AppRole): boolean {
  return canManageSales(role);
}

/** Everything a Quote Center screen needs to decide what to render. */
export interface QuoteCenterPermissions {
  viewQuoteCenter: boolean;
  createIntake: boolean;
  editSharedDraft: boolean;
  addQuoteNote: boolean;
  takeIntakeWork: boolean;
  manageQuoteAssignments: boolean;
  manageQuoteRecords: boolean;
  viewSalesReporting: boolean;
}

export function getQuoteCenterPermissions(role: AppRole): QuoteCenterPermissions {
  return {
    viewQuoteCenter: viewQuoteCenter(role),
    createIntake: createIntake(role),
    editSharedDraft: editSharedDraft(role),
    addQuoteNote: addQuoteNote(role),
    takeIntakeWork: takeIntakeWork(role),
    manageQuoteAssignments: manageQuoteAssignments(role),
    manageQuoteRecords: manageQuoteRecords(role),
    viewSalesReporting: viewSalesReporting(role),
  };
}
