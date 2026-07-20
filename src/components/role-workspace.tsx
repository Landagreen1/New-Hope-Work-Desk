"use client";

import {
  Building2,
  ClipboardCheck,
  Clock,
  FileSpreadsheet,
  Headphones,
  LayoutDashboard,
  RefreshCw,
  UserCog,
  UsersRound,
} from "lucide-react";
import { Suspense, useMemo, useState } from "react";

import { WorkDeskApp } from "@/components/work-desk-app";
import CommercialWorkspace from "@/features/commercial/CommercialWorkspace";
import TimeAttendanceWorkspace from "@/features/time-attendance/TimeAttendanceWorkspace";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import IntakeQueue from "@/features/cs-intake/IntakeQueue";
import type { ProfileLite } from "@/features/nhwd-shared/types";
import RenewalsPage from "@/features/renewals/RenewalsPage";
import WorkloadLog from "@/features/workload/WorkloadLog";
import type { DashboardData, SessionProfile } from "@/lib/types";

type WorkspaceTab =
  | "desk"
  | "quote_intake"
  | "customer_service"
  | "renewals"
  | "commercial_board"
  | "user_admin"
  | "time_attendance";

interface TabDefinition {
  id: WorkspaceTab;
  label: string;
  shortLabel?: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  /** When true, a visual separator appears before this tab */
  dividerBefore?: boolean;
}

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

