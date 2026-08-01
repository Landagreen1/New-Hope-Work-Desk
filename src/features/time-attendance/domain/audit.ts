// src/features/time-attendance/domain/audit.ts
// The vocabulary of the attendance audit trail, and the shape of one query over
// it.
//
// `attendance_audit_log` is written by four paths — `attendance_apply_correction`,
// `attendance_mark_reviewed`, `pto_decide`, and the `v1.9.1` repair step — and read
// by one, the Audit Log view. Requirement 16, criterion 4 gives that view filters
// for employee, work date range, action, and actor, and three of those four filter
// on a value that has to be spelled the same way in three places: the migration
// that writes it, the parser that accepts it, and the control that offers it.
// `action` is the one with a closed vocabulary, so it is written here once and the
// other two read it.
//
// This module holds no rule. It is the audit trail's vocabulary and its query
// shape, in the same relation to `/api/attendance/audit` that `RecordQuery` and
// `SAVED_FILTERS` in `domain/attendance.ts` are to `/api/attendance/records`:
//
//   - the shape and the accepted values here, pure and importable by both sides,
//   - `shared/audit-query.ts` turning a query into a query string,
//   - `parseAuditQuery` in `server/request-query.ts` turning one back.
//
// ## Why the action list is not read off the audit rows
//
// A filter control could be built from the distinct actions the current page
// happens to contain, and it would be wrong in the one case that matters: an
// administrator looking for a coverage override would find no such option on a
// page that holds none, and would conclude none was ever recorded. The vocabulary
// is what the module can write, not what this page happens to hold.
//
// Pure: no React, no I/O, no `Date.now()`.
//
// Requirements: 16.2 (the recorded fields), 16.3 (the view displays them),
// 16.4 (the four filters), 16.7 (pages of at most 100 entries)

// ─── Actions ─────────────────────────────────────────────────────────────────

/**
 * The `attendance_audit_log.action` values the module records.
 *
 * The five Requirement 16, criterion 1 names — an attendance correction, a
 * time-off decision, a coverage override, a review status change, and a payroll
 * processing event — expanded to the actions the mutation functions actually
 * write, because "attendance correction" is three distinguishable events and a
 * reader looking for a punch that was *added* should not have to read every punch
 * that was *changed*.
 *
 * `coverage_override` and `payroll_process` are in the vocabulary ahead of their
 * writers, the same way `types.ts` named the three new request statuses ahead of
 * the `v1.9.3` constraint: a filter that cannot be offered until the day its
 * first row is written is a filter an administrator discovers is missing at the
 * worst moment. Neither is written to this table today — payroll processing still
 * writes `public.audit_log` — so both correctly return nothing.
 */
export type AuditAction =
  | 'correct_punch'
  | 'add_punch'
  | 'add_note'
  | 'approve_unscheduled'
  | 'mark_reviewed'
  | 'pto_decision'
  | 'coverage_override'
  | 'payroll_process';

/** One action: what it is called, and what it records. */
export interface AuditActionDefinition {
  id: AuditAction;
  label: string;
  /** Plain language, shown as visible text under the filter rather than a title. */
  description: string;
}

/**
 * The action table, in the order the Audit Log view offers them: the correction
 * actions first, because they are what a reviewer traces most often, then the
 * review stamp, then the decisions and the two events written elsewhere.
 *
 * Requirements: 16.1, 16.4
 */
export const AUDIT_ACTIONS: readonly AuditActionDefinition[] = [
  {
    id: 'correct_punch',
    label: 'Punch corrected',
    description: 'An existing clock or break instant, or a stored minute count, was changed.',
  },
  {
    id: 'add_punch',
    label: 'Punch added',
    description: 'A clock or break value the employee never recorded was supplied.',
  },
  {
    id: 'add_note',
    label: 'Manager note added',
    description: 'A note was recorded against an employee and work date.',
  },
  {
    id: 'approve_unscheduled',
    label: 'Unscheduled work approved',
    description: 'Work on a date carrying no published schedule was approved, releasing payroll.',
  },
  {
    id: 'mark_reviewed',
    label: 'Marked reviewed',
    description: 'An employee and work date was marked reviewed. The first stamp stands.',
  },
  {
    id: 'pto_decision',
    label: 'Time-off decision',
    description: 'A time-off request changed status, with any balance movement it carried.',
  },
  {
    id: 'coverage_override',
    label: 'Coverage override',
    description:
      'An approval was committed over a staffing shortfall with a stated override reason.',
  },
  {
    id: 'payroll_process',
    label: 'Payroll processed',
    description: 'A payroll period was calculated, persisted, and locked.',
  },
];

/** The action identifiers, in `AUDIT_ACTIONS` order. */
export const AUDIT_ACTION_IDS: readonly AuditAction[] = AUDIT_ACTIONS.map(
  (action) => action.id,
);

const ACTION_BY_ID: ReadonlyMap<string, AuditActionDefinition> = new Map(
  AUDIT_ACTIONS.map((action) => [action.id, action]),
);

/** True when a string names one of the recorded actions. */
export function isAuditAction(value: string): value is AuditAction {
  return ACTION_BY_ID.has(value);
}

/** One action's definition, or undefined for a value outside the table. */
export function auditAction(id: string): AuditActionDefinition | undefined {
  return ACTION_BY_ID.get(id);
}

// ─── Entity types ────────────────────────────────────────────────────────────

/**
 * The `attendance_audit_log.entity_type` values the table documents.
 *
 * Not a filter — Requirement 16, criterion 4 names four and this is not one of
 * them — but it is half of "field or object changed" in criterion 2, so the view
 * has to be able to say `Clock entry` rather than `clock_entry`.
 */
export type AuditEntityType =
  | 'clock_entry'
  | 'break'
  | 'note'
  | 'schedule'
  | 'pto_request'
  | 'review'
  | 'payroll_period';

/** What each entity type is called on screen. */
export const AUDIT_ENTITY_LABELS: Record<AuditEntityType, string> = {
  clock_entry: 'Clock entry',
  break: 'Break',
  note: 'Manager note',
  schedule: 'Schedule',
  pto_request: 'Time-off request',
  review: 'Day review',
  payroll_period: 'Payroll period',
};

/**
 * An entity type as the view names it.
 *
 * A value outside the table is shown as given rather than as "unknown": the row
 * exists and the column is what the row records, so hiding an unrecognised value
 * would hide the entry's own subject.
 */
export function auditEntityLabel(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return AUDIT_ENTITY_LABELS[value as AuditEntityType] ?? value;
}

// ─── The query ───────────────────────────────────────────────────────────────

/**
 * One query over the audit trail: the four filters of Requirement 16, criterion
 * 4, plus the page.
 *
 * Every field is a conjunct, and an absent field is an absent key rather than
 * `undefined` on the object, matching `RecordQuery`. A work-date range excludes
 * entries carrying no work date, because an entry with no date does not fall
 * inside one — the payroll processing event is the case that arises, and it is
 * found by filtering on its action instead.
 *
 * Requirements: 16.4, 16.7
 */
export interface AuditQuery {
  /** Inclusive lower bound on the affected work date, `YYYY-MM-DD`. */
  from?: string;
  /** Inclusive upper bound on the affected work date, `YYYY-MM-DD`. */
  to?: string;
  /** The affected employees. */
  profileIds?: readonly string[];
  /** The recorded actions. */
  actions?: readonly AuditAction[];
  /** The employees who performed the recorded actions. */
  actorProfileIds?: readonly string[];
  /** 1-based. */
  page?: number;
  /** Entries per page. Capped by the service at 100 (Requirement 16, criterion 7). */
  limit?: number;
}
