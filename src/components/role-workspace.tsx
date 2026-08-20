"use client";

import {
  RefreshCw,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  getDefaultNavigation,
  resolveNavigationForRole,
  type DeskSection,
  type NavigationTarget,
} from "@/components/app-sidebar";
import {
  SidebarLayout,
  type ModuleAccess,
  type NavigationState,
  type SubNavId,
} from "@/components/sidebar-layout";
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
import { canAccessSpecialtyModule } from "@/features/specialty/api";
import QuotingTeamsAdmin from "@/features/specialty/QuotingTeamsAdmin";
import MarketDirectoryAdmin from "@/features/specialty/market-directory/MarketDirectoryAdmin";
import SpecialtyWorkspace, {
  type SpecialtySection,
} from "@/features/specialty/SpecialtyWorkspace";
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
    case "ua_sources":
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

/**
 * Maps the sidebar identifier to the Specialty Quotes destination.
 *
 * Anything the module does not own resolves to Work, so a stale navigation state
 * lands on the operational surface rather than nowhere.
 */
function subNavToSpecialtySection(subNav: SubNavId): SpecialtySection {
  switch (subNav) {
    case "specialty_database":
      return "quotes";
    case "specialty_reports":
      return "reports";
    default:
      return "work";
  }
}

export function RoleWorkspace({
  sessionProfile,
  initialData,
  initialDeskSection,
  initialNavigation,
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
  /**
   * Opens a named module and screen on first render, from `?module=&sub=`.
   *
   * Added for Specialty Quotes, whose workspace is a route of its own: a link back from
   * `/specialty-quotes/<id>` has to land on the screen the reader left, and navigation
   * here is React state rather than a URL. Resolved through
   * `resolveNavigationForRole`, so a screen this role is not offered lands somewhere
   * sensible instead of nowhere.
   */
  initialNavigation?: { module: NavigationState["module"]; subNav: SubNavId };
}) {
  const router = useRouter();
  const [navigation, setNavigation] = useState<NavigationState>(() => {
    /*
     * A requested screen is stored unresolved.
     *
     * `resolveNavigationForRole` needs `moduleAccess` to know whether Specialty Quotes
     * exists for this account, and that answer arrives from the database a moment later.
     * Resolving here would therefore reject a valid specialty link as an unknown module
     * and replace it with the role default — permanently, because the resolved value is
     * what state would then hold. `activeNavigation` below resolves it on every render
     * with the access flag in hand, which is the right moment.
     */
    if (initialNavigation) {
      return { module: initialNavigation.module, subNav: initialNavigation.subNav };
    }
    return resolveNavigationForRole(
      sessionProfile.role,
      initialDeskSection
        ? { module: "sales", subNav: "sales_desk", deskSection: initialDeskSection }
        : getDefaultNavigation(sessionProfile.role),
    );
  });

  /**
   * Whether this account is a member of any quoting team.
   *
   * Specialty Quotes is the one module whose visibility a role cannot answer, so the
   * database is asked once. It starts false, which is correct rather than merely safe:
   * no role's default navigation is a specialty screen, so nobody is bounced when the
   * answer arrives and the item appears.
   *
   * This only decides whether to render the nav item. `specialty_can_access()` and the
   * RLS policies are what actually refuse a non-member.
   */
  const [moduleAccess, setModuleAccess] = useState<ModuleAccess>({ specialtyQuotes: false });

  useEffect(() => {
    let cancelled = false;
    void canAccessSpecialtyModule().then((allowed) => {
      if (!cancelled) setModuleAccess({ specialtyQuotes: allowed });
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const activeNavigation = resolveNavigationForRole(sessionProfile.role, navigation, moduleAccess);

  const handleNavigate = useCallback(
    (nav: NavigationState) => {
      setNavigation(resolveNavigationForRole(sessionProfile.role, nav, moduleAccess));
    },
    [moduleAccess, sessionProfile.role],
  );

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

  // Quote Center hosts the intake form itself, in a modal over the search. Routing
  // out to the standalone Quote Intake page meant landing on a launcher with
  // cross-module links and a list of existing intakes, and hunting for a second
  // button to reach the form. The form is the thing someone with a customer on the
  // line wants, so it is what opens.

  // Determine what content to render based on sidebar navigation state
  const renderContent = () => {
    const { module, subNav } = activeNavigation;

    // --- Quote Center ---
    // One lookup destination shared by Customer Service, Sales, Commercial,
    // supervisors and managers. Its own screen rather than a WorkDeskApp tab,
    // because WorkDeskApp is where work lives and mixing the two back together is
    // what created the guess-which-database problem in the first place.
    if ((module === "sales" || module === "commercial") && subNav === "quote_center") {
      return (
        <Suspense fallback={<LoadingWorkspace label="Quote Center" />}>
          <QuoteCenter
            initialProfile={profile}
            embedded
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

    // --- Specialty Quotes ---
    // One module for Trucking, Homeowners and whatever line of business is routed to a
    // quoting team next. Rendered directly rather than as a WorkDeskApp tab, for the
    // same reason Quote Center is: that component is already 12,500 lines and keeping
    // new screens out of it is the point.
    //
    // No permission check here beyond the access flag. Membership is the boundary and
    // it is enforced by `specialty_can_access()` inside every RPC the module calls, so
    // an account that reached this branch without membership sees the module's own
    // refusal rather than a blank screen.
    if (module === "specialty_quotes" && moduleAccess.specialtyQuotes) {
      return (
        <Suspense fallback={<LoadingWorkspace label="Specialty Quotes" />}>
          <SpecialtyWorkspace
            initialProfile={profile}
            embedded
            activeSection={subNavToSpecialtySection(subNav)}
          />
        </Suspense>
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
    if (module === "user_admin" && (permissions.userAdministration || permissions.sourceAdministration)) {
      // Quoting Teams is a settings screen, so it lives here rather than adding a
      // fourth destination to Specialty Quotes.
      if (subNav === "ua_quoting_teams") {
        return (
          <Suspense fallback={<LoadingWorkspace label="Quoting Teams" />}>
            <QuotingTeamsAdmin initialProfile={profile} embedded />
          </Suspense>
        );
      }
      // Market Directory is a settings screen for managing submission markets.
      if (subNav === "ua_market_directory") {
        return (
          <Suspense fallback={<LoadingWorkspace label="Market Directory" />}>
            <MarketDirectoryAdmin initialProfile={profile} embedded />
          </Suspense>
        );
      }
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
      moduleAccess={moduleAccess}
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
