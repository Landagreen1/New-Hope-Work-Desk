// src/features/time-attendance/shared/navigation-target.ts
// Which Time & Attendance screen owns a navigation target, and whether that
// target can be opened at all.
//
// A `NavigationTarget` names a screen, a record, and whether to open that
// record's detail drawer. It exists because the Needs Attention inbox lists
// items belonging to four different screens, and selecting one has to land on
// the owning screen with that record open (Requirement 17, criterion 6).
//
// This module is the navigation half of that: pure functions, no I/O, no React.
// It answers three questions and no others.
//
//   1. **Which section owns this identifier.** `attendanceSectionForSubNav` is
//      the single mapping from a sidebar sub-navigation identifier to a workspace
//      section, and it is what both the workspace router and the target
//      resolution read. Two copies of that map would eventually disagree about
//      where an identifier lands.
//   2. **Which screen owns this record.** `navigationTargetForRecord` is the
//      mapping from a record kind to the sub-navigation identifier of the screen
//      that owns it, which is what turns an inbox item into a target. It lives
//      beside the section map so the screen a target names and the section that
//      receives it cannot disagree.
//   3. **Can this target be opened.** `resolveNavigationTarget` refuses a target
//      that names no record, names a record identifier it cannot read, or names
//      another employee's attendance day to a caller who may only see their own.
//      Each refusal carries the reason as text, because Requirement 1, criterion
//      12 asks for the reason to be displayed rather than for the drawer to
//      silently not open.
//
// What this module deliberately does **not** decide is whether the record
// exists. That is settled by the read the owning screen already performs for its
// own content, and a second read here would be a second answer to the same
// question. A screen whose read comes back empty or refused renders
// `TARGET_UNAVAILABLE_REASON.notFound` — or the refusal's own message — through
// `NavigationTargetNotice`, and does not open its drawer.
//
// Requirements: 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 21.1

import type { NavigationTarget, NavigationTargetRecordKind, SubNavId } from '@/components/app-sidebar';

import { addCalendarDays } from '../domain/work-date';

/**
 * The sections `TimeAttendanceWorkspace` routes between.
 *
 * These are the workspace's own section names rather than the sidebar's
 * identifiers, and there is one per section that has a screen behind it. There is
 * no `staffing` section: coverage folded into Today's Live_Coverage_Panel and into
 * the Time Off & Coverage calendar (Requirement 1, criterion 5), so a section name
 * for it would name nothing.
 */
export type AttendanceSection =
  | 'clock'
  | 'schedule'
  | 'pto'
  | 'payroll'
  | 'workforce'
  | 'reports';

/**
 * Every sub-navigation identifier the module answers to.
 *
 * The six the sidebar offers, and nothing else. The retired identifiers are gone
 * from `SubNavId` and from here, which does not weaken Requirement 1, criterion
 * 10: this is a lookup with a stated answer for a miss, and the answer is the
 * module's first section — Today. `resolveNavigationForRole` reaches the same
 * conclusion one step earlier by falling back to the module's first sub-item, so a
 * stored state naming an identifier this build no longer declares is normalised to
 * `ta_today` before it ever reaches this map.
 *
 * `Partial` because `SubNavId` spans every module, not only this one, and a Sales
 * identifier has no attendance section.
 */
const SECTION_FOR_SUBNAV: Partial<Record<SubNavId, AttendanceSection>> = {
  ta_today: 'clock',
  ta_schedule: 'schedule',
  ta_timeoff: 'pto',
  ta_review: 'reports',
  ta_payroll: 'payroll',
  ta_workforce: 'workforce',
};

/** The sections only an Attendance_Administrator may reach. */
const ADMINISTRATOR_SECTIONS: readonly AttendanceSection[] = [
  'payroll',
  'workforce',
  'reports',
];

/** The section every unresolvable identifier lands on: Today. */
const FIRST_SECTION: AttendanceSection = 'clock';

/**
 * The section a sub-navigation identifier renders.
 *
 * An identifier this module does not own, and an administrator section reached by
 * a caller who does not administer attendance, both resolve to Today — matching
 * where `resolveNavigationForRole` puts them, so the section rendered and the
 * item highlighted in the sidebar cannot disagree.
 *
 * Requirements: 1.7, 1.8, 1.9, 1.10, 1.4
 */
