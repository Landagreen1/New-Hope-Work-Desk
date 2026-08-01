// src/features/time-attendance/server/__tests__/permission-decision-table.test.ts
// Property test for the permission surface: one decision table, every role,
// every capability, every actor-to-target pairing.
//
// The table below is the specification, transcribed from Requirement 21 and from
// the four screen criteria that name a permission (5.21, 7.11, 8.13, 11.11,
// 15.9, 17.8). Each row carries two functions: `decide`, which answers using
// only the predicates `server/visibility.ts` exports, and `specified`, which
// answers from the role class the criteria name. The property is that the two
// agree for every generated request.
//
// What that does and does not prove is worth stating plainly. Because every
// attendance capability is decided by the same three exports, the table reduces
// to a small number of claims about those exports — it is not fourteen
// independent implementations being checked. Its value is that each capability
// is named against its criterion, so widening any one of them has to be a
// deliberate edit to this table rather than a quiet change to a predicate that
// nine screens happen to share. When the routes and services are written they
// consult these same predicates, which is what keeps the table honest.
//
// Two clauses are not table-shaped and are the ones most likely to rot:
//
//   Parity (Requirement 21, criterion 11). The exported predicates are
//   enumerated from the module objects rather than listed by hand, and each one
//   is checked for `manager` implying `super_admin`. A predicate added to
//   `lib/permissions.ts` next year is covered by this test without an edit,
//   which is the only way a rule about "every check in the codebase" can be
//   held by a test at all.
//
//   Reserved capabilities (Requirement 21, criterion 12). The six capabilities
//   the criterion reserves — pay rates, hourly pay, payroll settings,
//   clock-entry corrections, time-off approvals, and work schedules — are marked
//   `reserved` in the table, and no reserved row may answer true for `manager`.
//
// "No change recorded" (criterion 15) is asserted here as the decision half:
// every capability aimed at an employee outside the actor's visible set is
// refused. That nothing is written when a decision refuses is enforced where
// the writes are — the mutation functions (Properties 23 and 34) and the row
// level security policies (the stage-1 integration test in this directory).
//
// The shared absence calendar grant of criteria 8.13 and 11.11 is generated as
// an input rather than read from a role, because that is what the criteria
// describe: a grant that widens absence visibility for a role that is not an
// administrator. No such grant exists in the schema yet, and the table pins the
// shape it has to take when it arrives — an additional input to the decision,
// never a role gaining attendance administration.
//
// Feature: time-attendance-ui-redesign, Property 36: Permission decision table
// **Validates: Requirements 5.21, 7.11, 8.13, 11.11, 15.9, 17.8, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.7, 21.8, 21.11, 21.12, 21.15**

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as permissionsModule from '@/lib/permissions';
import { APP_ROLES, getRolePermissions } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import * as visibilityModule from '../visibility';
import {
  canAdministerAttendance,
  canReviewTeamAttendance,
  visibleProfileIds,
} from '../visibility';
import type { Actor } from '../visibility';
import { roleArb } from '../../domain/__tests__/arbitraries';

// ─── The specification side of the table ─────────────────────────────────────

/**
 * The roles the specification calls Attendance_Administrator.
 *
 * Transcribed, not imported: Requirement 21, criterion 12 reserves pay,
 * payroll, clock corrections, time-off approvals, and schedules to
 * `super_admin` and withholds them from `manager`, and the design's Permissions
 * model resolves Attendance_Administrator to `super_admin` throughout. Asking
 * `canAdministerAttendance` who the administrators are would make the whole
 * table agree with itself by construction.
 */
const ADMINISTRATOR_ROLES: readonly AppRole[] = ['super_admin'];

function specifiesAdministrator(role: AppRole): boolean {
  return ADMINISTRATOR_ROLES.includes(role);
}

/** What `visibleProfileIds` answers: every employee, or an explicit list. */
type Scope = string[] | 'all';

function scopeIncludes(scope: Scope, profileId: string): boolean {
  return scope === 'all' || scope.includes(profileId);
}

/**
 * One authorisation question: who is asking, about whom, and whether the shared
 * absence calendar grant of criteria 8.13 and 11.11 is in force.
 */
