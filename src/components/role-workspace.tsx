"use client";

import {
  RefreshCw,
} from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  getDefaultNavigation,
  resolveNavigationForRole,
  type NavigationTarget,
} from "@/components/app-sidebar";
import { SidebarLayout, type NavigationState, type SubNavId } from "@/components/sidebar-layout";
import { WorkDeskApp } from "@/components/work-desk-app";
import CommercialBoard from "@/features/commercial/CommercialBoard";
import CommercialCommissionReport from "@/features/commercial/CommercialCommissionReport";
import CommercialCommissionReview from "@/features/commercial/CommercialCommissionReview";
import CommercialDatabase from "@/features/commercial/CommercialDatabase";
import CommercialReports from "@/features/commercial/CommercialReports";
import CommercialTimingReport from "@/features/commercial/CommercialTimingReport";
import { attendanceSectionForSubNav } from "@/features/time-attendance/shared/navigation-target";
import TimeAttendanceWorkspace from "@/features/time-attendance/TimeAttendanceWorkspace";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import IntakeQueue from "@/features/cs-intake/IntakeQueue";
import type { ProfileLite } from "@/features/nhwd-shared/types";
import { NotificationPanel } from "@/features/notifications/NotificationPanel";
import PolicyFollowUpPage from "@/features/renewals/PolicyFollowUpPage";
import WorkloadLog from "@/features/workload/WorkloadLog";
import { getRolePermissions, isBroadManagerRole } from "@/lib/permissions";
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

function ManagerCustomerServiceWorkspace({
  profile,
  initialSubNav,
}: {
  profile: ProfileLite;
  initialSubNav?: "intakes" | "queue";
}) {
  const tab = initialSubNav ?? "intakes";

  return (
    <div className="space-y-5">
      {tab === "intakes" ? (
        <Suspense fallback={<LoadingWorkspace label="Quote Intake" />}>
          <CsIntakeLanding initialProfile={profile} embedded />
        </Suspense>
      ) : (
        <IntakeQueue initialProfile={profile} embedded />
      )}
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
    case "sales_databases":
      return "quotes"; // WorkDeskApp uses "quotes" for the databases tab
    case "sales_reports":
      return "reports";
    case "ua_users":
      return "administration";
    default:
      return undefined;
  }
}

/**
 * Maps sidebar SubNavId to WorkDeskApp's agent tab.
 */
function subNavToAgentTab(
  subNav: SubNavId,
): "desk" | "pricing" | "intake_queue" | "quotes" | "team" | "performance" | undefined {
  switch (subNav) {
    case "sales_desk":
      return "desk";
    case "sales_pricing":
      return "pricing";
    case "sales_intake_queue":
      return "intake_queue";
    case "sales_team":
      return "team";
    case "sales_databases":
      return "quotes";
    case "sales_performance":
      return "performance";
    default:
      return undefined;
  }
}

export function RoleWorkspace({
  sessionProfile,
  initialData,
}: {
  sessionProfile: SessionProfile;
  initialData: DashboardData;
}) {
  const router = useRouter();
  const [navigation, setNavigation] = useState<NavigationState>(
    () => getDefaultNavigation(sessionProfile.role),
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
  const isBroadManager = isBroadManagerRole(sessionProfile.role);

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

  // Determine what content to render based on sidebar navigation state
  const renderContent = () => {
    const { module, subNav } = activeNavigation;

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
          workloadDatabaseContent={
            <WorkloadLog initialProfile={profile} embedded />
          }
          embedded
        />
      );
    }

    // --- Customer Service ---
    if (module === "customer_service" && permissions.customerService) {
      const csSubTab = subNav === "cs_queue" ? "queue" : "intakes";
      return (
        <ManagerCustomerServiceWorkspace
          profile={profile}
          initialSubNav={csSubTab}
        />
      );
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
