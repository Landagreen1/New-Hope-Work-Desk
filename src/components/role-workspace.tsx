"use client";

import {
  ClipboardCheck,
  FileSpreadsheet,
  Headphones,
  LayoutDashboard,
  RefreshCw,
  UploadCloud,
  UsersRound,
} from "lucide-react";
import { Suspense, useMemo, useState } from "react";

import { WorkDeskApp } from "@/components/work-desk-app";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import IntakeQueue from "@/features/cs-intake/IntakeQueue";
import type { ProfileLite } from "@/features/nhwd-shared/types";
import PowerBiRenewalImport from "@/features/renewals/PowerBiRenewalImport";
import RenewalsPage from "@/features/renewals/RenewalsPage";
import type { DashboardData, SessionProfile } from "@/lib/types";

type WorkspaceTab =
  | "desk"
  | "quote_intake"
  | "intake_queue"
  | "customer_service"
  | "renewals"
  | "powerbi";

interface TabDefinition {
  id: WorkspaceTab;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
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
    <div className="mx-auto max-w-[1700px] px-4 py-3 sm:px-6 lg:px-8">
      <div className="flex gap-2 overflow-x-auto rounded-2xl border border-[#c9d5e9] bg-white p-1.5 shadow-sm">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`group flex min-w-fit items-center gap-3 rounded-xl px-4 py-3 text-left transition ${
                selected
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-600 hover:bg-[#eef3fb] hover:text-[#223f7a]"
              }`}
            >
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl ${
                  selected ? "bg-white/15" : "bg-slate-100 group-hover:bg-white"
                }`}
              >
                <Icon className="h-4 w-4" />
              </span>
              <span>
                <span className="block text-sm font-black">{tab.label}</span>
                <span
                  className={`hidden text-[10px] font-semibold sm:block ${
                    selected ? "text-blue-100" : "text-slate-400"
                  }`}
                >
                  {tab.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
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
              Quote intake and Sales handoff
            </h2>
            <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
              Review Customer Service intakes, return incomplete records, assign
              submitted requests, and confirm that completed intakes become
              Quotes Database records.
            </p>
          </div>
          <div className="flex gap-1 rounded-2xl border border-slate-200 bg-white p-1.5">
            <button
              type="button"
              onClick={() => setTab("intakes")}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black ${
                tab === "intakes"
                  ? "bg-[#223f7a] text-white"
                  : "text-slate-500 hover:bg-slate-100"
              }`}
            >
              <Headphones className="h-4 w-4" />
              Quote Intakes
            </button>
            <button
              type="button"
              onClick={() => setTab("queue")}
              className={`inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black ${
                tab === "queue"
                  ? "bg-[#223f7a] text-white"
                  : "text-slate-500 hover:bg-slate-100"
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
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("desk");

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

  const tabs = useMemo<TabDefinition[]>(() => {
    if (sessionProfile.role === "customer_service") {
      return [
        {
          id: "desk",
          label: "Work Desk",
          description: "Assigned service work",
          icon: LayoutDashboard,
        },
        {
          id: "quote_intake",
          label: "Customer Quote",
          description: "Collect quote information",
          icon: Headphones,
        },
        {
          id: "renewals",
          label: "Renewals",
          description: "My renewal follow-up",
          icon: FileSpreadsheet,
        },
      ];
    }

    if (sessionProfile.role === "manager") {
      return [
        {
          id: "desk",
          label: "Work Desk",
          description: "Queues, quotes and reports",
          icon: LayoutDashboard,
        },
        {
          id: "customer_service",
          label: "Customer Service",
          description: "Intakes and Sales handoff",
          icon: UsersRound,
        },
        {
          id: "renewals",
          label: "Renewals",
          description: "Pipeline and assignments",
          icon: FileSpreadsheet,
        },
        {
          id: "powerbi",
          label: "Power BI Upload",
          description: "Import and update renewal data",
          icon: UploadCloud,
        },
      ];
    }

    return [
      {
        id: "desk",
        label: "Work Desk",
        description: "Sales rotations and quotes",
        icon: LayoutDashboard,
      },
      {
        id: "intake_queue",
        label: "Intake Queue",
        description: "Claim Customer Service quotes",
        icon: ClipboardCheck,
      },
      {
        id: "renewals",
        label: "Renewals",
        description: "My assigned renewals",
        icon: FileSpreadsheet,
      },
    ];
  }, [sessionProfile.role]);

  let externalWorkspaceContent: React.ReactNode | undefined;

  if (activeTab === "quote_intake") {
    externalWorkspaceContent = (
      <Suspense fallback={<LoadingWorkspace label="Customer Quote" />}>
        <CsIntakeLanding initialProfile={profile} embedded />
      </Suspense>
    );
  } else if (activeTab === "intake_queue") {
    externalWorkspaceContent = <IntakeQueue initialProfile={profile} embedded />;
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
        showImportTab={false}
      />
    );
  } else if (activeTab === "powerbi") {
    externalWorkspaceContent = (
      <PowerBiRenewalImport initialProfile={profile} embedded />
    );
  }

  return (
    <WorkDeskApp
      sessionProfile={sessionProfile}
      initialData={initialData}
      workspaceTabs={
        <WorkspaceTabs
          tabs={tabs}
          active={activeTab}
          onChange={setActiveTab}
        />
      }
      externalWorkspaceContent={externalWorkspaceContent}
    />
  );
}