interface AttendanceRequest {
  actor: Actor;
  /** The employee whose data the request would read or change. */
  targetProfileId: string;
  sharedAbsenceCalendarGrant: boolean;
}

interface Capability {
  key: string;
  /** The acceptance criteria this row transcribes. */
  requirements: string;
  /** True when Requirement 21, criterion 12 reserves it to `super_admin`. */
  reserved: boolean;
  /** True when the row's answer depends on which employee is targeted. */
  targetScoped: boolean;
  /** The module's answer, composed only from the exported seam. */
  decide: (request: AttendanceRequest, scope: Scope) => boolean;
  /** The specification's answer, from the role class the criteria name. */
  specified: (request: AttendanceRequest) => boolean;
}

/** Reads and writes an administrator performs, and nobody else. */
function administratorOnly(
  key: string,
  requirements: string,
  reserved: boolean,
): Capability {
  return {
    key,
    requirements,
    reserved,
    targetScoped: false,
    decide: (request) => canAdministerAttendance(request.actor.role),
    specified: (request) => specifiesAdministrator(request.actor.role),
  };
}

/**
 * A decision an administrator takes about somebody else. Criteria 21.7 and 21.8
 * reject the self-pairing: nobody decides their own request and nobody clears an
 * exception recorded against themselves, whatever their role.
 */
function administratorAboutAnother(key: string, requirements: string, reserved: boolean): Capability {
  return {
    key,
    requirements,
    reserved,
    targetScoped: true,
    decide: (request) =>
      canAdministerAttendance(request.actor.role) &&
      request.targetProfileId !== request.actor.id,
    specified: (request) =>
      specifiesAdministrator(request.actor.role) &&
      request.targetProfileId !== request.actor.id,
  };
}

/**
 * The decision table. Every capability the validated criteria name, each with
 * the criterion it comes from.
 */
const CAPABILITIES: readonly Capability[] = [
  // ── Reads and scope (21.1, 21.2, and the four screens that scope by them)
  {
    key: 'read_own_attendance',
    requirements: '21.1',
    reserved: false,
    targetScoped: false,
    decide: (request, scope) => scopeIncludes(scope, request.actor.id),
    // Every employee reads their own attendance, including an administrator.
    specified: () => true,
  },
  {
    key: 'read_target_attendance',
    requirements: '21.1, 21.2, 21.15',
    reserved: false,
    targetScoped: true,
    decide: (request, scope) => scopeIncludes(scope, request.targetProfileId),
    specified: (request) =>
      specifiesAdministrator(request.actor.role) ||
      request.targetProfileId === request.actor.id,
  },
  administratorOnly('review_team_today', '5.21', false),
  administratorOnly('review_all_time_off_requests', '7.11', false),
  administratorOnly('review_all_inbox_items', '17.8', false),

  // ── The six capabilities Requirement 21, criterion 12 reserves
  administratorOnly('manage_pay_rates', '21.6, 21.12', true),
  administratorOnly('manage_hourly_pay', '21.6, 21.12', true),
  administratorOnly('manage_payroll_settings', '21.6, 21.12', true),
  administratorAboutAnother('correct_clock_entry', '21.4, 21.12', true),
  administratorAboutAnother('decide_time_off_request', '21.3, 21.7, 21.12', true),
  administratorOnly('manage_work_schedules', '21.5, 21.12', true),

  // ── Exception resolution: administrator, and never about oneself
  administratorAboutAnother('resolve_attendance_exception', '21.8', false),

  // ── Export pay columns (15.9), which are pay figures and therefore reserved
  administratorOnly('export_pay_columns', '15.9, 21.12', true),

  // ── The shared absence calendar grant (8.13, 11.11)
  {
    key: 'view_other_approved_absences',
    requirements: '11.11',
    reserved: false,
    targetScoped: false,
    decide: (request) =>
      canAdministerAttendance(request.actor.role) || request.sharedAbsenceCalendarGrant,
    specified: (request) =>
      specifiesAdministrator(request.actor.role) || request.sharedAbsenceCalendarGrant,
  },
  {
    key: 'include_absence_employee_names',
    requirements: '8.13',
    reserved: false,
    targetScoped: false,
    decide: (request) =>
      canAdministerAttendance(request.actor.role) || request.sharedAbsenceCalendarGrant,
    specified: (request) =>
      specifiesAdministrator(request.actor.role) || request.sharedAbsenceCalendarGrant,
  },
];

