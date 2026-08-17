"use client";

import {
  RefreshCw,
} from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  getDefaultNavigation,
  resolveNavigationForRole,
  type DeskSection,
  type NavigationTarget,
} from "@/components/app-sidebar";
import { SidebarLayout, type NavigationState, type SubNavId } from "@/components/sidebar-layout";
import { WorkDeskApp } from "@/components/work-desk-app";
import QuoteCenter from "@/features/quote-center/QuoteCenter";
import CommercialBoard from "@/features/commercial/CommercialBoard";
import CommercialCommissionReport from "@/features/commercial/CommercialCommissionReport";
import CommercialCommissionReview from "@/features/commercial/CommercialCommissionReview";
import CommercialDatabase from "@/features/commercial/CommercialDatabase";
import CommercialReports from "@/features/commercial/CommercialReports";
import CommercialTimingReport from "@/features/commercial/CommercialTimingReport";
import { attendanceSectionForSubNav } from "@/features/time-attendance/shared/navigation-target";
import TimeAttendanceWorkspace from "@/features/time-attendance/TimeAttendanceWorkspace";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import type { ProfileLite } from "@/features/nhwd-shared/types";
import { NotificationPanel } from "@/features/notifications/NotificationPanel";
import PolicyFollowUpPage from "@/features/renewals/PolicyFollowUpPage";
import SalesReportingCenter from "@/features/reporting/SalesReportingCenter";
import WorkloadLog from "@/features/workload/WorkloadLog";
import { getRolePermissions } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/client";
import type { DashboardData, SessionProfile } from "@/lib/types";

function LoadingWorkspace({ label }: { label: string }) {
  return (
    <div className="grid min-h-[420px] place-items-center rounded-[28px] border border-slate-200 bg-white font-black text-slate-500 shadow-sm">
      <div className="text-center">
        <RefreshCw className="mx-auto h-6 w-6 animate-spin text-[#223f7a]" />
        <p className="mt-3">Loading {label}…</p>
      </div>
    </div>
  );
}

/**
 * The Customer Service module, now a single screen.
 *
 * Its second screen was the shared CS-to-Sales queue, which rendered the very same
 * `IntakeQueue` component as the Sales module's Intake Queue — two sidebar entries
 * for one screen. That queue is work, so it now lives as a section of My Desk, and
 * this module is reached only by roles that have no Sales access at all.
 */
function ManagerCustomerServiceWorkspace({
  profile,
  initialSubNav,
}: {
  profile: ProfileLite;
  initialSubNav?: "intakes";
}) {
  void initialSubNav;
  return (
    <div className="space-y-5">
      <Suspense fallback={<LoadingWorkspace label="Quote Intake" />}>
        <CsIntakeLanding initialProfile={profile} embedded />
      </Suspense>
    </div>
  );
}

/**
 * Maps sidebar SubNavId to WorkDeskApp's forceManagerTab prop.
 * Only sales sub-nav items map to manager tabs.
 */
function subNavToManagerTab(
  subNav: SubNavId,
): "overview" | "work" | "quotes" | "reports" | "team" | "administration" | undefined {
  switch (subNav) {
    case "sales_overview":
      return "overview";
    case "sales_work":
      return "work";
    case "sales_reports":
      return "reports";
    case "ua_users":
      return "administration";
    // sales_databases is gone: the manager Quotes Database it opened is superseded
    // by Quote Center, which is rendered directly rather than as a WorkDeskApp tab.
    default:
      return undefined;
  }
}

/**
 * Maps sidebar SubNavId to WorkDeskApp's agent tab.
 *
 * Down to two entries. Pending Pricing, the Intake Queue and the Workload Log are
 * now sections of My Desk rather than tabs of their own, and the Quotes Database
 * and My Team have moved to Quote Center and Performance.
 */
function subNavToAgentTab(subNav: SubNavId): "desk" | "performance" | undefined {
  switch (subNav) {
    case "sales_desk":
      return "desk";
    case "sales_performance":
      return "performance";
    default:
      return undefined;
  }
}

