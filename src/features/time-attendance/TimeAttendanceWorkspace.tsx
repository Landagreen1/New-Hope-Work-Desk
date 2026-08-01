'use client';

// src/features/time-attendance/TimeAttendanceWorkspace.tsx
// The Time & Attendance section router.
//
// Renders one section, chosen by the sidebar's sub-navigation identifier, and
// hands that section the record it was navigated to.
//
// ## The six sections
//
// | sub-navigation | section    | screen                                    | criterion |
// | -------------- | ---------- | ----------------------------------------- | --------- |
// | `ta_today`     | `clock`    | `TodayScreen`                             | 1.7       |
// | `ta_schedule`  | `schedule` | `ScheduleManager`, preserved              | 2.1       |
// | `ta_timeoff`   | `pto`      | `TimeOffCoverageScreen`                   | 1.8       |
// | `ta_review`    | `reports`  | `ReviewCenter`, Exceptions active         | 1.9       |
// | `ta_payroll`   | `payroll`  | `PayrollDashboard` and `PayrollProcessor` | 2.2       |
// | `ta_workforce` | `workforce`| `WorkforceAdmin`                          | 2.3       |
//
// The last three are gated on `canAdministerAttendance`, which is the same
// predicate the sidebar builds its administrator block from, so a section the
// navigation would not offer cannot be rendered by a stored navigation state
// either (Requirement 1, criteria 3 and 4). The gate is a second check rather than
// a duplicated rule: one imported predicate, read in two places.
//
// There is no seventh screen. Coverage folded into Today's Live_Coverage_Panel
// and into the Time Off & Coverage screen's calendar, so there is no standalone
// Coverage screen to route to (Requirement 1, criterion 5), and the `staffing`
// section a stored navigation state may still name has nothing behind it. It is
// routed to Today rather than rendered as a blank panel, which is criterion 10.
// Task 24.4 removes the section, and this fallback with it.
//
// ## The screens are composed here, through their own seams
//
// Two of the six screens are built as a shell plus render seams: the Time Off &
// Coverage screen owns the three-pane arrangement and takes the calendar, the
// decision pane, and the composer as functions of the pane context; the
// Review_Center owns the tab list and takes four views the same way. Neither
// imports its panes.
//
// That leaves the composition itself somewhere, and here is where it belongs: this
// is the module's one router, so a pane can be added or withheld in one place, and
// a screen rendered without its seams degrades to stating that the affordance is
// unavailable rather than to a blank panel. The seams are also where the two facts
// a pane needs and its screen does not — the signed-in profile, and the
// organisation's timezone — are supplied.
//
// ## The navigation target
//
// A navigation may name a record as well as a screen, which is how the Needs
// Attention inbox opens a specific item on the screen that owns it. This
// component is where that instruction is judged:
//
//   - `resolveNavigationTarget` decides which section owns the target and whether
//     it can be opened at all, without a read.
//   - A target that can be opened is provided to the active section's subtree,
//     where the owning screen picks it up, opens the drawer, and clears the target
//     so nothing reopens on a later render.
//   - A target that cannot be opened renders the section with its reason stated
//     above it and no drawer, which is Requirement 1, criterion 12. That target
//     is not consumed, because nothing acted on it: the reason stays in front of
//     the reader until they navigate, and any sidebar selection drops it.
//
// The section a target names may differ from the section being rendered — an
// inbox item can be selected from any screen. The provider only ever carries a
// target the rendered section owns, so a screen cannot open a record belonging to
// another screen.
//
// ## The inbox is mounted here, once
//
// Requirement 17, criterion 1 asks for the Needs_Attention_Inbox on every Time &
// Attendance screen. It is mounted here rather than inside each of the six
// sections, above the section content, because that is the one place every section
// passes through: six mounts would be six chances for a screen to be added without
// one, and the criterion would then be true by habit rather than by construction.
//
// A selected item names a record on some screen, which is a navigation this
// component cannot perform — navigation state belongs to `role-workspace.tsx`. So
// the target is handed up through `onNavigate`, and the inbox is mounted only when
// that callback is present: an inbox whose selections went nowhere would be a list
// of broken links, which is worse than not showing it.
//
// ## The health ribbon is mounted here too, for three sections of the six
//
// Requirement 18, criterion 1 asks for the Health_Ribbon on Today, Schedule, and
// Time Off & Coverage — three of the six sections rather than all of them, because
// the other three are payroll, workforce configuration, and review, none of which
// is about the week ahead. So the mount is one condition on the active section,
// in the same place the inbox is mounted, rather than a copy inside each of the
// three screens.
//
// That is also what makes criterion 10 structural. There is one `HealthRibbon`
// instance, reading `/api/coverage` once; the three sections cannot disagree about
// a date's state because there is only ever one answer on screen. Three mounts
// reading the same endpoint would agree only as long as they were read at the same
// moment.
//
// ## One read of the organisation's timezone
//
// The strip's seven dates begin on the organisation's current date (Requirement 18,
// criterion 2), and the Time Off & Coverage panes render times against the same
// zone, so both need `attendance_policy.business_timezone` before any screen has
// rendered. `useBusinessTimeZone` takes it off `/api/attendance/day`, which already
// carries the policy singleton and is already the module's client-side day read —
// a policy endpoint would be a second definition of one row.
//
// The read is issued only for the three sections that consume the zone. Review,
// Payroll, and Workforce format against their own reads, so asking for a policy
// they do not use would be a request made for nothing.
//
// Requirements: 1.2, 1.3, 1.4, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12, 2.1, 2.2, 2.3,
// 17.1, 17.6, 18.1, 18.2, 18.10