const RESERVED_CAPABILITIES = CAPABILITIES.filter((capability) => capability.reserved);

// ─── The predicate surface, enumerated rather than listed ────────────────────

type RolePredicate = (role: AppRole) => boolean;

/**
 * Every exported function of the two permission modules that answers a boolean
 * for every role.
 *
 * Enumerated from the module objects so that a predicate added later is checked
 * for the `manager` to `super_admin` parity of Requirement 21, criterion 11
 * without anybody remembering to add it here. Label and mapping exports are
 * filtered out by the boolean test rather than by name, and `visibleProfileIds`
 * falls out too because it answers a promise.
 */
function exportedRolePredicates(): { name: string; predicate: RolePredicate }[] {
  const modules: readonly { label: string; exports: Record<string, unknown> }[] = [
    { label: 'lib/permissions', exports: permissionsModule as Record<string, unknown> },
    { label: 'server/visibility', exports: visibilityModule as Record<string, unknown> },
  ];

  const found: { name: string; predicate: RolePredicate }[] = [];
  const seen = new Set<unknown>();

  for (const { label, exports } of modules) {
    for (const [name, value] of Object.entries(exports)) {
      if (typeof value !== 'function' || value.length !== 1) continue;
      if (seen.has(value)) continue;

      const candidate = value as (role: AppRole) => unknown;
      let answersBooleanForEveryRole: boolean;
      try {
        // A function that raises for a valid role is not a permission
        // predicate, so it is skipped rather than reported as one.
        answersBooleanForEveryRole = APP_ROLES.every(
          (role) => typeof candidate(role) === 'boolean',
        );
      } catch {
        continue;
      }
      if (!answersBooleanForEveryRole) continue;

      seen.add(value);
      found.push({ name: `${label}.${name}`, predicate: value as RolePredicate });
    }
  }

  return found;
}

// ─── Generators ──────────────────────────────────────────────────────────────

const profileIdArb = fc.uuid();

/**
 * A request. The target is the actor itself about a third of the time, because
 * the self-pairing is where criteria 21.7 and 21.8 live and a pair of
 * independent uuids would never collide.
 */
const requestArb: fc.Arbitrary<AttendanceRequest> = fc
  .record({
    role: roleArb,
    actorId: profileIdArb,
    otherId: profileIdArb,
    targetsSelf: fc.oneof(
      { weight: 1, arbitrary: fc.constant(true) },
      { weight: 2, arbitrary: fc.constant(false) },
    ),
    sharedAbsenceCalendarGrant: fc.boolean(),
  })
  .map(({ role, actorId, otherId, targetsSelf, sharedAbsenceCalendarGrant }) => ({
    actor: { id: actorId, role },
    targetProfileId: targetsSelf ? actorId : otherId,
    sharedAbsenceCalendarGrant,
  }));

const capabilityArb: fc.Arbitrary<Capability> = fc.constantFrom(...CAPABILITIES);

// ─── The property ────────────────────────────────────────────────────────────

