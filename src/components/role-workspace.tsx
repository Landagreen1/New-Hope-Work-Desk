"use client";

import {
  ClipboardCheck,
  Headphones,
  RefreshCw,
} from "lucide-react";
import { Suspense, useCallback, useMemo, useState } from "react";

import { SidebarLayout, type NavigationState, type SubNavId } from "@/components/sidebar-layout";
import { WorkDeskApp } from "@/components/work-desk-app";
import CommercialWorkspace from "@/features/commercial/CommercialWorkspace";
import TimeAttendanceWorkspace from "@/features/time-attendance/TimeAttendanceWorkspace";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import IntakeQueue from "@/features/cs-intake/IntakeQueue";
import type { ProfileLite } from "@/features/nhwd-shared/types";
import RenewalsPage from "@/features/renewals/RenewalsPage";
import WorkloadLog from "@/features/workload/WorkloadLog";
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

  return (
    <div className="space-y-5">
      <section className="rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#eef3fb] p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
              Customer Service Management
            </p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
              Quote Intake &amp; Sales Handoff
            </h2>
            <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
              Review intakes, return incomplete records, assign submitted
              requests, and confirm that completed intakes become Quotes Database
              records.
            </p>
          </div>
          <div className="flex gap-0.5 rounded-2xl border border-slate-200 bg-white p-1">
            <button
              type="button"
              onClick={() => setTab("intakes")}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition-all ${
                tab === "intakes"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              }`}
            >
              <Headphones className="h-4 w-4" />
              Quote Intakes
            </button>
            <button
              type="button"
              onClick={() => setTab("queue")}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition-all ${
                tab === "queue"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-slate-50 hover:text-slate-700"
              }`}
            >
              <ClipboardCheck className="h-4 w-4" />
              Sales Queue
            </button>
          </div>
        </div>
      </section>

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
  const [navigation, setNavigation] = useState<NavigationState>(
    () => getDefaultNav(sessionProfile.role),
  );

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
      return (
        <Suspense fallback={<LoadingWorkspace label="Time & Attendance" />}>
          <TimeAttendanceWorkspace initialProfile={profile} embedded />
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
      navigation={navigation}
      onNavigate={handleNavigate}
    >
      {renderContent()}
    </SidebarLayout>
  );
}