import { Suspense, useMemo } from 'react';

import type { NavigationTarget } from '@/components/app-sidebar';
import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../nhwd-shared/types';
import PayrollDashboard from './PayrollDashboard';
import PayrollProcessor from './PayrollProcessor';
import { AuditLogView } from './review/AuditLogView';
import { EmployeeTrendsView } from './review/EmployeeTrendsView';
import { ExportsView } from './review/ExportsView';
import { OverviewView } from './review/OverviewView';
import { ReviewCenter, type ReviewViewContext } from './review/ReviewCenter';
import ScheduleManager from './ScheduleManager';
import { HealthRibbon } from './shared/HealthRibbon';
import { NavigationTargetNotice } from './shared/NavigationTargetNotice';
import { resolveNavigationTarget, type AttendanceSection } from './shared/navigation-target';
import { NeedsAttentionInbox } from './shared/NeedsAttentionInbox';
import { useBusinessTimeZone } from './shared/useAttendanceRoster';
import { NavigationTargetProvider } from './shared/useNavigationTarget';
import { renderCoveragePane } from './timeoff/CoverageCalendar';
import { renderComposerPane } from './timeoff/RequestComposer';
import { renderDecisionPane } from './timeoff/RequestDecisionDrawer';
import { TimeOffCoverageScreen } from './timeoff/TimeOffCoverageScreen';
import { TodayScreen } from './today/TodayScreen';
import WorkforceAdmin from './WorkforceAdmin';

interface TimeAttendanceWorkspaceProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
  /** Active section driven by the global sidebar navigation */
  activeSection?: AttendanceSection;
  /** A record this navigation named, if any. Resolved once and then cleared. */
  navigationTarget?: NavigationTarget;
  /** Called by the owning screen once it has opened the record. */
  onNavigationTargetConsumed?: () => void;
  /**
   * Called with the target a selected Needs Attention item names, for the caller
   * to put into navigation state. The inbox is mounted only when this is supplied.
   *
   * Requirements: 17.6
   */
  onNavigate?: (target: NavigationTarget) => void;
}

/**
 * The three sections the Health_Ribbon appears on: Today, Schedule, and Time Off
 * & Coverage.
 *
 * A list rather than three comparisons, so the set the criterion names is stated
 * once and a section added later has to be added to it deliberately. The same list
 * decides whether the business-timezone read is issued, because the strip is what
 * needs the zone earliest and the third of the three needs it for its panes.
 *
 * Requirements: 18.1, 18.2
 */
const RIBBON_SECTIONS: readonly AttendanceSection[] = ['clock', 'schedule', 'pto'];

/**
 * Sections that no longer have a screen behind them.
 *
 * `staffing` is the only one: the standalone Coverage screen folded into Today and
 * into the Time Off & Coverage calendar (Requirement 1, criterion 5), while the
 * section name is still reachable from a navigation state an older build stored.
 * Listing it here rather than leaving it unmatched below is what makes criterion 10
 * hold — an unmatched section would render as an empty panel.
 *
 * Requirements: 1.5, 1.10
 */
const RETIRED_SECTIONS: readonly AttendanceSection[] = ['staffing'];

/** The section a retired one is rendered as: Today. */
const RETIRED_SECTION_FALLBACK: AttendanceSection = 'clock';

/**
 * The Review_Center's four view seams.
 *
 * Each view's props are `ReviewViewContext` exactly, so the seam is a spread and
 * nothing is adapted between the two. Module constants rather than inline
 * closures: none of them captures anything, and a function rebuilt every render
 * would be a new identity for no reason.
 *
 * Requirements: 13.1, 14.1, 15.1, 16.3
 */
const renderOverview = (context: ReviewViewContext) => <OverviewView {...context} />;
const renderTrends = (context: ReviewViewContext) => <EmployeeTrendsView {...context} />;
const renderExports = (context: ReviewViewContext) => <ExportsView {...context} />;
const renderAudit = (context: ReviewViewContext) => <AuditLogView {...context} />;