describe('PBT-36: Permission decision table', () => {
  it('answers the specification table for every role, capability, and actor-to-target pairing, refuses out-of-scope requests, and keeps manager out of every super-admin capability', async () => {
    const rolesSeen = new Set<AppRole>();
    let administratorCases = 0;
    let employeeCases = 0;
    let selfPairings = 0;
    let crossPairings = 0;
    let grantedCases = 0;
    let refusedCases = 0;

    await fc.assert(
      fc.asyncProperty(requestArb, capabilityArb, async (request, capability) => {
        const { role } = request.actor;
        const scope = await visibleProfileIds(request.actor);

        // 1. The decision equals the specification table.
        const decided = capability.decide(request, scope);
        expect(decided).toBe(capability.specified(request));

        // 2. A capability Requirement 21, criterion 12 reserves is never
        //    answered true for `manager`, whatever the pairing.
        if (capability.reserved) {
          expect(
            capability.decide({ ...request, actor: { ...request.actor, role: 'manager' } }, [
              request.actor.id,
            ]),
          ).toBe(false);
        }

        // 3. Out-of-scope refusal (criterion 15): an employee the actor may not
        //    see yields no capability at all about that employee.
        const targetVisible = scopeIncludes(scope, request.targetProfileId);
        if (!targetVisible && capability.targetScoped) {
          expect(decided).toBe(false);
        }

        // 4. The scope itself: organisation-wide for an administrator, the
        //    signed-in employee alone otherwise (criteria 1 and 2), and never a
        //    set that reaches another employee without administration.
        if (specifiesAdministrator(role)) {
          expect(scope).toBe('all');
        } else {
          expect(scope).toEqual([request.actor.id]);
          expect(scopeIncludes(scope, request.actor.id)).toBe(true);
          if (request.targetProfileId !== request.actor.id) {
            expect(targetVisible).toBe(false);
          }
        }

        // 5. The two seam predicates and the permission surface cannot disagree
        //    about a role, which is what makes one table serve the sidebar, the
        //    routes, and the policies.
        expect(canAdministerAttendance(role)).toBe(specifiesAdministrator(role));
        expect(canReviewTeamAttendance(role)).toBe(specifiesAdministrator(role));
        expect(getRolePermissions(role).attendanceAdministration).toBe(
          canAdministerAttendance(role),
        );

        rolesSeen.add(role);
        if (specifiesAdministrator(role)) administratorCases += 1;
        else employeeCases += 1;
        if (request.targetProfileId === request.actor.id) selfPairings += 1;
        else crossPairings += 1;
        if (decided) grantedCases += 1;
        else refusedCases += 1;
      }),
      { numRuns: 300 },
    );

    // 6. Parity, criterion 11: for every exported predicate, accepting
    //    `manager` implies accepting `super_admin`. Enumerated, so a predicate
    //    added after this test was written is covered by it.
    const predicates = exportedRolePredicates();
    expect(predicates.length).toBeGreaterThanOrEqual(12);
    for (const { name, predicate } of predicates) {
      if (predicate('manager')) {
        expect(predicate('super_admin'), `${name} accepts manager but not super_admin`).toBe(true);
      }
    }

    // 7. And the other direction of criterion 12: no predicate that decides a
    //    reserved capability accepts `manager`, for any pairing of ids.
    for (const capability of RESERVED_CAPABILITIES) {
      const managerActor: Actor = { id: 'a', role: 'manager' };
      for (const targetProfileId of ['a', 'b']) {
        for (const sharedAbsenceCalendarGrant of [false, true]) {
          expect(
            capability.decide(
              { actor: managerActor, targetProfileId, sharedAbsenceCalendarGrant },
              ['a'],
            ),
            `${capability.key} (Requirements ${capability.requirements}) grants manager`,
          ).toBe(false);
        }
      }
    }

    // Guards against a vacuous pass: every role, both role classes, both
    // pairings, and both outcomes have to have been exercised.
    expect([...rolesSeen].sort()).toEqual([...APP_ROLES].sort());
    expect(administratorCases).toBeGreaterThan(0);
    expect(employeeCases).toBeGreaterThan(0);
    expect(selfPairings).toBeGreaterThan(0);
    expect(crossPairings).toBeGreaterThan(0);
    expect(grantedCases).toBeGreaterThan(0);
    expect(refusedCases).toBeGreaterThan(0);

    // And that the reserved set is the one criterion 12 names, so a row cannot
    // go missing and leave its capability silently unreserved.
    expect(RESERVED_CAPABILITIES.map((capability) => capability.key).sort()).toEqual([
      'correct_clock_entry',
      'decide_time_off_request',
      'export_pay_columns',
      'manage_hourly_pay',
      'manage_pay_rates',
      'manage_payroll_settings',
      'manage_work_schedules',
    ]);
  });
});
