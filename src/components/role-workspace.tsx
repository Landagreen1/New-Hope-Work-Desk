"use client";

import {
  RefreshCw,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { SidebarLayout, type NavigationState, type SubNavId } from "@/components/sidebar-layout";
import { WorkDeskApp } from "@/components/work-desk-app";
import CommercialWorkspace from "@/features/commercial/CommercialWorkspace";
import TimeAttendanceWorkspace from "@/features/time-attendance/TimeAttendanceWorkspace";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import IntakeQueue from "@/features/cs-intake/IntakeQueue";
import type { ProfileLite } from "@/features/nhwd-shared/types";
import RenewalsPage from "@/features/renewals/RenewalsPage";
import WorkloadLog from "@/features/workload/WorkloadLog";
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
  const [tab, setTab] = useState<"intakes" | "queue">(initialSubNav ?? "intakes");

  // Sync with sidebar navigation changes
  useEffect(() => {
    if (initialSubNav) setTab(initialSubNav);
  }, [initialSubNav]);

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

function getDefaultNav(role: string): NavigationState {
  if (role === "commercial") {
    return { module: "commercial", subNav: "commercial_board" };
  }
  if (role === "manager" || role === "super_admin") {
    return { module: "sales", subNav: "sales_overview" };
  }
  if (role === "customer_service") {
    return { module: "sales", subNav: "sales_desk" };
  }
  // agent
  return { module: "sales", subNav: "sales_desk" };
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
    () => getDefaultNav(sessionProfile.role),
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

  const handleNavigate = useCallback((nav: NavigationState) => {
    setNavigation(nav);
  }, []);

  const isManager = sessionProfile.role === "manager" || sessionProfile.role === "super_admin";

  // Determine what content to render based on sidebar navigation state
  const renderContent = () => {
    const { module, subNav } = navigation;

    // --- Sales module: delegate to WorkDeskApp ---
    if (module === "sales") {
      const forceManagerTab = isManager ? subNavToManagerTab(subNav) : undefined;
      const forceAgentTab = !isManager ? subNavToAgentTab(subNav) : undefined;

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
    if (module === "customer_service") {
      const csSubTab = subNav === "cs_queue" ? "queue" : "intakes";
      return (
        <ManagerCustomerServiceWorkspace
          profile={profile}
          initialSubNav={csSubTab}
        />
      );
    }

    // --- Commercial ---
    if (module === "commercial") {
      return (
        <Suspense fallback={<LoadingWorkspace label="Commercial Board" />}>
          <CommercialWorkspace initialProfile={profile} embedded />
        </Suspense>
      );
    }

    // --- Renewals ---
    if (module === "renewals") {
      return (
        <RenewalsPage
          initialProfile={profile}
          embedded
          initialTab={isManager ? "pipeline" : "overview"}
          showImportTab={isManager}
        />
      );
    }

    // --- Time & Attendance ---
    if (module === "time_attendance") {
      const taSection = subNav === "ta_schedule" ? "schedule"
        : subNav === "ta_pto" ? "pto"
        : subNav === "ta_payroll" ? "payroll"
        : subNav === "ta_staffing" ? "staffing"
        : subNav === "ta_workforce" ? "workforce"
        : "clock";
      return (
        <Suspense fallback={<LoadingWorkspace label="Time & Attendance" />}>
          <TimeAttendanceWorkspace initialProfile={profile} embedded activeSection={taSection} />
        </Suspense>
      );
    }

    // --- User Administration ---
    if (module === "user_admin") {
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
      navigation={navigation}
      onNavigate={handleNavigate}
      onSignOut={() => void handleSignOut()}
    >
      {renderContent()}
    </SidebarLayout>
  );
}