function LoadingFallback() {
  return (
    <div className="grid min-h-[300px] place-items-center rounded-2xl border border-slate-200 bg-white">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
    </div>
  );
}

export default function TimeAttendanceWorkspace({
  initialProfile,
  embedded = false,
  // Today when the caller names no section, which is the same answer
  // `attendanceSectionForSubNav` gives an identifier it does not own.
  activeSection: requestedSection = 'clock',
  navigationTarget,
  onNavigationTargetConsumed,
  onNavigate,
}: TimeAttendanceWorkspaceProps) {
  // A retired section is rendered as Today rather than as nothing.
  const section = RETIRED_SECTIONS.includes(requestedSection)
    ? RETIRED_SECTION_FALLBACK
    : requestedSection;
  const canAdminister = canAdministerAttendance(initialProfile.role);

  const resolution = useMemo(
    () =>
      resolveNavigationTarget({
        target: navigationTarget,
        section,
        viewer: { profileId: initialProfile.id, canAdminister },
      }),
    [navigationTarget, section, initialProfile.id, canAdminister],
  );

  // Only for the sections that consume it, so the other three issue no request.
  const timeZone = useBusinessTimeZone(RIBBON_SECTIONS.includes(section));

  // The Time Off & Coverage panes. Memoised on what they close over rather than
  // rebuilt per render: each is a function the screen calls, so a new identity
  // costs nothing on its own, but the pane it returns is given the profile and the
  // zone and those are what actually change.
  const coveragePane = useMemo(() => renderCoveragePane({ timeZone }), [timeZone]);
  const decisionPane = useMemo(
    () => renderDecisionPane({ profile: initialProfile, timeZone }),
    [initialProfile, timeZone],
  );
  const composerPane = useMemo(() => renderComposerPane({ timeZone }), [timeZone]);

  return (
    <section className={embedded ? 'text-slate-950' : ''}>
      {/* Criterion 1: above the content of whichever of the six sections is
          rendered, so it is reachable from every screen without being part of any
          of them. */}
      {onNavigate !== undefined && (
        <NeedsAttentionInbox
          canAdminister={canAdminister}
          onSelect={onNavigate}
          className="mb-4"
        />
      )}

      {/* Requirement 18, criterion 1: on Today, Schedule, and Time Off & Coverage,
          from one mount reading the endpoint once, so criterion 10 holds by
          construction. The zone is the organisation's, so the seven dates begin on
          its current date rather than on the reader's or on UTC. */}
      {RIBBON_SECTIONS.includes(section) && (
        <HealthRibbon timeZone={timeZone} className="mb-4" />
      )}

      {resolution.status === 'unavailable' && (
        <NavigationTargetNotice reason={resolution.reason} />
      )}
      <NavigationTargetProvider
        target={resolution.status === 'ready' ? resolution.target : null}
        onConsumed={onNavigationTargetConsumed}
      >
        <Suspense fallback={<LoadingFallback />}>
          {/* Criterion 7: Today, for every signed-in user. The screen itself
              chooses My Day or Team Today on the same predicate. */}
          {section === 'clock' && <TodayScreen initialProfile={initialProfile} />}

          {/* Requirement 2, criterion 1: preserved. The zone is the one the grid's
              stored shift times were written in, so the grid can read them on each
              employee's own clock — the same zone the ribbon above it uses, from
              the same read. */}
          {section === 'schedule' && (
            <ScheduleManager initialProfile={initialProfile} businessTimeZone={timeZone} />
          )}

          {/* Criterion 8: Time Off & Coverage, for every signed-in user, with the
              three panes plugged into the screen's seams. */}
          {section === 'pto' && (
            <TimeOffCoverageScreen
              initialProfile={initialProfile}
              renderCoverage={coveragePane}
              renderDecision={decisionPane}
              renderComposer={composerPane}
            />
          )}

          {/* Criteria 3, 4, and 9: Review, administrators only, opening on the
              Exception_Queue — which is the Review_Center's own default view. */}
          {section === 'reports' && canAdminister && (
            <ReviewCenter
              initialProfile={initialProfile}
              renderOverview={renderOverview}
              renderTrends={renderTrends}
              renderExports={renderExports}
              renderAudit={renderAudit}
            />
          )}

          {/* Requirement 2, criterion 2: preserved, both halves. */}
          {section === 'payroll' && canAdminister && (
            <div className="space-y-6">
              <PayrollDashboard initialProfile={initialProfile} />
              <PayrollProcessor initialProfile={initialProfile} />
            </div>
          )}

          {/* Requirement 2, criterion 3: preserved. */}
          {section === 'workforce' && canAdminister && (
            <WorkforceAdmin initialProfile={initialProfile} />
          )}
        </Suspense>
      </NavigationTargetProvider>
    </section>
  );
}