export function RoleWorkspace({
  sessionProfile,
  initialData,
  initialDeskSection,
}: {
  sessionProfile: SessionProfile;
  initialData: DashboardData;
  /**
   * Opens My Desk on a named section on first render, from `?desk=<section>`.
   *
   * Set by the retired `/tools/cs-intake/queue` route so an old bookmark for the
   * standalone Sales Intake Queue lands on the queue rather than on a 404 or on
   * whichever screen happens to be the role default.
   */
  initialDeskSection?: DeskSection;
}) {
  const router = useRouter();
  const [navigation, setNavigation] = useState<NavigationState>(() =>
    resolveNavigationForRole(
      sessionProfile.role,
      initialDeskSection
        ? { module: "sales", subNav: "sales_desk", deskSection: initialDeskSection }
        : getDefaultNavigation(sessionProfile.role),
    ),
  );

  const handleSignOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }, [router]);

  const profile = useMemo<ProfileLite>(
    () => ({
      id: sessionProfile.id,
      display_name: sessionProfile.displayName,
      initials: sessionProfile.initials,
      role: sessionProfile.role,
      is_active: true,
    }),
    [sessionProfile],
  );

  const permissions = getRolePermissions(sessionProfile.role);
  const activeNavigation = resolveNavigationForRole(sessionProfile.role, navigation);

  const handleNavigate = useCallback((nav: NavigationState) => {
    setNavigation(resolveNavigationForRole(sessionProfile.role, nav));
  }, [sessionProfile.role]);

  /**
   * Drops the record target once the owning screen has opened it.
   *
   * A target is a one-shot instruction: it opens a record's drawer and is then
   * spent. Leaving it in navigation state would reopen that drawer every time the
   * screen remounted, long after the reader had closed it. The screen keeps the
   * drawer open from its own state, so clearing here changes nothing on screen.
   *
   * Requirements: 1.11
   */
  const clearNavigationTarget = useCallback(() => {
    setNavigation((current) =>
      current.target === undefined ? current : { module: current.module, subNav: current.subNav },
    );
  }, []);

  /**
   * Moves to the screen a record belongs to, with the record named.
   *
   * The Needs Attention inbox is mounted on every Time & Attendance screen and its
   * items belong to four of them, so selecting one is a navigation rather than
   * something the screen holding the inbox can do itself. `subNav` is set from the
   * target's own `screen`, because `resolveNavigationForRole` drops a target whose
   * screen is not the one being navigated to — a target and a sub-navigation
   * identifier that disagree would open a drawer on a screen the reader is not
   * looking at.
   *
   * Requirements: 1.11, 17.6
   */
  const openNavigationTarget = useCallback(
    (target: NavigationTarget) => {
      setNavigation(
        resolveNavigationForRole(sessionProfile.role, {
          module: "time_attendance",
          subNav: target.screen,
          target,
        }),
      );
    },
    [sessionProfile.role],
  );

  /** Moves to My Desk, optionally landing on a specific section. */
  const goToMyDesk = useCallback(
    (section?: DeskSection) => {
      setNavigation(
        resolveNavigationForRole(sessionProfile.role, {
          module: "sales",
          subNav: "sales_desk",
          ...(section ? { deskSection: section } : {}),
        }),
      );
    },
    [sessionProfile.role],
  );

  /**
   * Opens an intake in the Customer Service intake screen.
   *
   * Quote Center deliberately does not host the intake form itself: the form is a
   * large, validated component with its own draft, conflict and submission
   * handling, and duplicating it would be exactly the kind of parallel
   * implementation this consolidation is removing. `?edit=<id>` is the route
   * CsIntakeLanding already supports for opening one record.
   */
  const openIntake = useCallback(
    (intakeId?: string) => {
      router.push(intakeId ? `/tools/cs-intake?edit=${intakeId}` : '/tools/cs-intake');
    },
    [router],
  );

  // Determine what content to render based on sidebar navigation state
  const renderContent = () => {
    const { module, subNav } = activeNavigation;

    // --- Quote Center ---
    // One lookup destination shared by Customer Service, Sales, supervisors and
    // managers. Its own screen rather than a WorkDeskApp tab, because WorkDeskApp is
    // where work lives and mixing the two back together is what created the
    // guess-which-database problem in the first place.
    if (module === "sales" && subNav === "quote_center" && permissions.sales) {
      return (
        <Suspense fallback={<LoadingWorkspace label="Quote Center" />}>
          <QuoteCenter
            initialProfile={profile}
            embedded
            onNewIntake={() => openIntake()}
            onContinueIntake={(intakeId) => openIntake(intakeId)}
            onGoToMyDesk={() => goToMyDesk()}
          />
        </Suspense>
      );
    }

    // --- Sales Reporting Center ---
    // Its own screen rather than another tab inside WorkDeskApp: that component is
    // already 12,500 lines and holds the twenty-four legacy reports, and keeping the new
    // centre out of it is the point of the redesign.
    // Spec: .kiro/specs/sales-reporting-center-redesign, Requirement 2.5.
    if (module === "sales" && subNav === "sales_reporting_center" && permissions.manageSales) {
      return (
        <Suspense fallback={<LoadingWorkspace label="Sales Reporting Center" />}>
          <SalesReportingCenter initialProfile={profile} />
        </Suspense>
      );
    }

    // --- Sales module: delegate to WorkDeskApp ---
    if (module === "sales" && permissions.sales) {
      const forceManagerTab = permissions.manageSales ? subNavToManagerTab(subNav) : undefined;
      const forceAgentTab = permissions.manageSales ? undefined : subNavToAgentTab(subNav);

      return (
        <WorkDeskApp
          sessionProfile={sessionProfile}
          initialData={initialData}
          forceManagerTab={forceManagerTab}
          forceAgentTab={forceAgentTab}
          forceDeskSection={activeNavigation.deskSection}
          workloadDatabaseContent={
            <WorkloadLog initialProfile={profile} embedded />
          }
          embedded
        />
      );
    }

    // --- Customer Service ---
    // Reached only by roles without Sales access: commercial and
    // commercial_supervisor, whose intake routing is unchanged.
    if (module === "customer_service" && permissions.customerService) {
      return <ManagerCustomerServiceWorkspace profile={profile} initialSubNav="intakes" />;
    }

    // --- Commercial ---
    if (module === "commercial" && permissions.commercial) {
      return (
        <Suspense fallback={<LoadingWorkspace label="Commercial" />}>
          {subNav === "commercial_database" && (
            <CommercialDatabase initialProfile={profile} embedded />
          )}
          {subNav === "commercial_commissions" && permissions.manageCommercial && (
            <CommercialCommissionReview initialProfile={profile} embedded />
          )}
          {subNav === "commercial_timing" && permissions.manageCommercial && (
            <CommercialTimingReport initialProfile={profile} embedded />
          )}
          {subNav === "commercial_commission_report" && permissions.manageCommercial && (
            <CommercialCommissionReport initialProfile={profile} embedded />
          )}
          {subNav === "commercial_reports" && permissions.manageCommercial && (
            <CommercialReports initialProfile={profile} embedded />
          )}
          {(subNav === "commercial_board" || (!["commercial_database", "commercial_commissions", "commercial_timing", "commercial_commission_report", "commercial_reports"].includes(subNav))) && (
            <CommercialBoard initialProfile={profile} embedded />
          )}
        </Suspense>
      );
    }

    // --- Policy Follow-up (Renewals + Pending Cancellations) ---
    if (module === "renewals" && permissions.renewals) {
      return (
        <Suspense>
          <PolicyFollowUpPage
            initialProfile={profile}
            embedded
          />
        </Suspense>
      );
    }

    // --- Time & Attendance ---
    if (module === "time_attendance" && permissions.timeAttendance) {
      // One mapping from sub-navigation identifier to section, shared with the
      // target resolution, so the section rendered and the section a record
      // target is offered to cannot disagree. `subNav` has already been through
      // `resolveNavigationForRole`, so an identifier this build no longer offers
      // arrives here as `ta_today`; the mapping answers Today for anything it does
      // not own regardless, which is Requirement 1, criterion 10.
      const taSection = attendanceSectionForSubNav(
        subNav,
        permissions.attendanceAdministration,
      );
      return (
        <Suspense fallback={<LoadingWorkspace label="Time & Attendance" />}>
          <TimeAttendanceWorkspace
            initialProfile={profile}
            embedded
            activeSection={taSection}
            navigationTarget={activeNavigation.target}
            onNavigationTargetConsumed={clearNavigationTarget}
            onNavigate={openNavigationTarget}
          />
        </Suspense>
      );
    }

    // --- User Administration ---
    if (module === "user_admin" && permissions.userAdministration) {
      return (
        <WorkDeskApp
          sessionProfile={sessionProfile}
          initialData={initialData}
          forceManagerTab="administration"
          workloadDatabaseContent={
            <WorkloadLog initialProfile={profile} embedded />
          }
          embedded
        />
      );
    }

    return null;
  };

  return (
    <SidebarLayout
      role={sessionProfile.role}
      displayName={sessionProfile.displayName}
      navigation={activeNavigation}
      onNavigate={handleNavigate}
      onSignOut={() => void handleSignOut()}
      headerRight={
        <NotificationPanel
          profile={{
            id: sessionProfile.id,
            display_name: sessionProfile.displayName,
            initials: sessionProfile.initials,
            role: sessionProfile.role,
            is_active: true,
          }}
        />
      }
    >
      {renderContent()}
    </SidebarLayout>
  );
}
