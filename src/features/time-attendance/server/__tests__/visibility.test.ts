// Example tests for the permission and visibility seams.
//
// Feature: time-attendance-ui-redesign, task 2.3
//
// Trimmed when Property 36 (`permission-decision-table.test.ts`) was written in
// task 2.4. The per-role sweeps that used to live here — accepted roles across
// `APP_ROLES`, the two predicates agreeing for every role, agreement with the
// `attendanceAdministration` surface, and the scope for every non-administrator
// role — are the universal statement, and Property 36 makes it across every
// role, capability, and actor-to-target pairing. Repeating them here would mean
// two places to edit when the boundary moves.
//
// What is left is the concrete boundary, named as three fixed examples: the one
// role that administers attendance, the one role most likely to be widened into
// it by accident, and the ordinary employee. A reader who wants to know what
// this module answers can read these five lines instead of a generator.
//
// Requirements: 21.1, 21.2, 21.11, 21.12

import { describe, expect, it } from 'vitest';
import {
  canAdministerAttendance,
  canReviewTeamAttendance,
  visibleProfileIds,
} from '../visibility';
import type { Actor } from '../visibility';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';

const SUPER_ADMIN: Actor = { id: ACTOR_ID, role: 'super_admin' };
const MANAGER: Actor = { id: ACTOR_ID, role: 'manager' };
const AGENT: Actor = { id: ACTOR_ID, role: 'agent' };

describe('the attendance administration boundary', () => {
  it('admits super_admin', () => {
    expect(canAdministerAttendance('super_admin')).toBe(true);
    expect(canReviewTeamAttendance('super_admin')).toBe(true);
  });

  it('withholds attendance administration from manager', () => {
    // Requirement 21, criterion 12. Pay, payroll, clock corrections, time-off
    // approvals, and schedules are super-admin exclusive, so the broad manager
    // role must not satisfy these checks even though it satisfies the general
    // management checks in `lib/permissions.ts`.
    expect(canAdministerAttendance('manager')).toBe(false);
    expect(canReviewTeamAttendance('manager')).toBe(false);
  });

  it('withholds it from an ordinary employee', () => {
    expect(canAdministerAttendance('agent')).toBe(false);
    expect(canReviewTeamAttendance('agent')).toBe(false);
  });
});

describe('visibleProfileIds', () => {
  it('resolves an administrator to every employee', async () => {
    // `'all'` is a statement that no profile filter belongs on the query, which
    // is what keeps an administrator read set-based (Requirement 21.2).
    await expect(visibleProfileIds(SUPER_ADMIN)).resolves.toBe('all');
  });

  it('resolves a manager and an employee to themselves alone', async () => {
    await expect(visibleProfileIds(MANAGER)).resolves.toEqual([ACTOR_ID]);
    await expect(visibleProfileIds(AGENT)).resolves.toEqual([ACTOR_ID]);
  });
});