export function attendanceSectionForSubNav(
  subNav: SubNavId,
  canAdminister: boolean,
): AttendanceSection {
  const section = SECTION_FOR_SUBNAV[subNav];
  if (section === undefined) return FIRST_SECTION;
  if (!canAdminister && ADMINISTRATOR_SECTIONS.includes(section)) return FIRST_SECTION;
  return section;
}

// ─── Which screen owns a record ──────────────────────────────────────────────

/**
 * The screen that owns each record kind, for a caller who administers
 * attendance.
 *
 * - An **attendance day** is owned by Review, because the Exception_Queue is the
 *   screen that lists Daily_Attendance_Records carrying an exception and its
 *   drawer is where a correction is made (Requirement 12, criteria 11 through 14).
 * - A **request** is owned by Time Off & Coverage, where the Request_Inbox lists
 *   it and the Request_Decision_Drawer decides it (Requirement 7 and Requirement
 *   10).
 * - A **coverage date** is owned by Time Off & Coverage, where the
 *   Coverage_Calendar shows the projection and the Coverage_Date_Drawer breaks it
 *   down (Requirement 8, criteria 1 through 5).
 */
const ADMINISTRATOR_SCREEN_FOR_RECORD: Record<NavigationTargetRecordKind, SubNavId> = {
  attendance_day: 'ta_review',
  pto_request: 'ta_timeoff',
  coverage_date: 'ta_timeoff',
};

/**
 * The screen an employee's own record is owned by.
 *
 * Review is an administrator screen (Requirement 1, criterion 4), so an employee's
 * own attendance day is owned by Today, which is the screen My_Day_View and its
 * history live on. Naming Review for them would have `resolveNavigationForRole`
 * drop the whole target on its way through — it discards a target whose screen the
 * role cannot reach — and the record would not open at all.
 */
const EMPLOYEE_SCREEN_FOR_RECORD: Partial<Record<NavigationTargetRecordKind, SubNavId>> = {
  attendance_day: 'ta_today',
};

/**
 * The target that opens one record on the screen that owns it.
 *
 * The two halves of an inbox item — `recordKind` and `recordId` — are exactly what
 * a `NavigationTarget` needs beside the screen, and the screen is this mapping. So
 * selecting an item is Requirement 17, criterion 6 with nothing left for the inbox
 * to decide, and the screens are named through `SubNavId` so the sidebar highlight,
 * the section rendered, and the record opened all follow from one value.
 *
 * `openDrawer` is always true: a target built from a record is a request to open
 * that record, and a target that selected a row without opening it would leave the
 * reader on a screen wondering what they were sent to look at.
 *
 * Requirements: 1.11, 17.6
 */
export function navigationTargetForRecord(
  recordKind: NavigationTargetRecordKind,
  recordId: string,
  canAdminister: boolean,
): NavigationTarget {
  const screen = canAdminister
    ? ADMINISTRATOR_SCREEN_FOR_RECORD[recordKind]
    : (EMPLOYEE_SCREEN_FOR_RECORD[recordKind] ?? ADMINISTRATOR_SCREEN_FOR_RECORD[recordKind]);

  return { screen, recordKind, recordId, openDrawer: true };
}

/**
 * A target that has been checked and belongs to the section being rendered.
 *
 * The screen is no longer part of the shape: the section that receives one of
 * these is the screen the target named. `recordKind` and `recordId` are both
 * present, which is what distinguishes this from the raw `NavigationTarget`.
 */
export interface SectionNavigationTarget {
  recordKind: NavigationTargetRecordKind;
  recordId: string;
  /** Whether the owning screen should open the record's detail drawer. */
  openDrawer: boolean;
}

/** The signed-in user, as far as opening a record is concerned. */
export interface NavigationTargetViewer {
  /** `profiles.id` of the signed-in user. */
  profileId: string;
  canAdminister: boolean;
}

/**
 * What the navigation layer decided about a target.
 *
 * - `none` — there is nothing for this section to do: no target, or a target
 *   belonging to another section, or one naming a screen and no record.
 * - `ready` — hand it to the owning screen.
 * - `unavailable` — render the screen without the drawer and display `reason`.
 */