function WorkspaceTabs({
  tabs,
  active,
  onChange,
}: {
  tabs: TabDefinition[];
  active: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="mx-auto max-w-[1700px] px-4 py-4 sm:px-6 lg:px-8">
      <nav
        role="tablist"
        className="flex items-center gap-1 overflow-x-auto rounded-2xl border border-[#d4dff0] bg-gradient-to-b from-white to-[#f8fafd] p-1.5 shadow-sm"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = active === tab.id;
          return (
            <div key={tab.id} className="flex items-center">
              {tab.dividerBefore && (
                <div className="mx-1.5 h-8 w-px shrink-0 bg-slate-200" />
              )}
              <button
                role="tab"
                type="button"
                aria-selected={selected}
                onClick={() => onChange(tab.id)}
                className={`group relative flex min-w-fit items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-left transition-all duration-200 sm:gap-3 sm:px-4 sm:py-3 ${
                  selected
                    ? "bg-gradient-to-b from-[#223f7a] to-[#1a3265] text-white shadow-md shadow-[#223f7a]/20"
                    : "text-slate-500 hover:bg-white hover:text-[#223f7a] hover:shadow-sm"
                }`}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg transition-colors sm:h-9 sm:w-9 sm:rounded-xl ${
                    selected
                      ? "bg-white/15"
                      : "bg-slate-100/80 group-hover:bg-[#eef3fb]"
                  }`}
                >
                  <Icon
                    className={`h-4 w-4 ${selected ? "text-white" : "text-slate-400 group-hover:text-[#223f7a]"}`}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-black sm:text-sm">
                    <span className="sm:hidden">
                      {tab.shortLabel ?? tab.label}
                    </span>
                    <span className="hidden sm:inline">{tab.label}</span>
                  </span>
                  <span
                    className={`hidden truncate text-[10px] font-semibold leading-tight lg:block ${
                      selected ? "text-blue-200" : "text-slate-400"
                    }`}
                  >
                    {tab.description}
                  </span>
                </span>
                {selected && (
                  <span className="absolute inset-x-3 -bottom-[7px] h-[3px] rounded-full bg-[#223f7a] sm:inset-x-4" />
                )}
              </button>
            </div>
          );
        })}
      </nav>
    </div>
  );
}

function ManagerCustomerServiceWorkspace({
  profile,
}: {
  profile: ProfileLite;
}) {
  const [tab, setTab] = useState<"intakes" | "queue">("intakes");

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

export function RoleWorkspace({
  sessionProfile,
  initialData,
}: {
  sessionProfile: SessionProfile;
  initialData: DashboardData;
}) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(
    sessionProfile.role === "commercial" ? "commercial_board" : "desk",
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

  /**
   * Tab structure (reworked for department alignment):
   *
   * ALL departments share: Work Desk → Customer Quote → Intake Queue → Renewals
   * (ordered by workflow progression: desk → create intake → claim intake → renewals)
   *
   * Management additionally gets: Customer Service (oversight), Power BI Upload
   * (separated visually with a divider)
   *
   * Future: Commercial, Homes, Trucking lines will add line-specific tabs.
   */
  const tabs = useMemo<TabDefinition[]>(() => {
    // --- Shared tabs in workflow order ---
    const sharedTabs: TabDefinition[] = [
      {
        id: "desk",
        label: "Sales",
        shortLabel: "Sales",
        description:
          sessionProfile.role === "manager"
            ? "Queues, quotes and reports"
            : sessionProfile.role === "customer_service"
              ? "Assigned service work"
              : "Sales rotations and quotes",
        icon: LayoutDashboard,
      },
      {
        id: "renewals",
        label: "Renewals",
        shortLabel: "Renewals",
        description:
          sessionProfile.role === "manager"
            ? "Pipeline and assignments"
            : "My renewal follow-up",
        icon: FileSpreadsheet,
      },
      {
        id: "time_attendance",
        label: "Time & Attendance",
        shortLabel: "Clock",
        description: "Clock in, schedule, PTO",
        icon: Clock,
      },
    ];

    // --- Management layout: streamlined tabs ---
    if (sessionProfile.role === "manager") {
      return [
        {
          id: "desk" as WorkspaceTab,
          label: "Sales",
          shortLabel: "Sales",
          description: "Turns, quotes and reports",
          icon: LayoutDashboard,
        },
        {
          id: "customer_service" as WorkspaceTab,
          label: "Customer Service",
          shortLabel: "CS",
          description: "Quote intake and sales handoff",
          icon: UsersRound,
        },
        {
          id: "commercial_board" as WorkspaceTab,
          label: "Commercial Board",
          shortLabel: "Commercial",
          description: "Commercial policies Kanban",
          icon: Building2,
        },
        {
          id: "renewals" as WorkspaceTab,
          label: "Renewals",
          shortLabel: "Renewals",
          description: "Pipeline, assignments and import",
          icon: FileSpreadsheet,
        },
        {
          id: "time_attendance" as WorkspaceTab,
          label: "Time & Attendance",
          shortLabel: "Clock",
          description: "Clock, schedules, PTO, payroll",
          icon: Clock,
          dividerBefore: true,
        },
        {
          id: "user_admin" as WorkspaceTab,
          label: "User Admin",
          shortLabel: "Users",
          description: "Users, access and sources",
          icon: UserCog,
        },
      ];
    }

    // Commercial role: Commercial Board + Time & Attendance
    if (sessionProfile.role === "commercial") {
      return [
        {
          id: "commercial_board" as WorkspaceTab,
          label: "Commercial Board",
          shortLabel: "Commercial",
          description: "Your commercial policies pipeline",
          icon: Building2,
        },
        {
          id: "time_attendance" as WorkspaceTab,
          label: "Time & Attendance",
          shortLabel: "Clock",
          description: "Clock in, schedule, PTO",
          icon: Clock,
        },
      ];
    }

    // Sales (agent) and Customer Service get the shared tabs
    return sharedTabs;
  }, [sessionProfile.role]);

  let externalWorkspaceContent: React.ReactNode | undefined;

  if (activeTab === "quote_intake") {
    externalWorkspaceContent = (
      <Suspense fallback={<LoadingWorkspace label="Customer Quote" />}>
        <CsIntakeLanding initialProfile={profile} embedded />
      </Suspense>
    );
  } else if (activeTab === "customer_service") {
    externalWorkspaceContent = (
      <ManagerCustomerServiceWorkspace profile={profile} />
    );
  } else if (activeTab === "renewals") {
    externalWorkspaceContent = (
      <RenewalsPage
        initialProfile={profile}
        embedded
        initialTab={sessionProfile.role === "manager" ? "pipeline" : "overview"}
        showImportTab={sessionProfile.role === "manager"}
      />
    );
  } else if (activeTab === "commercial_board") {
    externalWorkspaceContent = (
      <Suspense fallback={<LoadingWorkspace label="Commercial Board" />}>
        <CommercialWorkspace initialProfile={profile} embedded />
      </Suspense>
    );
  } else if (activeTab === "time_attendance") {
    externalWorkspaceContent = (
      <Suspense fallback={<LoadingWorkspace label="Time & Attendance" />}>
        <TimeAttendanceWorkspace initialProfile={profile} embedded />
      </Suspense>
    );
  }

  // When user_admin tab is selected, we tell WorkDeskApp to show its administration panel
  const forceManagerTab = activeTab === "user_admin" ? "administration" as const : undefined;

  return (
    <WorkDeskApp
      sessionProfile={sessionProfile}
      initialData={initialData}
      forceManagerTab={forceManagerTab}
      workspaceTabs={
        <WorkspaceTabs
          tabs={tabs}
          active={activeTab}
          onChange={setActiveTab}
        />
      }
      externalWorkspaceContent={externalWorkspaceContent}
      workloadDatabaseContent={
        <WorkloadLog initialProfile={profile} embedded />
      }
    />
  );
}
