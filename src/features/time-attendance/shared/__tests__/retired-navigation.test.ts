// Where a sub-navigation identifier the module no longer offers lands.
//
// Task 24.4 removed the four retired Time & Attendance identifiers from
// `SubNavId` and from the section map. Both places previously named them and both
// had an answer for them; the answer is now reached without either naming them,
// and it has to be the same answer — Requirement 1, criterion 10 asks a stored
// navigation state naming a removed identifier to resolve to the Today screen
// without raising an error.
//
// The cases below do not spell the four removed identifiers, and that is
// deliberate twice over. The reference scan (task 24.1) reports any source file
// that names one, and a test file naming them to prove they are gone would have to
// be exempted from the check that proves it. More to the point, spelling them
// would test nothing extra: neither resolution step has a branch per identifier
// any more. `resolveNavigationForRole` compares a string against the items the
// module actually offers, and `attendanceSectionForSubNav` is a lookup with a
// stated answer for a miss. So the class every removed identifier belongs to —
// a string the Time & Attendance module does not offer — is the whole of what
// there is to cover, and the members below are drawn from it: an identifier live
// on another module, and a string no module has ever declared.
//
// Each case forces in a value the compiler no longer admits, which is exactly
// what a browser holding older state would send. The casts are `SubNavId` casts
// rather than a loosened signature, so the production types stay closed.
//
// The navigation order, per-role visibility, and record-target rules are tasks
// 16.3 and 16.4. This file covers the fallback alone.
//
// Requirements: 1.10

import { describe, expect, it } from 'vitest';

import type { AppRole } from '@/features/nhwd-shared/types';
import type { NavigationState, SubNavId } from '@/components/app-sidebar';
import { getDefaultNavigation, resolveNavigationForRole } from '@/components/app-sidebar';

import { attendanceSectionForSubNav } from '../navigation-target';

/**
 * Identifiers the Time & Attendance module does not offer, which is the class
 * every removed identifier falls into.
 *
 * The first two are live elsewhere, so they also stand for a stored state that
 * named this module and another module's screen. The third is a string no build
 * has ever declared, which is the shape of a stored identifier from a build older
 * than this one.
 */
const NOT_OFFERED = ['sales_desk', 'ua_users', 'ta_screen_that_no_longer_exists'] as const;

/** The identifier and section Today is reached by. */
const TODAY: SubNavId = 'ta_today';
const TODAY_SECTION = 'clock';

/** One role that administers attendance and one that does not. */
const ROLES: readonly AppRole[] = ['super_admin', 'agent'];

const stored = (id: string): SubNavId => id as SubNavId;

function attendanceState(subNav: string): NavigationState {
  return { module: 'time_attendance', subNav: stored(subNav) };
}

describe('a stored attendance state naming an identifier the module does not offer', () => {
  it('resolves to Today for every role, without throwing', () => {
    for (const role of ROLES) {
      for (const subNav of NOT_OFFERED) {
        const resolved = resolveNavigationForRole(role, attendanceState(subNav));

        expect(resolved).toEqual({ module: 'time_attendance', subNav: TODAY });
      }
    }
  });

  it('stays inside the Time & Attendance module rather than falling to the role default', () => {
    // The module is reachable, so the resolution is the module's first sub-item.
    // Falling through to `getDefaultNavigation` would land an agent on the Sales
    // desk, a different module than the one the reader was last in.
    for (const role of ROLES) {
      expect(getDefaultNavigation(role).module).not.toBe('time_attendance');

      for (const subNav of NOT_OFFERED) {
        expect(resolveNavigationForRole(role, attendanceState(subNav)).module).toBe(
          'time_attendance',
        );
      }
    }
  });

  it('drops a record target that named the screen the state named', () => {
    // A target names a record on a screen. That screen is not one the module
    // offers, so the target describes a drawer nobody can open, and carrying it
    // onto Today would open the wrong one.
    const resolved = resolveNavigationForRole('super_admin', {
      module: 'time_attendance',
      subNav: stored('ta_screen_that_no_longer_exists'),
      target: {
        screen: stored('ta_screen_that_no_longer_exists'),
        recordKind: 'attendance_day',
        recordId: 'a3c1f0d2-0000-4000-8000-000000000000:2026-03-11',
        openDrawer: true,
      },
    });

    expect(resolved).toEqual({ module: 'time_attendance', subNav: TODAY });
  });
});

describe('attendanceSectionForSubNav', () => {
  it('answers Today for an identifier it does not own, whatever the caller may administer', () => {
    // The second resolution step. `resolveNavigationForRole` normalises to
    // `ta_today` before this is called, so this is the same answer given again at
    // the point of rendering — a section with no screen behind it cannot become a
    // blank panel.
    for (const canAdminister of [true, false]) {
      for (const subNav of NOT_OFFERED) {
        expect(attendanceSectionForSubNav(stored(subNav), canAdminister)).toBe(TODAY_SECTION);
      }
    }
  });

  it('maps the six offered identifiers to the six sections that have a screen', () => {
    expect(attendanceSectionForSubNav('ta_today', true)).toBe('clock');
    expect(attendanceSectionForSubNav('ta_schedule', true)).toBe('schedule');
    expect(attendanceSectionForSubNav('ta_timeoff', true)).toBe('pto');
    expect(attendanceSectionForSubNav('ta_review', true)).toBe('reports');
    expect(attendanceSectionForSubNav('ta_payroll', true)).toBe('payroll');
    expect(attendanceSectionForSubNav('ta_workforce', true)).toBe('workforce');
  });

  it('sends the three administrator sections to Today for a caller who is not one', () => {
    expect(attendanceSectionForSubNav('ta_review', false)).toBe(TODAY_SECTION);
    expect(attendanceSectionForSubNav('ta_payroll', false)).toBe(TODAY_SECTION);
    expect(attendanceSectionForSubNav('ta_workforce', false)).toBe(TODAY_SECTION);
  });
});
