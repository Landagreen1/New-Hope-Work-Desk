// src/features/time-attendance/server/visibility.ts
// The permission and visibility seams for the Time & Attendance module.
//
// Three exports, and every attendance read or write goes through them:
//
//   canAdministerAttendance  may this role administer attendance at all
//   canReviewTeamAttendance  may this role read attendance beyond its own
//   visibleProfileIds        which employees this actor may see
//
// The module holds no decision table of its own. `canAdministerAttendance` is
// re-exported unchanged from `src/lib/permissions.ts`, which is the single
// place a role-to-capability answer is written, so this file cannot drift from
// the sidebar, the API routes, or the row level security policies.
//
// ## Why the two predicates are separate
//
// They return the same answer today. They exist as two functions because they
// answer two different questions, and Appendix B, Open Question 1 (whether
// `manager` gains read-only team attendance) moves exactly one of them. The
// design's position is Preserve: Attendance_Administrator is `super_admin`
// only, matching `v1.6.2-enforce-scoped-supervisor-access.sql` and the
// workspace rule that pay, payroll, clock corrections, time-off approvals, and
// schedules are super-admin exclusive. `manager` gains nothing here.
//
// If that question later resolves the other way, `canReviewTeamAttendance`
// changes and a forward-only migration adds `manager` to the four select
// policies. `canAdministerAttendance` does not move, no screen changes, and no
// mutation path widens.
//
// `visibleProfileIds` is the matching seam for Open Question 6 (administrator
// visibility scope). It is organisation-wide today because `profiles` carries
// no manager-to-team relationship to scope by. It is declared async so that
// introducing a scoping query later is not a signature change rippling through
// every service.
//
// Requirements: 21.1 (an employee sees only their own attendance data),
// 21.2 (an administrator sees every employee they are authorised to review),
// 21.11 (a `manager` check also accepts `super_admin`),
// 21.12 (the capabilities reserved to `super_admin` stay reserved).

import { canAdministerAttendance } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

/**
 * The signed-in user, as every attendance service and route sees them.
 *
 * Resolved once per request from the session and the `profiles` row, then
 * passed down. No service reads the session itself, so a service call is
 * always explicit about whose authority it runs under.
 */
export interface Actor {
  /** `profiles.id`, which is also the auth user id. */
  id: string;
  role: AppRole;
}

/**
 * Whether this role administers attendance: corrections, time-off decisions,
 * schedules, pay, payroll, and the review surfaces.
 *
 * Re-exported unchanged from `src/lib/permissions.ts`. `super_admin` only.
 * Requirement 21, criterion 12 is why `manager` is excluded, and Requirement
 * 21, criterion 11 is satisfied by construction: no check in this module reads
 * the role `manager` at all.
 *
 * Requirements: 21.11, 21.12
 */
export { canAdministerAttendance };

/**
 * Whether this role may read attendance data for employees other than itself.
 *
 * Equal to `canAdministerAttendance` today, and deliberately not written as a
 * second copy of that rule: the delegation is what makes the two impossible to
 * disagree. This is the only predicate the read endpoints consult before
 * widening a query beyond the signed-in employee.
 *
 * Requirements: 21.1, 21.2
 */
export function canReviewTeamAttendance(role: AppRole): boolean {
  return canAdministerAttendance(role);
}

/**
 * The employees an actor may see, as `'all'` or an explicit list.
 *
 * `'all'` is not a wildcard the caller expands; it is a statement that no
 * profile filter belongs on the query, which is what keeps an administrator
 * read to a fixed number of set-based queries instead of one per employee.
 * A non-administrator gets exactly their own id, which is Requirement 21,
 * criterion 1.
 *
 * Every attendance read resolves its scope here and nowhere else, so adding a
 * team or department restriction later is one edit to this function.
 *
 * Requirements: 21.1, 21.2
 */
export async function visibleProfileIds(actor: Actor): Promise<string[] | 'all'> {
  return canReviewTeamAttendance(actor.role) ? 'all' : [actor.id];
}