export type NavigationTargetResolution =
  | { status: 'none' }
  | { status: 'ready'; target: SectionNavigationTarget }
  | { status: 'unavailable'; reason: string };

/**
 * Why a record could not be opened, in the words shown to the reader.
 *
 * Plain language and specific about what happened, because this text is the
 * whole of what Requirement 1, criterion 12 asks for. A refusal never states
 * whether the record exists: confirming the existence of a record the caller may
 * not read is a disclosure in itself.
 *
 * `notFound` is exported for the owning screens, whose own read is what settles
 * whether the record is still there.
 */
export const TARGET_UNAVAILABLE_REASON = {
  namesNoRecord: 'That item does not name a record, so there is nothing to open here.',
  malformedRecordId: 'That item names a record in a form this screen cannot read.',
  notVisible:
    'That record is not available to you. You can open your own attendance records only.',
  notFound:
    'That record is no longer available. It may have been changed or removed since this list was built.',
} as const;

const RESOLUTION_NONE: NavigationTargetResolution = { status: 'none' };

function unavailable(reason: string): NavigationTargetResolution {
  return { status: 'unavailable', reason };
}

function isCalendarDate(value: string): boolean {
  try {
    // The module's single calendar-date check: `addCalendarDays` rejects both a
    // malformed shape and a well-shaped value naming no date, such as 30 February.
    addCalendarDays(value, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The employee and work date an `attendance_day` identifier names, or null.
 *
 * The identifier is `profileId:workDate`. A profile identifier is a uuid and
 * carries no colon, so the first colon is the separator. The uuid itself is not
 * shape-checked here — the read reports an identifier that names no employee, and
 * this function only needs enough structure to tell whose record it is.
 */
export function parseAttendanceDayRecordId(
  recordId: string,
): { profileId: string; workDate: string } | null {
  const separator = recordId.indexOf(':');
  if (separator <= 0) return null;

  const profileId = recordId.slice(0, separator);
  const workDate = recordId.slice(separator + 1);
  if (profileId === '' || !isCalendarDate(workDate)) return null;

  return { profileId, workDate };
}

/**
 * What the section being rendered should do with the current navigation target.
 *
 * The checks that can be made without a read, in order:
 *
 *  1. No target, or a target owned by another section — nothing to do.
 *  2. A target naming no record — nothing to open. Reported rather than ignored
 *     when the target asked for a drawer, because an inbox item that opens a
 *     screen and then does nothing reads as a broken link.
 *  3. A record identifier this section cannot parse — reported, because retrying
 *     will not fix it.
 *  4. Another employee's attendance day, asked for by a caller who may see only
 *     their own — reported. This is the same rule `visibleProfileIds` enforces on
 *     the server; checking it here means the reader is told why instead of
 *     watching a drawer fail to open.
 *
 * Anything that passes is handed to the screen, whose own read settles whether
 * the record is still there.
 *
 * Requirements: 1.11, 1.12, 21.1
 */
export function resolveNavigationTarget(input: {
  target: NavigationTarget | undefined;
  section: AttendanceSection;
  viewer: NavigationTargetViewer;
}): NavigationTargetResolution {
  const { target, section, viewer } = input;

  if (target === undefined) return RESOLUTION_NONE;
  if (attendanceSectionForSubNav(target.screen, viewer.canAdminister) !== section) {
    return RESOLUTION_NONE;
  }

  const { recordKind, recordId } = target;
  const openDrawer = target.openDrawer === true;

  if (recordKind === undefined || recordId === undefined || recordId.trim() === '') {
    return openDrawer ? unavailable(TARGET_UNAVAILABLE_REASON.namesNoRecord) : RESOLUTION_NONE;
  }

  if (recordKind === 'attendance_day') {
    const parsed = parseAttendanceDayRecordId(recordId);
    if (parsed === null) return unavailable(TARGET_UNAVAILABLE_REASON.malformedRecordId);
    if (!viewer.canAdminister && parsed.profileId !== viewer.profileId) {
      return unavailable(TARGET_UNAVAILABLE_REASON.notVisible);
    }
  }

  if (recordKind === 'coverage_date' && !isCalendarDate(recordId)) {
    return unavailable(TARGET_UNAVAILABLE_REASON.malformedRecordId);
  }

  return { status: 'ready', target: { recordKind, recordId, openDrawer } };
}
