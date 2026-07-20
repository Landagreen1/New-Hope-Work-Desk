"use client";

import {
  Activity,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  BarChart3,
  Bell,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  CircleDollarSign,
  ClipboardList,
  Clock3,
  DollarSign,
  Download,
  FileText,
  FilePlus2,
  Gauge,
  KeyRound,
  Layers3,
  ListChecks,
  LogOut,
  MessageCircleMore,
  PhoneCall,
  Pencil,
  PieChart,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Store,
  ShieldCheck,
  SkipForward,
  Sparkles,
  Table2,
  TrendingUp,
  Trash2,
  UserPlus,
  UsersRound,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { loadDashboardData } from "@/lib/dashboard-data";
import { createClient } from "@/lib/supabase/client";
import CsIntakeLanding from "@/features/cs-intake/CsIntakeLanding";
import IntakeQueue from "@/features/cs-intake/IntakeQueue";
import type {
  Agent,
  CustomerServiceUser,
  AlertNotification,
  DashboardData,
  SourceOption,
  DealerSalesperson,
  AssignmentMethod,
  AvailabilityStatus,
  PassEvent,
  PendingPricingItem,
  PerformanceRow,
  NotSoldReason,
  QuoteOutcome,
  QuoteNote,
  QuoteActivity,
  QuoteTakeEvent,
  QuoteTakeTimer,
  WorkDeskSettings,
  RotationKind,
  SessionProfile,
  WorkItem,
  WorkType,
} from "@/lib/types";

import IntakeDataDisplay, { type IntakeDataDetails } from "@/features/cs-intake/IntakeDataDisplay";

const workTypeLabels: Record<WorkType, string> = {
  new_quote: "New Quote",
  requote: "Requote",
  activation: "Activation",
  change: "Change",
  whatsapp_update: "WhatsApp Update",
  payment: "Payment",
};

const methodStyles: Record<
  AssignmentMethod,
  { label: string; className: string }
> = {
  whatsapp_turn: {
    label: "WhatsApp Turn",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  ringcentral_turn: {
    label: "RingCentral Turn",
    className: "bg-blue-50 text-blue-700 ring-blue-200",
  },
  workload_turn: {
    label: "Workload Turn",
    className: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  owner: { label: "Owner", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  update_log: {
    label: "Update · No Turn",
    className: "bg-amber-50 text-amber-800 ring-amber-200",
  },
  manager_manual: {
    label: "Manager Assigned",
    className: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200",
  },
  manual_quote: {
    label: "Manual Quote · No Turn",
    className: "bg-slate-100 text-slate-700 ring-slate-200",
  },
  manual_workload: {
    label: "Manual Workload · No Turn",
    className: "bg-violet-50 text-violet-700 ring-violet-200",
  },
  payment_log: {
    label: "Payment · No Turn",
    className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  },
  customer_service: {
    label: "Customer Service",
    className: "bg-cyan-50 text-cyan-700 ring-cyan-200",
  },
};

const rotationConfig: Record<
  RotationKind,
  {
    title: string;
    shortTitle: string;
    description: string;
    action: string;
    icon: React.ReactNode;
    accent: string;
    soft: string;
    ring: string;
    button: string;
  }
> = {
  whatsapp: {
    title: "WhatsApp New Quotes",
    shortTitle: "WhatsApp",
    description: "Brand-new WhatsApp source quotes only.",
    action: "Take New Quote",
    icon: <MessageCircleMore className="h-4 w-4" />,
    accent: "text-emerald-700",
    soft: "bg-emerald-50",
    ring: "ring-emerald-200",
    button: "bg-emerald-600 hover:bg-emerald-700",
  },
  ringcentral: {
    title: "RingCentral Quotes / Requotes",
    shortTitle: "RingCentral",
    description: "New quotes and requotes from RingCentral.",
    action: "Take RC Quote",
    icon: <PhoneCall className="h-4 w-4" />,
    accent: "text-blue-700",
    soft: "bg-blue-50",
    ring: "ring-blue-200",
    button: "bg-blue-600 hover:bg-blue-700",
  },
  workload: {
    title: "Additional Workload",
    shortTitle: "Workload",
    description: "Redistributed activations and changes.",
    action: "Take Workload",
    icon: <Layers3 className="h-4 w-4" />,
    accent: "text-violet-700",
    soft: "bg-violet-50",
    ring: "ring-violet-200",
    button: "bg-violet-600 hover:bg-violet-700",
  },
};

const agentAccentCycle = [
  "from-[#223f7a] to-[#4d6aa8]",
  "from-[#2b4b87] to-[#6b84b5]",
  "from-[#17305f] to-[#45639d]",
  "from-[#355795] to-[#7890bc]",
];

function accentForAgent(agent: Agent) {
  return agentAccentCycle[
    (agent.rotationPosition - 1) % agentAccentCycle.length
  ];
}

type ModalType =
  | "whatsapp_quote"
  | "ringcentral_quote"
  | "workload_turn"
  | "manual_workload"
  | "payment"
  | "manual_quote"
  | "manager_assign_quote"
  | "quote_result"
  | "not_sold_reason"
  | "take_quote"
  | "quote_log"
  | "customer_service_pass"
  | "change_outcome"
  | null;
type AgentTab = "desk" | "pricing" | "intake_queue" | "quotes" | "team" | "performance";
type ManagerTab =
  | "overview"
  | "work"
  | "intake_queue"
  | "quotes"
  | "reports"
  | "team"
  | "administration";
type ReportView =
  | "executive"
  | "not_sold"
  | "exceptions"
  | "funnel"
  | "trends"
  | "agents"
  | "scorecard"
  | "workload"
  | "queues"
  | "taken"
  | "missed"
  | "passes"
  | "followup"
  | "documentation"
  | "channels"
  | "sources"
  | "service"
  | "activation"
  | "manager"
  | "integrity"
  | "system"
  | "timing"
  | "activity";

type ReportNavigationItem = {
  id: ReportView;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
};

type ReportNavigationGroup = {
  label: string;
  description: string;
  items: ReportNavigationItem[];
};

const reportNavigationGroups: ReportNavigationGroup[] = [
  {
    label: "Command Center",
    description: "Start here for priorities and daily direction.",
    items: [
      {
        id: "executive",
        label: "Executive Overview",
        description:
          "Top operating and sales indicators for the selected period.",
        icon: Gauge,
      },
      {
        id: "not_sold",
        label: "Not Sold Quotes",
        description:
          "Review every lost quote, its reason, timing, source, agent, and documentation.",
        icon: XCircle,
      },
      {
        id: "trends",
        label: "Daily Operations",
        description: "Day-by-day quote, sales, queue, and service movement.",
        icon: BarChart3,
      },
    ],
  },
  {
    label: "Sales",
    description: "Conversion, sources, channels, and speed.",
    items: [
      {
        id: "funnel",
        label: "Sales Funnel",
        description: "Follow quotes from receipt through Sold or Not Sold.",
        icon: TrendingUp,
      },
      {
        id: "sources",
        label: "Source Intelligence",
        description:
          "Compare volume, conversion, aging, and source opportunity.",
        icon: Table2,
      },
      {
        id: "channels",
        label: "Input Methods",
        description:
          "Compare WhatsApp, RingCentral, phone, walk-in, and other channels.",
        icon: PieChart,
      },
      {
        id: "timing",
        label: "Quote Timing",
        description:
          "Measure assignment, acceptance, pricing, and final-decision speed.",
        icon: Clock3,
      },
    ],
  },
  {
    label: "People",
    description: "Performance, capacity, and documentation.",
    items: [
      {
        id: "scorecard",
        label: "Agent 360",
        description:
          "Balanced agent scorecards across sales, speed, queues, and follow-up.",
        icon: Sparkles,
      },
      {
        id: "agents",
        label: "Agent Comparison",
        description:
          "Side-by-side operating and sales results for every agent.",
        icon: UsersRound,
      },
      {
        id: "workload",
        label: "Workload Capacity",
        description:
          "Open work, pending pricing, and workload distribution by agent.",
        icon: BriefcaseBusiness,
      },
      {
        id: "documentation",
        label: "Documentation Quality",
        description:
          "Note coverage, follow-up history, and documentation gaps.",
        icon: Pencil,
      },
    ],
  },
  {
    label: "Queues",
    description: "Turn health, missed windows, and rescue activity.",
    items: [
      {
        id: "queues",
        label: "Queue Health",
        description:
          "Queue volume, passes, manual changes, and distribution health.",
        icon: ListChecks,
      },
      {
        id: "taken",
        label: "Taken Quotes",
        description:
          "Quotes rescued after the current agent’s single response timer expired.",
        icon: Zap,
      },
      {
        id: "missed",
        label: "Missed Turns",
        description:
          "Current agents whose 3-minute response timer expired before another agent rescued the quote.",
        icon: SkipForward,
      },
      {
        id: "passes",
        label: "Pass Behavior",
        description: "Pass volume, reasons, and patterns by agent and queue.",
        icon: RefreshCw,
      },
    ],
  },
  {
    label: "Service",
    description: "Follow-up, activations, changes, and payments.",
    items: [
      {
        id: "followup",
        label: "Pending Follow-Up",
        description:
          "Aging, stale activity, and pending-pricing follow-up status.",
        icon: Clock3,
      },
      {
        id: "service",
        label: "Service Work",
        description:
          "Activations, changes, payments, and open service workload.",
        icon: Layers3,
      },
      {
        id: "activation",
        label: "Activation & Sold Audit",
        description:
          "Verify Sold credit, activation users, and missing activation history.",
        icon: CheckCircle2,
      },
      {
        id: "activity",
        label: "Raw Activity",
        description:
          "Detailed operational activity for deeper review and export.",
        icon: Activity,
      },
    ],
  },
  {
    label: "Control",
    description: "Management oversight, accuracy, and system integrity.",
    items: [
      {
        id: "exceptions",
        label: "Needs Attention",
        description:
          "Urgent exceptions, stalled work, and manager action items.",
        icon: AlertTriangle,
      },
      {
        id: "manager",
        label: "Manager Actions",
        description: "Assignments, reassignments, interventions, and outcomes.",
        icon: ShieldCheck,
      },
      {
        id: "integrity",
        label: "Data Integrity",
        description:
          "Duplicates, missing information, and workflow inconsistencies.",
        icon: AlertTriangle,
      },
      {
        id: "system",
        label: "System Health",
        description: "Queue, reset, data-link, and production health checks.",
        icon: Settings2,
      },
    ],
  },
];

const reportNavigationItems = reportNavigationGroups.flatMap(
  (group) => group.items,
);
type ManagerQuoteStage = "active" | "pending" | "finalized";
type QuoteRecord = {
  id: string;
  sourceWorkItemId: string;
  stage: ManagerQuoteStage;
  status: "Active" | "Price Sent" | "Sold" | "Not Sold";
  statusDate: string;
  createdAt: string;
  customer: string;
  source: string;
  salesperson: string;
  salespersonId?: string;
  agent: string;
  assignedProfileId: string;
  workType: "new_quote" | "requote";
  receivedThrough: string;
  takeEvent?: QuoteTakeEvent;
};

type AdminUserAccount = {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  role: "agent" | "manager" | "customer_service" | "commercial";
  rotation_position: number;
  availability: AvailabilityStatus;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
};

type TemporaryCredential = {
  username: string;
  displayName: string;
  temporaryPassword: string;
};

type PerformanceMetricKey =
  | "whatsappQuotes"
  | "ringCentralQuotes"
  | "workloadTurns"
  | "whatsappUpdates"
  | "manualQuotes"
  | "soldQuotes"
  | "passedTurns";
const performanceMetricKeys: PerformanceMetricKey[] = [
  "whatsappQuotes",
  "ringCentralQuotes",
  "workloadTurns",
  "whatsappUpdates",
  "manualQuotes",
  "soldQuotes",
  "passedTurns",
];

const notSoldReasonLabels: Record<NotSoldReason, string> = {
  price_too_high: "Price too high",
  chose_another_option: "Customer chose another option",
  no_response: "No response from customer / source",
  no_longer_needed: "Customer no longer needs coverage",
  other: "Other",
};

type NotSoldTarget =
  | { kind: "active"; item: WorkItem }
  | { kind: "pending"; item: PendingPricingItem }
  | null;

function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function isQuote(item: WorkItem) {
  return item.workType === "new_quote" || item.workType === "requote";
}

function buildQuoteRecords(
  workItems: WorkItem[],
  pendingPricing: PendingPricingItem[],
  quoteOutcomes: QuoteOutcome[],
  quoteTakeEvents: QuoteTakeEvent[] = [],
): QuoteRecord[] {
  const takeBySource = new Map(
    quoteTakeEvents.map((event) => [event.sourceWorkItemId, event]),
  );
  const rows: QuoteRecord[] = [
    ...workItems.filter(isQuote).map((item) => ({
      id: item.id,
      sourceWorkItemId: item.id,
      stage: "active" as const,
      status: "Active" as const,
      statusDate: item.createdAt,
      createdAt: item.createdAt,
      customer: item.customer,
      source: item.dealer,
      salesperson: item.salesperson || "Not recorded",
      salespersonId: item.salespersonId,
      agent: item.assignedAgent,
      assignedProfileId: item.assignedProfileId,
      workType: item.workType as "new_quote" | "requote",
      receivedThrough: item.receivedThrough || "Unknown",
      takeEvent: takeBySource.get(item.id),
    })),
    ...pendingPricing.map((item) => ({
      id: item.id,
      sourceWorkItemId: item.sourceWorkItemId,
      stage: "pending" as const,
      status: "Price Sent" as const,
      statusDate: item.priceSentAt,
      createdAt: item.quoteCreatedAt,
      customer: item.customer,
      source: item.dealer,
      salesperson: item.salesperson || "Not recorded",
      salespersonId: item.salespersonId,
      agent: item.assignedAgent,
      assignedProfileId: item.assignedProfileId,
      workType: item.workType,
      receivedThrough: item.receivedThrough || "Unknown",
      takeEvent: takeBySource.get(item.sourceWorkItemId),
    })),
    ...quoteOutcomes.map((item) => ({
      id: item.id,
      sourceWorkItemId: item.sourceWorkItemId,
      stage: "finalized" as const,
      status:
        item.decision === "sold" ? ("Sold" as const) : ("Not Sold" as const),
      statusDate: item.finalizedAt,
      createdAt: item.quoteCreatedAt,
      customer: item.customer,
      source: item.dealer,
      salesperson: item.salesperson || "Not recorded",
      salespersonId: item.salespersonId,
      agent: item.assignedAgent,
      assignedProfileId: item.assignedProfileId,
      workType: item.workType,
      receivedThrough: item.receivedThrough || "Unknown",
      takeEvent: takeBySource.get(item.sourceWorkItemId),
    })),
  ];
  return rows.sort(
    (a, b) =>
      new Date(b.statusDate).getTime() - new Date(a.statusDate).getTime(),
  );
}

function isActiveTask(item: WorkItem) {
  return item.status === "active" && item.workType !== "whatsapp_update";
}

function rotationEligibility(agent: Agent, rotation: RotationKind) {
  if (rotation === "whatsapp") return agent.whatsappActive;
  if (rotation === "ringcentral") return agent.ringCentralActive;
  return agent.workloadActive;
}

function queuePosition(agent: Agent, rotation: RotationKind) {
  if (rotation === "whatsapp") return agent.whatsappPosition;
  if (rotation === "ringcentral") return agent.ringCentralPosition;
  return agent.workloadPosition;
}

function orderedAgents(agentList: Agent[], rotation: RotationKind) {
  return [...agentList].sort(
    (a, b) => queuePosition(a, rotation) - queuePosition(b, rotation),
  );
}

function nextEligibleAgent(
  agentList: Agent[],
  currentId: string,
  rotation: RotationKind,
) {
  const queue = orderedAgents(agentList, rotation);
  const currentIndex = queue.findIndex((agent) => agent.id === currentId);
  if (currentIndex < 0) return currentId;
  for (let step = 1; step <= queue.length; step += 1) {
    const candidate = queue[(currentIndex + step) % queue.length];
    if (
      candidate.availability === "available" &&
      rotationEligibility(candidate, rotation)
    )
      return candidate.id;
  }
  return currentId;
}

function upcomingAgents(
  agentList: Agent[],
  currentId: string,
  rotation: RotationKind,
  count = 3,
) {
  const output: Agent[] = [];
  let pointer = currentId;
  while (output.length < count && output.length < agentList.length - 1) {
    const nextId = nextEligibleAgent(agentList, pointer, rotation);
    if (nextId === currentId || output.some((agent) => agent.id === nextId))
      break;
    const agent = agentList.find((item) => item.id === nextId);
    if (!agent) break;
    output.push(agent);
    pointer = nextId;
  }
  return output;
}

function formatElapsedSeconds(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const remaining = safe % 60;
  return `${minutes}m ${String(remaining).padStart(2, "0")}s`;
}

function localDateTimeInputValue(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

const quoteActivityLabels: Record<string, string> = {
  created: "Quote created",
  assigned: "Quote assigned",
  accepted: "Assignment accepted",
  reassigned: "Reassigned",
  price_sent: "Price sent",
  sold: "Marked Sold",
  not_sold: "Marked Not Sold",
  completed: "Work completed",
  cancelled: "Work cancelled",
  taken: "Quote stolen after timer",
  timer_claimed: "Timed quote claimed",
  customer_service_handoff: "Passed to Customer Service",
  activation: "Activation logged",
  change: "Change logged",
  payment: "Payment logged",
  created_from_cs_intake: "Created from CS Intake",
  ringcentral_intake_claim_completed: "RC Intake Claimed & Converted",
  outcome_change: "Outcome Changed",
};

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function daysSince(value: string) {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000),
  );
}

function durationMinutes(start?: string, end?: string) {
  if (!start || !end) return null;
  return Math.max(
    0,
    (new Date(end).getTime() - new Date(start).getTime()) / 60_000,
  );
}

function formatDuration(minutes: number | null) {
  if (minutes === null || Number.isNaN(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440)
    return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function matchesCalendarDay(value: string, day: string) {
  if (!day) return true;
  return dateInputValue(new Date(value)) === day;
}

const quoteUpdateFilterOptions = [
  ["all", "All updates"],
  ["created", "Quote created / taken"],
  ["accepted", "Assignment accepted"],
  ["price_sent", "Price sent"],
  ["sold", "Sold"],
  ["not_sold", "Not Sold"],
  ["activation", "Activation"],
  ["change", "Change"],
  ["taken", "Rescue / stolen quote"],
  ["customer_service_handoff", "Customer Service handoff"],
] as const;

function withinDateRange(value: string, start: string, end: string) {
  const stamp = new Date(value).getTime();
  const startStamp = new Date(`${start}T00:00:00`).getTime();
  const endStamp = new Date(`${end}T23:59:59.999`).getTime();
  return stamp >= startStamp && stamp <= endStamp;
}

function csvEscape(value: unknown) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.map(csvEscape).join(","),
    ...rows.map((row) =>
      headers.map((header) => csvEscape(row[header])).join(","),
    ),
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Avatar({
  agent,
  size = "md",
}: {
  agent: Agent;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = {
    sm: "h-8 w-8 text-xs",
    md: "h-10 w-10 text-sm",
    lg: "h-14 w-14 text-base",
  };
  return (
    <div
      className={cn(
        "grid shrink-0 place-items-center rounded-2xl bg-gradient-to-br font-black text-white shadow-sm",
        sizes[size],
        accentForAgent(agent),
      )}
      aria-label={agent.name}
    >
      {agent.initials}
    </div>
  );
}

function StatusDot({ status }: { status: AvailabilityStatus }) {
  return (
    <span
      className={cn(
        "inline-block h-2.5 w-2.5 rounded-full",
        status === "available" && "bg-emerald-500",
        status === "break" && "bg-amber-500",
        status === "unavailable" && "bg-slate-400",
      )}
    />
  );
}

function MethodBadge({ method }: { method: AssignmentMethod }) {
  const style = methodStyles[method] || {
    label: String(method).replaceAll("_", " "),
    className: "bg-slate-100 text-slate-700 ring-slate-200",
  };
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2.5 py-1 text-[11px] font-black ring-1",
        style.className,
      )}
    >
      {style.label}
    </span>
  );
}

function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-[28px] border border-white/70 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-xl font-black tracking-tight text-slate-950">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
            ) : null}
          </div>
          <button
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function normalizeSourceSearch(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function SourceCombobox({
  sources,
  required = true,
  allowEmpty = false,
  onSelectedIdChange,
}: {
  sources: SourceOption[];
  required?: boolean;
  allowEmpty?: boolean;
  onSelectedIdChange?: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = normalizeSourceSearch(query);
    if (!needle) return sources.slice(0, 12);
    return sources
      .map((dealer) => {
        const normalized = normalizeSourceSearch(dealer.name);
        const score =
          normalized === needle
            ? 0
            : normalized.startsWith(needle)
              ? 1
              : normalized.includes(needle)
                ? 2
                : dealer.name.toLowerCase().includes(query.toLowerCase())
                  ? 3
                  : 99;
        return { dealer, score };
      })
      .filter((row) => row.score < 99)
      .sort(
        (a, b) =>
          a.score - b.score || a.dealer.name.localeCompare(b.dealer.name),
      )
      .slice(0, 12)
      .map((row) => row.dealer);
  }, [sources, query]);

  function updateQuery(value: string) {
    setQuery(value);
    setOpen(true);
    const normalized = normalizeSourceSearch(value);
    const exact = sources.find(
      (dealer) => normalizeSourceSearch(dealer.name) === normalized,
    );
    if (exact) {
      setSelectedId(exact.id);
      onSelectedIdChange?.(exact.id);
    } else {
      setSelectedId("");
      onSelectedIdChange?.("");
    }
  }

  function chooseSource(dealer: SourceOption) {
    setSelectedId(dealer.id);
    onSelectedIdChange?.(dealer.id);
    setQuery(dealer.name);
    setOpen(false);
  }

  return (
    <div className="relative">
      <select
        name="dealer"
        required={required}
        value={selectedId}
        onChange={(event) => {
          setSelectedId(event.target.value);
          onSelectedIdChange?.(event.target.value);
        }}
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
      >
        <option value="">
          {allowEmpty ? "Direct / No source" : "Select source"}
        </option>
        {sources.map((dealer) => (
          <option key={dealer.id} value={dealer.id}>
            {dealer.name}
          </option>
        ))}
      </select>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder={
            allowEmpty
              ? "Paste or type source name (optional)"
              : "Paste or start typing source name"
          }
          autoComplete="off"
          className="field"
          style={{ paddingLeft: "3rem", paddingRight: "2.75rem" }}
        />
        {selectedId ? (
          <Check className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-600" />
        ) : null}
      </div>
      {selectedId ? (
        <p className="mt-1.5 text-xs font-bold text-emerald-700">
          Source matched and selected.
        </p>
      ) : query && !matches.length ? (
        <p className="mt-1.5 text-xs font-bold text-amber-700">
          No source found. Ask management to add it to the Sources list.
        </p>
      ) : (
        <p className="mt-1.5 text-xs font-semibold text-slate-400">
          Paste the source name from WhatsApp or type a few letters.
        </p>
      )}
      {open && (matches.length || (!query && allowEmpty)) ? (
        <div className="absolute z-50 mt-2 max-h-72 w-full overflow-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl">
          {allowEmpty ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setSelectedId("");
                onSelectedIdChange?.("");
                setQuery("");
                setOpen(false);
              }}
              className="w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold text-slate-500 hover:bg-slate-50"
            >
              Direct / No source
            </button>
          ) : null}
          {matches.map((dealer) => (
            <button
              key={dealer.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => chooseSource(dealer)}
              className={cn(
                "flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-bold hover:bg-[#f3f6fb]",
                selectedId === dealer.id && "bg-[#eef3fb] text-[#223f7a]",
              )}
            >
              <span>{dealer.name}</span>
              {selectedId === dealer.id ? <Check className="h-4 w-4" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DealerSalespersonFields({
  sources,
  salespeople,
  required = true,
  allowEmpty = false,
}: {
  sources: SourceOption[];
  salespeople: DealerSalesperson[];
  required?: boolean;
  allowEmpty?: boolean;
}) {
  const [dealerId, setDealerId] = useState("");
  const [salespersonId, setSalespersonId] = useState("");
  const availableSalespeople = useMemo(
    () =>
      salespeople
        .filter((person) => person.dealerId === dealerId && person.isActive)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [dealerId, salespeople],
  );

  useEffect(() => {
    setSalespersonId(
      availableSalespeople.length === 1 ? availableSalespeople[0].id : "",
    );
  }, [availableSalespeople]);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={allowEmpty ? "Source (optional)" : "Source"}>
        <SourceCombobox
          sources={sources}
          required={required}
          allowEmpty={allowEmpty}
          onSelectedIdChange={(id) => {
            setDealerId(id);
            setSalespersonId("");
          }}
        />
      </Field>
      <Field label="Salesperson">
        <select
          name="salesperson"
          value={salespersonId}
          onChange={(event) => setSalespersonId(event.target.value)}
          required={Boolean(dealerId && availableSalespeople.length)}
          disabled={!dealerId || !availableSalespeople.length}
          className="field"
        >
          <option value="">
            {!dealerId
              ? "Select a source first"
              : availableSalespeople.length
                ? "Select salesperson"
                : "No salesperson available — continue without one"}
          </option>
          {availableSalespeople.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
        {dealerId && !availableSalespeople.length ? (
          <p className="mt-1.5 text-xs font-bold text-slate-500">
            This source has no active salespeople. You may continue without selecting one.
          </p>
        ) : null}
      </Field>
    </div>
  );
}

function QuoteCombobox({ quotes }: { quotes: QuoteRecord[] }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const available = quotes.slice(0, 5000);
    if (!needle) return available.slice(0, 12);
    return available
      .filter((quote) =>
        [
          quote.customer,
          quote.source,
          quote.agent,
          quote.status,
          quote.receivedThrough,
        ].some((value) => value.toLowerCase().includes(needle)),
      )
      .slice(0, 12);
  }, [query, quotes]);

  const selected = quotes.find(
    (quote) => quote.sourceWorkItemId === selectedId,
  );

  return (
    <div className="relative">
      <input type="hidden" name="relatedQuote" value={selectedId} />
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedId("");
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder="Search customer, source, or agent"
          autoComplete="off"
          className="field"
          style={{ paddingLeft: "3rem", paddingRight: "2.75rem" }}
        />
        {selected ? (
          <Check className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-600" />
        ) : null}
      </div>
      {selected ? (
        <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
          Linked to {selected.customer} · {selected.source} · {selected.status}
        </div>
      ) : (
        <p className="mt-1.5 text-xs font-semibold text-slate-400">
          Select a Sold or Pending Pricing quote for this activation or change.
        </p>
      )}
      {open && matches.length ? (
        <div className="absolute z-50 mt-2 max-h-80 w-full overflow-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl">
          {matches.map((quote) => (
            <button
              key={`${quote.stage}-${quote.id}`}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setSelectedId(quote.sourceWorkItemId);
                setQuery(`${quote.customer} — ${quote.source}`);
                setOpen(false);
              }}
              className="w-full rounded-xl px-3 py-3 text-left hover:bg-[#f3f6fb]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-black text-slate-900">{quote.customer}</p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    {quote.source} · {quote.agent}
                  </p>
                </div>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-black text-slate-600">
                  {quote.status}
                </span>
              </div>
            </button>
          ))}
        </div>
      ) : null}
      {open && query && !matches.length ? (
        <p className="mt-2 text-xs font-bold text-amber-700">
          No matching Sold or Pending Pricing quote found. Use Old / Not in
          System when appropriate.
        </p>
      ) : null}
    </div>
  );
}

function PendingNotesPanel({
  notes,
  draft,
  onDraftChange,
  onAdd,
}: {
  notes: QuoteNote[];
  draft: string;
  onDraftChange: (value: string) => void;
  onAdd: () => void;
}) {
  return (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
          Follow-up notes
        </p>
        <span className="text-[10px] font-bold text-slate-400">
          {notes.length} note{notes.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="mt-3 max-h-40 space-y-2 overflow-auto">
        {notes.length ? (
          notes.map((note) => (
            <div key={note.id} className="rounded-xl bg-slate-50 px-3 py-2">
              <p className="text-sm font-semibold text-slate-700">
                {note.note}
              </p>
              <p className="mt-1 text-[10px] font-bold text-slate-400">
                @{note.authorUsername} · {note.authorName} ·{" "}
                {formatDateTime(note.createdAt)}
              </p>
            </div>
          ))
        ) : (
          <p className="text-xs font-semibold text-slate-400">
            No follow-up notes yet.
          </p>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <input
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder="Log follow-up or changes made"
          className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={!draft.trim()}
          className="rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add Note
        </button>
      </div>
    </div>
  );
}

/** Returns Tailwind color classes for the quote log timeline dot based on event type. */
function logEventColor(eventType: string): { dot: string; text: string } {
  switch (eventType) {
    case "created_from_cs_intake":
      return { dot: "bg-indigo-500 ring-indigo-100", text: "text-indigo-700" };
    case "created":
    case "assigned":
    case "accepted":
      return { dot: "bg-blue-500 ring-blue-100", text: "text-blue-700" };
    case "price_sent":
      return { dot: "bg-violet-500 ring-violet-100", text: "text-violet-700" };
    case "sold":
      return { dot: "bg-emerald-600 ring-emerald-100", text: "text-emerald-700" };
    case "not_sold":
      return { dot: "bg-rose-500 ring-rose-100", text: "text-rose-700" };
    case "taken":
    case "timer_claimed":
      return { dot: "bg-amber-500 ring-amber-100", text: "text-amber-700" };
    case "customer_service_handoff":
      return { dot: "bg-cyan-500 ring-cyan-100", text: "text-cyan-700" };
    case "ringcentral_intake_claim_completed":
      return { dot: "bg-indigo-500 ring-indigo-100", text: "text-indigo-700" };
    case "outcome_change":
      return { dot: "bg-purple-500 ring-purple-100", text: "text-purple-700" };
    case "note":
      return { dot: "bg-blue-500 ring-blue-100", text: "text-blue-700" };
    default:
      return { dot: "bg-slate-400 ring-slate-100", text: "text-slate-600" };
  }
}

/** Returns the icon for a quote log event type. */
function logEventIcon(eventType: string) {
  switch (eventType) {
    case "created_from_cs_intake":
      return <FileText className="h-3.5 w-3.5" />;
    case "created":
    case "assigned":
      return <FilePlus2 className="h-3.5 w-3.5" />;
    case "accepted":
      return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "price_sent":
      return <Send className="h-3.5 w-3.5" />;
    case "sold":
      return <DollarSign className="h-3.5 w-3.5" />;
    case "not_sold":
      return <XCircle className="h-3.5 w-3.5" />;
    case "taken":
    case "timer_claimed":
      return <Zap className="h-3.5 w-3.5" />;
    case "customer_service_handoff":
      return <UsersRound className="h-3.5 w-3.5" />;
    case "ringcentral_intake_claim_completed":
      return <PhoneCall className="h-3.5 w-3.5" />;
    case "note":
      return <MessageCircleMore className="h-3.5 w-3.5" />;
    case "outcome_change":
      return <Activity className="h-3.5 w-3.5" />;
    default:
      return <Clock3 className="h-3.5 w-3.5" />;
  }
}

function QuoteLogPanel({
  quote,
  activities,
  notes,
  draft,
  onDraftChange,
  onAddNote,
}: {
  quote: QuoteRecord | null;
  activities: QuoteActivity[];
  notes: QuoteNote[];
  draft: string;
  onDraftChange: (value: string) => void;
  onAddNote: () => void;
}) {
  if (!quote)
    return (
      <div className="p-6 text-sm font-semibold text-slate-500">
        Quote not found.
      </div>
    );

  const timeline = [
    ...activities.map((activity) => ({
      kind: "activity" as const,
      id: activity.id,
      createdAt: activity.createdAt,
      activity,
    })),
    ...notes.map((note) => ({
      kind: "note" as const,
      id: note.id,
      createdAt: note.createdAt,
      note,
    })),
  ].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

  return (
    <div className="space-y-4 p-6">
      <div className="rounded-2xl bg-[#f3f6fb] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-black text-slate-950">{quote.customer}</p>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              {quote.source} · {quote.agent}
            </p>
          </div>
          <span className="rounded-full bg-white px-3 py-1.5 text-xs font-black text-[#223f7a] ring-1 ring-[#c9d5e9]">
            {quote.status}
          </span>
        </div>
        {quote.takeEvent ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-xs font-semibold text-amber-900">
            <p className="font-black">
              Taken by @{quote.takeEvent.takerUsername} after{" "}
              {formatElapsedSeconds(quote.takeEvent.elapsedSeconds)}
            </p>
            <p className="mt-1">
              Missed turn:{" "}
              {quote.takeEvent.skippedAgents.length
                ? quote.takeEvent.skippedAgents
                    .map((agent) => `@${agent.username}`)
                    .join(", ")
                : "None"}
            </p>
            <p className="mt-1 text-amber-700">
              Received {formatDateTime(quote.takeEvent.receivedAt)} · Taken{" "}
              {formatDateTime(quote.takeEvent.takenAt)}
            </p>
          </div>
        ) : null}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
          Add shared note
        </p>
        <div className="mt-3 flex gap-2">
          <input
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Add information for the team"
            className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={onAddNote}
            disabled={!draft.trim()}
            className="rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            Add Note
          </button>
        </div>
      </div>

      <div className="max-h-[52vh] overflow-auto pr-1">
        {timeline.length ? (
          <div className="relative">
            {/* Vertical timeline line */}
            <div className="absolute left-[19px] top-6 bottom-6 w-0.5 bg-slate-200" aria-hidden="true" />

            <ul className="relative space-y-4">
              {timeline.map((entry) => {
                const eventType = entry.kind === "note" ? "note" : entry.activity.eventType;
                const color = logEventColor(eventType);

                if (entry.kind === "note") {
                  return (
                    <li key={`note-${entry.id}`} className="relative pl-12">
                      {/* Timeline dot */}
                      <div className={`absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full ring-4 ${color.dot}`}>
                        <span className="text-white">{logEventIcon("note")}</span>
                      </div>
                      {/* Note card */}
                      <div className="rounded-2xl border border-blue-100 bg-blue-50/50 px-4 py-3 shadow-sm">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={`text-xs font-black uppercase tracking-wide ${color.text}`}>
                            Note
                          </span>
                          <span className="text-xs font-semibold text-slate-400">
                            {formatDateTime(entry.note.createdAt)}
                          </span>
                        </div>
                        <p className="mt-1 text-sm font-bold text-slate-800">
                          @{entry.note.authorUsername} · {entry.note.authorName}
                        </p>
                        <p className="mt-2 text-sm font-semibold leading-6 text-slate-700">
                          {entry.note.note}
                        </p>
                      </div>
                    </li>
                  );
                }

                const detailReason =
                  typeof entry.activity.details?.reason === "string"
                    ? entry.activity.details.reason
                    : undefined;
                const detailChange =
                  typeof entry.activity.details?.change_type === "string"
                    ? entry.activity.details.change_type
                    : undefined;
                const detailNote =
                  typeof entry.activity.details?.note === "string"
                    ? entry.activity.details.note
                    : undefined;

                return (
                  <li key={`activity-${entry.id}`} className="relative pl-12">
                    {/* Timeline dot */}
                    <div className={`absolute left-1.5 top-1.5 flex h-7 w-7 items-center justify-center rounded-full ring-4 ${color.dot}`}>
                      <span className="text-white">{logEventIcon(entry.activity.eventType)}</span>
                    </div>
                    {/* Event card */}
                    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className={`text-xs font-black uppercase tracking-wide ${color.text}`}>
                          {quoteActivityLabels[entry.activity.eventType] ||
                            entry.activity.eventType}
                        </span>
                        <span className="text-xs font-semibold text-slate-400">
                          {formatDateTime(entry.activity.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 text-sm font-bold text-slate-800">
                        {entry.activity.actorName}
                      </p>
                      {entry.activity.assignedAgent ? (
                        <p className="mt-1 text-sm font-semibold text-slate-600">
                          Assigned agent: {entry.activity.assignedAgent}
                        </p>
                      ) : null}
                      {detailReason ? (
                        <p className="mt-1 text-sm font-semibold text-slate-600">
                          <span className="font-bold text-slate-700">Reason:</span> {detailReason}
                        </p>
                      ) : null}
                      {detailChange ? (
                        <p className="mt-1 text-sm font-semibold text-slate-600">
                          <span className="font-bold text-slate-700">Change type:</span> {detailChange}
                        </p>
                      ) : null}
                      {detailNote ? (
                        <p className="mt-1 text-sm font-semibold text-slate-600">
                          {detailNote}
                        </p>
                      ) : null}
                      {entry.activity.eventType === "created_from_cs_intake" &&
                        entry.activity.details ? (
                        <div className="mt-3">
                          <IntakeDataDisplay
                            details={entry.activity.details as unknown as IntakeDataDetails}
                          />
                        </div>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="rounded-2xl bg-slate-50 p-6 text-center text-sm font-semibold text-slate-400">
            No activity has been recorded yet.
          </p>
        )}
      </div>
    </div>
  );
}

type TeamInteraction = {
  id: string;
  sourceWorkItemId: string;
  occurredAt: string;
  eventType: string;
  customer: string;
  status: QuoteRecord["status"];
  workType: "new_quote" | "requote";
  agent: string;
  source: string;
  salesperson: string;
  inputMethod: string;
};

function MyTeamPanel({
  quotes,
  activities,
  onOpenLog,
}: {
  quotes: QuoteRecord[];
  activities: QuoteActivity[];
  onOpenLog: (sourceWorkItemId: string) => void;
}) {
  const [day, setDay] = useState(dateInputValue(new Date()));
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [type, setType] = useState("all");
  const [agent, setAgent] = useState("all");
  const [source, setSource] = useState("all");
  const [updateType, setUpdateType] = useState("all");

  const quoteBySource = useMemo(
    () => new Map(quotes.map((quote) => [quote.sourceWorkItemId, quote])),
    [quotes],
  );
  const interactions = useMemo<TeamInteraction[]>(() => {
    const rows: TeamInteraction[] = quotes.map((quote) => ({
      id: `created-${quote.sourceWorkItemId}`,
      sourceWorkItemId: quote.sourceWorkItemId,
      occurredAt: quote.createdAt,
      eventType: "created",
      customer: quote.customer,
      status: quote.status,
      workType: quote.workType,
      agent: quote.agent,
      source: quote.source,
      salesperson: quote.salesperson,
      inputMethod: quote.receivedThrough,
    }));
    for (const activity of activities) {
      const quote = quoteBySource.get(activity.sourceWorkItemId);
      if (!quote) continue;
      rows.push({
        id: activity.id,
        sourceWorkItemId: activity.sourceWorkItemId,
        occurredAt: activity.createdAt,
        eventType: activity.eventType,
        customer: quote.customer,
        status: quote.status,
        workType: quote.workType,
        agent:
          activity.actorName === "System" ? quote.agent : activity.actorName,
        source: quote.source,
        salesperson: quote.salesperson,
        inputMethod: quote.receivedThrough,
      });
    }
    return rows.sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }, [activities, quoteBySource, quotes]);

  const agents = useMemo(
    () => Array.from(new Set(interactions.map((row) => row.agent))).sort(),
    [interactions],
  );
  const sources = useMemo(
    () => Array.from(new Set(interactions.map((row) => row.source))).sort(),
    [interactions],
  );
  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return interactions.filter((row) => {
      const matchesSearch =
        !needle ||
        [
          row.customer,
          row.agent,
          row.source,
          row.salesperson,
          row.status,
          row.inputMethod,
        ].some((value) => value.toLowerCase().includes(needle));
      return (
        matchesCalendarDay(row.occurredAt, day) &&
        matchesSearch &&
        (status === "all" || row.status === status) &&
        (type === "all" || row.workType === type) &&
        (agent === "all" || row.agent === agent) &&
        (source === "all" || row.source === source) &&
        (updateType === "all" ||
          row.eventType === updateType ||
          (updateType === "taken" &&
            ["taken", "timer_claimed"].includes(row.eventType)))
      );
    });
  }, [agent, day, interactions, search, source, status, type, updateType]);

  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-6">
        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
          <UsersRound className="h-4 w-4" /> My Team
        </div>
        <h3 className="mt-1 text-xl font-black">Daily quote interactions</h3>
        <p className="mt-1 text-sm text-slate-500">
          See the newest quote and update activity first so the team can avoid
          entering duplicate customers during busy periods.
        </p>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Day">
            <input
              type="date"
              value={day}
              onChange={(event) => setDay(event.target.value)}
              className="field"
            />
          </Field>
          <Field label="Search">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="field"
              placeholder="Customer, agent, source, salesperson"
            />
          </Field>
          <Field label="Status">
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              className="field"
            >
              <option value="all">All statuses</option>
              <option>Active</option>
              <option>Price Sent</option>
              <option>Sold</option>
              <option>Not Sold</option>
            </select>
          </Field>
          <Field label="Update">
            <select
              value={updateType}
              onChange={(event) => setUpdateType(event.target.value)}
              className="field"
            >
              {quoteUpdateFilterOptions.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Type">
            <select
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="field"
            >
              <option value="all">All quote types</option>
              <option value="new_quote">New Quote</option>
              <option value="requote">Requote</option>
            </select>
          </Field>
          <Field label="Agent">
            <select
              value={agent}
              onChange={(event) => setAgent(event.target.value)}
              className="field"
            >
              <option value="all">All agents</option>
              {agents.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <Field label="Source">
            <select
              value={source}
              onChange={(event) => setSource(event.target.value)}
              className="field"
            >
              <option value="all">All sources</option>
              {sources.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <div className="flex items-end">
            <button
              onClick={() => {
                setDay(dateInputValue(new Date()));
                setSearch("");
                setStatus("all");
                setType("all");
                setAgent("all");
                setSource("all");
                setUpdateType("all");
              }}
              className="w-full rounded-xl border border-slate-200 px-4 py-3 text-sm font-black text-slate-600 hover:bg-slate-50"
            >
              Reset filters
            </button>
          </div>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-3">Time / Update</th>
              <th className="px-5 py-3">Customer</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">Source / Salesperson</th>
              <th className="px-5 py-3">Input</th>
              <th className="px-5 py-3">Log</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visible.map((row) => (
              <tr
                key={row.id}
                className={cn(
                  "hover:bg-slate-50",
                  row.eventType === "created" && "bg-emerald-50/30",
                )}
              >
                <td className="px-5 py-4">
                  <p className="font-black text-slate-800">
                    {quoteActivityLabels[row.eventType] || row.eventType}
                  </p>
                  <p className="mt-1 text-xs font-semibold text-slate-400">
                    {formatDateTime(row.occurredAt)}
                  </p>
                </td>
                <td className="px-5 py-4 font-black">{row.customer}</td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-700">
                    {row.status}
                  </span>
                </td>
                <td className="px-5 py-4 font-bold">
                  {workTypeLabels[row.workType]}
                </td>
                <td className="px-5 py-4 font-bold">{row.agent}</td>
                <td className="px-5 py-4">
                  <p className="font-semibold">{row.source}</p>
                  <p className="mt-1 text-xs text-slate-400">
                    {row.salesperson}
                  </p>
                </td>
                <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                  {row.inputMethod}
                </td>
                <td className="px-5 py-4">
                  <button
                    onClick={() => onOpenLog(row.sourceWorkItemId)}
                    className="rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-2 text-xs font-black text-[#223f7a]"
                  >
                    Open
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!visible.length ? (
          <div className="p-5">
            <EmptyState
              title="No matching team interactions"
              note="Adjust the day or filters to review other quote activity."
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function StartRescueTimerForm({
  rotation,
  sourceList,
  salespeople,
  onSubmit,
}: {
  rotation: "whatsapp";
  sourceList: SourceOption[];
  salespeople: DealerSalesperson[];
  manual?: boolean;
  onSubmit: (formData: FormData) => Promise<void>;
}) {
  const [receivedLocal, setReceivedLocal] = useState(localDateTimeInputValue());

  return (
    <form action={onSubmit} className="space-y-4 p-6">
      <input type="hidden" name="rotation" value={rotation} />
      <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold leading-6 text-amber-900">
        Starting the timer alerts the current agent immediately. The quote
        becomes available to every other eligible agent after the current
        agent&apos;s single 3-minute response period expires.
      </div>
      <Field label="Time quote came in">
        <input
          name="receivedAt"
          type="datetime-local"
          required
          value={receivedLocal}
          onChange={(event) => setReceivedLocal(event.target.value)}
          className="field"
        />
      </Field>
      <Field label="Customer name">
        <input name="customer" required className="field" />
      </Field>
      <DealerSalespersonFields sources={sourceList} salespeople={salespeople} />
      <input type="hidden" name="quoteType" value="new_quote" />
      <Field label="Notes (optional)">
        <textarea
          name="note"
          rows={3}
          className="field"
          placeholder="Important information about this quote"
        />
      </Field>
      <button className="w-full rounded-xl bg-amber-600 px-4 py-3 font-black text-white hover:bg-amber-700">
        Start 3-Minute Timer
      </button>
    </form>
  );
}

function RescueTimerPanel({
  timer,
  currentUserId,
  canRescue,
  onClaim,
  onSteal,
}: {
  timer: QuoteTakeTimer;
  currentUserId: string;
  canRescue: boolean;
  onClaim: () => void;
  onSteal: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const remainingSeconds = Math.max(
    0,
    Math.ceil((new Date(timer.deadlineAt).getTime() - now) / 1000),
  );
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(timer.receivedAt).getTime()) / 1000),
  );
  const ready = remainingSeconds === 0;
  const isCurrentAgent = timer.currentProfileId === currentUserId;

  return (
    <div
      className={cn(
        "mt-4 rounded-2xl border p-4",
        ready
          ? "border-rose-200 bg-rose-50"
          : remainingSeconds <= 30
            ? "border-amber-300 bg-amber-50"
            : "border-blue-200 bg-blue-50/60",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-500">
            Rescue timer
          </p>
          <p className="mt-1 truncate font-black text-slate-900">
            {timer.customer}
          </p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            {timer.dealer} · Started by @{timer.startedByUsername}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p
            className={cn(
              "text-2xl font-black",
              ready
                ? "text-rose-700"
                : remainingSeconds <= 30
                  ? "text-amber-700"
                  : "text-blue-700",
            )}
          >
            {ready ? "READY" : formatElapsedSeconds(remainingSeconds)}
          </p>
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
            remaining
          </p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 rounded-xl bg-white/75 p-3 text-xs font-semibold text-slate-600 sm:grid-cols-2">
        <p>
          <strong>Turn owner:</strong> @{timer.currentAgentUsername}
        </p>
        <p>
          <strong>Elapsed:</strong> {formatElapsedSeconds(elapsedSeconds)}
        </p>
        <p>
          <strong>Received:</strong> {formatDateTime(timer.receivedAt)}
        </p>
        <p>
          <strong>Deadline:</strong> {formatDateTime(timer.deadlineAt)}
        </p>
      </div>
      {isCurrentAgent ? (
        <button
          onClick={onClaim}
          className="mt-3 w-full rounded-xl bg-[#223f7a] px-4 py-3 text-xs font-black text-white hover:bg-[#17305f]"
        >
          Take Timed Quote
        </button>
      ) : canRescue ? (
        <button
          onClick={onSteal}
          disabled={!ready}
          className={cn(
            "mt-3 w-full rounded-xl px-4 py-3 text-xs font-black text-white",
            ready
              ? "bg-rose-600 hover:bg-rose-700"
              : "cursor-not-allowed bg-slate-300",
          )}
        >
          {ready
            ? "Steal Quote"
            : `Available in ${formatElapsedSeconds(remainingSeconds)}`}
        </button>
      ) : (
        <p className="mt-3 rounded-xl bg-white/70 px-3 py-2 text-center text-xs font-bold text-slate-500">
          You must be Available and active in this queue to rescue the quote.
        </p>
      )}
    </div>
  );
}

function WorkloadTurnForm({
  quotes,
  agents,
  sources,
  salespeople,
  manual = false,
  onSubmit,
}: {
  quotes: QuoteRecord[];
  agents: Agent[];
  sources: SourceOption[];
  salespeople: DealerSalesperson[];
  manual?: boolean;
  onSubmit: (formData: FormData) => Promise<void>;
}) {
  const [mode, setMode] = useState<"linked" | "new">("linked");

  return (
    <form action={onSubmit} className="space-y-4 p-6">
      <input type="hidden" name="workloadMode" value={mode} />
      <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1.5">
        <button
          type="button"
          onClick={() => setMode("linked")}
          className={cn(
            "rounded-xl px-3 py-2.5 text-xs font-black",
            mode === "linked"
              ? "bg-white text-[#223f7a] shadow-sm"
              : "text-slate-500",
          )}
        >
          Existing Quote
        </button>
        <button
          type="button"
          onClick={() => setMode("new")}
          className={cn(
            "rounded-xl px-3 py-2.5 text-xs font-black",
            mode === "new"
              ? "bg-white text-[#223f7a] shadow-sm"
              : "text-slate-500",
          )}
        >
          Old / Not in System
        </button>
      </div>
      {mode === "linked" ? (
        <>
          <div className="rounded-2xl bg-violet-50 p-4 text-sm font-semibold text-violet-800">
            Only Sold and Pending Pricing quotes are available. Customer,
            source, and original owner are copied automatically.
          </div>
          <Field label="Existing quote">
            <QuoteCombobox quotes={quotes} />
          </Field>
        </>
      ) : (
        <>
          <div className="rounded-2xl bg-amber-50 p-4 text-sm font-semibold text-amber-900">
            Use this for older business that is not in Work Desk. An Activation
            will also create a Sold quote record automatically.
          </div>
          <Field label="Customer name">
            <input name="customer" required className="field" />
          </Field>
          <DealerSalespersonFields
            sources={sources}
            salespeople={salespeople}
            required={false}
            allowEmpty
          />
          <Field label="Original owner (optional)">
            <select name="owner" className="field">
              <option value="">Unknown / Current agent</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Work type">
          <select name="workType" className="field">
            <option value="activation">Activation</option>
            <option value="change">Change</option>
          </select>
        </Field>
        <Field label="Change type (optional)">
          <select name="changeType" className="field">
            <option value="">Not applicable</option>
            <option>Add Vehicle</option>
            <option>Remove Vehicle</option>
            <option>Add Driver</option>
            <option>Remove Driver</option>
            <option>Change Coverage</option>
            <option>Other Policy Change</option>
          </select>
        </Field>
      </div>
      <Field label="Notes (optional)">
        <textarea
          name="note"
          rows={3}
          className="field"
          placeholder="What was requested or changed?"
        />
      </Field>
      <button className="w-full rounded-xl bg-violet-600 px-4 py-3 font-black text-white">
        {manual ? "Log Manual Workload" : "Take Additional Workload"}
      </button>
    </form>
  );
}

function TabBar<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: Array<{ id: T; label: string; icon: React.ReactNode; badge?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition",
            value === tab.id
              ? "bg-[#223f7a] text-white shadow-sm"
              : "text-slate-500 hover:bg-[#f3f6fb] hover:text-[#223f7a]",
          )}
        >
          {tab.icon}
          {tab.label}
          {tab.badge ? (
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[10px]",
                value === tab.id
                  ? "bg-white/15 text-white"
                  : "bg-rose-50 text-rose-700",
              )}
            >
              {tab.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

function RotationCard({
  variant,
  current,
  upcoming,
  isMyTurn,
  canStartTimer = false,
  timer,
  currentUserId,
  onAction,
  onPass,
  onStartTimer,
  onClaimTimer,
  onStealTimer,
}: {
  variant: RotationKind;
  current: Agent | null;
  upcoming: Agent[];
  isMyTurn: boolean;
  canStartTimer?: boolean;
  timer?: QuoteTakeTimer;
  currentUserId: string;
  onAction: () => void;
  onPass: () => void;
  onStartTimer?: () => void;
  onClaimTimer?: () => void;
  onStealTimer?: () => void;
}) {
  const config = rotationConfig[variant];
  const canRescue = Boolean(
    canStartTimer && timer && timer.currentProfileId !== currentUserId,
  );
  return (
    <section className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div
            className={cn(
              "flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em]",
              config.accent,
            )}
          >
            {config.icon}
            {config.shortTitle}
          </div>
          <p className="mt-1 text-xs font-semibold text-slate-400">
            {config.description}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[10px] font-black ring-1",
            isMyTurn
              ? "bg-red-50 text-red-700 ring-red-200"
              : current
                ? cn(config.soft, config.accent, config.ring)
                : "bg-slate-100 text-slate-500 ring-slate-200",
          )}
        >
          {isMyTurn ? "YOUR TURN" : current ? "LIVE" : "WAITING"}
        </span>
      </div>
      {current ? (
        <>
          <div className="mt-5 flex items-center gap-3">
            <Avatar agent={current} />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                Current
              </p>
              <p className="truncate text-xl font-black tracking-tight">
                {current.name}
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 overflow-hidden text-xs font-bold text-slate-500">
            <span>Next</span>
            <ChevronRight className="h-3.5 w-3.5" />
            {upcoming.slice(0, 2).map((agent) => (
              <span key={agent.id} className="rounded-lg bg-slate-50 px-2 py-1">
                {agent.name}
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-5 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
          <p className="font-black text-slate-700">No agent yet</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
            The first eligible agent to click Available starts this queue for
            the day.
          </p>
        </div>
      )}

      {timer && onClaimTimer && onStealTimer ? (
        <RescueTimerPanel
          timer={timer}
          currentUserId={currentUserId}
          canRescue={canRescue}
          onClaim={onClaimTimer}
          onSteal={onStealTimer}
        />
      ) : null}

      <div className="mt-5 flex flex-wrap gap-2">
        {!timer ? (
          <button
            onClick={onAction}
            disabled={!isMyTurn}
            className={cn(
              "flex min-w-[150px] flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-xs font-black transition",
              isMyTurn
                ? `${config.button} text-white`
                : "cursor-not-allowed bg-slate-100 text-slate-400",
            )}
          >
            {variant === "workload" ? (
              <BriefcaseBusiness className="h-4 w-4" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {config.action}
          </button>
        ) : null}
        {!timer && canStartTimer && onStartTimer ? (
          <button
            onClick={onStartTimer}
            className="rounded-xl bg-amber-500 px-4 py-3 text-xs font-black text-white transition hover:bg-amber-600"
          >
            Start Timer
          </button>
        ) : null}
        {isMyTurn && !timer && variant !== "workload" ? (
          <button
            onClick={onPass}
            className="rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-600 hover:bg-slate-50"
          >
            Pass
          </button>
        ) : null}
      </div>
      {timer ? (
        <p className="mt-3 text-[11px] font-semibold leading-5 text-slate-400">
          Stealing consumes only the displayed current agent&apos;s turn. The
          next regular queue position does not change.
        </p>
      ) : null}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  note,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  note?: string;
  icon: React.ReactNode;
  tone: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div
        className={cn("grid h-10 w-10 place-items-center rounded-2xl", tone)}
      >
        {icon}
      </div>
      <p className="mt-4 text-xs font-black uppercase tracking-[0.14em] text-slate-400">
        {label}
      </p>
      <p className="mt-1 text-3xl font-black tracking-tight text-slate-950">
        {value}
      </p>
      {note ? (
        <p className="mt-1 text-xs font-semibold text-slate-500">{note}</p>
      ) : null}
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  average,
  rank,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  average: number;
  rank: number;
  tone: string;
}) {
  const above = value >= average;
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div
          className={cn("grid h-10 w-10 place-items-center rounded-2xl", tone)}
        >
          {icon}
        </div>
        <span
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-black",
            above
              ? "bg-emerald-50 text-emerald-700"
              : "bg-slate-100 text-slate-500",
          )}
        >
          #{rank}
        </span>
      </div>
      <p className="mt-5 text-sm font-bold text-slate-500">{label}</p>
      <div className="mt-1 flex items-end gap-3">
        <span className="text-3xl font-black tracking-tight text-slate-950">
          {value}
        </span>
        <span className="pb-1 text-xs font-bold text-slate-400">
          Team avg {average.toFixed(1)}
        </span>
      </div>
    </div>
  );
}

function EmptyState({ title, note }: { title: string; note: string }) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center">
      <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
      <p className="mt-3 font-black text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{note}</p>
    </div>
  );
}

function CustomerServiceWorkspace({
  user,
  activeWork,
  recentActivity,
  quoteNotesBySource,
  noteDrafts,
  onDraftChange,
  onAccept,
  onComplete,
  onOpenLog,
  onAddNote,
}: {
  user: CustomerServiceUser;
  activeWork: WorkItem[];
  recentActivity: WorkItem[];
  quoteNotesBySource: Map<string, QuoteNote[]>;
  noteDrafts: Record<string, string>;
  onDraftChange: (sourceWorkItemId: string, value: string) => void;
  onAccept: (item: WorkItem) => Promise<void>;
  onComplete: (item: WorkItem) => Promise<void>;
  onOpenLog: (sourceWorkItemId: string) => void;
  onAddNote: (sourceWorkItemId: string) => Promise<void>;
}) {
  return (
    <div className="space-y-6">
      <section className="rounded-[28px] border border-cyan-200 bg-gradient-to-br from-white to-cyan-50 p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="grid h-14 w-14 place-items-center rounded-2xl bg-cyan-700 text-lg font-black text-white">
              {user.initials}
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-cyan-700">
                Customer Service Workspace
              </p>
              <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
                {user.name}
              </h2>
              <p className="mt-1 text-sm font-semibold text-slate-600">
                Assigned Activations and Changes from the sales team.
              </p>
            </div>
          </div>
          <div className="rounded-2xl bg-white px-5 py-4 text-center ring-1 ring-cyan-200">
            <p className="text-3xl font-black text-cyan-700">
              {activeWork.length}
            </p>
            <p className="text-xs font-black uppercase tracking-wider text-slate-500">
              Open assignments
            </p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6">
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-cyan-700">
            <BriefcaseBusiness className="h-4 w-4" /> Assigned Work
          </div>
          <h3 className="mt-1 text-xl font-black">
            Activations and Changes needing attention
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Accept each handoff, review the instructions and quote log, document
            your work, then mark it complete.
          </p>
        </div>
        <div className="p-5">
          {activeWork.length ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {activeWork.map((item) => {
                const sourceId = item.relatedQuoteSourceWorkItemId;
                const notes = sourceId
                  ? quoteNotesBySource.get(sourceId) || []
                  : [];
                return (
                  <div
                    key={item.id}
                    className="rounded-2xl border border-cyan-100 bg-cyan-50/30 p-5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-black text-slate-950">
                          {item.customer}
                        </p>
                        <p className="mt-1 text-sm font-semibold text-slate-500">
                          {workTypeLabels[item.workType]} · {item.dealer}
                        </p>
                        <p className="mt-2 text-xs font-bold text-cyan-700">
                          Assigned {formatDateTime(item.assignedAt)}
                        </p>
                      </div>
                      <MethodBadge method={item.assignmentMethod} />
                    </div>
                    {item.note ? (
                      <div className="mt-4 rounded-xl bg-white p-3 text-sm font-semibold leading-6 text-slate-600 ring-1 ring-cyan-100">
                        <strong>Handoff details:</strong>
                        <br />
                        {item.note}
                      </div>
                    ) : null}
                    {sourceId ? (
                      <PendingNotesPanel
                        notes={notes}
                        draft={noteDrafts[sourceId] || ""}
                        onDraftChange={(value) =>
                          onDraftChange(sourceId, value)
                        }
                        onAdd={() => void onAddNote(sourceId)}
                      />
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {sourceId ? (
                        <button
                          onClick={() => onOpenLog(sourceId)}
                          className="rounded-xl border border-[#c9d5e9] bg-white px-3 py-2.5 text-xs font-black text-[#223f7a]"
                        >
                          Quote Log
                        </button>
                      ) : null}
                      {!item.acceptedAt ? (
                        <button
                          onClick={() => void onAccept(item)}
                          className="rounded-xl bg-amber-500 px-4 py-2.5 text-xs font-black text-white hover:bg-amber-600"
                        >
                          Accept Assignment
                        </button>
                      ) : (
                        <button
                          onClick={() => void onComplete(item)}
                          className="rounded-xl bg-cyan-700 px-4 py-2.5 text-xs font-black text-white hover:bg-cyan-800"
                        >
                          Mark Complete
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              title="No Customer Service assignments"
              note="Activations and Changes passed by agents will appear here."
            />
          )}
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
            Recent Activity
          </p>
          <h3 className="mt-1 text-xl font-black">
            Completed Customer Service work
          </h3>
        </div>
        <div className="divide-y divide-slate-100">
          {recentActivity.length ? (
            recentActivity.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-4 px-6 py-4"
              >
                <div>
                  <p className="font-black text-slate-800">{item.customer}</p>
                  <p className="mt-1 text-sm text-slate-500">
                    {workTypeLabels[item.workType]} · {item.dealer}
                  </p>
                </div>
                <div className="text-right">
                  <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">
                    Completed
                  </span>
                  <p className="mt-2 text-xs font-semibold text-slate-400">
                    {formatDateTime(item.completedAt || item.createdAt)}
                  </p>
                </div>
              </div>
            ))
          ) : (
            <div className="p-5">
              <EmptyState
                title="No completed assignments yet"
                note="Finished Customer Service work will appear here."
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

export function WorkDeskApp({
  sessionProfile,
  initialData,
  workspaceTabs,
  externalWorkspaceContent,
  workloadDatabaseContent,
  forceManagerTab,
}: {
  sessionProfile: SessionProfile;
  initialData: DashboardData;
  workspaceTabs?: React.ReactNode;
  externalWorkspaceContent?: React.ReactNode;
  workloadDatabaseContent?: React.ReactNode;
  forceManagerTab?: "overview" | "work" | "quotes" | "reports" | "team" | "administration";
}) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [agentList, setAgentList] = useState(initialData.agents);
  const [customerServiceUsers, setCustomerServiceUsers] = useState<
    CustomerServiceUser[]
  >(initialData.customerServiceUsers);
  const [sourceList, setSourceList] = useState<SourceOption[]>(
    initialData.sources,
  );
  const [salespeople, setSalespeople] = useState<DealerSalesperson[]>(
    initialData.salespeople,
  );
  const [workItems, setWorkItems] = useState<WorkItem[]>(initialData.workItems);
  const [pendingPricing, setPendingPricing] = useState<PendingPricingItem[]>(
    initialData.pendingPricing,
  );
  const [quoteOutcomes, setQuoteOutcomes] = useState<QuoteOutcome[]>(
    initialData.quoteOutcomes,
  );
  const [quoteNotes, setQuoteNotes] = useState<QuoteNote[]>(
    initialData.quoteNotes,
  );
  const [quoteActivities, setQuoteActivities] = useState<QuoteActivity[]>(
    initialData.quoteActivities,
  );
  const [quoteTakeEvents, setQuoteTakeEvents] = useState<QuoteTakeEvent[]>(
    initialData.quoteTakeEvents,
  );
  const [quoteTakeTimers, setQuoteTakeTimers] = useState<QuoteTakeTimer[]>(
    initialData.quoteTakeTimers,
  );
  const [workDeskSettings, setWorkDeskSettings] = useState<WorkDeskSettings>(
    initialData.settings,
  );
  const [notifications, setNotifications] = useState<AlertNotification[]>(
    initialData.notifications,
  );
  const [performance, setPerformance] = useState<PerformanceRow[]>(
    initialData.performance,
  );
  const [passEvents, setPassEvents] = useState<PassEvent[]>(
    initialData.passEvents,
  );
  const [agentTab, setAgentTab] = useState<AgentTab>("desk");
  const [managerTab, setManagerTab] = useState<ManagerTab>(forceManagerTab ?? "overview");

  // Sync forceManagerTab from parent (top-level tab navigation)
  useEffect(() => {
    if (forceManagerTab) setManagerTab(forceManagerTab);
  }, [forceManagerTab]);

  const [whatsappCurrentId, setWhatsappCurrentId] = useState(
    initialData.rotations.whatsapp,
  );
  const [ringCentralCurrentId, setRingCentralCurrentId] = useState(
    initialData.rotations.ringcentral,
  );
  const [workloadCurrentId, setWorkloadCurrentId] = useState(
    initialData.rotations.workload,
  );
  const [modal, setModal] = useState<ModalType>(null);
  const [quoteResultItemId, setQuoteResultItemId] = useState<string | null>(
    null,
  );
  const [notSoldTarget, setNotSoldTarget] = useState<NotSoldTarget>(null);
  const [changeOutcomeRecord, setChangeOutcomeRecord] =
    useState<QuoteRecord | null>(null);
  const [takeRotation, setTakeRotation] = useState<"whatsapp" | null>(null);
  const [customerServicePassItemId, setCustomerServicePassItemId] = useState<
    string | null
  >(null);
  const [quoteLogSourceId, setQuoteLogSourceId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(
    () =>
      typeof window !== "undefined" &&
      "Notification" in window &&
      window.localStorage.getItem("nhwd-alerts-enabled") === "true" &&
      Notification.permission === "granted",
  );
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [quoteSearch, setQuoteSearch] = useState("");
  const [quoteDayFilter, setQuoteDayFilter] = useState(
    dateInputValue(new Date()),
  );
  const [quoteStatusFilter, setQuoteStatusFilter] = useState("all");
  const [quoteUpdateFilter, setQuoteUpdateFilter] = useState("all");
  const [agentDatabaseView, setAgentDatabaseView] = useState<"quotes" | "workloads">("quotes");
  const todayForPerformance = dateInputValue(new Date());
  const [agentPerformanceStart, setAgentPerformanceStart] = useState(todayForPerformance);
  const [agentPerformanceEnd, setAgentPerformanceEnd] = useState(todayForPerformance);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const refreshTimer = useRef<number | null>(null);
  const refreshInFlight = useRef(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(() => new Date());
  const seenNotificationIds = useRef(
    new Set(
      initialData.notifications
        .filter((item) => item.readAt)
        .map((item) => item.id),
    ),
  );
  const requestedTimerWarningIds = useRef(
    new Set(
      initialData.quoteTakeTimers
        .filter((timer) => timer.warningSentAt)
        .map((timer) => timer.id),
    ),
  );

  const currentUserId = sessionProfile.id;
  const isManager = sessionProfile.role === "manager";
  const isCustomerService = sessionProfile.role === "customer_service";
  const currentUser = agentList.find((agent) => agent.id === currentUserId);
  const currentCustomerServiceUser = customerServiceUsers.find(
    (user) => user.id === currentUserId,
  );
  const whatsappCurrent = whatsappCurrentId
    ? (agentList.find((agent) => agent.id === whatsappCurrentId) ?? null)
    : null;
  const ringCentralCurrent = ringCentralCurrentId
    ? (agentList.find((agent) => agent.id === ringCentralCurrentId) ?? null)
    : null;
  const workloadCurrent = workloadCurrentId
    ? (agentList.find((agent) => agent.id === workloadCurrentId) ?? null)
    : null;
  const whatsappTimer = quoteTakeTimers.find(
    (timer) => timer.rotation === "whatsapp",
  );
  const customerServicePassItem =
    workItems.find((item) => item.id === customerServicePassItemId) ?? null;
  const myActiveWork = workItems.filter(
    (item) => item.assignedProfileId === currentUserId && isActiveTask(item),
  );
  const myPendingPricing = currentUser
    ? pendingPricing.filter((item) => item.assignedProfileId === currentUserId)
    : [];

  // Unclaimed intakes count for agent Intake Queue badge
  const [unclaimedIntakeCount, setUnclaimedIntakeCount] = useState(0);
  useEffect(() => {
    if (sessionProfile.role !== 'agent') return;
    fetch('/api/intakes')
      .then((r) => r.json())
      .then((body) => {
        const intakes = (body.intakes ?? []) as Array<{ status: string }>;
        setUnclaimedIntakeCount(intakes.filter((i) => i.status === 'submitted' || i.status === 'waiting_for_claim').length);
      })
      .catch(() => {});
  }, [sessionProfile.role]);

  const myRecentActivity = workItems
    .filter(
      (item) =>
        item.assignedProfileId === currentUserId && item.status !== "active",
    )
    .slice(0, 8);
  const quoteResultItem =
    workItems.find((item) => item.id === quoteResultItemId) ?? null;
  const unreadNotifications = notifications.filter((item) => !item.readAt);

  const allQuoteRecords = useMemo(
    () =>
      buildQuoteRecords(
        workItems,
        pendingPricing,
        quoteOutcomes,
        quoteTakeEvents,
      ),
    [pendingPricing, quoteOutcomes, quoteTakeEvents, workItems],
  );
  const workloadSelectableQuotes = useMemo(
    () =>
      allQuoteRecords.filter(
        (quote) => quote.status === "Sold" || quote.status === "Price Sent",
      ),
    [allQuoteRecords],
  );
  const visibleAgentQuotes = useMemo(() => {
    const needle = quoteSearch.trim().toLowerCase();
    return allQuoteRecords.filter((quote) => {
      const activities = quoteActivities.filter(
        (activity) => activity.sourceWorkItemId === quote.sourceWorkItemId,
      );
      const latestStamp = activities.reduce(
        (latest, activity) =>
          new Date(activity.createdAt).getTime() > new Date(latest).getTime()
            ? activity.createdAt
            : latest,
        quote.statusDate,
      );
      const matchesSearch =
        !needle ||
        [
          quote.customer,
          quote.source,
          quote.salesperson,
          quote.agent,
          quote.status,
          quote.receivedThrough,
          workTypeLabels[quote.workType],
        ].some((value) => value.toLowerCase().includes(needle));
      const matchesStatus =
        quoteStatusFilter === "all" || quote.status === quoteStatusFilter;
      const matchesUpdate =
        quoteUpdateFilter === "all" ||
        (quoteUpdateFilter === "created"
          ? true
          : activities.some(
              (activity) => activity.eventType === quoteUpdateFilter,
            ));
      return (
        matchesSearch &&
        matchesStatus &&
        matchesUpdate &&
        matchesCalendarDay(latestStamp, quoteDayFilter)
      );
    });
  }, [
    allQuoteRecords,
    quoteActivities,
    quoteDayFilter,
    quoteSearch,
    quoteStatusFilter,
    quoteUpdateFilter,
  ]);
  const quoteNotesBySource = useMemo(() => {
    const rows = new Map<string, QuoteNote[]>();
    for (const note of quoteNotes)
      rows.set(note.sourceWorkItemId, [
        ...(rows.get(note.sourceWorkItemId) || []),
        note,
      ]);
    return rows;
  }, [quoteNotes]);
  const quoteActivitiesBySource = useMemo(() => {
    const rows = new Map<string, QuoteActivity[]>();
    for (const activity of quoteActivities)
      rows.set(activity.sourceWorkItemId, [
        ...(rows.get(activity.sourceWorkItemId) || []),
        activity,
      ]);
    return rows;
  }, [quoteActivities]);
  const quoteLogRecord = quoteLogSourceId
    ? (allQuoteRecords.find(
        (quote) => quote.sourceWorkItemId === quoteLogSourceId,
      ) ?? null)
    : null;

  const emptyPerformance: PerformanceRow = {
    agentId: currentUserId,
    whatsappQuotes: 0,
    ringCentralQuotes: 0,
    workloadTurns: 0,
    whatsappUpdates: 0,
    manualQuotes: 0,
    soldQuotes: 0,
    ownedActivations: 0,
    ownedChanges: 0,
    requotes: 0,
    passedTurns: 0,
  };
  const myPerformance =
    performance.find((row) => row.agentId === currentUserId) ??
    emptyPerformance;
  const performanceMetrics = useMemo(
    () =>
      performanceMetricKeys.map((key) => {
        const values = performance.map((row) => Number(row[key]));
        const value = Number(myPerformance[key]);
        const average = values.length
          ? values.reduce((sum, item) => sum + item, 0) / values.length
          : 0;
        return {
          key,
          value,
          average,
          rank: values.length
            ? [...values].sort((a, b) => b - a).indexOf(value) + 1
            : 1,
        };
      }),
    [myPerformance, performance],
  );

  const agentPerformanceSummary = useMemo(() => {
    const myQuotes = allQuoteRecords.filter(
      (quote) =>
        quote.assignedProfileId === currentUserId &&
        withinDateRange(quote.createdAt, agentPerformanceStart, agentPerformanceEnd),
    );
    const notSold = myQuotes.filter((quote) => quote.status === "Not Sold");
    const sold = myQuotes.filter((quote) => quote.status === "Sold");
    const priceMinutes = myQuotes
      .map((quote) => {
        const priceEvent = quoteActivities
          .filter(
            (activity) =>
              activity.sourceWorkItemId === quote.sourceWorkItemId &&
              activity.eventType === "price_sent",
          )
          .sort(
            (a, b) =>
              new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
          )[0];
        return priceEvent
          ? durationMinutes(quote.createdAt, priceEvent.createdAt)
          : null;
      })
      .filter((value): value is number => value !== null);
    return {
      total: myQuotes.length,
      sold: sold.length,
      notSold,
      averagePriceMinutes: priceMinutes.length
        ? priceMinutes.reduce((sum, value) => sum + value, 0) / priceMinutes.length
        : null,
    };
  }, [
    agentPerformanceEnd,
    agentPerformanceStart,
    allQuoteRecords,
    currentUserId,
    quoteActivities,
  ]);

  function setAgentPerformancePreset(
    preset: "today" | "yesterday" | "week",
  ) {
    const end = new Date();
    const start = new Date();
    if (preset === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    } else if (preset === "week") {
      start.setDate(start.getDate() - 6);
    }
    setAgentPerformanceStart(dateInputValue(start));
    setAgentPerformanceEnd(dateInputValue(end));
  }

  const todayKey = dateInputValue(new Date());
  const dailyEfficiencyByAgent = useMemo(() => {
    const rows = new Map<
      string,
      { total: number; finalized: number; efficiency: number }
    >();
    for (const agent of agentList)
      rows.set(agent.name, { total: 0, finalized: 0, efficiency: 0 });

    const addQuote = (
      agentName: string,
      createdAt: string,
      finalized: boolean,
    ) => {
      if (!withinDateRange(createdAt, todayKey, todayKey)) return;
      const row = rows.get(agentName) ?? {
        total: 0,
        finalized: 0,
        efficiency: 0,
      };
      row.total += 1;
      if (finalized) row.finalized += 1;
      row.efficiency = row.total ? (row.finalized / row.total) * 100 : 0;
      rows.set(agentName, row);
    };

    workItems
      .filter(isQuote)
      .forEach((item) => addQuote(item.assignedAgent, item.createdAt, false));
    pendingPricing.forEach((item) =>
      addQuote(item.assignedAgent, item.quoteCreatedAt, false),
    );
    quoteOutcomes.forEach((item) =>
      addQuote(item.assignedAgent, item.quoteCreatedAt, true),
    );
    return rows;
  }, [agentList, pendingPricing, quoteOutcomes, todayKey, workItems]);

  const myEfficiency = currentUser
    ? (dailyEfficiencyByAgent.get(currentUser.name)?.efficiency ?? 0)
    : 0;
  const efficiencyValues = agentList.map(
    (agent) => dailyEfficiencyByAgent.get(agent.name)?.efficiency ?? 0,
  );
  const efficiencyAverage = efficiencyValues.length
    ? efficiencyValues.reduce((sum, value) => sum + value, 0) /
      efficiencyValues.length
    : 0;
  const efficiencyRank = efficiencyValues.length
    ? [...efficiencyValues].sort((a, b) => b - a).indexOf(myEfficiency) + 1
    : 1;

  const applyDashboardData = useCallback((data: DashboardData) => {
    setAgentList(data.agents);
    setCustomerServiceUsers(data.customerServiceUsers);
    setSourceList(data.sources);
    setSalespeople(data.salespeople);
    setWorkItems(data.workItems);
    setPendingPricing(data.pendingPricing);
    setQuoteOutcomes(data.quoteOutcomes);
    setQuoteNotes(data.quoteNotes);
    setQuoteActivities(data.quoteActivities);
    setQuoteTakeEvents(data.quoteTakeEvents);
    setQuoteTakeTimers(data.quoteTakeTimers);
    setWorkDeskSettings(data.settings);
    setNotifications(data.notifications);
    setPerformance(data.performance);
    setPassEvents(data.passEvents);
    setWhatsappCurrentId(data.rotations.whatsapp);
    setRingCentralCurrentId(data.rotations.ringcentral);
    setWorkloadCurrentId(data.rotations.workload);
  }, []);

  const refreshLiveData = useCallback(
    async (silent = false) => {
      if (refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        const data = await loadDashboardData(supabase);
        applyDashboardData(data);
        setLastUpdatedAt(new Date());
      } catch (caught) {
        if (!silent)
          showToast(
            caught instanceof Error
              ? caught.message
              : "Unable to refresh live data.",
          );
      } finally {
        refreshInFlight.current = false;
      }
    },
    [applyDashboardData, supabase],
  );

  useEffect(() => {
    const channel = supabase
      .channel("work-desk-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "profiles" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dealers" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dealer_salespeople" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rotation_state" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_items" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "pending_pricing_quotes" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "quote_outcomes" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "quote_notes" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_item_events" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "quote_take_events" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "quote_take_timers" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_desk_settings" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "user_notifications" },
        scheduleRefresh,
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "turn_events" },
        scheduleRefresh,
      )
      .subscribe();

    function scheduleRefresh() {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => {
        void refreshLiveData();
      }, 180);
    }

    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [refreshLiveData, supabase]);

  useEffect(() => {
    const refresh = () => {
      void refreshLiveData(true);
    };
    const interval = window.setInterval(refresh, 60_000);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshLiveData]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function showToast(message: string) {
    setToast(message);
  }

  async function runRpc(
    name: string,
    args: Record<string, unknown>,
    successMessage: string,
  ) {
    const { error } = await supabase.rpc(name, args);
    if (error) {
      await refreshLiveData();
      showToast(error.message);
      return false;
    }
    await refreshLiveData();
    showToast(successMessage);
    return true;
  }

  function playAlertSound() {
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as typeof window & { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.35,
      );
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.36);
      oscillator.addEventListener("ended", () => void context.close());
    } catch {
      // Sound is a convenience; persistent in-app alerts still remain available.
    }
  }

  async function enableNotifications() {
    if (!("Notification" in window))
      return showToast("This browser does not support desktop notifications.");
    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    setNotificationsEnabled(enabled);
    window.localStorage.setItem(
      "nhwd-alerts-enabled",
      enabled ? "true" : "false",
    );
    if (enabled) playAlertSound();
    showToast(
      enabled
        ? "Desktop alerts enabled. Turn and assignment alerts are active."
        : "Notification permission was not granted.",
    );
  }

  useEffect(() => {
    const newlyArrived = notifications.filter(
      (item) => !seenNotificationIds.current.has(item.id),
    );
    if (!newlyArrived.length) return;

    newlyArrived.forEach((item) => seenNotificationIds.current.add(item.id));
    const latest = newlyArrived[0];
    showToast(`${latest.title}: ${latest.message}`);

    if (
      notificationsEnabled &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      new Notification(latest.title, { body: latest.message, tag: latest.id });
      playAlertSound();
    }
  }, [notifications, notificationsEnabled]);

  useEffect(() => {
    if (isManager) return;

    const checkWarnings = async () => {
      const now = Date.now();
      const warningTimers = quoteTakeTimers.filter((timer) => {
        if (
          timer.rotation !== "whatsapp" ||
          timer.currentProfileId !== currentUserId ||
          timer.warningSentAt ||
          requestedTimerWarningIds.current.has(timer.id)
        )
          return false;
        const remaining = Math.ceil(
          (new Date(timer.deadlineAt).getTime() - now) / 1000,
        );
        return remaining > 0 && remaining <= 30;
      });

      for (const timer of warningTimers) {
        requestedTimerWarningIds.current.add(timer.id);
        const { error } = await supabase.rpc("send_quote_take_timer_warning", {
          p_timer_id: timer.id,
        });
        if (error) requestedTimerWarningIds.current.delete(timer.id);
      }
    };

    void checkWarnings();
    const interval = window.setInterval(() => {
      void checkWarnings();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [currentUserId, isManager, quoteTakeTimers, supabase]);

  async function markNotificationsRead() {
    const success = await runRpc(
      "mark_my_notifications_read",
      {},
      "Alerts marked as read.",
    );
    if (success) setNotificationPanelOpen(false);
  }

  async function handleAvailability(status: AvailabilityStatus) {
    await runRpc(
      "set_my_availability",
      { p_status: status },
      `Status changed to ${status === "break" ? "Break / Lunch" : status}.`,
    );
  }

  async function handlePass(rotation: RotationKind) {
    if (rotation === "workload")
      return showToast(
        "Additional Workload turns cannot be passed. Take the task, then use Customer Service overflow when enabled.",
      );
    const reason = window.prompt(
      "Why are you passing this turn?",
      "Current workload",
    );
    if (!reason?.trim()) return;
    await runRpc(
      "pass_my_turn",
      { p_rotation: rotation, p_reason: reason.trim() },
      `${rotationConfig[rotation].title} turn passed.`,
    );
  }

  function openQuoteResult(itemId: string) {
    setQuoteResultItemId(itemId);
    setModal("quote_result");
  }

  async function acceptAssignedItem(item: WorkItem) {
    await runRpc(
      "accept_my_assigned_item",
      { p_work_item_id: item.id },
      `${item.customer} accepted. Your work timer is now running.`,
    );
  }

  async function completeWorkItem(item: WorkItem) {
    if (!item.acceptedAt)
      return showToast("Accept this assignment before completing it.");
    if (isQuote(item)) return openQuoteResult(item.id);
    await runRpc(
      "complete_my_service_item",
      { p_work_item_id: item.id, p_status: "completed" },
      "Task marked completed. No rotation moved.",
    );
  }

  async function finalizeActiveQuote(status: "price_sent" | "sold") {
    if (!quoteResultItem || !isQuote(quoteResultItem)) return;
    const success =
      status === "price_sent"
        ? await runRpc(
            "move_my_quote_to_pending_pricing",
            { p_work_item_id: quoteResultItem.id },
            "Price sent. Quote moved out of active workload and into Pending Pricing.",
          )
        : await runRpc(
            "finalize_my_active_quote",
            {
              p_work_item_id: quoteResultItem.id,
              p_decision: "sold",
              p_not_sold_reason: null,
              p_not_sold_reason_other: null,
            },
            "Quote marked Sold.",
          );
    if (success) {
      setModal(null);
      setQuoteResultItemId(null);
    }
  }

  async function finalizePendingPricingSold(item: PendingPricingItem) {
    await runRpc(
      "finalize_pending_pricing_quote",
      {
        p_pending_id: item.id,
        p_decision: "sold",
        p_not_sold_reason: null,
        p_not_sold_reason_other: null,
      },
      `${item.customer} marked Sold.`,
    );
  }

  function requestChangeOutcome(record: QuoteRecord) {
    setChangeOutcomeRecord(record);
    setModal("change_outcome");
  }

  async function submitChangeOutcome(formData: FormData) {
    if (!changeOutcomeRecord) return;
    const note = String(formData.get("note") || "").trim();
    if (!note)
      return showToast(
        "Enter a note explaining why you're changing this outcome.",
      );

    const targetDecision: "sold" | "not_sold" =
      changeOutcomeRecord.status === "Sold" ? "not_sold" : "sold";

    let reason: NotSoldReason | null = null;
    let otherText: string | null = null;

    if (targetDecision === "not_sold") {
      reason = String(formData.get("reason") || "") as NotSoldReason;
      if (!reason) {
        return showToast("Please select a Not Sold reason.");
      }
      otherText = String(formData.get("otherReason") || "").trim();
      if (reason === "other" && !otherText) {
        return showToast("Please type the Other reason.");
      }
    }

    const success = await runRpc(
      "change_quote_outcome",
      {
        p_outcome_id: changeOutcomeRecord.id,
        p_new_decision: targetDecision,
        p_not_sold_reason: reason,
        p_not_sold_reason_other:
          reason === "other" ? otherText : null,
        p_note: note,
      },
      `${changeOutcomeRecord.customer} outcome changed to ${targetDecision === "sold" ? "Sold" : "Not Sold"}.`,
    );
    if (success) {
      setModal(null);
      setChangeOutcomeRecord(null);
    }
  }

  async function addQuoteNote(sourceWorkItemId: string) {
    const draft = (noteDrafts[sourceWorkItemId] || "").trim();
    if (!draft) return;
    const success = await runRpc(
      "add_quote_note",
      { p_source_work_item_id: sourceWorkItemId, p_note: draft },
      "Quote note added.",
    );
    if (success)
      setNoteDrafts((current) => ({ ...current, [sourceWorkItemId]: "" }));
  }

  function requestNotSold(target: NotSoldTarget) {
    setNotSoldTarget(target);
    setModal("not_sold_reason");
  }

  async function submitNotSoldReason(formData: FormData) {
    if (!notSoldTarget) return;
    const reason = String(formData.get("reason")) as NotSoldReason;
    const other = String(formData.get("otherReason") || "").trim();
    if (reason === "other" && !other) {
      showToast("Please type the Other reason.");
      return;
    }

    const args = {
      p_decision: "not_sold",
      p_not_sold_reason: reason,
      p_not_sold_reason_other: reason === "other" ? other : null,
    };
    const success =
      notSoldTarget.kind === "active"
        ? await runRpc(
            "finalize_my_active_quote",
            { p_work_item_id: notSoldTarget.item.id, ...args },
            "Quote marked Not Sold.",
          )
        : await runRpc(
            "finalize_pending_pricing_quote",
            { p_pending_id: notSoldTarget.item.id, ...args },
            `${notSoldTarget.item.customer} marked Not Sold.`,
          );

    if (success) {
      setModal(null);
      setQuoteResultItemId(null);
      setNotSoldTarget(null);
    }
  }

  function openTake(rotation: "whatsapp") {
    setTakeRotation(rotation);
    setModal("take_quote");
  }

  function openQuoteLog(sourceWorkItemId: string) {
    setQuoteLogSourceId(sourceWorkItemId);
    setModal("quote_log");
  }

  async function submitTakeQuote(formData: FormData) {
    const rotation = String(formData.get("rotation")) as "whatsapp";
    const receivedAtLocal = String(formData.get("receivedAt") || "");
    const customer = String(formData.get("customer") || "");
    const dealerId = String(formData.get("dealer") || "");
    const salespersonId = String(formData.get("salesperson") || "");
    const workType = String(formData.get("quoteType") || "new_quote") as
      "new_quote" | "requote";
    const note = String(formData.get("note") || "").trim();
    const receivedDate = new Date(receivedAtLocal);
    if (!receivedAtLocal || Number.isNaN(receivedDate.getTime()))
      return showToast("Enter the time the quote came in.");

    const success = await runRpc(
      "start_quote_take_timer_v094",
      {
        p_rotation: rotation,
        p_received_at: receivedDate.toISOString(),
        p_customer_name: customer,
        p_dealer_id: dealerId,
        p_salesperson_id: salespersonId || null,
        p_work_type: workType,
        p_note: note || null,
      },
      "Rescue timer started. The current agent was alerted.",
    );
    if (success) {
      setModal(null);
      setTakeRotation(null);
    }
  }

  async function claimTimedQuote(timerId: string) {
    await runRpc(
      "claim_timed_quote",
      { p_timer_id: timerId },
      "Timed quote claimed. The normal queue advanced from your turn.",
    );
  }

  async function stealTimedQuote(timerId: string) {
    await runRpc(
      "steal_timed_quote",
      { p_timer_id: timerId },
      "Quote stolen. Only the missed agent's turn was consumed; the next queue position was preserved.",
    );
  }

  function openCustomerServicePass(item: WorkItem) {
    setCustomerServicePassItemId(item.id);
    setModal("customer_service_pass");
  }

  async function submitCustomerServicePass(formData: FormData) {
    if (!customerServicePassItem) return;
    const reason = String(formData.get("reason") || "").trim();
    const handoffNote = String(formData.get("handoffNote") || "").trim();
    if (!reason || !handoffNote)
      return showToast(
        "Enter both the reason and the Customer Service handoff details.",
      );
    const success = await runRpc(
      "pass_workload_to_customer_service",
      {
        p_work_item_id: customerServicePassItem.id,
        p_reason: reason,
        p_handoff_note: handoffNote,
      },
      `${customerServicePassItem.customer} passed to Customer Service and recorded as a workload pass.`,
    );
    if (success) {
      setModal(null);
      setCustomerServicePassItemId(null);
    }
  }

  async function managerUpdateCustomerServiceOverflow(
    enabled: boolean,
    profileId: string | null,
  ) {
    await runRpc(
      "manager_update_customer_service_overflow",
      { p_enabled: enabled, p_customer_service_profile_id: profileId },
      enabled
        ? "Customer Service overflow enabled."
        : "Customer Service overflow disabled.",
    );
  }

  async function submitWhatsappQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer"));
    const salespersonId = String(formData.get("salesperson") || "");
    const note = String(formData.get("note") || "").trim();
    const success = await runRpc(
      "claim_whatsapp_quote_v094",
      {
        p_customer_name: customer,
        p_dealer_id: dealerId,
        p_salesperson_id: salespersonId || null,
        p_note: note || null,
      },
      "New WhatsApp quote logged. The rotation advanced.",
    );
    if (success) setModal(null);
  }

  async function submitRingCentralQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer"));
    const salespersonId = String(formData.get("salesperson") || "");
    const workType = String(formData.get("quoteType")) as
      "new_quote" | "requote";
    const note = String(formData.get("note") || "").trim();
    const success = await runRpc(
      "claim_ringcentral_quote_v094",
      {
        p_customer_name: customer,
        p_dealer_id: dealerId,
        p_salesperson_id: salespersonId || null,
        p_work_type: workType,
        p_note: note || null,
      },
      `${workTypeLabels[workType]} logged. The RingCentral rotation advanced.`,
    );
    if (success) setModal(null);
  }

  async function submitWorkloadTurn(formData: FormData) {
    const mode = String(formData.get("workloadMode") || "linked") as
      "linked" | "new";
    const workType = String(formData.get("workType")) as
      "activation" | "change";
    const changeType = String(formData.get("changeType") || "").trim();
    const note = String(formData.get("note") || "").trim();

    let success = false;
    if (mode === "linked") {
      const relatedQuoteId = String(formData.get("relatedQuote") || "");
      if (!relatedQuoteId)
        return showToast("Select the existing quote this workload belongs to.");
      success = await runRpc(
        "claim_linked_workload_turn",
        {
          p_related_quote_source_work_item_id: relatedQuoteId,
          p_work_type: workType,
          p_change_type: changeType || null,
          p_note: note || null,
        },
        workType === "activation"
          ? "Activation taken. The linked quote was marked Sold and the workload rotation advanced."
          : "Change linked to the existing quote. The workload rotation advanced.",
      );
    } else {
      const customer = String(formData.get("customer") || "");
      const dealerId = String(formData.get("dealer") || "");
      const salespersonId = String(formData.get("salesperson") || "");
      const ownerId = String(formData.get("owner") || "");
      success = await runRpc(
        "claim_unlinked_workload_turn_v094",
        {
          p_customer_name: customer,
          p_dealer_id: dealerId || null,
          p_salesperson_id: salespersonId || null,
          p_work_type: workType,
          p_original_owner_profile_id: ownerId || null,
          p_change_type: changeType || null,
          p_note: note || null,
        },
        workType === "activation"
          ? "Legacy activation taken and recorded as Sold. The workload rotation advanced."
          : "Legacy change taken. The workload rotation advanced.",
      );
    }
    if (success) setModal(null);
  }

  async function submitManualWorkload(formData: FormData) {
    const mode = String(formData.get("workloadMode") || "linked") as
      "linked" | "new";
    const workType = String(formData.get("workType")) as
      "activation" | "change";
    const changeType = String(formData.get("changeType") || "").trim();
    const note = String(formData.get("note") || "").trim();
    const relatedQuoteId = String(formData.get("relatedQuote") || "");
    const customer = String(formData.get("customer") || "");
    const dealerId = String(formData.get("dealer") || "");
    const salespersonId = String(formData.get("salesperson") || "");
    const ownerId = String(formData.get("owner") || "");
    if (mode === "linked" && !relatedQuoteId)
      return showToast("Select the existing quote this workload belongs to.");
    const success = await runRpc(
      "log_manual_workload",
      {
        p_mode: mode,
        p_related_quote_source_work_item_id: relatedQuoteId || null,
        p_customer_name: customer || null,
        p_dealer_id: dealerId || null,
        p_salesperson_id: salespersonId || null,
        p_work_type: workType,
        p_original_owner_profile_id: ownerId || null,
        p_change_type: changeType || null,
        p_note: note || null,
      },
      `${workTypeLabels[workType]} logged without moving the Additional Workload queue.`,
    );
    if (success) setModal(null);
  }

  async function submitPayment(formData: FormData) {
    const customer = String(formData.get("customer") || "");
    const dealerId = String(formData.get("dealer") || "");
    const salespersonId = String(formData.get("salesperson") || "");
    const note = String(formData.get("note") || "").trim();
    const success = await runRpc(
      "log_payment_v094",
      {
        p_customer_name: customer,
        p_dealer_id: dealerId || null,
        p_salesperson_id: salespersonId || null,
        p_note: note,
      },
      "Payment recorded. No rotation moved.",
    );
    if (success) setModal(null);
  }

  async function submitManualQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer") || "");
    const salespersonId = String(formData.get("salesperson") || "");
    const workType = String(formData.get("quoteType")) as
      "new_quote" | "requote";
    const inputMethod = String(formData.get("inputMethod"));
    const note = String(formData.get("note") || "").trim();
    const success = await runRpc(
      "log_manual_quote_v094",
      {
        p_customer_name: customer,
        p_dealer_id: dealerId || null,
        p_salesperson_id: salespersonId || null,
        p_work_type: workType,
        p_received_through: inputMethod,
        p_note: note || null,
      },
      "Manual quote recorded for reporting. No rotation moved.",
    );
    if (success) setModal(null);
  }

  async function submitManagerAssignedQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer") || "");
    const salespersonId = String(formData.get("salesperson") || "");
    const workType = String(formData.get("quoteType")) as
      "new_quote" | "requote";
    const inputMethod = String(formData.get("inputMethod"));
    const assignedProfileId = String(formData.get("assignedAgent"));
    const note = String(formData.get("note") || "");
    const agent = agentList.find(
      (candidate) => candidate.id === assignedProfileId,
    );
    const success = await runRpc(
      "manager_create_and_assign_quote_v094",
      {
        p_customer_name: customer,
        p_dealer_id: dealerId || null,
        p_salesperson_id: salespersonId || null,
        p_work_type: workType,
        p_received_through: inputMethod,
        p_assigned_profile_id: assignedProfileId,
        p_note: note || null,
      },
      `Quote created and assigned to ${agent?.name || "the selected agent"}.`,
    );
    if (success) setModal(null);
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  async function managerReassignWork(itemId: string, profileId: string) {
    const agent = agentList.find((candidate) => candidate.id === profileId);
    const reason = window.prompt(
      `Why are you assigning this work to ${agent?.name || "the selected agent"}?`,
    );
    if (!reason?.trim())
      return showToast("A manager assignment note is required.");
    await runRpc(
      "manager_reassign_work_item",
      {
        p_work_item_id: itemId,
        p_new_profile_id: profileId,
        p_reason: reason.trim(),
      },
      `Task reassigned to ${agent?.name || "selected agent"}.`,
    );
  }

  async function managerReassignPending(itemId: string, profileId: string) {
    const agent = agentList.find((candidate) => candidate.id === profileId);
    const reason = window.prompt(
      `Why are you assigning this pricing follow-up to ${agent?.name || "the selected agent"}?`,
    );
    if (!reason?.trim())
      return showToast("A manager assignment note is required.");
    await runRpc(
      "manager_reassign_pending_pricing",
      {
        p_pending_id: itemId,
        p_new_profile_id: profileId,
        p_reason: reason.trim(),
      },
      `Pricing follow-up reassigned to ${agent?.name || "selected agent"}.`,
    );
  }

  async function managerDeleteQuote(
    stage: ManagerQuoteStage,
    quoteId: string,
    customer: string,
  ) {
    const reason = window.prompt(
      `Why are you deleting the quote for ${customer}? This reason will be kept in the audit log.`,
    );
    if (!reason?.trim()) return;
    if (
      !window.confirm(
        `Permanently delete the ${customer} quote from Work Desk and all performance reports? This cannot be undone.`,
      )
    )
      return;
    await runRpc(
      "manager_delete_quote",
      { p_quote_stage: stage, p_quote_id: quoteId, p_reason: reason.trim() },
      `${customer} quote deleted.`,
    );
  }

  async function managerSetRotation(rotation: RotationKind, profileId: string) {
    await runRpc(
      "manager_set_rotation_current",
      {
        p_rotation: rotation,
        p_profile_id: profileId,
        p_reason: "Manager changed rotation from Overview",
      },
      `${rotationConfig[rotation].shortTitle} rotation changed.`,
    );
  }

  async function managerToggleRotation(agent: Agent, rotation: RotationKind) {
    const current =
      rotation === "whatsapp"
        ? agent.whatsappActive
        : rotation === "ringcentral"
          ? agent.ringCentralActive
          : agent.workloadActive;
    await runRpc(
      "manager_set_rotation_eligibility",
      {
        p_profile_id: agent.id,
        p_rotation: rotation,
        p_active: !current,
        p_reason: "Manager changed rotation eligibility from Team Controls",
      },
      `${agent.name} ${!current ? "activated in" : "paused from"} the ${rotationConfig[rotation].shortTitle} rotation.`,
    );
  }

  async function managerSetQueueOrder(
    rotation: RotationKind,
    profileIds: string[],
  ) {
    await runRpc(
      "manager_set_queue_order",
      { p_rotation: rotation, p_profile_ids: profileIds },
      `${rotationConfig[rotation].shortTitle} queue order saved.`,
    );
  }

  const agentTabs: Array<{
    id: AgentTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    {
      id: "desk",
      label: "My Desk",
      icon: <Gauge className="h-4 w-4" />,
      badge: myActiveWork.length,
    },
    {
      id: "pricing",
      label: "Pending Pricing",
      icon: <Clock3 className="h-4 w-4" />,
      badge: myPendingPricing.length,
    },
    {
      id: "intake_queue",
      label: "Intake Queue",
      icon: <ClipboardList className="h-4 w-4" />,
      badge: unclaimedIntakeCount || undefined,
    },
    { id: "team", label: "My Team", icon: <UsersRound className="h-4 w-4" /> },
    {
      id: "quotes",
      label: "Databases",
      icon: <Table2 className="h-4 w-4" />,
    },
    {
      id: "performance",
      label: "Performance",
      icon: <TrendingUp className="h-4 w-4" />,
    },
  ];

  return (
    <div className="min-h-screen bg-[#f3f5f9] text-slate-950">
      {toast ? (
        <div className="fixed right-5 top-5 z-[60] flex max-w-md items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-xl">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />
          {toast}
        </div>
      ) : null}

      <header className="sticky top-0 z-30 border-b border-[#dbe3f0] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1700px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Image
              src="/new-hope-logo-horizontal.png"
              alt="New Hope Insurance"
              width={190}
              height={48}
              className="h-10 w-auto object-contain"
              priority
            />
            <div className="hidden border-l border-slate-200 pl-4 md:block">
              <h1 className="font-black tracking-tight text-[#17305f]">
                Work Desk
              </h1>
              <p className="text-xs font-semibold text-slate-400">
                Sales operations · Three live rotations
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <button
                onClick={() => setNotificationPanelOpen((open) => !open)}
                className="relative inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50"
              >
                <Bell className="h-4 w-4" />
                Alerts
                {unreadNotifications.length ? (
                  <span className="grid h-5 min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[10px] text-white">
                    {unreadNotifications.length}
                  </span>
                ) : null}
              </button>
              {notificationPanelOpen ? (
                <div className="absolute right-0 top-12 z-50 w-[380px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                    <div>
                      <p className="text-sm font-black text-slate-900">
                        Alerts
                      </p>
                      <p className="text-[11px] font-semibold text-slate-400">
                        Turns, rescue timers, and assignments
                      </p>
                    </div>
                    {unreadNotifications.length ? (
                      <button
                        onClick={() => void markNotificationsRead()}
                        className="text-[11px] font-black text-[#223f7a]"
                      >
                        Mark all read
                      </button>
                    ) : null}
                  </div>
                  {!notificationsEnabled ? (
                    <div className="border-b border-slate-100 bg-amber-50 px-4 py-3">
                      <p className="text-xs font-bold text-amber-800">
                        Desktop notifications and sound are off.
                      </p>
                      <button
                        onClick={() => void enableNotifications()}
                        className="mt-2 rounded-lg bg-amber-500 px-3 py-2 text-[11px] font-black text-white"
                      >
                        Enable Desktop Alerts
                      </button>
                    </div>
                  ) : null}
                  <div className="max-h-96 overflow-auto">
                    {notifications.length ? (
                      notifications.slice(0, 12).map((item) => (
                        <div
                          key={item.id}
                          className={cn(
                            "border-b border-slate-100 px-4 py-3 last:border-b-0",
                            !item.readAt && "bg-[#f3f6fb]",
                          )}
                        >
                          <div className="flex items-start gap-3">
                            <div
                              className={cn(
                                "mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl",
                                item.type === "turn"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-blue-50 text-blue-700",
                              )}
                            >
                              <Bell className="h-4 w-4" />
                            </div>
                            <div>
                              <p className="text-sm font-black text-slate-900">
                                {item.title}
                              </p>
                              <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
                                {item.message}
                              </p>
                              <p className="mt-1 text-[10px] font-bold text-slate-400">
                                {formatDateTime(item.createdAt)}
                              </p>
                            </div>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-6 text-center text-sm font-semibold text-slate-400">
                        No alerts yet.
                      </div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="hidden items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-[10px] font-black text-emerald-700 lg:flex">
              <RefreshCw className="h-3.5 w-3.5" />
              Updated{" "}
              {lastUpdatedAt.toLocaleTimeString([], {
                hour: "numeric",
                minute: "2-digit",
              })}
            </div>
            <div className="hidden rounded-xl bg-slate-50 px-3 py-2 text-right sm:block">
              <p className="text-xs font-black text-slate-800">
                {sessionProfile.displayName}
              </p>
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
                {sessionProfile.role === "manager"
                  ? "Management"
                  : sessionProfile.role === "customer_service"
                    ? "Customer Service"
                    : `@${sessionProfile.username}`}
              </p>
            </div>
            <button
              onClick={handleSignOut}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50"
              title="Sign out"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      {workspaceTabs ? (
        <div className="sticky top-[65px] z-20 border-b border-[#dbe3f0] bg-[#f3f5f9]/95 backdrop-blur-xl">
          {workspaceTabs}
        </div>
      ) : null}

      <main className="mx-auto max-w-[1700px] px-4 py-6 sm:px-6 lg:px-8">
        {externalWorkspaceContent !== undefined ? (
          externalWorkspaceContent
        ) : isCustomerService && currentCustomerServiceUser ? (
          <CustomerServiceWorkspace
            user={currentCustomerServiceUser}
            activeWork={myActiveWork}
            recentActivity={myRecentActivity}
            quoteNotesBySource={quoteNotesBySource}
            noteDrafts={noteDrafts}
            onDraftChange={(sourceWorkItemId, value) =>
              setNoteDrafts((current) => ({
                ...current,
                [sourceWorkItemId]: value,
              }))
            }
            onAccept={acceptAssignedItem}
            onComplete={completeWorkItem}
            onOpenLog={openQuoteLog}
            onAddNote={addQuoteNote}
          />
        ) : !isManager && currentUser ? (
          <div className="space-y-5">
            <section className="flex flex-col gap-4 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-4">
                <Avatar agent={currentUser} size="lg" />
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">
                    Working as
                  </p>
                  <h2 className="mt-1 text-2xl font-black tracking-tight">
                    {currentUser.name}
                  </h2>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    {myActiveWork.length} active task
                    {myActiveWork.length === 1 ? "" : "s"} ·{" "}
                    {myPendingPricing.length} awaiting source decision
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="mr-2 flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-400">
                  <Activity className="h-4 w-4" /> My status
                </div>
                {(
                  [
                    ["available", "Available", "bg-emerald-600 text-white"],
                    ["break", "Break / Lunch", "bg-amber-500 text-white"],
                    ["unavailable", "Unavailable", "bg-slate-700 text-white"],
                  ] as const
                ).map(([status, label, activeClass]) => (
                  <button
                    key={status}
                    onClick={() => handleAvailability(status)}
                    className={cn(
                      "rounded-xl px-3 py-2 text-xs font-black transition",
                      currentUser.availability === status
                        ? activeClass
                        : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50",
                    )}
                  >
                    {label}
                  </button>
                ))}
                <p className="w-full pt-1 text-[11px] font-semibold text-slate-400 lg:text-right">
                  Daily start: the first eligible agent to click Available
                  starts each queue for the day.
                </p>
              </div>
            </section>

            <TabBar tabs={agentTabs} value={agentTab} onChange={setAgentTab} />

            {agentTab === "desk" ? (
              <div className="space-y-6">
                <section className="grid gap-5 xl:grid-cols-3">
                  <RotationCard
                    variant="whatsapp"
                    current={whatsappCurrent}
                    upcoming={
                      whatsappCurrentId
                        ? upcomingAgents(
                            agentList,
                            whatsappCurrentId,
                            "whatsapp",
                          )
                        : []
                    }
                    isMyTurn={
                      whatsappCurrentId !== null &&
                      currentUserId === whatsappCurrentId
                    }
                    canStartTimer={
                      whatsappCurrentId !== null &&
                      currentUserId !== whatsappCurrentId &&
                      currentUser.availability === "available" &&
                      currentUser.whatsappActive
                    }
                    timer={whatsappTimer}
                    currentUserId={currentUserId}
                    onAction={() => setModal("whatsapp_quote")}
                    onPass={() => handlePass("whatsapp")}
                    onStartTimer={() => openTake("whatsapp")}
                    onClaimTimer={() =>
                      whatsappTimer && void claimTimedQuote(whatsappTimer.id)
                    }
                    onStealTimer={() =>
                      whatsappTimer && void stealTimedQuote(whatsappTimer.id)
                    }
                  />
                  <RotationCard
                    variant="ringcentral"
                    current={ringCentralCurrent}
                    upcoming={
                      ringCentralCurrentId
                        ? upcomingAgents(
                            agentList,
                            ringCentralCurrentId,
                            "ringcentral",
                          )
                        : []
                    }
                    isMyTurn={
                      ringCentralCurrentId !== null &&
                      currentUserId === ringCentralCurrentId
                    }
                    currentUserId={currentUserId}
                    onAction={() => setModal("ringcentral_quote")}
                    onPass={() => handlePass("ringcentral")}
                  />
                  <RotationCard
                    variant="workload"
                    current={workloadCurrent}
                    upcoming={
                      workloadCurrentId
                        ? upcomingAgents(
                            agentList,
                            workloadCurrentId,
                            "workload",
                          )
                        : []
                    }
                    isMyTurn={
                      workloadCurrentId !== null &&
                      currentUserId === workloadCurrentId
                    }
                    currentUserId={currentUserId}
                    onAction={() => setModal("workload_turn")}
                    onPass={() => handlePass("workload")}
                  />
                </section>

                <section className="grid gap-5 xl:grid-cols-[1.45fr_.55fr]">
                  <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-col gap-3 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                          <ListChecks className="h-4 w-4" /> My Active Tasks
                        </div>
                        <h3 className="mt-1 text-xl font-black">
                          Work that needs your attention
                        </h3>
                        <p className="mt-1 text-sm text-slate-500">
                          Price-sent quotes move to Pending Pricing and stop
                          counting as workload.
                        </p>
                      </div>
                      <span className="rounded-full bg-[#eef3fb] px-3 py-1.5 text-xs font-black text-[#223f7a] ring-1 ring-[#c9d5e9]">
                        {myActiveWork.length} active
                      </span>
                    </div>
                    <div className="p-5">
                      {myActiveWork.length ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          {myActiveWork.map((item) => (
                            <div
                              key={item.id}
                              className="rounded-2xl border border-slate-200 p-4 transition hover:border-[#b5c4df] hover:shadow-sm"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-black text-slate-900">
                                      {item.customer}
                                    </span>
                                    <MethodBadge
                                      method={item.assignmentMethod}
                                    />
                                  </div>
                                  <p className="mt-1 text-sm font-semibold text-slate-500">
                                    {workTypeLabels[item.workType]} ·{" "}
                                    {item.dealer}
                                  </p>
                                  {item.relatedQuoteSourceWorkItemId ? (
                                    <p className="mt-2 text-xs font-black text-violet-700">
                                      Linked to an existing quote record
                                    </p>
                                  ) : null}
                                  <p className="mt-2 text-xs font-semibold text-slate-400">
                                    Assigned {formatDateTime(item.assignedAt)}
                                  </p>
                                  {item.acceptedAt ? (
                                    <p className="mt-1 text-xs font-semibold text-emerald-700">
                                      Accepted {formatDateTime(item.acceptedAt)}
                                    </p>
                                  ) : (
                                    <p className="mt-1 text-xs font-black text-amber-700">
                                      Awaiting your acceptance
                                    </p>
                                  )}
                                </div>
                                <div className="flex flex-col gap-2">
                                  {isQuote(item) ? (
                                    <button
                                      onClick={() => openQuoteLog(item.id)}
                                      className="rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-2 text-xs font-black text-[#223f7a]"
                                    >
                                      Log
                                    </button>
                                  ) : null}
                                  {item.acceptedAt ? (
                                    <button
                                      onClick={() => completeWorkItem(item)}
                                      className="rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white transition hover:bg-[#17305f]"
                                    >
                                      {isQuote(item)
                                        ? "Quote Status"
                                        : "Complete"}
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() =>
                                        void acceptAssignedItem(item)
                                      }
                                      className="rounded-xl bg-amber-500 px-3 py-2 text-xs font-black text-white transition hover:bg-amber-600"
                                    >
                                      Accept
                                    </button>
                                  )}
                                  {item.acceptedAt &&
                                  workDeskSettings.customerServiceOverflowEnabled &&
                                  (item.workType === "activation" ||
                                    item.workType === "change") &&
                                  workDeskSettings.customerServiceProfileId !==
                                    currentUserId ? (
                                    <button
                                      onClick={() =>
                                        openCustomerServicePass(item)
                                      }
                                      className="rounded-xl border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs font-black text-cyan-800 hover:bg-cyan-100"
                                    >
                                      Pass to CS
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <EmptyState
                          title="No active tasks"
                          note="You are caught up. Price-sent quotes stay in the separate follow-up list."
                        />
                      )}
                    </div>
                  </div>

                  <div className="space-y-5">
                    <div className="rounded-[28px] border border-[#c9d5e9] bg-[#f3f6fb] p-6 shadow-sm">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                            Quick Actions
                          </p>
                          <h3 className="mt-1 text-xl font-black">
                            Log no-turn work
                          </h3>
                        </div>
                        <Sparkles className="h-5 w-5 text-[#4d6aa8]" />
                      </div>
                      <div className="mt-5 grid gap-3">
                        <button
                          onClick={() => setModal("payment")}
                          className="group rounded-2xl border border-white bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
                        >
                          <div className="flex items-center gap-3">
                            <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-50 text-emerald-700">
                              <CircleDollarSign className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-black text-slate-900">
                                Payments
                              </p>
                              <p className="mt-1 text-xs font-semibold text-slate-500">
                                Log payment activity. No quote link or turn
                                required.
                              </p>
                            </div>
                          </div>
                        </button>
                        <button
                          onClick={() => setModal("manual_workload")}
                          className="group rounded-2xl border border-white bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
                        >
                          <div className="flex items-center gap-3">
                            <div className="grid h-10 w-10 place-items-center rounded-xl bg-violet-50 text-violet-700">
                              <Layers3 className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-black text-slate-900">
                                Log Manual Workload
                              </p>
                              <p className="mt-1 text-xs font-semibold text-slate-500">
                                Activation or Change without moving the workload
                                turn.
                              </p>
                            </div>
                          </div>
                        </button>
                        <button
                          onClick={() => setModal("manual_quote")}
                          className="group rounded-2xl border border-white bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"
                        >
                          <div className="flex items-center gap-3">
                            <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]">
                              <FilePlus2 className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-black text-slate-900">
                                Submit Manual Quote
                              </p>
                              <p className="mt-1 text-xs font-semibold text-slate-500">
                                Outside normal channels. Reporting only.
                              </p>
                            </div>
                          </div>
                        </button>
                      </div>
                    </div>

                    <div className="rounded-[28px] bg-[#223f7a] p-6 text-white shadow-sm">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-black uppercase tracking-[0.16em] text-blue-200">
                            At a glance
                          </p>
                          <h3 className="mt-1 text-xl font-black">
                            Your follow-up
                          </h3>
                        </div>
                        <ClipboardList className="h-5 w-5 text-blue-200" />
                      </div>
                      <div className="mt-5 grid grid-cols-2 gap-3">
                        <div className="rounded-2xl bg-white/10 p-4">
                          <p className="text-3xl font-black">
                            {myActiveWork.length}
                          </p>
                          <p className="mt-1 text-xs font-bold text-blue-100">
                            Active tasks
                          </p>
                        </div>
                        <div className="rounded-2xl bg-white/10 p-4">
                          <p className="text-3xl font-black">
                            {myPendingPricing.length}
                          </p>
                          <p className="mt-1 text-xs font-bold text-blue-100">
                            Pricing follow-ups
                          </p>
                        </div>
                      </div>
                      <button
                        onClick={() => setAgentTab("pricing")}
                        className="mt-4 w-full rounded-xl bg-white px-3 py-2.5 text-xs font-black text-[#223f7a]"
                      >
                        Open Pending Pricing
                      </button>
                    </div>
                  </div>
                </section>

                <section className="rounded-[28px] border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-100 p-6">
                    <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                      Recent Activity
                    </p>
                    <h3 className="mt-1 text-xl font-black">
                      Completed updates and tasks
                    </h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {myRecentActivity.length ? (
                      myRecentActivity.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-4 px-6 py-4"
                        >
                          <div>
                            <p className="font-black text-slate-800">
                              {item.customer}
                            </p>
                            <p className="mt-1 text-sm text-slate-500">
                              {workTypeLabels[item.workType]} ·{" "}
                              {item.note || item.dealer}
                            </p>
                          </div>
                          <div className="text-right">
                            <MethodBadge method={item.assignmentMethod} />
                            <p className="mt-2 text-xs font-semibold text-slate-400">
                              {formatDateTime(
                                item.completedAt || item.createdAt,
                              )}
                            </p>
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className="p-5">
                        <EmptyState
                          title="No recent activity"
                          note="Completed work will appear here."
                        />
                      </div>
                    )}
                  </div>
                </section>
              </div>
            ) : null}

            {agentTab === "pricing" ? (
              <section className="rounded-[28px] border border-blue-200 bg-white shadow-sm">
                <div className="flex flex-col gap-3 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-blue-600">
                      <Clock3 className="h-4 w-4" /> Pending Pricing
                    </div>
                    <h3 className="mt-1 text-xl font-black">
                      Waiting for source confirmation
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Log every follow-up and change so the quote can be
                      reviewed by the team later.
                    </p>
                  </div>
                  <span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700 ring-1 ring-blue-200">
                    {myPendingPricing.length} waiting
                  </span>
                </div>
                <div className="p-5">
                  {myPendingPricing.length ? (
                    <div className="grid gap-4 xl:grid-cols-2">
                      {myPendingPricing.map((item) => {
                        const notes =
                          quoteNotesBySource.get(item.sourceWorkItemId) || [];
                        return (
                          <div
                            key={item.id}
                            className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-black text-slate-900">
                                  {item.customer}
                                </p>
                                <p className="mt-1 text-sm font-semibold text-slate-500">
                                  {workTypeLabels[item.workType]} ·{" "}
                                  {item.dealer}
                                </p>
                                <p className="mt-2 text-xs font-bold text-blue-700">
                                  Price sent {formatDateTime(item.priceSentAt)}{" "}
                                  · {daysSince(item.priceSentAt)} day
                                  {daysSince(item.priceSentAt) === 1
                                    ? ""
                                    : "s"}{" "}
                                  waiting
                                </p>
                              </div>
                              <MethodBadge method={item.assignmentMethod} />
                            </div>
                            <PendingNotesPanel
                              notes={notes}
                              draft={noteDrafts[item.sourceWorkItemId] || ""}
                              onDraftChange={(value) =>
                                setNoteDrafts((current) => ({
                                  ...current,
                                  [item.sourceWorkItemId]: value,
                                }))
                              }
                              onAdd={() =>
                                void addQuoteNote(item.sourceWorkItemId)
                              }
                            />
                            <div className="mt-4 grid grid-cols-3 gap-2">
                              <button
                                onClick={() =>
                                  openQuoteLog(item.sourceWorkItemId)
                                }
                                className="rounded-xl border border-[#c9d5e9] bg-white px-3 py-2.5 text-xs font-black text-[#223f7a]"
                              >
                                Log
                              </button>
                              <button
                                onClick={() =>
                                  void finalizePendingPricingSold(item)
                                }
                                className="rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-black text-white"
                              >
                                Sold
                              </button>
                              <button
                                onClick={() =>
                                  requestNotSold({ kind: "pending", item })
                                }
                                className="rounded-xl bg-rose-50 px-3 py-2.5 text-xs font-black text-rose-700 ring-1 ring-rose-200"
                              >
                                Not Sold
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState
                      title="No quotes waiting on a decision"
                      note="When you mark a quote Price Sent, it will move here."
                    />
                  )}
                </div>
              </section>
            ) : null}

            {agentTab === "intake_queue" ? (
              <IntakeQueue initialProfile={{ id: sessionProfile.id, display_name: sessionProfile.displayName, initials: sessionProfile.initials, role: sessionProfile.role as "agent" | "customer_service" | "manager" | "commercial", is_active: true }} embedded />
            ) : null}

            {agentTab === "quotes" ? (
              <section className="flex flex-col gap-3 rounded-[24px] border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Team Databases</p>
                  <p className="mt-1 text-sm font-semibold text-slate-500">Review the quotes and workload handled by every team member.</p>
                </div>
                <div className="flex gap-1 rounded-2xl bg-slate-100 p-1.5">
                  <button type="button" onClick={() => setAgentDatabaseView("quotes")} className={cn("rounded-xl px-4 py-2.5 text-xs font-black", agentDatabaseView === "quotes" ? "bg-[#223f7a] text-white" : "text-slate-500 hover:bg-white")}>Quotes</button>
                  <button type="button" onClick={() => setAgentDatabaseView("workloads")} className={cn("rounded-xl px-4 py-2.5 text-xs font-black", agentDatabaseView === "workloads" ? "bg-[#223f7a] text-white" : "text-slate-500 hover:bg-white")}>Workloads</button>
                </div>
              </section>
            ) : null}

            {agentTab === "quotes" && agentDatabaseView === "quotes" ? (
              <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-6">
                  <div>
                    <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                      <Table2 className="h-4 w-4" /> Quotes Database
                    </div>
                    <h3 className="mt-1 text-xl font-black">
                      All quotes from every agent
                    </h3>
                    <p className="mt-1 text-sm text-slate-500">
                      Search and filter existing quotes before working an
                      activation or change. This prevents duplicate records.
                    </p>
                  </div>
                  <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    <Field label="Day">
                      <input
                        type="date"
                        value={quoteDayFilter}
                        onChange={(event) =>
                          setQuoteDayFilter(event.target.value)
                        }
                        className="field"
                      />
                    </Field>
                    <Field label="Status">
                      <select
                        value={quoteStatusFilter}
                        onChange={(event) =>
                          setQuoteStatusFilter(event.target.value)
                        }
                        className="field"
                      >
                        <option value="all">All statuses</option>
                        <option>Active</option>
                        <option>Price Sent</option>
                        <option>Sold</option>
                        <option>Not Sold</option>
                      </select>
                    </Field>
                    <Field label="Update">
                      <select
                        value={quoteUpdateFilter}
                        onChange={(event) =>
                          setQuoteUpdateFilter(event.target.value)
                        }
                        className="field"
                      >
                        {quoteUpdateFilterOptions.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Search">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                        <input
                          value={quoteSearch}
                          onChange={(event) =>
                            setQuoteSearch(event.target.value)
                          }
                          placeholder="Customer, source, salesperson, agent"
                          className="field"
                          style={{ paddingLeft: "3rem" }}
                        />
                      </div>
                    </Field>
                  </div>
                  <button
                    onClick={() => {
                      setQuoteDayFilter("");
                      setQuoteStatusFilter("all");
                      setQuoteUpdateFilter("all");
                      setQuoteSearch("");
                    }}
                    className="mt-3 text-xs font-black text-[#223f7a]"
                  >
                    Show all records
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-sm">
                    <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
                      <tr>
                        <th className="px-5 py-3">Customer</th>
                        <th className="px-5 py-3">Status</th>
                        <th className="px-5 py-3">Type</th>
                        <th className="px-5 py-3">Agent</th>
                        <th className="px-5 py-3">Source / Salesperson</th>
                        <th className="px-5 py-3">Input</th>
                        <th className="px-5 py-3">Updated</th>
                        <th className="px-5 py-3">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {visibleAgentQuotes.map((quote) => {
                        const statusClass =
                          quote.status === "Sold"
                            ? "bg-emerald-50 text-emerald-700"
                            : quote.status === "Not Sold"
                              ? "bg-rose-50 text-rose-700"
                              : quote.status === "Price Sent"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-amber-50 text-amber-700";
                        const latestNote = (quoteNotesBySource.get(
                          quote.sourceWorkItemId,
                        ) || [])[0];
                        return (
                          <tr
                            key={`${quote.stage}-${quote.id}`}
                            className="hover:bg-slate-50"
                          >
                            <td className="px-5 py-4">
                              <p className="font-black text-slate-900">
                                {quote.customer}
                              </p>
                              <p className="mt-1 text-xs text-slate-400">
                                {quote.source}
                              </p>
                              {quote.takeEvent ? (
                                <p className="mt-2 text-[11px] font-black text-amber-700">
                                  Taken by @{quote.takeEvent.takerUsername}{" "}
                                  after{" "}
                                  {formatElapsedSeconds(
                                    quote.takeEvent.elapsedSeconds,
                                  )}
                                </p>
                              ) : null}
                              {latestNote ? (
                                <p className="mt-2 max-w-md truncate text-xs font-semibold text-slate-500">
                                  Latest note: {latestNote.note}
                                </p>
                              ) : null}
                            </td>
                            <td className="px-5 py-4">
                              <span
                                className={cn(
                                  "rounded-full px-2.5 py-1 text-xs font-black",
                                  statusClass,
                                )}
                              >
                                {quote.status}
                              </span>
                            </td>
                            <td className="px-5 py-4 font-bold text-slate-600">
                              {workTypeLabels[quote.workType]}
                            </td>
                            <td className="px-5 py-4 font-bold text-slate-700">
                              {quote.agent}
                            </td>
                            <td className="px-5 py-4">
                              <p className="font-semibold text-slate-600">
                                {quote.source}
                              </p>
                              <p className="mt-1 text-xs text-slate-400">
                                {quote.salesperson}
                              </p>
                            </td>
                            <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                              {quote.receivedThrough}
                            </td>
                            <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                              {formatDateTime(quote.statusDate)}
                            </td>
                            <td className="px-5 py-4">
                              <div className="flex flex-wrap gap-2">
                                <button
                                  onClick={() =>
                                    openQuoteLog(quote.sourceWorkItemId)
                                  }
                                  className="rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-2 text-xs font-black text-[#223f7a]"
                                >
                                  Log
                                </button>
                                {(quote.status === "Sold" ||
                                  quote.status === "Not Sold") &&
                                quote.assignedProfileId === currentUserId ? (
                                  <button
                                    onClick={() =>
                                      requestChangeOutcome(quote)
                                    }
                                    className="rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-2 text-xs font-black text-[#223f7a]"
                                  >
                                    Change Outcome
                                  </button>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!visibleAgentQuotes.length ? (
                    <div className="p-5">
                      <EmptyState
                        title="No matching quotes"
                        note="Try a different customer, source, agent, or status."
                      />
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            {agentTab === "quotes" && agentDatabaseView === "workloads" ? (
              workloadDatabaseContent ?? (
                <EmptyState title="Workload database unavailable" note="Refresh the page or contact Management." />
              )
            ) : null}

            {agentTab === "team" ? (
              <MyTeamPanel
                quotes={allQuoteRecords}
                activities={quoteActivities}
                onOpenLog={openQuoteLog}
              />
            ) : null}

            {agentTab === "performance" ? (
              <section className="space-y-5">
                <section className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
                    <div>
                      <p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">Performance Period</p>
                      <h3 className="mt-1 text-xl font-black">My quote results</h3>
                    </div>
                    <div className="flex flex-wrap items-end gap-2">
                      <button type="button" className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black" onClick={() => setAgentPerformancePreset("today")}>Today</button>
                      <button type="button" className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black" onClick={() => setAgentPerformancePreset("yesterday")}>Yesterday</button>
                      <button type="button" className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black" onClick={() => setAgentPerformancePreset("week")}>Current Week</button>
                      <label><span className="block text-[10px] font-black uppercase text-slate-400">From</span><input type="date" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold" value={agentPerformanceStart} onChange={(event) => setAgentPerformanceStart(event.target.value)} /></label>
                      <label><span className="block text-[10px] font-black uppercase text-slate-400">To</span><input type="date" className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold" value={agentPerformanceEnd} onChange={(event) => setAgentPerformanceEnd(event.target.value)} /></label>
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl bg-slate-50 p-4"><p className="text-xs font-black uppercase text-slate-400">Quotes</p><p className="mt-1 text-3xl font-black">{agentPerformanceSummary.total}</p></div>
                    <div className="rounded-2xl bg-emerald-50 p-4"><p className="text-xs font-black uppercase text-emerald-700">Sold</p><p className="mt-1 text-3xl font-black text-emerald-800">{agentPerformanceSummary.sold}</p></div>
                    <div className="rounded-2xl bg-rose-50 p-4"><p className="text-xs font-black uppercase text-rose-700">Not Sold</p><p className="mt-1 text-3xl font-black text-rose-800">{agentPerformanceSummary.notSold.length}</p></div>
                    <div className="rounded-2xl bg-blue-50 p-4"><p className="text-xs font-black uppercase text-blue-700">Avg. time to pricing</p><p className="mt-1 text-3xl font-black text-blue-800">{formatDuration(agentPerformanceSummary.averagePriceMinutes)}</p></div>
                  </div>
                </section>
                {agentPerformanceSummary.notSold.length ? (
                  <details className="rounded-[24px] border border-rose-200 bg-white shadow-sm">
                    <summary className="cursor-pointer list-none p-4 font-black text-rose-800 [&::-webkit-details-marker]:hidden">Not Sold quotes in this period · {agentPerformanceSummary.notSold.length}</summary>
                    <div className="divide-y divide-slate-100 border-t border-rose-100">
                      {agentPerformanceSummary.notSold.map((quote) => (
                        <button key={quote.id} type="button" onClick={() => openQuoteLog(quote.sourceWorkItemId)} className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-rose-50/40">
                          <div><p className="font-black">{quote.customer}</p><p className="mt-1 text-xs font-semibold text-slate-500">{quote.source} · {quote.salesperson} · {formatDateTime(quote.statusDate)}</p></div>
                          <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-black text-rose-700">Open Log</span>
                        </button>
                      ))}
                    </div>
                  </details>
                ) : null}
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
                  {performanceMetrics.map((metric) => {
                    const setup = {
                      whatsappQuotes: [
                        "WhatsApp Quotes",
                        <MessageCircleMore
                          className="h-5 w-5 text-emerald-700"
                          key="i"
                        />,
                        "bg-emerald-50",
                      ],
                      ringCentralQuotes: [
                        "RC Quotes",
                        <PhoneCall className="h-5 w-5 text-blue-700" key="i" />,
                        "bg-blue-50",
                      ],
                      workloadTurns: [
                        "Workload",
                        <Layers3 className="h-5 w-5 text-violet-700" key="i" />,
                        "bg-violet-50",
                      ],
                      whatsappUpdates: [
                        "Payments",
                        <CircleDollarSign
                          className="h-5 w-5 text-emerald-700"
                          key="i"
                        />,
                        "bg-emerald-50",
                      ],
                      manualQuotes: [
                        "Manual Quotes",
                        <FilePlus2
                          className="h-5 w-5 text-slate-700"
                          key="i"
                        />,
                        "bg-slate-100",
                      ],
                      soldQuotes: [
                        "Sold Quotes",
                        <CircleDollarSign
                          className="h-5 w-5 text-emerald-700"
                          key="i"
                        />,
                        "bg-emerald-50",
                      ],
                      passedTurns: [
                        "Turns Passed",
                        <SkipForward
                          className="h-5 w-5 text-rose-700"
                          key="i"
                        />,
                        "bg-rose-50",
                      ],
                    }[metric.key] as [string, React.ReactNode, string];
                    return (
                      <MetricCard
                        key={metric.key}
                        label={setup[0]}
                        icon={setup[1]}
                        tone={setup[2]}
                        value={metric.value}
                        average={metric.average}
                        rank={metric.rank}
                      />
                    );
                  })}
                  <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-50">
                        <Gauge className="h-5 w-5 text-cyan-700" />
                      </div>
                      <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-black text-cyan-700">
                        #{efficiencyRank}
                      </span>
                    </div>
                    <p className="mt-5 text-sm font-bold text-slate-500">
                      Completion Efficiency
                    </p>
                    <div className="mt-1 flex items-end gap-3">
                      <span className="text-3xl font-black tracking-tight text-slate-950">
                        {myEfficiency.toFixed(1)}%
                      </span>
                      <span className="pb-1 text-xs font-bold text-slate-400">
                        Team avg {efficiencyAverage.toFixed(1)}%
                      </span>
                    </div>
                    <p className="mt-2 text-[11px] font-semibold text-slate-400">
                      Final Sold/Not Sold decisions ÷ all quotes received today.
                    </p>
                  </div>
                </div>
                <TeamPerformanceTable
                  agentList={agentList}
                  performance={performance}
                  currentUserId={currentUserId}
                  efficiencyByAgent={dailyEfficiencyByAgent}
                />
              </section>
            ) : null}
          </div>
        ) : (
          <ManagerView
            agentList={agentList}
            customerServiceUsers={customerServiceUsers}
            sourceList={sourceList}
            workItems={workItems}
            pendingPricing={pendingPricing}
            quoteOutcomes={quoteOutcomes}
            quoteNotes={quoteNotes}
            quoteActivities={quoteActivities}
            quoteTakeEvents={quoteTakeEvents}
            settings={workDeskSettings}
            performance={performance}
            passEvents={passEvents}
            whatsappCurrentId={whatsappCurrentId}
            ringCentralCurrentId={ringCentralCurrentId}
            workloadCurrentId={workloadCurrentId}
            managerTab={managerTab}
            setManagerTab={setManagerTab}
            finalizePendingPricingSold={finalizePendingPricingSold}
            onRequestNotSold={(item) =>
              requestNotSold({ kind: "pending", item })
            }
            onOpenAssignQuote={() => setModal("manager_assign_quote")}
            onReassignWork={managerReassignWork}
            onReassignPending={managerReassignPending}
            onDeleteQuote={managerDeleteQuote}
            onOpenQuoteLog={openQuoteLog}
            onAddQuoteNote={addQuoteNote}
            noteDrafts={noteDrafts}
            setNoteDrafts={setNoteDrafts}
            onSetRotation={managerSetRotation}
            onToggleRotation={managerToggleRotation}
            onSetQueueOrder={managerSetQueueOrder}
            onUpdateCustomerServiceOverflow={
              managerUpdateCustomerServiceOverflow
            }
            workloadDatabaseContent={workloadDatabaseContent}
            forceManagerTab={forceManagerTab}
          />
        )}
      </main>

      <Modal
        open={modal === "whatsapp_quote"}
        title="Take WhatsApp New Quote"
        subtitle="This advances only the WhatsApp rotation."
        onClose={() => setModal(null)}
      >
        <form action={submitWhatsappQuote} className="space-y-4 p-6">
          <Field label="Customer name">
            <input name="customer" required className="field" />
          </Field>
          <DealerSalespersonFields
            sources={sourceList}
            salespeople={salespeople}
          />
          <Field label="Notes (optional)">
            <textarea
              name="note"
              rows={3}
              className="field"
              placeholder="Important information for this quote"
            />
          </Field>
          <button className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-black text-white">
            Confirm New Quote
          </button>
        </form>
      </Modal>

      <Modal
        open={modal === "ringcentral_quote"}
        title="Take RingCentral Quote"
        subtitle="New quotes and requotes advance only the RingCentral rotation."
        onClose={() => setModal(null)}
      >
        <form action={submitRingCentralQuote} className="space-y-4 p-6">
          <Field label="Customer name">
            <input name="customer" required className="field" />
          </Field>
          <DealerSalespersonFields
            sources={sourceList}
            salespeople={salespeople}
          />
          <Field label="Quote type">
            <select name="quoteType" className="field">
              <option value="new_quote">New Quote</option>
              <option value="requote">Requote</option>
            </select>
          </Field>
          <Field label="Notes (optional)">
            <textarea
              name="note"
              rows={3}
              className="field"
              placeholder="Important information for this quote"
            />
          </Field>
          <button className="w-full rounded-xl bg-blue-600 px-4 py-3 font-black text-white">
            Confirm RingCentral Turn
          </button>
        </form>
      </Modal>

      <Modal
        open={modal === "take_quote" && takeRotation !== null}
        title="Start WhatsApp Rescue Timer"
        subtitle="Alert the current WhatsApp agent and begin one 3-minute response period without changing the queue order."
        onClose={() => {
          setModal(null);
          setTakeRotation(null);
        }}
      >
        {takeRotation ? (
          <StartRescueTimerForm
            rotation={takeRotation}
            sourceList={sourceList}
            salespeople={salespeople}
            onSubmit={submitTakeQuote}
          />
        ) : null}
      </Modal>

      <Modal
        open={modal === "workload_turn"}
        title="Take Additional Workload"
        subtitle="Select a Sold or Pending Pricing quote, or enter older business that is not in Work Desk."
        onClose={() => setModal(null)}
      >
        <WorkloadTurnForm
          quotes={workloadSelectableQuotes}
          agents={agentList}
          sources={sourceList}
          salespeople={salespeople}
          onSubmit={submitWorkloadTurn}
        />
      </Modal>

      <Modal
        open={modal === "manual_workload"}
        title="Log Manual Workload"
        subtitle="Record an Activation or Change without consuming or moving the Additional Workload turn."
        onClose={() => setModal(null)}
      >
        <WorkloadTurnForm
          quotes={workloadSelectableQuotes}
          agents={agentList}
          sources={sourceList}
          salespeople={salespeople}
          manual
          onSubmit={submitManualWorkload}
        />
      </Modal>

      <Modal
        open={modal === "change_outcome" && changeOutcomeRecord !== null}
        title="Change Outcome"
        subtitle="Change the finalized outcome of this quote. The change will be recorded in the quote log."
        onClose={() => {
          setModal(null);
          setChangeOutcomeRecord(null);
        }}
      >
        {changeOutcomeRecord ? (
          <form action={submitChangeOutcome} className="space-y-4 p-6">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="font-black text-slate-950">
                {changeOutcomeRecord.customer}
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-700">
                {changeOutcomeRecord.source} · Currently:{" "}
                <span
                  className={
                    changeOutcomeRecord.status === "Sold"
                      ? "rounded bg-emerald-100 px-2 py-0.5 text-emerald-800"
                      : "rounded bg-red-100 px-2 py-0.5 text-red-800"
                  }
                >
                  {changeOutcomeRecord.status}
                </span>
              </p>
              <p className="mt-2 text-sm font-semibold text-blue-700">
                → Change to{" "}
                {changeOutcomeRecord.status === "Sold"
                  ? "Not Sold"
                  : "Sold"}
              </p>
            </div>
            {changeOutcomeRecord.status === "Sold" && (
              <>
                <Field label="Not Sold reason">
                  <select
                    name="reason"
                    className="field"
                    defaultValue="price_too_high"
                  >
                    <option value="price_too_high">Price too high</option>
                    <option value="chose_another_option">
                      Customer chose another option
                    </option>
                    <option value="no_response">
                      No response from customer / source
                    </option>
                    <option value="no_longer_needed">
                      Customer no longer needs coverage
                    </option>
                    <option value="other">Other</option>
                  </select>
                </Field>
                <Field label="Other reason (required only when Other is selected)">
                  <textarea
                    name="otherReason"
                    rows={3}
                    className="field"
                    placeholder="Type the reason here"
                  />
                </Field>
              </>
            )}
            <Field label="Note (required)">
              <textarea
                name="note"
                required
                rows={4}
                className="field"
                placeholder="Explain why you are changing this outcome. This note is recorded in the quote log."
              />
            </Field>
            <button className="w-full rounded-xl bg-blue-600 px-4 py-3 font-black text-white hover:bg-blue-700">
              Confirm Change
            </button>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={
          modal === "customer_service_pass" && customerServicePassItem !== null
        }
        title="Pass Workload to Customer Service"
        subtitle="The workload turn stays counted to you, and this handoff is recorded as a pass with your explanation."
        onClose={() => {
          setModal(null);
          setCustomerServicePassItemId(null);
        }}
      >
        {customerServicePassItem ? (
          <form action={submitCustomerServicePass} className="space-y-4 p-6">
            <div className="rounded-2xl border border-cyan-200 bg-cyan-50 p-4">
              <p className="font-black text-cyan-950">
                {customerServicePassItem.customer}
              </p>
              <p className="mt-1 text-sm font-semibold text-cyan-800">
                {workTypeLabels[customerServicePassItem.workType]} →{" "}
                {workDeskSettings.customerServiceProfileName ||
                  "Customer Service"}
                {workDeskSettings.customerServiceProfileUsername
                  ? ` · @${workDeskSettings.customerServiceProfileUsername}`
                  : ""}
              </p>
              <p className="mt-2 text-xs font-semibold leading-5 text-cyan-700">
                This records one workload pass. It does not move the Additional
                Workload queue again.
              </p>
            </div>
            <Field label="Reason for passing">
              <select
                name="reason"
                required
                className="field"
                defaultValue="Workload buildup"
              >
                <option>Workload buildup</option>
                <option>Staffing coverage</option>
                <option>Customer Service handling</option>
                <option>Time-sensitive service request</option>
                <option>Other</option>
              </select>
            </Field>
            <Field label="What Customer Service needs to do">
              <textarea
                name="handoffNote"
                required
                rows={5}
                className="field"
                placeholder="Explain the requested activation or change, what has already been done, and the next step."
              />
            </Field>
            <button className="w-full rounded-xl bg-cyan-700 px-4 py-3 font-black text-white hover:bg-cyan-800">
              Confirm Customer Service Handoff
            </button>
          </form>
        ) : null}
      </Modal>

      <Modal
        open={modal === "payment"}
        title="Log Payment"
        subtitle="Payment activity does not require an existing quote and does not move a rotation."
        onClose={() => setModal(null)}
      >
        <form action={submitPayment} className="space-y-4 p-6">
          <Field label="Customer or account name">
            <input name="customer" required className="field" />
          </Field>
          <DealerSalespersonFields
            sources={sourceList}
            salespeople={salespeople}
            required={false}
            allowEmpty
          />
          <Field label="Payment notes">
            <textarea
              name="note"
              required
              rows={4}
              className="field"
              placeholder="Payment received, amount, method, or other useful details"
            />
          </Field>
          <button className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-black text-white">
            Record Payment
          </button>
        </form>
      </Modal>

      <Modal
        open={modal === "manual_quote"}
        title="Submit Manual Quote"
        subtitle="For quotes outside the normal rotations. Recorded for reporting and does not consume a turn."
        onClose={() => setModal(null)}
      >
        <form action={submitManualQuote} className="space-y-4 p-6">
          <div className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-600">
            No rotation will move when this quote is submitted.
          </div>
          <Field label="Customer name">
            <input name="customer" required className="field" />
          </Field>
          <DealerSalespersonFields
            sources={sourceList}
            salespeople={salespeople}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quote type">
              <select name="quoteType" className="field">
                <option value="new_quote">New Quote</option>
                <option value="requote">Requote</option>
              </select>
            </Field>
            <Field label="Input method">
              <select name="inputMethod" className="field">
                <option>Phone call</option>
                <option>Walk-in / Client in office</option>
                <option>Referral</option>
                <option>Email</option>
                <option>Website</option>
                <option>Other</option>
              </select>
            </Field>
          </div>
          <Field label="Notes (optional)">
            <textarea
              name="note"
              rows={3}
              className="field"
              placeholder="Important information for this quote"
            />
          </Field>
          <button className="w-full rounded-xl bg-slate-950 px-4 py-3 font-black text-white">
            Submit Manual Quote
          </button>
        </form>
      </Modal>

      <Modal
        open={modal === "quote_log"}
        title="Quote Log"
        subtitle="Shared activity and notes visible to every agent."
        onClose={() => {
          setModal(null);
          setQuoteLogSourceId(null);
        }}
      >
        <QuoteLogPanel
          quote={quoteLogRecord}
          activities={
            quoteLogSourceId
              ? quoteActivitiesBySource.get(quoteLogSourceId) || []
              : []
          }
          notes={
            quoteLogSourceId
              ? quoteNotesBySource.get(quoteLogSourceId) || []
              : []
          }
          draft={quoteLogSourceId ? noteDrafts[quoteLogSourceId] || "" : ""}
          onDraftChange={(value) => {
            if (quoteLogSourceId)
              setNoteDrafts((current) => ({
                ...current,
                [quoteLogSourceId]: value,
              }));
          }}
          onAddNote={() => {
            if (quoteLogSourceId) void addQuoteNote(quoteLogSourceId);
          }}
        />
      </Modal>

      <Modal
        open={modal === "manager_assign_quote"}
        title="Create & Assign Quote"
        subtitle="Create a quote for any agent. No rotation moves."
        onClose={() => setModal(null)}
      >
        <form action={submitManagerAssignedQuote} className="space-y-4 p-6">
          <div className="rounded-2xl bg-[#f3f6fb] p-4 text-sm font-semibold text-[#223f7a]">
            The selected agent will receive an in-app and desktop alert. The
            time they take the quote is recorded separately from the assignment
            time.
          </div>
          <Field label="Customer name">
            <input name="customer" required className="field" />
          </Field>
          <DealerSalespersonFields
            sources={sourceList}
            salespeople={salespeople}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quote type">
              <select name="quoteType" className="field">
                <option value="new_quote">New Quote</option>
                <option value="requote">Requote</option>
              </select>
            </Field>
            <Field label="Input method">
              <select name="inputMethod" className="field">
                <option>WhatsApp</option>
                <option>RingCentral</option>
                <option>Phone call</option>
                <option>Walk-in / Client in office</option>
                <option>Email</option>
                <option>Referral</option>
                <option>Website</option>
                <option>Other</option>
              </select>
            </Field>
          </div>
          <Field label="Assign to agent">
            <select name="assignedAgent" required className="field">
              {agentList.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ·{" "}
                  {agent.availability === "available"
                    ? "Available"
                    : agent.availability === "break"
                      ? "Lunch"
                      : "Unavailable"}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assignment note">
            <textarea
              name="note"
              required
              rows={3}
              className="field"
              placeholder="Explain why this quote is being assigned and anything the agent should know"
            />
          </Field>
          <button className="w-full rounded-xl bg-[#223f7a] px-4 py-3 font-black text-white hover:bg-[#17305f]">
            Create & Assign Quote
          </button>
        </form>
      </Modal>

      <Modal
        open={modal === "not_sold_reason"}
        title="Why was this quote not sold?"
        subtitle="Choose the best reason so management can report on lost opportunities."
        onClose={() => {
          setModal(null);
          setNotSoldTarget(null);
        }}
      >
        <form action={submitNotSoldReason} className="space-y-4 p-6">
          <div className="rounded-2xl bg-rose-50 p-4">
            <p className="font-black text-rose-900">
              {notSoldTarget?.item.customer}
            </p>
            <p className="mt-1 text-sm font-semibold text-rose-700">
              This will close the quote as Not Sold.
            </p>
          </div>
          <Field label="Not Sold reason">
            <select
              name="reason"
              className="field"
              defaultValue="price_too_high"
            >
              <option value="price_too_high">Price too high</option>
              <option value="chose_another_option">
                Customer chose another option
              </option>
              <option value="no_response">
                No response from customer / source
              </option>
              <option value="no_longer_needed">
                Customer no longer needs coverage
              </option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Other reason (required only when Other is selected)">
            <textarea
              name="otherReason"
              rows={3}
              className="field"
              placeholder="Type the reason here"
            />
          </Field>
          <button className="w-full rounded-xl bg-rose-600 px-4 py-3 font-black text-white hover:bg-rose-700">
            Confirm Not Sold
          </button>
        </form>
      </Modal>

      <Modal
        open={modal === "quote_result"}
        title="Quote Final Decision"
        subtitle="Price Sent moves the quote out of your active workload and into management follow-up."
        onClose={() => {
          setModal(null);
          setQuoteResultItemId(null);
        }}
      >
        <div className="p-6">
          <div className="rounded-2xl bg-slate-50 p-4">
            <p className="font-black">{quoteResultItem?.customer}</p>
            <p className="mt-1 text-sm text-slate-500">
              {quoteResultItem
                ? workTypeLabels[quoteResultItem.workType]
                : "Quote"}{" "}
              · {quoteResultItem?.dealer}
            </p>
          </div>
          <div className="mt-5 grid gap-3">
            <button
              onClick={() => void finalizeActiveQuote("price_sent")}
              className="flex items-center justify-between rounded-2xl border border-blue-200 bg-blue-50 p-4 text-left"
            >
              <div>
                <p className="font-black text-blue-900">Price Sent</p>
                <p className="mt-1 text-xs font-semibold text-blue-700">
                  Remove from active workload and add to Pending Pricing.
                </p>
              </div>
              <Send className="h-5 w-5 text-blue-600" />
            </button>
            <button
              onClick={() => void finalizeActiveQuote("sold")}
              className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left"
            >
              <div>
                <p className="font-black text-emerald-900">Sold</p>
                <p className="mt-1 text-xs font-semibold text-emerald-700">
                  Close immediately as a sale.
                </p>
              </div>
              <CircleDollarSign className="h-5 w-5 text-emerald-600" />
            </button>
            <button
              onClick={() => {
                if (quoteResultItem)
                  requestNotSold({ kind: "active", item: quoteResultItem });
              }}
              className="flex items-center justify-between rounded-2xl border border-rose-200 bg-rose-50 p-4 text-left"
            >
              <div>
                <p className="font-black text-rose-900">Not Sold</p>
                <p className="mt-1 text-xs font-semibold text-rose-700">
                  Close without a sale.
                </p>
              </div>
              <XCircle className="h-5 w-5 text-rose-600" />
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function TeamPerformanceTable({
  agentList,
  performance,
  currentUserId,
  efficiencyByAgent,
}: {
  agentList: Agent[];
  performance: PerformanceRow[];
  currentUserId: string;
  efficiencyByAgent: Map<
    string,
    { total: number; finalized: number; efficiency: number }
  >;
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Live Team Comparison
        </p>
        <h3 className="mt-1 text-xl font-black">
          Activity and availability by agent
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          See who is available and whether an unavailable teammate still has
          active work that may need coverage. Completion Efficiency counts only
          quotes with a final Sold or Not Sold decision as completed.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">Status</th>
              <th className="px-5 py-3">Open Tasks</th>
              <th className="px-5 py-3">WA Quotes</th>
              <th className="px-5 py-3">RC Quotes</th>
              <th className="px-5 py-3">Workload</th>
              <th className="px-5 py-3">Payments</th>
              <th className="px-5 py-3">Manual</th>
              <th className="px-5 py-3">Sold</th>
              <th className="px-5 py-3">Efficiency</th>
              <th className="px-5 py-3">Turns Passed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {agentList.map((agent) => {
              const row = performance.find(
                (item) => item.agentId === agent.id,
              ) ?? {
                agentId: agent.id,
                whatsappQuotes: 0,
                ringCentralQuotes: 0,
                workloadTurns: 0,
                whatsappUpdates: 0,
                manualQuotes: 0,
                soldQuotes: 0,
                ownedActivations: 0,
                ownedChanges: 0,
                requotes: 0,
                passedTurns: 0,
              };
              const efficiency =
                efficiencyByAgent.get(agent.name)?.efficiency ?? 0;
              const statusLabel =
                agent.availability === "available"
                  ? "Available"
                  : agent.availability === "break"
                    ? "Break / Lunch"
                    : "Unavailable";
              const statusStyle =
                agent.availability === "available"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : agent.availability === "break"
                    ? "bg-amber-50 text-amber-700 ring-amber-200"
                    : "bg-slate-100 text-slate-600 ring-slate-200";
              const needsCoverage =
                agent.availability !== "available" && agent.activeCount > 0;
              return (
                <tr
                  key={agent.id}
                  className={cn(
                    agent.id === currentUserId
                      ? "bg-[#f3f6fb]"
                      : needsCoverage
                        ? "bg-amber-50/40"
                        : "hover:bg-slate-50",
                  )}
                >
                  <td className="px-5 py-4">
                    <div className="flex items-center gap-3">
                      <Avatar agent={agent} size="sm" />
                      <p className="font-black">{agent.name}</p>
                    </div>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={cn(
                        "inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-black ring-1",
                        statusStyle,
                      )}
                    >
                      <StatusDot status={agent.availability} />
                      {statusLabel}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-black",
                        needsCoverage
                          ? "bg-amber-100 text-amber-800"
                          : agent.activeCount
                            ? "bg-[#eef3fb] text-[#223f7a]"
                            : "bg-slate-100 text-slate-500",
                      )}
                    >
                      {agent.activeCount}
                      {needsCoverage ? " · needs coverage" : ""}
                    </span>
                  </td>
                  <td className="px-5 py-4 font-black">{row.whatsappQuotes}</td>
                  <td className="px-5 py-4 font-black">
                    {row.ringCentralQuotes}
                  </td>
                  <td className="px-5 py-4 font-black">{row.workloadTurns}</td>
                  <td className="px-5 py-4 font-black">
                    {row.whatsappUpdates}
                  </td>
                  <td className="px-5 py-4 font-black">{row.manualQuotes}</td>
                  <td className="px-5 py-4 font-black text-emerald-700">
                    {row.soldQuotes}
                  </td>
                  <td className="px-5 py-4">
                    <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">
                      {efficiency.toFixed(1)}%
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-black",
                        row.passedTurns
                          ? "bg-rose-50 text-rose-700"
                          : "bg-slate-100 text-slate-500",
                      )}
                    >
                      {row.passedTurns}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ManagerView({
  agentList,
  customerServiceUsers,
  sourceList,
  workItems,
  pendingPricing,
  quoteOutcomes,
  quoteNotes,
  quoteActivities,
  quoteTakeEvents,
  settings,
  performance,
  passEvents,
  whatsappCurrentId,
  ringCentralCurrentId,
  workloadCurrentId,
  managerTab,
  setManagerTab,
  finalizePendingPricingSold,
  onRequestNotSold,
  onOpenAssignQuote,
  onReassignWork,
  onReassignPending,
  onDeleteQuote,
  onOpenQuoteLog,
  onAddQuoteNote,
  noteDrafts,
  setNoteDrafts,
  onSetRotation,
  onToggleRotation,
  onSetQueueOrder,
  onUpdateCustomerServiceOverflow,
  workloadDatabaseContent,
  forceManagerTab,
}: {
  agentList: Agent[];
  customerServiceUsers: CustomerServiceUser[];
  sourceList: SourceOption[];
  workItems: WorkItem[];
  pendingPricing: PendingPricingItem[];
  quoteOutcomes: QuoteOutcome[];
  quoteNotes: QuoteNote[];
  quoteActivities: QuoteActivity[];
  quoteTakeEvents: QuoteTakeEvent[];
  settings: WorkDeskSettings;
  performance: PerformanceRow[];
  passEvents: PassEvent[];
  whatsappCurrentId: string | null;
  ringCentralCurrentId: string | null;
  workloadCurrentId: string | null;
  managerTab: ManagerTab;
  setManagerTab: (tab: ManagerTab) => void;
  finalizePendingPricingSold: (item: PendingPricingItem) => Promise<void>;
  onRequestNotSold: (item: PendingPricingItem) => void;
  onOpenAssignQuote: () => void;
  onReassignWork: (itemId: string, profileId: string) => Promise<void>;
  onReassignPending: (itemId: string, profileId: string) => Promise<void>;
  onDeleteQuote: (
    stage: ManagerQuoteStage,
    quoteId: string,
    customer: string,
  ) => Promise<void>;
  onOpenQuoteLog: (sourceWorkItemId: string) => void;
  onAddQuoteNote: (sourceWorkItemId: string) => Promise<void>;
  noteDrafts: Record<string, string>;
  setNoteDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  onSetRotation: (rotation: RotationKind, profileId: string) => Promise<void>;
  onToggleRotation: (agent: Agent, rotation: RotationKind) => Promise<void>;
  onSetQueueOrder: (
    rotation: RotationKind,
    profileIds: string[],
  ) => Promise<void>;
  onUpdateCustomerServiceOverflow: (
    enabled: boolean,
    profileId: string | null,
  ) => Promise<void>;
  workloadDatabaseContent?: React.ReactNode;
  forceManagerTab?: ManagerTab;
}) {
  const [reportView, setReportView] = useState<ReportView>("executive");
  const [workView, setWorkView] = useState<"tasks" | "pricing" | "workload">("tasks");
  const [managerDatabaseView, setManagerDatabaseView] = useState<"quotes" | "workloads">("quotes");
  const [administrationView, setAdministrationView] = useState<
    "controls" | "users" | "sources"
  >("users");
  const selectedReport =
    reportNavigationItems.find((item) => item.id === reportView) ??
    reportNavigationItems[0];
  const selectedReportGroup =
    reportNavigationGroups.find((group) =>
      group.items.some((item) => item.id === reportView),
    ) ?? reportNavigationGroups[0];
  const SelectedReportIcon = selectedReport.icon;
  const [quoteSearch, setQuoteSearch] = useState("");
  const [managerQuoteDay, setManagerQuoteDay] = useState(
    dateInputValue(new Date()),
  );
  const [managerQuoteStatus, setManagerQuoteStatus] = useState("all");
  const [managerQuoteUpdate, setManagerQuoteUpdate] = useState("all");
  const [managerNow] = useState(() => Date.now());
  const today = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(today.getDate() - 6);
  const [reportStart, setReportStart] = useState(dateInputValue(weekAgo));
  const [reportEnd, setReportEnd] = useState(dateInputValue(today));
  const activeTasks = workItems.filter(isActiveTask);

  const openCountByAgent = useMemo(
    () =>
      activeTasks.reduce<Record<string, number>>((acc, item) => {
        acc[item.assignedAgent] = (acc[item.assignedAgent] ?? 0) + 1;
        return acc;
      }, {}),
    [activeTasks],
  );
  const maxWorkload = Object.entries(openCountByAgent).sort(
    (a, b) => b[1] - a[1],
  )[0];
  const stalePricing = pendingPricing.filter(
    (item) => daysSince(item.priceSentAt) >= 1,
  );
  const awaitingAcceptance = activeTasks.filter((item) => !item.acceptedAt);
  const staleAssignments = awaitingAcceptance.filter(
    (item) => managerNow - new Date(item.assignedAt).getTime() >= 5 * 60_000,
  );
  const unavailableWithWork = agentList.filter(
    (agent) =>
      agent.availability === "unavailable" &&
      (openCountByAgent[agent.name] ?? 0) > 0,
  );
  const managerAlerts = [
    ...(awaitingAcceptance.length
      ? [
          `${awaitingAcceptance.length} assigned item${awaitingAcceptance.length === 1 ? " is" : "s are"} waiting for agent acceptance.`,
        ]
      : []),
    ...(staleAssignments.length
      ? [
          `${staleAssignments.length} assignment${staleAssignments.length === 1 ? " has" : "s have"} been waiting more than 5 minutes for acceptance.`,
        ]
      : []),
    ...(pendingPricing.length
      ? [`${pendingPricing.length} quotes are awaiting a final customer or source decision after pricing was sent.`]
      : []),
    ...(stalePricing.length
      ? [
          `${stalePricing.length} pending pricing items should be followed up today.`,
        ]
      : []),
    ...(unavailableWithWork.length
      ? [
          `${unavailableWithWork.length} unavailable agent${unavailableWithWork.length === 1 ? " has" : "s have"} active tasks.`,
        ]
      : []),
    ...(maxWorkload
      ? [
          `${maxWorkload[0]} currently has the highest active workload: ${maxWorkload[1]} tasks.`,
        ]
      : []),
  ];

  const quoteRecords = useMemo(
    () =>
      buildQuoteRecords(
        workItems,
        pendingPricing,
        quoteOutcomes,
        quoteTakeEvents,
      ),
    [pendingPricing, quoteOutcomes, quoteTakeEvents, workItems],
  );

  const visibleQuoteRecords = useMemo(() => {
    const needle = quoteSearch.trim().toLowerCase();
    return quoteRecords.filter((item) => {
      const activities = quoteActivities.filter(
        (activity) => activity.sourceWorkItemId === item.sourceWorkItemId,
      );
      const latestStamp = activities.reduce(
        (latest, activity) =>
          new Date(activity.createdAt).getTime() > new Date(latest).getTime()
            ? activity.createdAt
            : latest,
        item.statusDate,
      );
      const matchesSearch =
        !needle ||
        [
          item.customer,
          item.source,
          item.salesperson,
          item.agent,
          item.status,
          item.receivedThrough,
          workTypeLabels[item.workType],
        ].some((value) => value.toLowerCase().includes(needle));
      const matchesStatus =
        managerQuoteStatus === "all" || item.status === managerQuoteStatus;
      const matchesUpdate =
        managerQuoteUpdate === "all" ||
        (managerQuoteUpdate === "created"
          ? true
          : activities.some(
              (activity) => activity.eventType === managerQuoteUpdate,
            ));
      return (
        matchesSearch &&
        matchesStatus &&
        matchesUpdate &&
        matchesCalendarDay(latestStamp, managerQuoteDay)
      );
    });
  }, [
    managerQuoteDay,
    managerQuoteStatus,
    managerQuoteUpdate,
    quoteActivities,
    quoteRecords,
    quoteSearch,
  ]);

  const quoteNotesBySource = useMemo(() => {
    const rows = new Map<string, QuoteNote[]>();
    for (const note of quoteNotes)
      rows.set(note.sourceWorkItemId, [
        ...(rows.get(note.sourceWorkItemId) || []),
        note,
      ]);
    return rows;
  }, [quoteNotes]);
  const quoteActivitiesBySource = useMemo(() => {
    const rows = new Map<string, QuoteActivity[]>();
    for (const activity of quoteActivities)
      rows.set(activity.sourceWorkItemId, [
        ...(rows.get(activity.sourceWorkItemId) || []),
        activity,
      ]);
    return rows;
  }, [quoteActivities]);
  const tabs: Array<{
    id: ManagerTab;
    label: string;
    icon: React.ReactNode;
    badge?: number;
  }> = [
    {
      id: "overview",
      label: "Overview",
      icon: <ShieldCheck className="h-4 w-4" />,
    },
    {
      id: "work",
      label: "Work & Pricing",
      icon: <ClipboardList className="h-4 w-4" />,
      badge: activeTasks.length + pendingPricing.length,
    },
    {
      id: "quotes",
      label: "Databases",
      icon: <Table2 className="h-4 w-4" />,
    },
    {
      id: "reports",
      label: "Reports",
      icon: <BarChart3 className="h-4 w-4" />,
    },
  ];

  function setPreset(kind: "today" | "yesterday" | "week" | "month") {
    const end = new Date();
    const start = new Date();
    if (kind === "yesterday") {
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
    }
    if (kind === "week") start.setDate(start.getDate() - 6);
    if (kind === "month") start.setDate(1);
    setReportStart(dateInputValue(start));
    setReportEnd(dateInputValue(end));
  }

  const reportData = useMemo(() => {
    const activeQuotes = workItems
      .filter(
        (item) =>
          isQuote(item) &&
          withinDateRange(item.createdAt, reportStart, reportEnd),
      )
      .map((item) => ({
        id: item.id,
        sourceWorkItemId: item.id,
        createdAt: item.createdAt,
        assignedAt: item.assignedAt,
        acceptedAt: item.acceptedAt,
        priceSentAt: undefined as string | undefined,
        finalizedAt: undefined as string | undefined,
        customer: item.customer,
        dealer: item.dealer,
        salesperson: item.salesperson || "Not recorded",
        workType: item.workType as "new_quote" | "requote",
        agent: item.assignedAgent,
        originalOwner: item.originalOwner || "Not recorded",
        method: item.assignmentMethod,
        channel: item.receivedThrough || "Unknown",
        lifecycle: "Active",
        decision: "",
        notSoldReason: undefined as string | undefined,
      }));
    const pending = pendingPricing
      .filter((item) =>
        withinDateRange(item.quoteCreatedAt, reportStart, reportEnd),
      )
      .map((item) => ({
        id: item.id,
        sourceWorkItemId: item.sourceWorkItemId,
        createdAt: item.quoteCreatedAt,
        assignedAt: item.assignedAt,
        acceptedAt: item.acceptedAt,
        priceSentAt: item.priceSentAt,
        finalizedAt: undefined as string | undefined,
        customer: item.customer,
        dealer: item.dealer,
        salesperson: item.salesperson || "Not recorded",
        workType: item.workType,
        agent: item.assignedAgent,
        originalOwner: item.originalOwner || "Not recorded",
        method: item.assignmentMethod,
        channel: item.receivedThrough || "Unknown",
        lifecycle: "Price Sent",
        decision: "",
        notSoldReason: undefined as string | undefined,
      }));
    const outcomes = quoteOutcomes
      .filter((item) =>
        withinDateRange(item.quoteCreatedAt, reportStart, reportEnd),
      )
      .map((item) => ({
        id: item.id,
        sourceWorkItemId: item.sourceWorkItemId,
        createdAt: item.quoteCreatedAt,
        assignedAt: item.assignedAt,
        acceptedAt: item.acceptedAt,
        priceSentAt: item.priceSentAt,
        finalizedAt: item.finalizedAt,
        customer: item.customer,
        dealer: item.dealer,
        salesperson: item.salesperson || "Not recorded",
        workType: item.workType,
        agent: item.assignedAgent,
        originalOwner: item.originalOwner || "Not recorded",
        method: item.assignmentMethod,
        channel: item.receivedThrough || "Unknown",
        lifecycle: item.decision === "sold" ? "Sold" : "Not Sold",
        decision: item.decision,
        notSoldReason:
          item.decision === "not_sold"
            ? item.notSoldReason === "other"
              ? item.notSoldReasonOther || "Other"
              : item.notSoldReason
                ? notSoldReasonLabels[item.notSoldReason]
                : "Unknown"
            : undefined,
      }));
    const quotes = [...activeQuotes, ...pending, ...outcomes];
    const service = workItems.filter(
      (item) =>
        !isQuote(item) &&
        withinDateRange(item.createdAt, reportStart, reportEnd),
    );
    const sold = quotes.filter((item) => item.lifecycle === "Sold").length;
    const notSold = quotes.filter(
      (item) => item.lifecycle === "Not Sold",
    ).length;
    const finalized = sold + notSold;
    const efficiency = quotes.length ? (finalized / quotes.length) * 100 : 0;
    const conversion = finalized ? (sold / finalized) * 100 : 0;

    const timingRows = quotes.map((item) => ({
      ...item,
      timeToAccept: durationMinutes(item.assignedAt, item.acceptedAt),
      timeToPrice: durationMinutes(item.acceptedAt, item.priceSentAt),
      timeToFinal: durationMinutes(item.acceptedAt, item.finalizedAt),
      priceToDecision: durationMinutes(item.priceSentAt, item.finalizedAt),
      totalCycle: durationMinutes(item.createdAt, item.finalizedAt),
    }));

    const notSoldRows = timingRows
      .filter((item) => item.lifecycle === "Not Sold")
      .map((item) => {
        const notes = quoteNotesBySource.get(item.sourceWorkItemId) || [];
        const latestNote = notes[0];
        return {
          ...item,
          noteCount: notes.length,
          latestNote: latestNote?.note || "",
          latestNoteAt: latestNote?.createdAt,
          latestNoteBy: latestNote?.authorName || "",
        };
      })
      .sort(
        (left, right) =>
          new Date(right.finalizedAt || right.createdAt).getTime() -
          new Date(left.finalizedAt || left.createdAt).getTime(),
      );

    const averageDuration = (values: Array<number | null>) => {
      const valid = values.filter((value): value is number => value !== null);
      return valid.length
        ? valid.reduce((sum, value) => sum + value, 0) / valid.length
        : null;
    };

    const timingByAgent = agentList
      .map((agent) => {
        const rows = timingRows.filter((item) => item.agent === agent.name);
        return {
          agent: agent.name,
          quotes: rows.length,
          accepted: rows.filter((item) => item.acceptedAt).length,
          avgAccept: averageDuration(rows.map((item) => item.timeToAccept)),
          avgPrice: averageDuration(rows.map((item) => item.timeToPrice)),
          avgFinal: averageDuration(rows.map((item) => item.timeToFinal)),
          avgPriceDecision: averageDuration(
            rows.map((item) => item.priceToDecision),
          ),
          avgTotalCycle: averageDuration(rows.map((item) => item.totalCycle)),
        };
      })
      .sort(
        (a, b) =>
          (a.avgFinal ?? Number.POSITIVE_INFINITY) -
          (b.avgFinal ?? Number.POSITIVE_INFINITY),
      );

    const byAgent = agentList
      .map((agent) => {
        const rows = quotes.filter((item) => item.agent === agent.name);
        const serviceRows = service.filter(
          (item) => item.assignedAgent === agent.name,
        );
        const agentSold = rows.filter(
          (item) => item.lifecycle === "Sold",
        ).length;
        const agentNotSold = rows.filter(
          (item) => item.lifecycle === "Not Sold",
        ).length;
        const agentDecided = agentSold + agentNotSold;
        const passes = passEvents.filter(
          (event) =>
            event.actorAgentId === agent.id &&
            withinDateRange(event.createdAt, reportStart, reportEnd),
        ).length;
        return {
          agent: agent.name,
          quotes: rows.length,
          whatsapp: rows.filter((item) => item.method === "whatsapp_turn")
            .length,
          ringcentral: rows.filter((item) => item.method === "ringcentral_turn")
            .length,
          manual: rows.filter((item) => item.method === "manual_quote").length,
          workload: serviceRows.filter(
            (item) => item.assignmentMethod === "workload_turn",
          ).length,
          updates: serviceRows.filter(
            (item) => item.assignmentMethod === "update_log",
          ).length,
          sold: agentSold,
          notSold: agentNotSold,
          finalized: agentDecided,
          pending: rows.filter((item) => item.lifecycle === "Price Sent")
            .length,
          passes,
          efficiency: rows.length ? (agentDecided / rows.length) * 100 : 0,
          conversion: agentDecided ? (agentSold / agentDecided) * 100 : 0,
        };
      })
      .sort((a, b) => b.quotes - a.quotes);

    const group = (key: "channel" | "dealer") => {
      const map = new Map<
        string,
        {
          name: string;
          quotes: number;
          sold: number;
          notSold: number;
          pending: number;
        }
      >();
      quotes.forEach((item) => {
        const name = item[key];
        const row = map.get(name) || {
          name,
          quotes: 0,
          sold: 0,
          notSold: 0,
          pending: 0,
        };
        row.quotes += 1;
        if (item.lifecycle === "Sold") row.sold += 1;
        if (item.lifecycle === "Not Sold") row.notSold += 1;
        if (item.lifecycle === "Price Sent") row.pending += 1;
        map.set(name, row);
      });
      return Array.from(map.values())
        .map((row) => {
          const finalized = row.sold + row.notSold;
          return {
            ...row,
            finalized,
            efficiency: row.quotes ? (finalized / row.quotes) * 100 : 0,
            conversion: finalized ? (row.sold / finalized) * 100 : 0,
          };
        })
        .sort((a, b) => b.quotes - a.quotes);
    };

    const notSoldReasonMap = new Map<string, number>();
    outcomes
      .filter((item) => item.lifecycle === "Not Sold")
      .forEach((item) => {
        const reason = item.notSoldReason || "Unknown";
        notSoldReasonMap.set(reason, (notSoldReasonMap.get(reason) || 0) + 1);
      });
    const notSoldReasons = Array.from(notSoldReasonMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    const quoteBySource = new Map(
      quoteRecords.map((quote) => [quote.sourceWorkItemId, quote]),
    );
    const takenRows = quoteTakeEvents
      .filter((event) => withinDateRange(event.takenAt, reportStart, reportEnd))
      .map((event) => {
        const quote = quoteBySource.get(event.sourceWorkItemId);
        return {
          ...event,
          customer: quote?.customer || "Unknown quote",
          source: quote?.source || "Unknown source",
          salesperson: quote?.salesperson || "Not recorded",
          quoteAgent: quote?.agent || "Unknown agent",
          quoteStatus: quote?.status || "Unknown",
          workType: quote?.workType || "new_quote",
          receivedThrough:
            quote?.receivedThrough ||
            (event.rotation === "whatsapp" ? "WhatsApp" : "RingCentral"),
        };
      })
      .sort(
        (a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime(),
      );

    const takenByAgent = agentList
      .map((agent) => {
        const rows = takenRows.filter((row) => row.takerProfileId === agent.id);
        return {
          agent: agent.name,
          username: rows[0]?.takerUsername || "",
          total: rows.length,
          whatsapp: rows.filter((row) => row.rotation === "whatsapp").length,
          ringcentral: rows.filter((row) => row.rotation === "ringcentral")
            .length,
          skippedAgents: rows.reduce(
            (sum, row) => sum + row.skippedAgents.length,
            0,
          ),
          avgElapsedSeconds: rows.length
            ? rows.reduce((sum, row) => sum + row.elapsedSeconds, 0) /
              rows.length
            : 0,
        };
      })
      .filter((row) => row.total > 0)
      .sort(
        (a, b) =>
          b.total - a.total || a.avgElapsedSeconds - b.avgElapsedSeconds,
      );

    const takenSummary = {
      total: takenRows.length,
      whatsapp: takenRows.filter((row) => row.rotation === "whatsapp").length,
      ringcentral: takenRows.filter((row) => row.rotation === "ringcentral")
        .length,
      skippedAgents: takenRows.reduce(
        (sum, row) => sum + row.skippedAgents.length,
        0,
      ),
      avgElapsedSeconds: takenRows.length
        ? takenRows.reduce((sum, row) => sum + row.elapsedSeconds, 0) /
          takenRows.length
        : 0,
    };

    const pendingInRange = pendingPricing.filter((item) =>
      withinDateRange(item.priceSentAt, reportStart, reportEnd),
    );
    const totalPasses = passEvents.filter((event) =>
      withinDateRange(event.createdAt, reportStart, reportEnd),
    ).length;
    const byChannel = group("channel");
    const bySource = group("dealer");
    const activitiesInRange = quoteActivities.filter((item) =>
      withinDateRange(item.createdAt, reportStart, reportEnd),
    );
    const notesInRange = quoteNotes.filter((item) =>
      withinDateRange(item.createdAt, reportStart, reportEnd),
    );
    const paymentRows = service.filter((item) => item.workType === "payment");
    const activationRows = service.filter(
      (item) => item.workType === "activation",
    );
    const changeRows = service.filter((item) => item.workType === "change");
    const now = managerNow;
    const referenceIso = new Date(managerNow).toISOString();
    const stalePending = pendingPricing.filter(
      (item) => daysSince(item.priceSentAt) >= 2,
    );
    const noNotePending = pendingPricing.filter(
      (item) => !(quoteNotesBySource.get(item.sourceWorkItemId) || []).length,
    );
    const quoteSourceCounts = quoteRecords.reduce<Record<string, number>>(
      (acc, quote) => {
        const key = `${quote.customer.toLowerCase()}|${quote.source.toLowerCase()}`;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      },
      {},
    );
    const duplicateCount = Object.values(quoteSourceCounts).filter(
      (count) => count > 1,
    ).length;
    const managerInterventions = activitiesInRange.filter((activity) =>
      /assign|reassign|manager|delete|rotation/i.test(activity.eventType),
    );
    const activationEvents = activitiesInRange.filter((activity) =>
      /activation/i.test(activity.eventType),
    );
    const soldWithoutActivation = quoteOutcomes.filter(
      (quote) =>
        quote.decision === "sold" &&
        !(quoteActivitiesBySource.get(quote.sourceWorkItemId) || []).some(
          (activity) => /activation/i.test(activity.eventType),
        ),
    ).length;
    const exceptionItems = [
      ...awaitingAcceptance.map((item) => ({
        severity: "warning" as const,
        area: "Assignment",
        issue: `${item.customer} is awaiting acceptance`,
        owner: item.assignedAgent,
        age: formatDuration(durationMinutes(item.assignedAt, referenceIso)),
      })),
      ...staleAssignments.map((item) => ({
        severity: "critical" as const,
        area: "Assignment",
        issue: `${item.customer} has waited more than 5 minutes`,
        owner: item.assignedAgent,
        age: formatDuration(durationMinutes(item.assignedAt, referenceIso)),
      })),
      ...stalePending.map((item) => ({
        severity: "warning" as const,
        area: "Follow-Up",
        issue: `${item.customer} has stale pricing`,
        owner: item.assignedAgent,
        age: `${daysSince(item.priceSentAt)} days`,
      })),
      ...noNotePending.map((item) => ({
        severity: "warning" as const,
        area: "Documentation",
        issue: `${item.customer} has pending pricing with no notes`,
        owner: item.assignedAgent,
        age: `${daysSince(item.priceSentAt)} days`,
      })),
      ...activeTasks
        .filter(
          (item) => now - new Date(item.assignedAt).getTime() > 30 * 60_000,
        )
        .map((item) => ({
          severity: "warning" as const,
          area: "Workload",
          issue: `${item.customer} active more than 30 minutes`,
          owner: item.assignedAgent,
          age: formatDuration(durationMinutes(item.assignedAt, referenceIso)),
        })),
      ...unavailableWithWork.map((agent) => ({
        severity: "critical" as const,
        area: "Coverage",
        issue: `${agent.name} is unavailable with active work`,
        owner: agent.name,
        age: `${openCountByAgent[agent.name] ?? 0} tasks`,
      })),
    ].slice(0, 100);
    const workloadByAgent = agentList
      .map((agent) => {
        const agentActive = activeTasks.filter(
          (item) => item.assignedAgent === agent.name,
        );
        const agentPending = pendingPricing.filter(
          (item) => item.assignedAgent === agent.name,
        );
        return {
          agent: agent.name,
          status: agent.availability,
          activeQuotes: agentActive.filter(isQuote).length,
          activations: agentActive.filter(
            (item) => item.workType === "activation",
          ).length,
          changes: agentActive.filter((item) => item.workType === "change")
            .length,
          payments: agentActive.filter((item) => item.workType === "payment")
            .length,
          pending: agentPending.length,
          unaccepted: agentActive.filter((item) => !item.acceptedAt).length,
          total: agentActive.length + agentPending.length,
        };
      })
      .sort((a, b) => b.total - a.total);
    const documentationByAgent = agentList
      .map((agent) => {
        const authored = notesInRange.filter(
          (note) => note.authorName === agent.name,
        );
        const agentQuotes = quotes.filter(
          (quote) => quote.agent === agent.name,
        );
        const withNotes = agentQuotes.filter(
          (quote) => (quoteNotesBySource.get(quote.id) || []).length > 0,
        ).length;
        return {
          agent: agent.name,
          notes: authored.length,
          quotes: agentQuotes.length,
          withNotes,
          coverage: agentQuotes.length
            ? (withNotes / agentQuotes.length) * 100
            : 0,
        };
      })
      .sort((a, b) => b.notes - a.notes);
    const missedByAgent = agentList
      .map((agent) => {
        const rows = takenRows.filter((row) =>
          row.skippedAgents.some((skipped) => skipped.id === agent.id),
        );
        return {
          agent: agent.name,
          missed: rows.length,
          whatsapp: rows.filter((row) => row.rotation === "whatsapp").length,
          ringcentral: rows.filter((row) => row.rotation === "ringcentral")
            .length,
          sold: rows.filter((row) => row.quoteStatus === "Sold").length,
          pending: rows.filter(
            (row) =>
              row.quoteStatus === "Price Sent" || row.quoteStatus === "Active",
          ).length,
        };
      })
      .filter((row) => row.missed > 0)
      .sort((a, b) => b.missed - a.missed);
    const passByAgent = agentList
      .map((agent) => {
        const rows = passEvents.filter(
          (event) =>
            event.actorAgentId === agent.id &&
            withinDateRange(event.createdAt, reportStart, reportEnd),
        );
        return {
          agent: agent.name,
          total: rows.length,
          whatsapp: rows.filter((row) => row.rotation === "whatsapp").length,
          ringcentral: rows.filter((row) => row.rotation === "ringcentral")
            .length,
          workload: rows.filter((row) => row.rotation === "workload").length,
          reasons: rows.map((row) => row.reason || "No reason"),
        };
      })
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total);
    const queueHealth = (
      ["whatsapp", "ringcentral", "workload"] as RotationKind[]
    ).map((rotation) => {
      const rotationName =
        rotation === "whatsapp"
          ? "WhatsApp"
          : rotation === "ringcentral"
            ? "RingCentral"
            : "Additional Workload";
      const currentId =
        rotation === "whatsapp"
          ? whatsappCurrentId
          : rotation === "ringcentral"
            ? ringCentralCurrentId
            : workloadCurrentId;
      const currentAgent =
        agentList.find((agent) => agent.id === currentId) || null;
      const eligible = agentList.filter((agent) =>
        rotationEligibility(agent, rotation),
      );
      const available = eligible.filter(
        (agent) => agent.availability === "available",
      );
      const passes = passEvents.filter(
        (event) =>
          event.rotation === rotation &&
          withinDateRange(event.createdAt, reportStart, reportEnd),
      ).length;
      const taken = takenRows.filter((row) => row.rotation === rotation).length;
      const claims =
        quotes.filter((quote) =>
          rotation === "whatsapp"
            ? quote.method === "whatsapp_turn"
            : rotation === "ringcentral"
              ? quote.method === "ringcentral_turn"
              : false,
        ).length +
        service.filter(
          (item) =>
            rotation === "workload" &&
            item.assignmentMethod === "workload_turn",
        ).length;
      const health =
        !currentAgent && available.length
          ? "Needs current agent"
          : currentAgent && currentAgent.availability !== "available"
            ? "Current unavailable"
            : "Healthy";
      return {
        rotation: rotationName,
        current: currentAgent?.name || "No agent yet",
        eligible: eligible.length,
        available: available.length,
        claims,
        passes,
        taken,
        health,
      };
    });
    const agentScorecards = byAgent
      .map((row) => {
        const timing = timingByAgent.find((item) => item.agent === row.agent);
        const workload = workloadByAgent.find(
          (item) => item.agent === row.agent,
        );
        const docs = documentationByAgent.find(
          (item) => item.agent === row.agent,
        );
        const taken = takenByAgent.find((item) => item.agent === row.agent);
        const score = Math.round(
          row.efficiency * 0.22 +
            row.conversion * 0.22 +
            (docs?.coverage || 0) * 0.18 +
            Math.max(0, 100 - ((timing?.avgPrice || 0) / 60) * 20) * 0.18 +
            Math.max(0, 100 - (workload?.unaccepted || 0) * 15) * 0.1 +
            Math.min(100, (taken?.total || 0) * 20) * 0.1,
        );
        return {
          ...row,
          score,
          avgPrice: timing?.avgPrice ?? null,
          docCoverage: docs?.coverage || 0,
          taken: taken?.total || 0,
          workload: workload?.total || 0,
        };
      })
      .sort((a, b) => b.score - a.score);
    const sourceRisk = bySource.map((row) => ({
      ...row,
      taken: takenRows.filter((event) => event.source === row.name).length,
      notes: quoteRecords
        .filter((quote) => quote.source === row.name)
        .reduce(
          (sum, quote) =>
            sum + (quoteNotesBySource.get(quote.sourceWorkItemId) || []).length,
          0,
        ),
      category:
        row.quotes >= 10 && row.conversion >= 60
          ? "High value"
          : row.quotes >= 10 && row.conversion < 50
            ? "Needs attention"
            : row.quotes < 5 && row.conversion < 40
              ? "Low value"
              : "Monitor",
    }));

    const sourceSalespersonMap = new Map<
      string,
      {
        source: string;
        salesperson: string;
        quotes: number;
        sold: number;
        notSold: number;
        pending: number;
        sourceWorkItemIds: string[];
      }
    >();

    quotes.forEach((item) => {
      const salesperson = item.salesperson || "Not recorded";
      const key = `${item.dealer}\u0000${salesperson}`;
      const row = sourceSalespersonMap.get(key) || {
        source: item.dealer,
        salesperson,
        quotes: 0,
        sold: 0,
        notSold: 0,
        pending: 0,
        sourceWorkItemIds: [],
      };

      row.quotes += 1;
      row.sourceWorkItemIds.push(item.sourceWorkItemId);
      if (item.lifecycle === "Sold") row.sold += 1;
      if (item.lifecycle === "Not Sold") row.notSold += 1;
      if (item.lifecycle === "Price Sent") row.pending += 1;
      sourceSalespersonMap.set(key, row);
    });

    const sourceSalespeople = Array.from(sourceSalespersonMap.values())
      .map((row) => {
        const finalized = row.sold + row.notSold;
        const efficiency = row.quotes ? (finalized / row.quotes) * 100 : 0;
        const conversion = finalized ? (row.sold / finalized) * 100 : 0;
        const taken = takenRows.filter(
          (event) =>
            event.source === row.source &&
            event.salesperson === row.salesperson,
        ).length;
        const notes = row.sourceWorkItemIds.reduce(
          (sum, sourceWorkItemId) =>
            sum + (quoteNotesBySource.get(sourceWorkItemId) || []).length,
          0,
        );

        return {
          source: row.source,
          salesperson: row.salesperson,
          quotes: row.quotes,
          sold: row.sold,
          notSold: row.notSold,
          pending: row.pending,
          finalized,
          efficiency,
          conversion,
          taken,
          notes,
          category:
            row.quotes >= 10 && conversion >= 60
              ? "High value"
              : row.quotes >= 10 && conversion < 50
                ? "Needs attention"
                : row.quotes < 5 && conversion < 40
                  ? "Low value"
                  : "Monitor",
        };
      })
      .sort(
        (left, right) =>
          right.sold - left.sold ||
          right.conversion - left.conversion ||
          right.quotes - left.quotes ||
          left.source.localeCompare(right.source) ||
          left.salesperson.localeCompare(right.salesperson),
      );
    const dailyMap = new Map<
      string,
      {
        date: string;
        quotes: number;
        sold: number;
        notSold: number;
        pending: number;
        taken: number;
        passes: number;
        service: number;
      }
    >();
    const ensureDay = (date: string) => {
      const key = date.slice(0, 10);
      const row = dailyMap.get(key) || {
        date: key,
        quotes: 0,
        sold: 0,
        notSold: 0,
        pending: 0,
        taken: 0,
        passes: 0,
        service: 0,
      };
      dailyMap.set(key, row);
      return row;
    };
    quotes.forEach((quote) => {
      const row = ensureDay(quote.createdAt);
      row.quotes += 1;
      if (quote.lifecycle === "Sold") row.sold += 1;
      if (quote.lifecycle === "Not Sold") row.notSold += 1;
      if (quote.lifecycle === "Price Sent") row.pending += 1;
    });
    takenRows.forEach((row) => {
      ensureDay(row.takenAt).taken += 1;
    });
    passEvents
      .filter((event) =>
        withinDateRange(event.createdAt, reportStart, reportEnd),
      )
      .forEach((event) => {
        ensureDay(event.createdAt).passes += 1;
      });
    service.forEach((item) => {
      ensureDay(item.createdAt).service += 1;
    });
    const dailyRows = Array.from(dailyMap.values()).sort((a, b) =>
      b.date.localeCompare(a.date),
    );
    const integrityIssues = [
      ...(duplicateCount
        ? [
            {
              severity: "warning" as const,
              issue: "Possible duplicate quote groups",
              detail: `${duplicateCount} customer/source groups have multiple records`,
            },
          ]
        : []),
      ...(soldWithoutActivation
        ? [
            {
              severity: "warning" as const,
              issue: "Sold without activation log",
              detail: `${soldWithoutActivation} sold quotes do not show activation activity`,
            },
          ]
        : []),
      ...quoteRecords
        .filter(
          (quote) =>
            quote.status === "Price Sent" &&
            !(quoteNotesBySource.get(quote.sourceWorkItemId) || []).length,
        )
        .map((quote) => ({
          severity: "warning" as const,
          issue: "Price Sent without notes",
          detail: `${quote.customer} · ${quote.agent}`,
        }))
        .slice(0, 20),
      ...queueHealth
        .filter((row) => row.health !== "Healthy")
        .map((row) => ({
          severity: "critical" as const,
          issue: `${row.rotation} queue issue`,
          detail: row.health,
        })),
    ];
    const systemChecks = [
      {
        check: "Agents loaded",
        status: agentList.length > 0,
        detail: `${agentList.length} active agents`,
      },
      {
        check: "Sources loaded",
        status: sourceList.length > 0,
        detail: `${sourceList.length} active sources`,
      },
      {
        check: "Quote logs loaded",
        status: true,
        detail: `${quoteActivities.length} activities · ${quoteNotes.length} notes`,
      },
      {
        check: "Take events loaded",
        status: true,
        detail: `${quoteTakeEvents.length} take records`,
      },
      {
        check: "Queue records present",
        status: queueHealth.length === 3,
        detail: `${queueHealth.length}/3 queues`,
      },
      {
        check: "No stuck queue",
        status: !queueHealth.some((row) => row.health !== "Healthy"),
        detail: queueHealth
          .map((row) => `${row.rotation}: ${row.health}`)
          .join(" · "),
      },
    ];
    return {
      quotes,
      timingRows,
      timingByAgent,
      notSoldRows,
      notSoldReasons,
      service,
      sold,
      notSold,
      finalized,
      efficiency,
      conversion,
      pendingInRange,
      totalPasses,
      byAgent,
      byChannel,
      bySource,
      takenRows,
      takenByAgent,
      takenSummary,
      exceptionItems,
      workloadByAgent,
      documentationByAgent,
      missedByAgent,
      passByAgent,
      queueHealth,
      agentScorecards,
      sourceRisk,
      sourceSalespeople,
      paymentRows,
      activationRows,
      changeRows,
      managerInterventions,
      activationEvents,
      integrityIssues,
      systemChecks,
      dailyRows,
    };
  }, [
    agentList,
    passEvents,
    pendingPricing,
    quoteOutcomes,
    quoteRecords,
    quoteTakeEvents,
    reportEnd,
    reportStart,
    workItems,
    quoteActivities,
    quoteNotes,
    quoteNotesBySource,
    quoteActivitiesBySource,
    activeTasks,
    awaitingAcceptance,
    staleAssignments,
    unavailableWithWork,
    openCountByAgent,
    sourceList.length,
    whatsappCurrentId,
    ringCentralCurrentId,
    workloadCurrentId,
    managerNow,
  ]);

  function exportAllQuotes() {
    downloadCsv(
      `quotes-${reportStart}-to-${reportEnd}.csv`,
      reportData.timingRows.map((row) => ({
        "Quote Created": formatDateTime(row.createdAt),
        "Assigned At": formatDateTime(row.assignedAt),
        "Accepted At": row.acceptedAt ? formatDateTime(row.acceptedAt) : "",
        "Price Sent At": row.priceSentAt ? formatDateTime(row.priceSentAt) : "",
        "Final Decision At": row.finalizedAt
          ? formatDateTime(row.finalizedAt)
          : "",
        Customer: row.customer,
        Source: row.dealer,
        Salesperson: row.salesperson,
        Type: workTypeLabels[row.workType],
        Agent: row.agent,
        "Input Method": row.channel,
        Status: row.lifecycle,
        "Not Sold Reason": row.notSoldReason || "",
        "Minutes Assign to Take":
          row.timeToAccept === null ? "" : Math.round(row.timeToAccept),
        "Minutes Take to Price":
          row.timeToPrice === null ? "" : Math.round(row.timeToPrice),
        "Minutes Take to Final":
          row.timeToFinal === null ? "" : Math.round(row.timeToFinal),
        "Minutes Price to Decision":
          row.priceToDecision === null ? "" : Math.round(row.priceToDecision),
        "Total Cycle Minutes":
          row.totalCycle === null ? "" : Math.round(row.totalCycle),
      })),
    );
  }

  function exportNotSoldQuotes() {
    downloadCsv(
      `not-sold-quotes-${reportStart}-to-${reportEnd}.csv`,
      reportData.notSoldRows.map((row) => ({
        "Final Decision At": row.finalizedAt ? formatDateTime(row.finalizedAt) : "",
        "Quote Created": formatDateTime(row.createdAt),
        "Price Sent At": row.priceSentAt ? formatDateTime(row.priceSentAt) : "",
        Customer: row.customer,
        Source: row.dealer,
        Salesperson: row.salesperson,
        "Assigned Agent": row.agent,
        "Original Owner": row.originalOwner,
        "Quote Type": workTypeLabels[row.workType],
        "Input Method": row.channel,
        "Assignment Method": methodStyles[row.method].label,
        "Not Sold Reason": row.notSoldReason || "Unknown",
        "Minutes Assign to Take": row.timeToAccept === null ? "" : Math.round(row.timeToAccept),
        "Minutes Take to Price": row.timeToPrice === null ? "" : Math.round(row.timeToPrice),
        "Minutes Price to Decision": row.priceToDecision === null ? "" : Math.round(row.priceToDecision),
        "Total Cycle Minutes": row.totalCycle === null ? "" : Math.round(row.totalCycle),
        "Note Count": row.noteCount,
        "Latest Note": row.latestNote,
        "Latest Note By": row.latestNoteBy,
        "Latest Note At": row.latestNoteAt ? formatDateTime(row.latestNoteAt) : "",
      })),
    );
  }

  function exportPendingPricing() {
    downloadCsv(
      `pending-pricing-${dateInputValue(new Date())}.csv`,
      pendingPricing.map((item) => ({
        "Price Sent": formatDateTime(item.priceSentAt),
        "Days Waiting": daysSince(item.priceSentAt),
        Customer: item.customer,
        Source: item.dealer,
        Salesperson: item.salesperson || "Not recorded",
        Type: workTypeLabels[item.workType],
        Agent: item.assignedAgent,
        "Input Method": item.receivedThrough || "",
      })),
    );
  }

  function exportAgentReport() {
    downloadCsv(
      `agent-performance-${reportStart}-to-${reportEnd}.csv`,
      reportData.byAgent.map((row) => ({
        Agent: row.agent,
        Quotes: row.quotes,
        "Finalized Quotes": row.finalized,
        WhatsApp: row.whatsapp,
        RingCentral: row.ringcentral,
        Manual: row.manual,
        "Workload Turns": row.workload,
        "WhatsApp Updates": row.updates,
        "Turns Passed": row.passes,
        Sold: row.sold,
        "Not Sold": row.notSold,
        "Price Sent": row.pending,
        "Efficiency %": row.efficiency.toFixed(1),
        "Conversion %": row.conversion.toFixed(1),
      })),
    );
  }

  function exportSourceReport() {
    downloadCsv(
      `source-salesperson-performance-${reportStart}-to-${reportEnd}.csv`,
      reportData.sourceSalespeople.map((row) => ({
        Salesperson: row.salesperson,
        Source: row.source,
        Quotes: row.quotes,
        "Finalized Quotes": row.finalized,
        Sold: row.sold,
        "Not Sold": row.notSold,
        "Price Sent": row.pending,
        "Efficiency %": row.efficiency.toFixed(1),
        "Conversion %": row.conversion.toFixed(1),
        "Quotes Taken": row.taken,
        Notes: row.notes,
        Category: row.category,
      })),
    );
  }

  function exportServiceActivity() {
    downloadCsv(
      `service-activity-${reportStart}-to-${reportEnd}.csv`,
      reportData.service.map((item) => ({
        Date: formatDateTime(item.createdAt),
        Customer: item.customer,
        Source: item.dealer,
        Salesperson: item.salesperson || "Not recorded",
        Type: workTypeLabels[item.workType],
        Agent: item.assignedAgent,
        Method: methodStyles[item.assignmentMethod].label,
        Status: item.status,
      })),
    );
  }

  function exportTimingReport() {
    downloadCsv(
      `quote-timing-${reportStart}-to-${reportEnd}.csv`,
      reportData.timingByAgent.map((row) => ({
        Agent: row.agent,
        Quotes: row.quotes,
        Accepted: row.accepted,
        "Avg Assignment to Acceptance": formatDuration(row.avgAccept),
        "Avg Acceptance to Price": formatDuration(row.avgPrice),
        "Avg Acceptance to Final Decision": formatDuration(row.avgFinal),
        "Avg Price Sent to Decision": formatDuration(row.avgPriceDecision),
        "Avg Total Quote Cycle": formatDuration(row.avgTotalCycle),
      })),
    );
  }

  function exportTakenReport() {
    downloadCsv(
      `taken-quotes-${reportStart}-to-${reportEnd}.csv`,
      reportData.takenRows.map((row) => ({
        "Taken At": formatDateTime(row.takenAt),
        "Quote Received At": formatDateTime(row.receivedAt),
        Customer: row.customer,
        Source: row.source,
        Queue: row.rotation === "whatsapp" ? "WhatsApp" : "RingCentral",
        "Taken By": `@${row.takerUsername}`,
        "Quote Agent": row.quoteAgent,
        "Missed Agent": row.skippedAgents
          .map((agent) => `@${agent.username}`)
          .join(", "),
        "Missed Turn Count": row.skippedAgents.length,
        "Elapsed Seconds": row.elapsedSeconds,
        "Elapsed Time": formatElapsedSeconds(row.elapsedSeconds),
        "Quote Status": row.quoteStatus,
        "Input Method": row.receivedThrough,
      })),
    );
  }

  return (
    <div className="space-y-5">
      {!forceManagerTab && <TabBar tabs={tabs} value={managerTab} onChange={setManagerTab} />}

      {managerTab === "work" ? (
        <section className="flex flex-col gap-3 rounded-[24px] border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
              Work Management
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Keep active assignments and pricing follow-up together without showing both tables at once.
            </p>
          </div>
          <div className="flex gap-1 rounded-2xl bg-slate-100 p-1.5">
            <button
              type="button"
              onClick={() => setWorkView("tasks")}
              className={cn(
                "rounded-xl px-4 py-2.5 text-xs font-black transition",
                workView === "tasks"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-white",
              )}
            >
              Open Tasks · {activeTasks.length}
            </button>
            <button
              type="button"
              onClick={() => setWorkView("pricing")}
              className={cn(
                "rounded-xl px-4 py-2.5 text-xs font-black transition",
                workView === "pricing"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-white",
              )}
            >
              Pending Pricing · {pendingPricing.length}
            </button>
            <button
              type="button"
              onClick={() => setWorkView("workload")}
              className={cn(
                "rounded-xl px-4 py-2.5 text-xs font-black transition",
                workView === "workload"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-white",
              )}
            >
              Workload Log
            </button>
          </div>
        </section>
      ) : null}

      {managerTab === "administration" ? (
        <section className="flex flex-col gap-3 rounded-[24px] border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
              User Administration
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Users, permissions, sources and salespeople management.
            </p>
          </div>
          <div className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1.5">
            <button
              type="button"
              onClick={() => setAdministrationView("users")}
              className={cn(
                "rounded-xl px-4 py-2.5 text-xs font-black transition",
                administrationView === "users"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-white",
              )}
            >
              Users & Access
            </button>
            <button
              type="button"
              onClick={() => setAdministrationView("sources")}
              className={cn(
                "rounded-xl px-4 py-2.5 text-xs font-black transition",
                administrationView === "sources"
                  ? "bg-[#223f7a] text-white shadow-sm"
                  : "text-slate-500 hover:bg-white",
              )}
            >
              Sources & Salespeople
            </button>
          </div>
        </section>
      ) : null}

      {managerTab === "quotes" ? (
        <section className="flex flex-col gap-3 rounded-[24px] border border-slate-200 bg-white p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Agency Databases</p><p className="mt-1 text-sm font-semibold text-slate-500">Quotes and workload records in one place.</p></div>
          <div className="flex gap-1 rounded-2xl bg-slate-100 p-1.5">
            <button type="button" onClick={() => setManagerDatabaseView("quotes")} className={cn("rounded-xl px-4 py-2.5 text-xs font-black", managerDatabaseView === "quotes" ? "bg-[#223f7a] text-white" : "text-slate-500 hover:bg-white")}>Quotes Database</button>
            <button type="button" onClick={() => setManagerDatabaseView("workloads")} className={cn("rounded-xl px-4 py-2.5 text-xs font-black", managerDatabaseView === "workloads" ? "bg-[#223f7a] text-white" : "text-slate-500 hover:bg-white")}>Workload Database</button>
          </div>
        </section>
      ) : null}

      {managerTab === "overview" ? (
        <div className="space-y-5">
          <section className="flex flex-wrap items-center justify-between gap-3 rounded-[22px] border border-[#c9d5e9] bg-white px-4 py-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]"><FilePlus2 className="h-4 w-4" /></div>
              <div><p className="text-xs font-black uppercase tracking-[0.14em] text-[#223f7a]">Manager Quick Action</p><p className="text-sm font-bold text-slate-500">Create and assign a quote without moving a queue.</p></div>
            </div>
            <button onClick={onOpenAssignQuote} className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-4 py-2.5 text-xs font-black text-white hover:bg-[#17305f]"><UserPlus className="h-4 w-4" />Create & Assign</button>
          </section>

          <details className="rounded-[28px] border border-amber-200 bg-amber-50 shadow-sm">
            <summary className="cursor-pointer list-none p-5 [&::-webkit-details-marker]:hidden">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-start gap-3">
                  <Bell className="mt-0.5 h-5 w-5 text-amber-700" />
                  <div>
                    <p className="font-black text-amber-950">Manager alerts</p>
                    <p className="mt-1 text-xs font-semibold text-amber-700">
                      {managerAlerts.length
                        ? `${managerAlerts.length} item${managerAlerts.length === 1 ? "" : "s"} need review. Click to expand.`
                        : "No operational alerts right now."}
                    </p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-700 ring-1 ring-amber-200">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                  Live
                </span>
              </div>
            </summary>
            <div className="border-t border-amber-200 px-5 pb-5">
              {managerAlerts.length ? (
                <ul className="mt-4 grid gap-3 text-sm font-semibold text-amber-900 md:grid-cols-2">
                  {managerAlerts.map((alert) => (
                    <li key={alert} className="flex gap-2 rounded-2xl bg-white/65 p-3">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                      {alert}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 rounded-2xl bg-white/65 p-4 text-sm font-bold text-emerald-700">
                  No operational alerts right now.
                </p>
              )}
            </div>
          </details>

          <section className="rounded-[24px] border border-slate-200 bg-white shadow-sm p-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-[#223f7a]">Team Availability</p>
                <p className="mt-0.5 text-sm font-bold text-slate-500">Who's clocked in and ready</p>
              </div>
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-black text-emerald-700 ring-1 ring-emerald-200">{agentList.filter((agent) => agent.availability === "available").length} available</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {agentList.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2 rounded-xl bg-slate-50 p-2.5">
                  <StatusDot status={agent.availability} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-black text-slate-800">{agent.name}</p>
                    <p className="text-[10px] font-bold capitalize text-slate-400">{agent.availability === "break" ? "Break" : agent.availability}</p>
                  </div>
                  <div className="flex gap-0.5">
                    {([['WA', agent.whatsappActive], ['RC', agent.ringCentralActive], ['WL', agent.workloadActive]] as const).map(([label, active]) => <span key={label} className={cn("rounded px-1 py-0.5 text-[8px] font-black", active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-400")}>{label}</span>)}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-4">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                Rotation Control
              </p>
              <h2 className="mt-1 text-2xl font-black tracking-tight">
                Current turns
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Change a rotation only when management needs to correct the
                order.
              </p>
            </div>
            <div className="grid gap-5 xl:grid-cols-3">
              {(
                [
                  ["whatsapp", whatsappCurrentId],
                  ["ringcentral", ringCentralCurrentId],
                  ["workload", workloadCurrentId],
                ] as const
              ).map(([kind, currentId]) => {
                const current = currentId
                  ? (agentList.find((agent) => agent.id === currentId) ?? null)
                  : null;
                const config = rotationConfig[kind];
                return (
                  <div
                    key={kind}
                    className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm"
                  >
                    <div
                      className={cn(
                        "flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em]",
                        config.accent,
                      )}
                    >
                      {config.icon}
                      {config.title}
                    </div>
                    {current ? (
                      <div className="mt-4 flex items-center gap-3">
                        <Avatar agent={current} />
                        <div>
                          <p className="text-xs font-bold text-slate-400">
                            Current
                          </p>
                          <p className="font-black">{current.name}</p>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-4">
                        <p className="font-black text-slate-700">
                          No agent yet
                        </p>
                        <p className="mt-1 text-xs font-semibold text-slate-500">
                          Waiting for the first eligible agent to become
                          Available.
                        </p>
                      </div>
                    )}
                    <select
                      value={currentId || ""}
                      onChange={(event) => {
                        if (event.target.value)
                          void onSetRotation(kind, event.target.value);
                      }}
                      className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-black"
                    >
                      <option value="">No agent yet</option>
                      {agentList.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      ) : null}

      {managerTab === "work" && workView === "tasks" ? (
        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                All Open Tasks
              </p>
              <h3 className="mt-1 text-xl font-black">
                Redistribute active work
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Pending pricing is intentionally excluded from workload.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">
                {activeTasks.length} open
              </span>
              <button
                onClick={onOpenAssignQuote}
                className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-4 py-2.5 text-xs font-black text-white"
              >
                <FilePlus2 className="h-4 w-4" /> Create & Assign Quote
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">Work</th>
                  <th className="px-5 py-3">Owner</th>
                  <th className="px-5 py-3">Assigned</th>
                  <th className="px-5 py-3">Acceptance</th>
                  <th className="px-5 py-3">Source</th>
                  <th className="px-5 py-3">Assigned</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activeTasks.map((item) => (
                  <tr key={item.id}>
                    <td className="px-5 py-4">
                      <p className="font-black">{item.customer}</p>
                      <p className="mt-1 text-xs text-slate-400">
                        {item.dealer}
                      </p>
                      {item.relatedQuoteSourceWorkItemId ? (
                        <p className="mt-2 text-[10px] font-black uppercase tracking-wide text-violet-700">
                          Linked quote
                        </p>
                      ) : null}
                    </td>
                    <td className="px-5 py-4">
                      <p className="font-bold">
                        {workTypeLabels[item.workType]}
                      </p>
                      <div className="mt-2">
                        <MethodBadge method={item.assignmentMethod} />
                      </div>
                    </td>
                    <td className="px-5 py-4 text-slate-600">
                      {item.originalOwner || "—"}
                    </td>
                    <td className="px-5 py-4">
                      <select
                        value={
                          agentList.find(
                            (agent) => agent.name === item.assignedAgent,
                          )?.id || ""
                        }
                        onChange={(event) =>
                          void onReassignWork(item.id, event.target.value)
                        }
                        className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black"
                      >
                        {agentList.map((agent) => (
                          <option key={agent.id} value={agent.id}>
                            {agent.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-5 py-4">
                      {item.acceptedAt ? (
                        <div>
                          <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">
                            Accepted
                          </span>
                          <p className="mt-2 text-[10px] font-semibold text-slate-400">
                            {formatDateTime(item.acceptedAt)}
                          </p>
                        </div>
                      ) : (
                        <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-black text-amber-700">
                          Awaiting acceptance
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-slate-600">
                      {item.receivedThrough}
                    </td>
                    <td className="px-5 py-4 text-xs font-semibold text-slate-400">
                      {formatDateTime(item.assignedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {managerTab === "work" && workView === "pricing" ? (
        <section className="overflow-hidden rounded-[28px] border border-blue-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-blue-600">
                <Clock3 className="h-4 w-4" /> Pending Pricing Follow-Up
              </div>
              <h3 className="mt-1 text-xl font-black">
                Management follow-up list
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Review follow-up notes, reassign responsibility, and record the
                final decision.
              </p>
            </div>
            <button
              onClick={exportPendingPricing}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-black text-white"
            >
              <Download className="h-4 w-4" /> Export Pending CSV
            </button>
          </div>
          <div className="grid gap-4 p-5 xl:grid-cols-2">
            {pendingPricing.map((item) => {
              const notes = quoteNotesBySource.get(item.sourceWorkItemId) || [];
              return (
                <div
                  key={item.id}
                  className={cn(
                    "rounded-2xl border p-4",
                    daysSince(item.priceSentAt) >= 2
                      ? "border-amber-200 bg-amber-50/40"
                      : "border-blue-100 bg-blue-50/30",
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-black text-slate-900">
                        {item.customer}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-slate-500">
                        {item.dealer} · {workTypeLabels[item.workType]}
                      </p>
                      <p className="mt-2 text-xs font-bold text-blue-700">
                        Price sent {formatDateTime(item.priceSentAt)} ·{" "}
                        {daysSince(item.priceSentAt)} day
                        {daysSince(item.priceSentAt) === 1 ? "" : "s"} waiting
                      </p>
                    </div>
                    <span className="rounded-full bg-white px-2.5 py-1 text-xs font-black text-slate-600 ring-1 ring-slate-200">
                      {item.receivedThrough || "Unknown"}
                    </span>
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto]">
                    <select
                      value={
                        agentList.find(
                          (agent) => agent.name === item.assignedAgent,
                        )?.id || ""
                      }
                      onChange={(event) =>
                        void onReassignPending(item.id, event.target.value)
                      }
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black"
                    >
                      {agentList.map((agent) => (
                        <option key={agent.id} value={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                    <div className="flex gap-2">
                      <button
                        onClick={() => onOpenQuoteLog(item.sourceWorkItemId)}
                        className="rounded-lg border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a]"
                      >
                        Log
                      </button>
                      <button
                        onClick={() => void finalizePendingPricingSold(item)}
                        className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black text-white"
                      >
                        Sold
                      </button>
                      <button
                        onClick={() => onRequestNotSold(item)}
                        className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 ring-1 ring-rose-200"
                      >
                        Not Sold
                      </button>
                    </div>
                  </div>
                  <PendingNotesPanel
                    notes={notes}
                    draft={noteDrafts[item.sourceWorkItemId] || ""}
                    onDraftChange={(value) =>
                      setNoteDrafts((current) => ({
                        ...current,
                        [item.sourceWorkItemId]: value,
                      }))
                    }
                    onAdd={() => void onAddQuoteNote(item.sourceWorkItemId)}
                  />
                </div>
              );
            })}
          </div>
          {!pendingPricing.length ? (
            <div className="p-5">
              <EmptyState
                title="No pending pricing quotes"
                note="Price-sent quotes will appear here with their follow-up history."
              />
            </div>
          ) : null}
        </section>
      ) : null}

      {managerTab === "quotes" ? (
        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-6">
            <div>
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                <Table2 className="h-4 w-4" /> Quotes Database
              </div>
              <h3 className="mt-1 text-xl font-black">
                Manage and filter every quote status
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Filter by day, status, update, customer, source, salesperson, or
                agent. Delete only incorrect or test records.
              </p>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <Field label="Day">
                <input
                  type="date"
                  value={managerQuoteDay}
                  onChange={(event) => setManagerQuoteDay(event.target.value)}
                  className="field"
                />
              </Field>
              <Field label="Status">
                <select
                  value={managerQuoteStatus}
                  onChange={(event) =>
                    setManagerQuoteStatus(event.target.value)
                  }
                  className="field"
                >
                  <option value="all">All statuses</option>
                  <option>Active</option>
                  <option>Price Sent</option>
                  <option>Sold</option>
                  <option>Not Sold</option>
                </select>
              </Field>
              <Field label="Update">
                <select
                  value={managerQuoteUpdate}
                  onChange={(event) =>
                    setManagerQuoteUpdate(event.target.value)
                  }
                  className="field"
                >
                  {quoteUpdateFilterOptions.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Search">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={quoteSearch}
                    onChange={(event) => setQuoteSearch(event.target.value)}
                    placeholder="Customer, source, salesperson, agent"
                    className="field"
                    style={{ paddingLeft: "3rem" }}
                  />
                </div>
              </Field>
            </div>
            <button
              onClick={() => {
                setManagerQuoteDay("");
                setManagerQuoteStatus("all");
                setManagerQuoteUpdate("all");
                setQuoteSearch("");
              }}
              className="mt-3 text-xs font-black text-[#223f7a]"
            >
              Show all records
            </button>
          </div>
          <div className="border-b border-amber-100 bg-amber-50 px-6 py-3 text-xs font-semibold text-amber-900">
            Deletion is manager-only, requires a reason, and is permanently
            recorded in the audit log.
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-5 py-3">Customer</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Type</th>
                  <th className="px-5 py-3">Agent</th>
                  <th className="px-5 py-3">Source / Salesperson</th>
                  <th className="px-5 py-3">Input</th>
                  <th className="px-5 py-3">Last Status</th>
                  <th className="px-5 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visibleQuoteRecords.map((item) => {
                  const statusClass =
                    item.status === "Sold"
                      ? "bg-emerald-50 text-emerald-700"
                      : item.status === "Not Sold"
                        ? "bg-rose-50 text-rose-700"
                        : item.status === "Price Sent"
                          ? "bg-blue-50 text-blue-700"
                          : "bg-amber-50 text-amber-700";
                  return (
                    <tr
                      key={`${item.stage}-${item.id}`}
                      className="hover:bg-slate-50"
                    >
                      <td className="px-5 py-4">
                        <p className="font-black text-slate-900">
                          {item.customer}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.source}
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-black",
                            statusClass,
                          )}
                        >
                          {item.status}
                        </span>
                      </td>
                      <td className="px-5 py-4 font-bold text-slate-600">
                        {workTypeLabels[item.workType]}
                      </td>
                      <td className="px-5 py-4 font-bold text-slate-700">
                        {item.agent}
                      </td>
                      <td className="px-5 py-4">
                        <p className="font-semibold text-slate-600">
                          {item.source}
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {item.salesperson}
                        </p>
                      </td>
                      <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                        {item.receivedThrough}
                      </td>
                      <td className="px-5 py-4 text-xs font-semibold text-slate-500">
                        {formatDateTime(item.statusDate)}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex gap-2">
                          <button
                            onClick={() =>
                              onOpenQuoteLog(item.sourceWorkItemId)
                            }
                            className="rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-2 text-xs font-black text-[#223f7a]"
                          >
                            Log
                          </button>
                          <button
                            onClick={() =>
                              void onDeleteQuote(
                                item.stage,
                                item.id,
                                item.customer,
                              )
                            }
                            className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 transition hover:bg-rose-100"
                          >
                            <Trash2 className="h-4 w-4" /> Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!visibleQuoteRecords.length ? (
            <div className="p-8 text-center text-sm font-semibold text-slate-500">
              No quote records match your search.
            </div>
          ) : null}
        </section>
      ) : null}

      {managerTab === "quotes" && managerDatabaseView === "workloads" ? (
        workloadDatabaseContent ?? <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><EmptyState title="Workload database unavailable" note="Refresh the page or verify the workload module." /></div>
      ) : null}

      {managerTab === "work" && workView === "workload" ? (
        workloadDatabaseContent ?? <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><EmptyState title="Workload log unavailable" note="Refresh the page or verify the workload module." /></div>
      ) : null}

      {managerTab === "reports" ? (
        <section className="space-y-5">
          <div className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-5 2xl:flex-row 2xl:items-end 2xl:justify-between">
              <div>
                <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                  <BarChart3 className="h-4 w-4" /> Reports Center
                </div>
                <h2 className="mt-2 text-2xl font-black">
                  Operational and sales intelligence
                </h2>
                <p className="mt-1 max-w-2xl text-sm font-semibold text-slate-500">
                  Start with the Command Center, then use the grouped report
                  library for deeper analysis.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Start date">
                  <input
                    type="date"
                    value={reportStart}
                    onChange={(event) => setReportStart(event.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold"
                  />
                </Field>
                <Field label="End date">
                  <input
                    type="date"
                    value={reportEnd}
                    onChange={(event) => setReportEnd(event.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold"
                  />
                </Field>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setPreset("today")}
                className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-200"
              >
                Today
              </button>
              <button
                onClick={() => setPreset("yesterday")}
                className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-200"
              >
                Yesterday
              </button>
              <button
                onClick={() => setPreset("week")}
                className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-200"
              >
                Last 7 Days
              </button>
              <button
                onClick={() => setPreset("month")}
                className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-200"
              >
                This Month
              </button>
              <span className="w-full pt-1 text-xs font-bold text-slate-400 sm:ml-auto sm:w-auto sm:pt-0">
                Showing {formatDate(`${reportStart}T12:00:00`)} –{" "}
                {formatDate(`${reportEnd}T12:00:00`)}
              </span>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <SummaryCard
              label="Quotes"
              value={reportData.quotes.length}
              note="All input methods"
              icon={<ClipboardList className="h-5 w-5 text-[#223f7a]" />}
              tone="bg-[#eef3fb]"
            />
            <SummaryCard
              label="Sold"
              value={reportData.sold}
              note="Final Sold decisions"
              icon={<CircleDollarSign className="h-5 w-5 text-emerald-700" />}
              tone="bg-emerald-50"
            />
            <SummaryCard
              label="Conversion"
              value={`${reportData.conversion.toFixed(1)}%`}
              note="Sold ÷ finalized"
              icon={<TrendingUp className="h-5 w-5 text-[#223f7a]" />}
              tone="bg-[#eef3fb]"
            />
            <SummaryCard
              label="Efficiency"
              value={`${reportData.efficiency.toFixed(1)}%`}
              note="Finalized ÷ all quotes"
              icon={<Gauge className="h-5 w-5 text-cyan-700" />}
              tone="bg-cyan-50"
            />
            <SummaryCard
              label="Pending"
              value={pendingPricing.length}
              note="Current follow-up list"
              icon={<Clock3 className="h-5 w-5 text-amber-700" />}
              tone="bg-amber-50"
            />
            <SummaryCard
              label="Exceptions"
              value={reportData.exceptionItems.length}
              note="Items needing review"
              icon={<AlertTriangle className="h-5 w-5 text-rose-700" />}
              tone="bg-rose-50"
            />
          </div>

          <div className="grid min-w-0 gap-5 xl:grid-cols-[270px_minmax(0,1fr)]">
            <aside className="hidden xl:block">
              <div className="sticky top-5 overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-100 p-5">
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                    Report Library
                  </p>
                  <div className="mt-1 flex items-end justify-between gap-3">
                    <h3 className="text-xl font-black text-slate-900">
                      Choose a view
                    </h3>
                    <span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-[10px] font-black text-[#223f7a]">
                      {reportNavigationItems.length} reports
                    </span>
                  </div>
                </div>
                <nav className="max-h-[calc(100vh-9rem)] space-y-5 overflow-y-auto p-3">
                  {reportNavigationGroups.map((group) => (
                    <div key={group.label}>
                      <div className="px-2 pb-2">
                        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                          {group.label}
                        </p>
                      </div>
                      <div className="space-y-1">
                        {group.items.map((item) => {
                          const Icon = item.icon;
                          const active = reportView === item.id;
                          return (
                            <button
                              key={item.id}
                              onClick={() => setReportView(item.id)}
                              className={cn(
                                "flex w-full items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm font-black transition",
                                active
                                  ? "bg-[#223f7a] text-white shadow-sm"
                                  : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                              )}
                            >
                              <span
                                className={cn(
                                  "grid h-8 w-8 shrink-0 place-items-center rounded-xl",
                                  active
                                    ? "bg-white/15"
                                    : "bg-slate-100 text-[#223f7a]",
                                )}
                              >
                                <Icon className="h-4 w-4" />
                              </span>
                              <span className="min-w-0 truncate">
                                {item.label}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </nav>
              </div>
            </aside>

            <div className="min-w-0 space-y-5">
              <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm xl:hidden">
                <label
                  className="text-xs font-black uppercase tracking-[0.14em] text-slate-500"
                  htmlFor="mobile-report-selector"
                >
                  Select report
                </label>
                <select
                  id="mobile-report-selector"
                  value={reportView}
                  onChange={(event) =>
                    setReportView(event.target.value as ReportView)
                  }
                  className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 outline-none focus:border-[#6b84b5] focus:ring-4 focus:ring-[#eef3fb]"
                >
                  {reportNavigationGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>

              <div className="rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#f3f6fb] p-5 shadow-sm sm:p-6">
                <div className="flex items-start gap-4">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#223f7a] text-white shadow-sm">
                    <SelectedReportIcon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] font-black uppercase tracking-[0.18em] text-[#4d6aa8]">
                      {selectedReportGroup.label}
                    </p>
                    <h3 className="mt-1 text-2xl font-black tracking-tight text-[#17305f]">
                      {selectedReport.label}
                    </h3>
                    <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
                      {selectedReport.description}
                    </p>
                  </div>
                </div>
              </div>

              <div className="min-w-0">
                {reportView === "executive" ? (
                  <ExecutiveReport reportData={reportData} />
                ) : null}
                {reportView === "not_sold" ? (
                  <NotSoldReport rows={reportData.notSoldRows} onExport={exportNotSoldQuotes} />
                ) : null}
                {reportView === "exceptions" ? (
                  <ExceptionCenterReport items={reportData.exceptionItems} />
                ) : null}
                {reportView === "funnel" ? (
                  <FunnelReport
                    quotes={reportData.quotes}
                    sold={reportData.sold}
                    notSold={reportData.notSold}
                    pending={pendingPricing.length}
                  />
                ) : null}
                {reportView === "trends" ? (
                  <DailyOperationsReport rows={reportData.dailyRows} />
                ) : null}
                {reportView === "agents" ? (
                  <AgentOperationsReport rows={reportData.byAgent} />
                ) : null}
                {reportView === "scorecard" ? (
                  <AgentScorecardReport rows={reportData.agentScorecards} />
                ) : null}
                {reportView === "workload" ? (
                  <WorkloadCapacityReport rows={reportData.workloadByAgent} />
                ) : null}
                {reportView === "queues" ? (
                  <QueueHealthReport
                    rows={reportData.queueHealth}
                    settings={settings}
                    customerServiceUsers={customerServiceUsers}
                    onUpdate={onUpdateCustomerServiceOverflow}
                  />
                ) : null}
                {reportView === "taken" ? (
                  <TakenQuotesReport
                    rows={reportData.takenRows}
                    byAgent={reportData.takenByAgent}
                    summary={reportData.takenSummary}
                  />
                ) : null}
                {reportView === "missed" ? (
                  <MissedTurnsReport rows={reportData.missedByAgent} />
                ) : null}
                {reportView === "passes" ? (
                  <PassBehaviorReport rows={reportData.passByAgent} />
                ) : null}
                {reportView === "followup" ? (
                  <FollowUpReport pendingPricing={reportData.pendingInRange} />
                ) : null}
                {reportView === "documentation" ? (
                  <DocumentationQualityReport
                    rows={reportData.documentationByAgent}
                  />
                ) : null}
                {reportView === "channels" ? (
                  <RankedReportTable
                    title="Input Method Performance"
                    rows={reportData.byChannel}
                  />
                ) : null}
                {reportView === "sources" ? (
                  <SourceRiskReport
                    rows={reportData.sourceRisk}
                    salespersonRows={reportData.sourceSalespeople}
                  />
                ) : null}
                {reportView === "service" ? (
                  <ServiceControlReport
                    activations={reportData.activationRows}
                    changes={reportData.changeRows}
                    payments={reportData.paymentRows}
                  />
                ) : null}
                {reportView === "activation" ? (
                  <ActivationAuditReport
                    activations={reportData.activationRows}
                    activationEvents={reportData.activationEvents}
                    outcomes={quoteOutcomes}
                  />
                ) : null}
                {reportView === "manager" ? (
                  <ManagerInterventionReport
                    rows={reportData.managerInterventions}
                  />
                ) : null}
                {reportView === "integrity" ? (
                  <IntegrityReport issues={reportData.integrityIssues} />
                ) : null}
                {reportView === "system" ? (
                  <SystemHealthReport checks={reportData.systemChecks} />
                ) : null}
                {reportView === "timing" ? (
                  <QuoteTimingReport
                    rows={reportData.timingByAgent}
                    details={reportData.timingRows}
                  />
                ) : null}
                {reportView === "activity" ? (
                  <ServiceActivityReport items={reportData.service} />
                ) : null}
              </div>

              <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                    Exports
                  </p>
                  <h3 className="mt-1 text-xl font-black">
                    Download report data
                  </h3>
                  <p className="mt-1 text-sm text-slate-500">
                    CSV files open directly in Excel.
                  </p>
                </div>
                <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  <ExportButton
                    label="All Quote Data"
                    onClick={exportAllQuotes}
                  />
                  <ExportButton
                    label="Not Sold Quotes"
                    onClick={exportNotSoldQuotes}
                  />
                  <ExportButton
                    label="Quote Timing"
                    onClick={exportTimingReport}
                  />
                  <ExportButton
                    label="Taken Quotes"
                    onClick={exportTakenReport}
                  />
                  <ExportButton
                    label="Pending Pricing"
                    onClick={exportPendingPricing}
                  />
                  <ExportButton
                    label="Agent Performance"
                    onClick={exportAgentReport}
                  />
                  <ExportButton
                    label="Source Performance"
                    onClick={exportSourceReport}
                  />
                  <ExportButton
                    label="Service Activity"
                    onClick={exportServiceActivity}
                  />
                </div>
              </section>
            </div>
          </div>
        </section>
      ) : null}

      {managerTab === "administration" && administrationView === "sources" ? <SourceAdminPanel /> : null}

      {managerTab === "administration" && administrationView === "users" ? <UserAdminPanel /> : null}

      {managerTab === "administration" && administrationView === "controls" ? (
        <div className="space-y-5">
          <QueueOrderPanel agentList={agentList} onSave={onSetQueueOrder} />
          <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 p-6">
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                Team Controls
              </p>
              <h3 className="mt-1 text-xl font-black">
                Availability and rotation eligibility
              </h3>
              <p className="mt-2 max-w-4xl text-sm text-slate-500">
                <strong className="text-[#223f7a]">Active</strong> means the
                agent is eligible for that queue. When the agent is on Lunch or
                Unavailable, the queue shows <strong>Skipped</strong> and the
                rotation automatically moves around them. Their eligibility is
                preserved until they return.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="px-5 py-3">Agent</th>
                    <th className="px-5 py-3">Status</th>
                    <th className="px-5 py-3">WhatsApp</th>
                    <th className="px-5 py-3">RingCentral</th>
                    <th className="px-5 py-3">Workload</th>
                    <th className="px-5 py-3">Active Tasks</th>
                    <th className="px-5 py-3">Pending Pricing</th>
                    <th className="px-5 py-3">Passes Today</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {agentList.map((agent) => {
                    const performanceRow = performance.find(
                      (row) => row.agentId === agent.id,
                    );
                    const queueCells = [
                      ["whatsapp", "whatsappActive"],
                      ["ringcentral", "ringCentralActive"],
                      ["workload", "workloadActive"],
                    ] as const;
                    return (
                      <tr key={agent.id}>
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <Avatar agent={agent} size="sm" />
                            <p className="font-black">{agent.name}</p>
                          </div>
                        </td>
                        <td className="px-5 py-4">
                          <span className="inline-flex items-center gap-2 text-xs font-black capitalize">
                            <StatusDot status={agent.availability} />
                            {agent.availability === "break"
                              ? "Break / Lunch"
                              : agent.availability}
                          </span>
                        </td>
                        {queueCells.map(([rotation, key]) => {
                          const eligible = agent[key];
                          const skipped =
                            eligible && agent.availability !== "available";
                          const label = !eligible
                            ? "Paused"
                            : skipped
                              ? `Skipped · ${agent.availability === "break" ? "Lunch" : "Unavailable"}`
                              : "Active";
                          const style = !eligible
                            ? "bg-slate-100 text-slate-500"
                            : skipped
                              ? agent.availability === "break"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-slate-100 text-slate-600"
                              : "bg-[#eef3fb] text-[#223f7a]";
                          return (
                            <td key={key} className="px-5 py-4">
                              <button
                                onClick={() =>
                                  void onToggleRotation(agent, rotation)
                                }
                                className={cn(
                                  "rounded-full px-3 py-1.5 text-xs font-black",
                                  style,
                                )}
                                title={
                                  eligible
                                    ? "Click to pause this agent from the queue"
                                    : "Click to activate this agent in the queue"
                                }
                              >
                                {label}
                              </button>
                            </td>
                          );
                        })}
                        <td className="px-5 py-4 font-black">
                          {openCountByAgent[agent.name] ?? 0}
                        </td>
                        <td className="px-5 py-4 font-black text-[#223f7a]">
                          {
                            pendingPricing.filter(
                              (item) => item.assignedAgent === agent.name,
                            ).length
                          }
                        </td>
                        <td className="px-5 py-4">
                          <span
                            className={cn(
                              "rounded-full px-2.5 py-1 text-xs font-black",
                              performanceRow?.passedTurns
                                ? "bg-rose-50 text-rose-700"
                                : "bg-slate-100 text-slate-500",
                            )}
                          >
                            {performanceRow?.passedTurns ?? 0}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

type SourceAdminRow = {
  id: string;
  name: string;
  notes: string | null;
  is_active: boolean;
  created_at: string;
};

function SourceAdminPanel() {
  const supabase = useMemo(() => createClient(), []);
  const [dealers, setSources] = useState<SourceAdminRow[]>([]);
  const [salespeopleRows, setSalespeopleRows] = useState<DealerSalesperson[]>(
    [],
  );
  const [salespersonDealerId, setSalespersonDealerId] = useState("");
  const [salespersonName, setSalespersonName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadSources = useCallback(async () => {
    const [dealerResult, salespersonResult] = await Promise.all([
      supabase
        .from("dealers")
        .select("id,name,notes,is_active,created_at")
        .order("name"),
      supabase
        .from("dealer_salespeople")
        .select("id,dealer_id,name,notes,is_active,created_at")
        .order("name"),
    ]);
    const loadError = dealerResult.error || salespersonResult.error;
    if (loadError) {
      setError(loadError.message);
    } else {
      setSources((dealerResult.data ?? []) as SourceAdminRow[]);
      setSalespeopleRows(
        (
          (salespersonResult.data ?? []) as Array<{
            id: string;
            dealer_id: string;
            name: string;
            notes: string | null;
            is_active: boolean;
            created_at: string;
          }>
        ).map((row) => ({
          id: row.id,
          dealerId: row.dealer_id,
          name: row.name,
          notes: row.notes || undefined,
          isActive: row.is_active,
          createdAt: row.created_at,
        })),
      );
      setError("");
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadSources();
    }, 0);
    const channel = supabase
      .channel("dealer-admin-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dealers" },
        () => void loadSources(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "dealer_salespeople" },
        () => void loadSources(),
      )
      .subscribe();
    return () => {
      window.clearTimeout(initialLoad);
      void supabase.removeChannel(channel);
    };
  }, [loadSources, supabase]);

  const visibleSources = useMemo(() => {
    const needle = normalizeSourceSearch(search);
    if (!needle) return dealers;
    return dealers.filter(
      (dealer) =>
        normalizeSourceSearch(dealer.name).includes(needle) ||
        normalizeSourceSearch(dealer.notes ?? "").includes(needle),
    );
  }, [dealers, search]);

  function clearForm() {
    setEditingId(null);
    setName("");
    setNotes("");
    setError("");
  }

  function startEdit(dealer: SourceAdminRow) {
    setEditingId(dealer.id);
    setName(dealer.name);
    setNotes(dealer.notes ?? "");
    setError("");
    setMessage("");
  }

  async function saveSource(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = name.trim().replace(/\s+/g, " ");
    if (cleanName.length < 2)
      return setError("Source name must contain at least two characters.");

    const normalized = normalizeSourceSearch(cleanName);
    const duplicate = dealers.find(
      (dealer) =>
        dealer.id !== editingId &&
        normalizeSourceSearch(dealer.name) === normalized,
    );
    if (duplicate)
      return setError(`A source named “${duplicate.name}” already exists.`);

    setSaving(true);
    setError("");
    setMessage("");
    const payload = { name: cleanName, notes: notes.trim() || null };
    const result = editingId
      ? await supabase.from("dealers").update(payload).eq("id", editingId)
      : await supabase.from("dealers").insert(payload);
    setSaving(false);

    if (result.error) return setError(result.error.message);
    setMessage(
      editingId
        ? "Source updated."
        : "Source created and immediately available to agents.",
    );
    clearForm();
    await loadSources();
  }

  async function toggleSource(dealer: SourceAdminRow) {
    const action = dealer.is_active ? "deactivate" : "reactivate";
    if (
      dealer.is_active &&
      !window.confirm(
        `Deactivate ${dealer.name}? Historical reports will remain unchanged.`,
      )
    )
      return;
    const { error: updateError } = await supabase
      .from("dealers")
      .update({ is_active: !dealer.is_active })
      .eq("id", dealer.id);
    if (updateError) return setError(updateError.message);
    setMessage(
      `${dealer.name} ${action === "deactivate" ? "deactivated" : "reactivated"}.`,
    );
    if (editingId === dealer.id) clearForm();
    await loadSources();
  }

  async function addSalesperson(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanName = salespersonName.trim().replace(/\s+/g, " ");
    if (!salespersonDealerId || cleanName.length < 2)
      return setError("Select a source and enter the salesperson name.");
    const { error: insertError } = await supabase
      .from("dealer_salespeople")
      .insert({ dealer_id: salespersonDealerId, name: cleanName });
    if (insertError) return setError(insertError.message);
    setSalespersonName("");
    setMessage("Salesperson added.");
    await loadSources();
  }

  async function toggleSalesperson(person: DealerSalesperson) {
    const { error: updateError } = await supabase
      .from("dealer_salespeople")
      .update({ is_active: !person.isActive })
      .eq("id", person.id);
    if (updateError) return setError(updateError.message);
    setMessage(
      `${person.name} ${person.isActive ? "deactivated" : "reactivated"}.`,
    );
    await loadSources();
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-5 xl:grid-cols-[.62fr_1.38fr]">
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Store className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                Source Administration
              </p>
              <h3 className="mt-1 text-xl font-black">
                {editingId ? "Edit source" : "Create a source"}
              </h3>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Only management can change this directory. Active sources appear
            instantly in every agent quote form.
          </p>
          {error ? (
            <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
              {error}
            </div>
          ) : null}
          {message ? (
            <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">
              {message}
            </div>
          ) : null}
          <form onSubmit={saveSource} className="mt-6 space-y-4">
            <Field label="Source name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                maxLength={120}
                className="field"
                placeholder="Paste or type the official source name"
              />
            </Field>
            <Field label="Management notes (optional)">
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                rows={4}
                maxLength={500}
                className="field"
                placeholder="Internal note, location, alternate name, or contact detail"
              />
            </Field>
            <div className="flex gap-2">
              <button
                disabled={saving}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3 font-black text-white transition hover:bg-[#17305f] disabled:opacity-60"
              >
                <Check className="h-5 w-5" />
                {saving
                  ? "Saving..."
                  : editingId
                    ? "Save Changes"
                    : "Create Source"}
              </button>
              {editingId ? (
                <button
                  type="button"
                  onClick={clearForm}
                  className="rounded-2xl border border-slate-200 px-4 py-3 font-black text-slate-600 hover:bg-slate-50"
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                Source Directory
              </p>
              <h3 className="mt-1 text-xl font-black">
                {dealers.length} sources
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Deactivate old sources instead of deleting them so historical
                reports remain intact.
              </p>
            </div>
            <div className="relative w-full sm:max-w-sm">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="field"
                style={{ paddingLeft: "3rem" }}
                placeholder="Search source name or notes"
              />
            </div>
          </div>
          <div className="max-h-[650px] overflow-auto">
            {loading ? (
              <div className="p-8 text-sm font-semibold text-slate-500">
                Loading sources...
              </div>
            ) : visibleSources.length ? (
              <div className="divide-y divide-slate-100">
                {visibleSources.map((dealer) => (
                  <div
                    key={dealer.id}
                    className={cn(
                      "flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between",
                      !dealer.is_active && "bg-slate-50/80",
                    )}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p
                          className={cn(
                            "font-black",
                            !dealer.is_active && "text-slate-500",
                          )}
                        >
                          {dealer.name}
                        </p>
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider",
                            dealer.is_active
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-slate-200 text-slate-600",
                          )}
                        >
                          {dealer.is_active ? "Active" : "Inactive"}
                        </span>
                      </div>
                      {dealer.notes ? (
                        <p className="mt-1 text-sm text-slate-500">
                          {dealer.notes}
                        </p>
                      ) : (
                        <p className="mt-1 text-xs font-semibold text-slate-400">
                          No notes
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        onClick={() => startEdit(dealer)}
                        className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a] hover:bg-[#f3f6fb]"
                      >
                        <Pencil className="h-4 w-4" /> Edit
                      </button>
                      <button
                        onClick={() => void toggleSource(dealer)}
                        className={cn(
                          "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black",
                          dealer.is_active
                            ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200"
                            : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200",
                        )}
                      >
                        {dealer.is_active ? (
                          <XCircle className="h-4 w-4" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4" />
                        )}
                        {dealer.is_active ? "Deactivate" : "Reactivate"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-6">
                <EmptyState
                  title="No sources found"
                  note="Adjust the search or create a new source."
                />
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
          <UsersRound className="h-4 w-4" /> Dealer Salespeople
        </div>
        <h3 className="mt-1 text-xl font-black">
          Assign salespeople to each source
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Agents must choose one of these salespeople after selecting the
          dealer. Deactivate old names to preserve historical quote records.
        </p>
        <form
          onSubmit={addSalesperson}
          className="mt-5 grid gap-3 md:grid-cols-[1fr_1fr_auto]"
        >
          <select
            value={salespersonDealerId}
            onChange={(event) => setSalespersonDealerId(event.target.value)}
            required
            className="field"
          >
            <option value="">Select source</option>
            {dealers
              .filter((dealer) => dealer.is_active)
              .map((dealer) => (
                <option key={dealer.id} value={dealer.id}>
                  {dealer.name}
                </option>
              ))}
          </select>
          <input
            value={salespersonName}
            onChange={(event) => setSalespersonName(event.target.value)}
            required
            className="field"
            placeholder="Salesperson full name"
          />
          <button className="rounded-xl bg-[#223f7a] px-5 py-3 text-sm font-black text-white">
            Add Salesperson
          </button>
        </form>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {dealers.map((dealer) => {
            const people = salespeopleRows.filter(
              (person) => person.dealerId === dealer.id,
            );
            return (
              <div
                key={dealer.id}
                className="rounded-2xl border border-slate-200 p-4"
              >
                <p className="font-black">{dealer.name}</p>
                <div className="mt-3 space-y-2">
                  {people.length ? (
                    people.map((person) => (
                      <div
                        key={person.id}
                        className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2"
                      >
                        <span
                          className={cn(
                            "text-sm font-bold",
                            !person.isActive && "text-slate-400 line-through",
                          )}
                        >
                          {person.name}
                        </span>
                        <button
                          onClick={() => void toggleSalesperson(person)}
                          className={cn(
                            "rounded-lg px-2.5 py-1 text-[10px] font-black",
                            person.isActive
                              ? "bg-rose-50 text-rose-700"
                              : "bg-emerald-50 text-emerald-700",
                          )}
                        >
                          {person.isActive ? "Deactivate" : "Reactivate"}
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="text-xs font-semibold text-amber-700">
                      No salesperson configured.
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function QueueOrderPanel({
  agentList,
  onSave,
}: {
  agentList: Agent[];
  onSave: (rotation: RotationKind, profileIds: string[]) => Promise<void>;
}) {
  const liveOrders = useMemo<Record<RotationKind, string[]>>(
    () => ({
      whatsapp: orderedAgents(agentList, "whatsapp").map((agent) => agent.id),
      ringcentral: orderedAgents(agentList, "ringcentral").map(
        (agent) => agent.id,
      ),
      workload: orderedAgents(agentList, "workload").map((agent) => agent.id),
    }),
    [agentList],
  );
  const [drafts, setDrafts] =
    useState<Record<RotationKind, string[]>>(liveOrders);
  const [saving, setSaving] = useState<RotationKind | "all" | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(() => setDrafts(liveOrders), 0);
    return () => window.clearTimeout(timer);
  }, [liveOrders]);

  function move(rotation: RotationKind, index: number, direction: -1 | 1) {
    setDrafts((current) => {
      const list = [...current[rotation]];
      const target = index + direction;
      if (target < 0 || target >= list.length) return current;
      [list[index], list[target]] = [list[target], list[index]];
      return { ...current, [rotation]: list };
    });
    setMessage("");
  }

  async function save(rotation: RotationKind) {
    setSaving(rotation);
    await onSave(rotation, drafts[rotation]);
    setSaving(null);
    setMessage(`${rotationConfig[rotation].shortTitle} order saved.`);
  }

  function copyWhatsappToAll() {
    setDrafts((current) => ({
      ...current,
      ringcentral: [...current.whatsapp],
      workload: [...current.whatsapp],
    }));
    setMessage(
      "WhatsApp order copied into the other two drafts. Save the queues to apply it.",
    );
  }

  async function saveAll() {
    setSaving("all");
    for (const rotation of [
      "whatsapp",
      "ringcentral",
      "workload",
    ] as RotationKind[])
      await onSave(rotation, drafts[rotation]);
    setSaving(null);
    setMessage("All three queue orders saved.");
  }

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
            <Layers3 className="h-4 w-4" /> Queue Order
          </div>
          <h3 className="mt-1 text-xl font-black">
            Organize each rotation independently
          </h3>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">
            The three queues may use the same order or completely different
            orders. Reordering a queue does not move the current turn; it
            changes who comes next.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={copyWhatsappToAll}
            className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a] hover:bg-[#f3f6fb]"
          >
            <Copy className="h-4 w-4" /> Copy WhatsApp to other queues
          </button>
          <button
            disabled={saving !== null}
            onClick={() => void saveAll()}
            className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white hover:bg-[#17305f] disabled:opacity-60"
          >
            <Check className="h-4 w-4" />
            {saving === "all" ? "Saving..." : "Save All"}
          </button>
        </div>
      </div>
      {message ? (
        <div className="mt-4 rounded-2xl bg-[#eef3fb] px-4 py-3 text-sm font-bold text-[#223f7a]">
          {message}
        </div>
      ) : null}
      <div className="mt-6 grid gap-5 xl:grid-cols-3">
        {(["whatsapp", "ringcentral", "workload"] as RotationKind[]).map(
          (rotation) => {
            const config = rotationConfig[rotation];
            return (
              <div
                key={rotation}
                className="overflow-hidden rounded-3xl border border-slate-200"
              >
                <div className={cn("border-b p-4", config.soft)}>
                  <div
                    className={cn(
                      "flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em]",
                      config.accent,
                    )}
                  >
                    {config.icon}
                    {config.title}
                  </div>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Drag-free controls for reliable ordering.
                  </p>
                </div>
                <div className="divide-y divide-slate-100">
                  {drafts[rotation].map((agentId, index) => {
                    const agent = agentList.find((item) => item.id === agentId);
                    if (!agent) return null;
                    return (
                      <div
                        key={agent.id}
                        className="flex items-center gap-3 p-3"
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-black text-slate-500">
                          {index + 1}
                        </span>
                        <Avatar agent={agent} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-black">
                            {agent.name}
                          </p>
                          <p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
                            {rotationEligibility(agent, rotation)
                              ? agent.availability === "available"
                                ? "Active"
                                : agent.availability === "break"
                                  ? "Skipped · Lunch"
                                  : "Skipped · Unavailable"
                              : "Paused"}
                          </p>
                        </div>
                        <div className="flex gap-1">
                          <button
                            disabled={index === 0}
                            onClick={() => move(rotation, index, -1)}
                            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-25"
                            aria-label={`Move ${agent.name} up`}
                          >
                            <ArrowUp className="h-4 w-4" />
                          </button>
                          <button
                            disabled={index === drafts[rotation].length - 1}
                            onClick={() => move(rotation, index, 1)}
                            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-25"
                            aria-label={`Move ${agent.name} down`}
                          >
                            <ArrowDown className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="border-t border-slate-100 p-3">
                  <button
                    disabled={saving !== null}
                    onClick={() => void save(rotation)}
                    className={cn(
                      "w-full rounded-xl px-3 py-2.5 text-xs font-black text-white disabled:opacity-60",
                      config.button,
                    )}
                  >
                    {saving === rotation
                      ? "Saving..."
                      : `Save ${config.shortTitle} Order`}
                  </button>
                </div>
              </div>
            );
          },
        )}
      </div>
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900">
        <strong>Daily start rule:</strong> the first eligible agent to click
        Available each business day starts that queue. Normally the same first
        agent starts all three queues; a manager-paused agent will not start the
        queue they are paused from.
      </div>
    </section>
  );
}

function UserAdminPanel() {
  const [users, setUsers] = useState<AdminUserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showDeletedUsers, setShowDeletedUsers] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminUserAccount | null>(null);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [error, setError] = useState("");
  const [credential, setCredential] = useState<TemporaryCredential | null>(
    null,
  );

  const loadUsers = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const payload = (await response.json()) as {
        users?: AdminUserAccount[];
        error?: string;
      };
      if (!response.ok)
        throw new Error(payload.error || "Unable to load users.");
      setUsers(payload.users ?? []);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to load users.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/users", { cache: "no-store" })
      .then(async (response) => {
        const payload = (await response.json()) as {
          users?: AdminUserAccount[];
          error?: string;
        };
        if (!response.ok)
          throw new Error(payload.error || "Unable to load users.");
        return payload.users ?? [];
      })
      .then((rows) => {
        if (active) setUsers(rows);
      })
      .catch((caught) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : "Unable to load users.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setCredential(null);
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: String(form.get("username") || ""),
          displayName: String(form.get("displayName") || ""),
          initials: String(form.get("initials") || ""),
          role: String(form.get("role") || "agent"),
        }),
      });
      const payload = (await response.json()) as {
        user?: AdminUserAccount;
        temporaryPassword?: string;
        error?: string;
      };
      if (!response.ok || !payload.user || !payload.temporaryPassword)
        throw new Error(payload.error || "Unable to create user.");
      setCredential({
        username: payload.user.username,
        displayName: payload.user.display_name,
        temporaryPassword: payload.temporaryPassword,
      });
      formEl.reset();
      await loadUsers();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to create user.",
      );
    } finally {
      setSaving(false);
    }
  }

  function beginPasswordReset(user: AdminUserAccount) {
    setResetTarget(user);
    setTemporaryPassword("");
    setError("");
    setCredential(null);
  }

  async function resetPassword(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!resetTarget) return;
    if (temporaryPassword.length < 8 || temporaryPassword.length > 72) {
      setError("Temporary password must be between 8 and 72 characters.");
      return;
    }
    setResettingId(resetTarget.id);
    setError("");
    setCredential(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: resetTarget.id, temporaryPassword }),
      });
      const payload = (await response.json()) as {
        username?: string;
        displayName?: string;
        temporaryPassword?: string;
        error?: string;
      };
      if (
        !response.ok ||
        !payload.username ||
        !payload.displayName ||
        !payload.temporaryPassword
      )
        throw new Error(payload.error || "Unable to reset password.");
      setCredential({
        username: payload.username,
        displayName: payload.displayName,
        temporaryPassword: payload.temporaryPassword,
      });
      setResetTarget(null);
      setTemporaryPassword("");
      await loadUsers();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to reset password.",
      );
    } finally {
      setResettingId(null);
    }
  }

  async function deleteUser(user: AdminUserAccount) {
    const reason = window.prompt(
      `Why are you deleting ${user.display_name}? Their historical records will be preserved.`,
    );
    if (!reason?.trim()) return;
    if (
      !window.confirm(
        `Delete access for ${user.display_name}? They will be removed from active queues and will no longer be able to sign in.`,
      )
    )
      return;
    setDeletingId(user.id);
    setError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id, reason: reason.trim() }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(payload.error || "Unable to delete user.");
      await loadUsers();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to delete user.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
  }

  return (
    <div className="space-y-5">
      <Modal
        open={resetTarget !== null}
        title="Set Temporary Password"
        subtitle="Choose the exact temporary password the employee will use at the next sign-in."
        onClose={() => {
          setResetTarget(null);
          setTemporaryPassword("");
        }}
      >
        <form onSubmit={resetPassword} className="space-y-4 p-6">
          <div className="rounded-2xl bg-[#eef3fb] p-4">
            <p className="font-black text-[#17305f]">
              {resetTarget?.display_name}
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-600">
              @{resetTarget?.username}
            </p>
          </div>
          <Field label="Temporary password">
            <input
              type="text"
              value={temporaryPassword}
              onChange={(event) => setTemporaryPassword(event.target.value)}
              required
              minLength={8}
              maxLength={72}
              autoComplete="off"
              className="field"
              placeholder="Enter the temporary password"
            />
          </Field>
          <p className="text-xs font-semibold leading-5 text-slate-500">
            The employee will be required to replace this with a private
            password after signing in.
          </p>
          <button
            disabled={resettingId === resetTarget?.id}
            className="w-full rounded-xl bg-[#223f7a] px-4 py-3 font-black text-white disabled:opacity-50"
          >
            {resettingId === resetTarget?.id
              ? "Resetting..."
              : "Reset Password"}
          </button>
        </form>
      </Modal>
      {credential ? (
        <section className="rounded-[28px] border border-[#b8c7e1] bg-[#eef3fb] p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">
                <KeyRound className="h-4 w-4" /> Temporary Credential
              </div>
              <h3 className="mt-1 text-xl font-black text-[#17305f]">
                Give this to {credential.displayName}
              </h3>
              <p className="mt-1 text-sm font-semibold text-slate-600">
                The temporary password is shown only here. The user must create
                a private password at the next sign-in.
              </p>
            </div>
            <button
              onClick={() => setCredential(null)}
              className="self-start rounded-xl border border-[#b8c7e1] bg-white px-3 py-2 text-xs font-black text-[#223f7a]"
            >
              Dismiss
            </button>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#d5deed]">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                Username
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <code className="font-black text-[#223f7a]">
                  {credential.username}
                </code>
                <button
                  onClick={() => void copyText(credential.username)}
                  className="rounded-lg p-2 text-[#223f7a] hover:bg-[#eef3fb]"
                  aria-label="Copy username"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#d5deed]">
              <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">
                Temporary Password
              </p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <code className="break-all font-black text-[#223f7a]">
                  {credential.temporaryPassword}
                </code>
                <button
                  onClick={() => void copyText(credential.temporaryPassword)}
                  className="rounded-lg p-2 text-[#223f7a] hover:bg-[#eef3fb]"
                  aria-label="Copy password"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {error ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">
          {error}
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[.72fr_1.28fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <UserPlus className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                User Administration
              </p>
              <h3 className="mt-1 text-xl font-black">Create a new login</h3>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-500">
            Agents are added at the end of the three queue orders. Customer
            Service and Manager accounts never enter sales rotations.
          </p>
          <form onSubmit={createUser} className="mt-6 space-y-4">
            <Field label="Full name">
              <input
                name="displayName"
                required
                maxLength={80}
                className="field"
                placeholder="Example: Ana Lopez"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Username">
                <input
                  name="username"
                  required
                  minLength={3}
                  maxLength={30}
                  className="field"
                  placeholder="analopez"
                />
              </Field>
              <Field label="Initials">
                <input
                  name="initials"
                  maxLength={4}
                  className="field uppercase"
                  placeholder="AL"
                />
              </Field>
            </div>
            <Field label="Role">
              <select name="role" className="field">
                <option value="agent">Sales</option>
                <option value="customer_service">Customer Service</option>
                <option value="commercial">Commercial</option>
                <option value="manager">Manager / Admin</option>
              </select>
            </Field>
            <button
              disabled={saving}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3 font-black text-white transition hover:bg-[#17305f] disabled:opacity-60"
            >
              <UserPlus className="h-5 w-5" />
              {saving ? "Creating..." : "Create User"}
            </button>
          </form>
        </section>

        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
                Accounts
              </p>
              <h3 className="mt-1 text-xl font-black">
                User access and password resets
              </h3>
              <p className="mt-1 text-sm text-slate-500">
                Deleting a user removes access and queue participation while
                preserving historical records.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowDeletedUsers((value) => !value)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 hover:bg-slate-50"
              >
                {showDeletedUsers ? "Hide Deleted" : "Show Deleted"}
              </button>
              <button
                onClick={() => {
                  setLoading(true);
                  void loadUsers();
                }}
                className="rounded-xl border border-slate-200 p-2.5 text-[#223f7a] hover:bg-[#f3f6fb]"
                aria-label="Refresh users"
              >
                <RefreshCw
                  className={cn("h-4 w-4", loading && "animate-spin")}
                />
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-5 py-3">User</th>
                  <th className="px-5 py-3">Username</th>
                  <th className="px-5 py-3">Role</th>
                  <th className="px-5 py-3">Status</th>
                  <th className="px-5 py-3">Password</th>
                  <th className="px-5 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users
                  .filter((user) => showDeletedUsers || user.is_active)
                  .map((user) => (
                    <tr
                      key={user.id}
                      className={
                        !user.is_active ? "bg-slate-50 opacity-75" : ""
                      }
                    >
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#223f7a] text-xs font-black text-white">
                            {user.initials}
                          </div>
                          <div>
                            <p className="font-black">{user.display_name}</p>
                            <p className="mt-1 text-xs text-slate-400">
                              Created {formatDate(user.created_at)}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <code className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-black text-[#223f7a]">
                          {user.username}
                        </code>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-black",
                            user.role === "manager"
                              ? "bg-[#eef3fb] text-[#223f7a]"
                              : user.role === "customer_service"
                                ? "bg-cyan-50 text-cyan-700"
                                : user.role === "commercial"
                                  ? "bg-amber-50 text-amber-700"
                                  : "bg-slate-100 text-slate-600",
                          )}
                        >
                          {user.role === "manager"
                            ? "Manager / Admin"
                            : user.role === "customer_service"
                              ? "Customer Service"
                              : user.role === "commercial"
                                ? "Commercial"
                                : "Sales"}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-black",
                            user.is_active
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-rose-50 text-rose-700",
                          )}
                        >
                          {user.is_active ? "Active" : "Deleted"}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-black",
                            user.must_change_password
                              ? "bg-amber-50 text-amber-700"
                              : "bg-emerald-50 text-emerald-700",
                          )}
                        >
                          {user.must_change_password
                            ? "Temporary"
                            : "Private set"}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                          {user.is_active ? (
                            <>
                              <button
                                disabled={resettingId === user.id}
                                onClick={() => beginPasswordReset(user)}
                                className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a] hover:bg-[#f3f6fb] disabled:opacity-50"
                              >
                                <KeyRound className="h-4 w-4" />
                                {resettingId === user.id
                                  ? "Resetting..."
                                  : "Reset Password"}
                              </button>
                              <button
                                disabled={deletingId === user.id}
                                onClick={() => void deleteUser(user)}
                                className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 hover:bg-rose-100 disabled:opacity-50"
                              >
                                <Trash2 className="h-4 w-4" />
                                {deletingId === user.id
                                  ? "Deleting..."
                                  : "Delete User"}
                              </button>
                            </>
                          ) : (
                            <span className="text-xs font-semibold text-slate-400">
                              Historical access record
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {loading && !users.length ? (
            <div className="p-6 text-sm font-semibold text-slate-500">
              Loading users...
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ExecutiveReport({
  reportData,
}: {
  reportData: {
    quotes: Array<{ lifecycle: string }>;
    byChannel: Array<{
      name: string;
      quotes: number;
      sold: number;
      efficiency: number;
      conversion: number;
    }>;
    byAgent: Array<{
      agent: string;
      quotes: number;
      sold: number;
      efficiency: number;
      conversion: number;
    }>;
    notSoldReasons: Array<{ name: string; count: number }>;
    notSoldRows: Array<{
      id: string;
      customer: string;
      dealer: string;
      agent: string;
      finalizedAt?: string;
      notSoldReason?: string;
    }>;
  };
}) {
  const maxChannel = Math.max(1, ...reportData.byChannel.map((row) => row.quotes));
  const recentNotSold = reportData.notSoldRows.slice(0, 5);
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Quote Mix</p>
        <h3 className="mt-1 text-xl font-black">Volume by channel</h3>
        <div className="mt-5 space-y-4">
          {reportData.byChannel.slice(0, 6).map((row) => (
            <div key={row.name}>
              <div className="flex items-center justify-between text-sm"><span className="font-black text-slate-700">{row.name}</span><span className="font-black">{row.quotes}</span></div>
              <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#4d6aa8]" style={{ width: `${(row.quotes / maxChannel) * 100}%` }} /></div>
            </div>
          ))}
        </div>
      </section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Lost Quotes</p>
        <h3 className="mt-1 text-xl font-black">Most recent Not Sold decisions</h3>
        <div className="mt-5 space-y-3">
          {recentNotSold.length ? recentNotSold.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-4 rounded-2xl bg-rose-50 p-4">
              <div className="min-w-0"><p className="truncate font-black text-slate-900">{item.customer}</p><p className="mt-1 truncate text-xs font-semibold text-slate-500">{item.agent} · {item.dealer}</p><p className="mt-1 truncate text-xs font-black text-rose-700">{item.notSoldReason || 'Reason not recorded'}</p></div>
              <span className="shrink-0 text-xs font-bold text-slate-500">{item.finalizedAt ? formatDate(item.finalizedAt) : '—'}</span>
            </div>
          )) : <EmptyState title="No Not Sold decisions" note="Lost quotes will appear here with their reasons and documentation." />}
        </div>
      </section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm xl:col-span-2">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Lost Opportunity Analysis</p>
        <h3 className="mt-1 text-xl font-black">Top Not Sold reasons</h3>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {reportData.notSoldReasons.length ? reportData.notSoldReasons.slice(0, 5).map((row) => (
            <div key={row.name} className="rounded-2xl bg-rose-50 p-4"><p className="text-2xl font-black text-rose-700">{row.count}</p><p className="mt-1 text-xs font-bold text-rose-900">{row.name}</p></div>
          )) : <div className="sm:col-span-2 xl:col-span-5"><EmptyState title="No Not Sold decisions" note="Reasons will appear here once agents close lost quotes." /></div>}
        </div>
      </section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm xl:col-span-2">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Top Agents</p>
        <h3 className="mt-1 text-xl font-black">Quote volume and conversion</h3>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {reportData.byAgent.slice(0, 3).map((row, index) => (
            <div key={row.agent} className="rounded-2xl border border-slate-200 p-4">
              <span className="text-xs font-black text-slate-400">#{index + 1}</span><p className="mt-1 text-lg font-black">{row.agent}</p>
              <div className="mt-4 grid grid-cols-4 gap-2 text-center"><div><p className="font-black">{row.quotes}</p><p className="text-[10px] font-bold text-slate-400">Quotes</p></div><div><p className="font-black text-emerald-700">{row.sold}</p><p className="text-[10px] font-bold text-slate-400">Sold</p></div><div><p className="font-black text-cyan-700">{row.efficiency.toFixed(0)}%</p><p className="text-[10px] font-bold text-slate-400">Eff.</p></div><div><p className="font-black text-blue-700">{row.conversion.toFixed(0)}%</p><p className="text-[10px] font-bold text-slate-400">Conv.</p></div></div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AgentOperationsReport({
  rows,
}: {
  rows: Array<{
    agent: string;
    quotes: number;
    whatsapp: number;
    ringcentral: number;
    manual: number;
    workload: number;
    updates: number;
    passes: number;
    sold: number;
    notSold: number;
    finalized: number;
    pending: number;
    efficiency: number;
    conversion: number;
  }>;
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Agent Distribution
        </p>
        <h3 className="mt-1 text-xl font-black">
          Sales and operational activity
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          Efficiency = final Sold/Not Sold decisions ÷ all quotes. Pending
          Pricing is not counted as completed.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">WA</th>
              <th className="px-5 py-3">RC</th>
              <th className="px-5 py-3">Manual</th>
              <th className="px-5 py-3">Workload</th>
              <th className="px-5 py-3">Payments</th>
              <th className="px-5 py-3">Passes</th>
              <th className="px-5 py-3">Finalized</th>
              <th className="px-5 py-3">Sold</th>
              <th className="px-5 py-3">Pending</th>
              <th className="px-5 py-3">Efficiency</th>
              <th className="px-5 py-3">Conversion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.agent}>
                <td className="px-5 py-4 font-black">{row.agent}</td>
                <td className="px-5 py-4 font-black text-emerald-700">
                  {row.whatsapp}
                </td>
                <td className="px-5 py-4 font-black text-blue-700">
                  {row.ringcentral}
                </td>
                <td className="px-5 py-4 font-black">{row.manual}</td>
                <td className="px-5 py-4 font-black text-violet-700">
                  {row.workload}
                </td>
                <td className="px-5 py-4 font-black text-amber-700">
                  {row.updates}
                </td>
                <td className="px-5 py-4 font-black text-rose-700">
                  {row.passes}
                </td>
                <td className="px-5 py-4 font-black text-cyan-700">
                  {row.finalized}
                </td>
                <td className="px-5 py-4 font-black text-emerald-700">
                  {row.sold}
                </td>
                <td className="px-5 py-4 font-black text-blue-700">
                  {row.pending}
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">
                    {row.efficiency.toFixed(1)}%
                  </span>
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs font-black text-[#223f7a]">
                    {row.conversion.toFixed(1)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function QuoteTimingReport({
  rows,
  details,
}: {
  rows: Array<{
    agent: string;
    quotes: number;
    accepted: number;
    avgAccept: number | null;
    avgPrice: number | null;
    avgFinal: number | null;
    avgPriceDecision: number | null;
    avgTotalCycle: number | null;
  }>;
  details: Array<{
    id: string;
    customer: string;
    dealer: string;
    agent: string;
    lifecycle: string;
    createdAt: string;
    assignedAt: string;
    acceptedAt?: string;
    priceSentAt?: string;
    finalizedAt?: string;
    timeToAccept: number | null;
    timeToPrice: number | null;
    timeToFinal: number | null;
    priceToDecision: number | null;
    totalCycle: number | null;
    notSoldReason?: string;
  }>;
}) {
  const finalizedDetails = details
    .filter((item) => item.finalizedAt)
    .sort(
      (a, b) =>
        new Date(b.finalizedAt || 0).getTime() -
        new Date(a.finalizedAt || 0).getTime(),
    );
  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
            Quote Cycle Timing
          </p>
          <h3 className="mt-1 text-xl font-black">Average speed by agent</h3>
          <p className="mt-1 text-sm text-slate-500">
            Measures assignment → quote taken, quote taken → price sent, and
            quote taken → final Sold/Not Sold decision.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-3">Agent</th>
                <th className="px-5 py-3">Quotes</th>
                <th className="px-5 py-3">Taken</th>
                <th className="px-5 py-3">Assign → Take</th>
                <th className="px-5 py-3">Take → Price</th>
                <th className="px-5 py-3">Take → Final</th>
                <th className="px-5 py-3">Price → Decision</th>
                <th className="px-5 py-3">Total Cycle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.agent}>
                  <td className="px-5 py-4 font-black">{row.agent}</td>
                  <td className="px-5 py-4 font-black">{row.quotes}</td>
                  <td className="px-5 py-4 font-black text-emerald-700">
                    {row.accepted}
                  </td>
                  <td className="px-5 py-4 font-black text-amber-700">
                    {formatDuration(row.avgAccept)}
                  </td>
                  <td className="px-5 py-4 font-black text-blue-700">
                    {formatDuration(row.avgPrice)}
                  </td>
                  <td className="px-5 py-4 font-black text-cyan-700">
                    {formatDuration(row.avgFinal)}
                  </td>
                  <td className="px-5 py-4 font-black text-violet-700">
                    {formatDuration(row.avgPriceDecision)}
                  </td>
                  <td className="px-5 py-4 font-black text-[#223f7a]">
                    {formatDuration(row.avgTotalCycle)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
            Detailed Timeline
          </p>
          <h3 className="mt-1 text-xl font-black">Recent finalized quotes</h3>
          <p className="mt-1 text-sm text-slate-500">
            Every lifecycle timestamp is preserved for audit and coaching.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Agent</th>
                <th className="px-5 py-3">Assigned</th>
                <th className="px-5 py-3">Taken by Agent</th>
                <th className="px-5 py-3">Price Sent</th>
                <th className="px-5 py-3">Final Decision</th>
                <th className="px-5 py-3">Outcome</th>
                <th className="px-5 py-3">Cycle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {finalizedDetails.slice(0, 100).map((item) => (
                <tr key={item.id}>
                  <td className="px-5 py-4">
                    <p className="font-black">{item.customer}</p>
                    <p className="mt-1 text-xs text-slate-400">{item.dealer}</p>
                  </td>
                  <td className="px-5 py-4 font-bold">{item.agent}</td>
                  <td className="px-5 py-4 text-xs text-slate-600">
                    {formatDateTime(item.assignedAt)}
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-600">
                    {item.acceptedAt ? formatDateTime(item.acceptedAt) : "—"}
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-600">
                    {item.priceSentAt ? formatDateTime(item.priceSentAt) : "—"}
                  </td>
                  <td className="px-5 py-4 text-xs text-slate-600">
                    {item.finalizedAt ? formatDateTime(item.finalizedAt) : "—"}
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-black",
                        item.lifecycle === "Sold"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-rose-50 text-rose-700",
                      )}
                    >
                      {item.lifecycle}
                    </span>
                    {item.notSoldReason ? (
                      <p className="mt-2 max-w-48 text-[10px] font-semibold text-slate-400">
                        {item.notSoldReason}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 font-black text-[#223f7a]">
                    {formatDuration(item.totalCycle)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RankedReportTable({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    name: string;
    quotes: number;
    sold: number;
    notSold: number;
    finalized: number;
    pending: number;
    efficiency: number;
    conversion: number;
  }>;
}) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Comparative Report
        </p>
        <h3 className="mt-1 text-xl font-black">{title}</h3>
        <p className="mt-1 text-sm text-slate-500">
          Efficiency counts only Sold and Not Sold as completed; Price Sent
          remains pending.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-3">Rank</th>
              <th className="px-5 py-3">Name</th>
              <th className="px-5 py-3">Quotes</th>
              <th className="px-5 py-3">Finalized</th>
              <th className="px-5 py-3">Sold</th>
              <th className="px-5 py-3">Not Sold</th>
              <th className="px-5 py-3">Price Sent</th>
              <th className="px-5 py-3">Efficiency</th>
              <th className="px-5 py-3">Conversion</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={row.name}>
                <td className="px-5 py-4 font-black text-slate-400">
                  #{index + 1}
                </td>
                <td className="px-5 py-4 font-black">{row.name}</td>
                <td className="px-5 py-4 font-black">{row.quotes}</td>
                <td className="px-5 py-4 font-black text-cyan-700">
                  {row.finalized}
                </td>
                <td className="px-5 py-4 font-black text-emerald-700">
                  {row.sold}
                </td>
                <td className="px-5 py-4 font-black text-rose-700">
                  {row.notSold}
                </td>
                <td className="px-5 py-4 font-black text-blue-700">
                  {row.pending}
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">
                    {row.efficiency.toFixed(1)}%
                  </span>
                </td>
                <td className="px-5 py-4">
                  <span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs font-black text-[#223f7a]">
                    {row.conversion.toFixed(1)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TakenQuotesReport({
  rows,
  byAgent,
  summary,
}: {
  rows: Array<
    QuoteTakeEvent & {
      customer: string;
      source: string;
      quoteAgent: string;
      quoteStatus: string;
      workType: WorkType;
      receivedThrough: string;
    }
  >;
  byAgent: Array<{
    agent: string;
    username: string;
    total: number;
    whatsapp: number;
    ringcentral: number;
    skippedAgents: number;
    avgElapsedSeconds: number;
  }>;
  summary: {
    total: number;
    whatsapp: number;
    ringcentral: number;
    skippedAgents: number;
    avgElapsedSeconds: number;
  };
}) {
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          label="Taken Quotes"
          value={summary.total}
          note="Overdue quotes taken"
          icon={<Zap className="h-5 w-5 text-amber-700" />}
          tone="bg-amber-50"
        />
        <SummaryCard
          label="Avg Elapsed"
          value={formatElapsedSeconds(summary.avgElapsedSeconds)}
          note="Received → Take"
          icon={<Clock3 className="h-5 w-5 text-blue-700" />}
          tone="bg-blue-50"
        />
        <SummaryCard
          label="Missed Turns"
          value={summary.skippedAgents}
          note="Current-agent timers expired"
          icon={<SkipForward className="h-5 w-5 text-rose-700" />}
          tone="bg-rose-50"
        />
        <SummaryCard
          label="WhatsApp"
          value={summary.whatsapp}
          note="Taken from WA queue"
          icon={<MessageCircleMore className="h-5 w-5 text-emerald-700" />}
          tone="bg-emerald-50"
        />
        <SummaryCard
          label="RingCentral"
          value={summary.ringcentral}
          note="Taken from RC queue"
          icon={<PhoneCall className="h-5 w-5 text-blue-700" />}
          tone="bg-blue-50"
        />
      </div>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-amber-700">
            Taken Performance
          </p>
          <h3 className="mt-1 text-xl font-black">Who takes overdue quotes</h3>
          <p className="mt-1 text-sm text-slate-500">
            Counts only successful Take actions. Lower elapsed time means the
            agent acted sooner after becoming eligible.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-amber-50/60 text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-3">Agent</th>
                <th className="px-5 py-3">Taken</th>
                <th className="px-5 py-3">WhatsApp</th>
                <th className="px-5 py-3">RingCentral</th>
                <th className="px-5 py-3">Avg Elapsed</th>
                <th className="px-5 py-3">Missed Turns</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byAgent.map((row) => (
                <tr key={row.agent}>
                  <td className="px-5 py-4">
                    <p className="font-black">{row.agent}</p>
                    {row.username ? (
                      <p className="mt-1 text-xs font-bold text-slate-400">
                        @{row.username}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-5 py-4 font-black text-amber-700">
                    {row.total}
                  </td>
                  <td className="px-5 py-4 font-black text-emerald-700">
                    {row.whatsapp}
                  </td>
                  <td className="px-5 py-4 font-black text-blue-700">
                    {row.ringcentral}
                  </td>
                  <td className="px-5 py-4 font-black">
                    {formatElapsedSeconds(row.avgElapsedSeconds)}
                  </td>
                  <td className="px-5 py-4 font-black text-rose-700">
                    {row.skippedAgents}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!byAgent.length ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">
            No successful Take actions in this date range.
          </div>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
            Taken Quote Detail
          </p>
          <h3 className="mt-1 text-xl font-black">
            Every successful Take action
          </h3>
          <p className="mt-1 text-sm text-slate-500">
            Shows the exact quote, taker, missed current agent, queue, and
            elapsed time.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-5 py-3">Taken</th>
                <th className="px-5 py-3">Customer</th>
                <th className="px-5 py-3">Queue</th>
                <th className="px-5 py-3">Taken By</th>
                <th className="px-5 py-3">Missed Agent</th>
                <th className="px-5 py-3">Elapsed</th>
                <th className="px-5 py-3">Quote Agent</th>
                <th className="px-5 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-5 py-4">
                    <p className="text-xs font-bold text-slate-600">
                      {formatDateTime(row.takenAt)}
                    </p>
                    <p className="mt-1 text-[10px] font-semibold text-slate-400">
                      Received {formatDateTime(row.receivedAt)}
                    </p>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-black">{row.customer}</p>
                    <p className="mt-1 text-xs text-slate-400">{row.source}</p>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-black",
                        row.rotation === "whatsapp"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-blue-50 text-blue-700",
                      )}
                    >
                      {row.rotation === "whatsapp" ? "WhatsApp" : "RingCentral"}
                    </span>
                  </td>
                  <td className="px-5 py-4">
                    <p className="font-black">{row.takerName}</p>
                    <p className="mt-1 text-xs font-bold text-slate-400">
                      @{row.takerUsername}
                    </p>
                  </td>
                  <td className="px-5 py-4 text-xs font-semibold text-slate-600">
                    {row.skippedAgents.length
                      ? row.skippedAgents
                          .map((agent) => `@${agent.username}`)
                          .join(", ")
                      : "None"}
                  </td>
                  <td className="px-5 py-4 font-black text-amber-700">
                    {formatElapsedSeconds(row.elapsedSeconds)}
                  </td>
                  <td className="px-5 py-4 font-bold text-slate-700">
                    {row.quoteAgent}
                  </td>
                  <td className="px-5 py-4">
                    <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-700">
                      {row.quoteStatus}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rows.length ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">
            No taken quotes in this date range.
          </div>
        ) : null}
      </section>
    </div>
  );
}

function FollowUpReport({
  pendingPricing,
}: {
  pendingPricing: PendingPricingItem[];
}) {
  const buckets = [
    {
      label: "Sent today",
      count: pendingPricing.filter((item) => daysSince(item.priceSentAt) === 0)
        .length,
      tone: "bg-blue-50 text-blue-700",
    },
    {
      label: "1 day waiting",
      count: pendingPricing.filter((item) => daysSince(item.priceSentAt) === 1)
        .length,
      tone: "bg-amber-50 text-amber-700",
    },
    {
      label: "2+ days waiting",
      count: pendingPricing.filter((item) => daysSince(item.priceSentAt) >= 2)
        .length,
      tone: "bg-rose-50 text-rose-700",
    },
  ];
  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
        Aging Analysis
      </p>
      <h3 className="mt-1 text-xl font-black">
        Pending pricing follow-up priority
      </h3>
      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        {buckets.map((bucket) => (
          <div
            key={bucket.label}
            className={cn("rounded-2xl p-5", bucket.tone)}
          >
            <p className="text-3xl font-black">{bucket.count}</p>
            <p className="mt-1 text-sm font-black">{bucket.label}</p>
          </div>
        ))}
      </div>
      <div className="mt-6 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="py-3">Customer</th>
              <th className="py-3">Source</th>
              <th className="py-3">Agent</th>
              <th className="py-3">Sent</th>
              <th className="py-3">Age</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...pendingPricing]
              .sort(
                (a, b) =>
                  new Date(a.priceSentAt).getTime() -
                  new Date(b.priceSentAt).getTime(),
              )
              .map((item) => (
                <tr key={item.id}>
                  <td className="py-4 font-black">{item.customer}</td>
                  <td className="py-4 text-slate-600">{item.dealer}</td>
                  <td className="py-4 font-bold">{item.assignedAgent}</td>
                  <td className="py-4 text-slate-600">
                    {formatDateTime(item.priceSentAt)}
                  </td>
                  <td className="py-4 font-black text-amber-700">
                    {daysSince(item.priceSentAt)} days
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ServiceActivityReport({ items }: { items: WorkItem[] }) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-6">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
          Non-Quote Activity
        </p>
        <h3 className="mt-1 text-xl font-black">
          Updates, activations, and changes
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="px-5 py-3">Date</th>
              <th className="px-5 py-3">Customer</th>
              <th className="px-5 py-3">Type</th>
              <th className="px-5 py-3">Agent</th>
              <th className="px-5 py-3">Method</th>
              <th className="px-5 py-3">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((item) => (
              <tr key={item.id}>
                <td className="px-5 py-4 text-xs text-slate-500">
                  {formatDateTime(item.createdAt)}
                </td>
                <td className="px-5 py-4">
                  <p className="font-black">{item.customer}</p>
                  <p className="mt-1 text-xs text-slate-400">{item.dealer}</p>
                </td>
                <td className="px-5 py-4 font-bold">
                  {workTypeLabels[item.workType]}
                </td>
                <td className="px-5 py-4 font-bold">{item.assignedAgent}</td>
                <td className="px-5 py-4">
                  <MethodBadge method={item.assignmentMethod} />
                </td>
                <td className="px-5 py-4 capitalize text-slate-600">
                  {item.status}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type ExceptionRow = {
  severity: "warning" | "critical";
  area: string;
  issue: string;
  owner: string;
  age: string;
};
type DailyRow = {
  date: string;
  quotes: number;
  sold: number;
  notSold: number;
  pending: number;
  taken: number;
  passes: number;
  service: number;
};
type AgentScoreRow = {
  agent: string;
  score: number;
  quotes: number;
  sold: number;
  conversion: number;
  efficiency: number;
  avgPrice: number | null;
  docCoverage: number;
  taken: number;
  workload: number;
  passes: number;
};
type WorkloadRow = {
  agent: string;
  status: AvailabilityStatus;
  activeQuotes: number;
  activations: number;
  changes: number;
  payments: number;
  pending: number;
  unaccepted: number;
  total: number;
};
type QueueHealthRow = {
  rotation: string;
  current: string;
  eligible: number;
  available: number;
  claims: number;
  passes: number;
  taken: number;
  health: string;
};
type MissedTurnRow = {
  agent: string;
  missed: number;
  whatsapp: number;
  ringcentral: number;
  sold: number;
  pending: number;
};
type PassBehaviorRow = {
  agent: string;
  total: number;
  whatsapp: number;
  ringcentral: number;
  workload: number;
  reasons: string[];
};
type DocumentationRow = {
  agent: string;
  notes: number;
  quotes: number;
  withNotes: number;
  coverage: number;
};
type SourceRiskRow = {
  name: string;
  quotes: number;
  sold: number;
  notSold: number;
  pending: number;
  finalized: number;
  efficiency: number;
  conversion: number;
  taken: number;
  notes: number;
  category: string;
};

type SourceSalespersonRow = {
  source: string;
  salesperson: string;
  quotes: number;
  sold: number;
  notSold: number;
  pending: number;
  finalized: number;
  efficiency: number;
  conversion: number;
  taken: number;
  notes: number;
  category: string;
};
type IntegrityIssue = {
  severity: "warning" | "critical";
  issue: string;
  detail: string;
};
type SystemCheck = { check: string; status: boolean; detail: string };

type ManagerActivityRow = QuoteActivity;

function ReportShell({
  eyebrow,
  title,
  note,
  children,
}: {
  eyebrow: string;
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">
        {eyebrow}
      </p>
      <h3 className="mt-1 text-xl font-black">{title}</h3>
      <p className="mt-1 text-sm text-slate-500">{note}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function EmptyReport({ title, note }: { title: string; note: string }) {
  return <EmptyState title={title} note={note} />;
}

function NotSoldReport({
  rows,
  onExport,
}: {
  rows: Array<{
    id: string;
    finalizedAt?: string;
    createdAt: string;
    priceSentAt?: string;
    customer: string;
    dealer: string;
    salesperson: string;
    agent: string;
    originalOwner: string;
    workType: "new_quote" | "requote";
    channel: string;
    notSoldReason?: string;
    timeToPrice: number | null;
    priceToDecision: number | null;
    totalCycle: number | null;
    noteCount: number;
    latestNote: string;
    latestNoteBy: string;
    latestNoteAt?: string;
  }>;
  onExport: () => void;
}) {
  const topReason = Array.from(
    rows.reduce((map, row) => {
      const reason = row.notSoldReason || "Unknown";
      map.set(reason, (map.get(reason) || 0) + 1);
      return map;
    }, new Map<string, number>()),
  ).sort((left, right) => right[1] - left[1])[0];
  const noResponse = rows.filter((row) => row.notSoldReason === "No Response").length;
  const decisionTimes = rows.map((row) => row.priceToDecision).filter((value): value is number => value !== null);
  const averageDecision = decisionTimes.length ? decisionTimes.reduce((sum, value) => sum + value, 0) / decisionTimes.length : null;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard label="Not Sold" value={rows.length} note="Selected date range" icon={<XCircle className="h-5 w-5 text-rose-700" />} tone="bg-rose-50" />
        <SummaryCard label="Top Reason" value={topReason?.[0] || "—"} note={topReason ? `${topReason[1]} quotes` : "No decisions"} icon={<AlertTriangle className="h-5 w-5 text-amber-700" />} tone="bg-amber-50" />
        <SummaryCard label="No Response" value={noResponse} note="Follow-up opportunity" icon={<PhoneCall className="h-5 w-5 text-blue-700" />} tone="bg-blue-50" />
        <SummaryCard label="Avg Price to Decision" value={formatDuration(averageDecision)} note="After pricing was sent" icon={<Clock3 className="h-5 w-5 text-violet-700" />} tone="bg-violet-50" />
      </div>
      <ReportShell eyebrow="Not Sold Report" title="Lost quote details" note="Customer, source, salesperson, agent, timing, reason, and documentation for every Not Sold decision.">
        <div className="mb-4 flex justify-end"><button type="button" onClick={onExport} disabled={!rows.length} className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-4 py-2.5 text-xs font-black text-white disabled:opacity-50"><Download className="h-4 w-4" />Export Not Sold CSV</button></div>
        {rows.length ? <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="py-3 pr-5">Decision</th><th className="py-3 pr-5">Customer</th><th className="py-3 pr-5">Source / Salesperson</th><th className="py-3 pr-5">Agent / Input</th><th className="py-3 pr-5">Reason</th><th className="py-3 pr-5">Timing</th><th className="py-3">Documentation</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.id}><td className="py-4 pr-5"><p className="font-black">{row.finalizedAt ? formatDate(row.finalizedAt) : '—'}</p><p className="mt-1 text-xs font-semibold text-slate-400">Created {formatDate(row.createdAt)}</p></td><td className="py-4 pr-5"><p className="font-black text-slate-900">{row.customer}</p><p className="mt-1 text-xs font-semibold text-slate-500">{workTypeLabels[row.workType]}</p></td><td className="py-4 pr-5"><p className="font-bold">{row.dealer}</p><p className="mt-1 text-xs text-slate-500">{row.salesperson}</p></td><td className="py-4 pr-5"><p className="font-bold">{row.agent}</p><p className="mt-1 text-xs text-slate-500">{row.channel}</p></td><td className="py-4 pr-5"><span className="rounded-full bg-rose-50 px-2.5 py-1 text-xs font-black text-rose-700">{row.notSoldReason || 'Unknown'}</span></td><td className="py-4 pr-5 text-xs font-semibold text-slate-600"><p>Take → Price: {formatDuration(row.timeToPrice)}</p><p className="mt-1">Price → Decision: {formatDuration(row.priceToDecision)}</p><p className="mt-1">Total: {formatDuration(row.totalCycle)}</p></td><td className="max-w-sm py-4"><p className="font-black">{row.noteCount} note{row.noteCount === 1 ? '' : 's'}</p><p className="mt-1 line-clamp-2 text-xs font-semibold text-slate-500">{row.latestNote || 'No quote note recorded'}</p>{row.latestNoteBy ? <p className="mt-1 text-[11px] font-bold text-slate-400">{row.latestNoteBy}{row.latestNoteAt ? ` · ${formatDateTime(row.latestNoteAt)}` : ''}</p> : null}</td></tr>)}</tbody></table></div> : <EmptyReport title="No Not Sold quotes" note="No quotes were marked Not Sold in the selected date range." />}
      </ReportShell>
    </div>
  );
}

function ExceptionCenterReport({ items }: { items: ExceptionRow[] }) {
  const critical = items.filter((item) => item.severity === "critical").length;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Exceptions"
          value={items.length}
          note="Current red flags"
          icon={<AlertTriangle className="h-5 w-5 text-rose-700" />}
          tone="bg-rose-50"
        />
        <SummaryCard
          label="Critical"
          value={critical}
          note="Needs manager action"
          icon={<XCircle className="h-5 w-5 text-rose-700" />}
          tone="bg-rose-50"
        />
        <SummaryCard
          label="Warnings"
          value={items.length - critical}
          note="Monitor closely"
          icon={<Clock3 className="h-5 w-5 text-amber-700" />}
          tone="bg-amber-50"
        />
      </div>
      <ReportShell
        eyebrow="Control Room"
        title="Needs Attention"
        note="Assignments, stale follow-ups, unavailable agents with work, and other operating exceptions."
      >
        {items.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3">Level</th>
                  <th className="py-3">Area</th>
                  <th className="py-3">Issue</th>
                  <th className="py-3">Owner</th>
                  <th className="py-3">Age / Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item, index) => (
                  <tr key={`${item.issue}-${index}`}>
                    <td className="py-4">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-black",
                          item.severity === "critical"
                            ? "bg-rose-50 text-rose-700"
                            : "bg-amber-50 text-amber-700",
                        )}
                      >
                        {item.severity}
                      </span>
                    </td>
                    <td className="py-4 font-bold">{item.area}</td>
                    <td className="py-4 font-black">{item.issue}</td>
                    <td className="py-4 text-slate-600">{item.owner}</td>
                    <td className="py-4 font-bold text-slate-500">
                      {item.age}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyReport
            title="No exceptions found"
            note="The selected date range and current workload look clean."
          />
        )}
      </ReportShell>
    </div>
  );
}

function FunnelReport({
  quotes,
  sold,
  notSold,
  pending,
}: {
  quotes: Array<{ lifecycle: string }>;
  sold: number;
  notSold: number;
  pending: number;
}) {
  const active = quotes.filter((quote) => quote.lifecycle === "Active").length;
  const finalized = sold + notSold;
  const total = Math.max(1, quotes.length);
  const bars = [
    { label: "Active", value: active, tone: "bg-slate-400" },
    { label: "Price Sent", value: pending, tone: "bg-blue-500" },
    { label: "Sold", value: sold, tone: "bg-emerald-500" },
    { label: "Not Sold", value: notSold, tone: "bg-rose-500" },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-4">
        <SummaryCard
          label="Quote Volume"
          value={quotes.length}
          note="Selected range"
          icon={<ClipboardList className="h-5 w-5 text-[#223f7a]" />}
          tone="bg-[#eef3fb]"
        />
        <SummaryCard
          label="Finalized"
          value={finalized}
          note="Sold + Not Sold"
          icon={<CheckCircle2 className="h-5 w-5 text-cyan-700" />}
          tone="bg-cyan-50"
        />
        <SummaryCard
          label="Pending"
          value={pending}
          note="Needs follow-up"
          icon={<Clock3 className="h-5 w-5 text-amber-700" />}
          tone="bg-amber-50"
        />
        <SummaryCard
          label="Conversion"
          value={`${finalized ? ((sold / finalized) * 100).toFixed(1) : "0.0"}%`}
          note="Sold ÷ Finalized"
          icon={<TrendingUp className="h-5 w-5 text-emerald-700" />}
          tone="bg-emerald-50"
        />
      </div>
      <ReportShell
        eyebrow="Sales Funnel"
        title="Quote lifecycle breakdown"
        note="Shows where quotes are sitting in the process."
      >
        <div className="space-y-5">
          {bars.map((bar) => (
            <div key={bar.label}>
              <div className="flex justify-between text-sm">
                <span className="font-black">{bar.label}</span>
                <span className="font-black">{bar.value}</span>
              </div>
              <div className="mt-2 h-4 overflow-hidden rounded-full bg-slate-100">
                <div
                  className={cn("h-full rounded-full", bar.tone)}
                  style={{ width: `${(bar.value / total) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </ReportShell>
    </div>
  );
}

function DailyOperationsReport({ rows }: { rows: DailyRow[] }) {
  return (
    <ReportShell
      eyebrow="Daily Operations"
      title="Day-by-day performance"
      note="Compares volume, sales, service activity, passes, and Taken activity by day."
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3">Date</th>
                <th className="py-3">Quotes</th>
                <th className="py-3">Sold</th>
                <th className="py-3">Not Sold</th>
                <th className="py-3">Pending</th>
                <th className="py-3">Taken</th>
                <th className="py-3">Passes</th>
                <th className="py-3">Service</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.date}>
                  <td className="py-4 font-black">
                    {formatDate(`${row.date}T12:00:00`)}
                  </td>
                  <td className="py-4 font-black">{row.quotes}</td>
                  <td className="py-4 font-black text-emerald-700">
                    {row.sold}
                  </td>
                  <td className="py-4 font-black text-rose-700">
                    {row.notSold}
                  </td>
                  <td className="py-4 font-black text-blue-700">
                    {row.pending}
                  </td>
                  <td className="py-4 font-black text-amber-700">
                    {row.taken}
                  </td>
                  <td className="py-4 font-black text-rose-700">
                    {row.passes}
                  </td>
                  <td className="py-4 font-black text-violet-700">
                    {row.service}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReport
          title="No daily data"
          note="Activity will appear as the team works in the selected date range."
        />
      )}
    </ReportShell>
  );
}

function AgentScorecardReport({ rows }: { rows: AgentScoreRow[] }) {
  return (
    <ReportShell
      eyebrow="Agent 360"
      title="Balanced performance scorecard"
      note="Combines sales, completion, speed, documentation, workload, and quote rescue behavior."
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="py-3">Rank</th>
              <th className="py-3">Agent</th>
              <th className="py-3">Score</th>
              <th className="py-3">Quotes</th>
              <th className="py-3">Sold</th>
              <th className="py-3">Conversion</th>
              <th className="py-3">Efficiency</th>
              <th className="py-3">Avg Price</th>
              <th className="py-3">Notes Coverage</th>
              <th className="py-3">Taken</th>
              <th className="py-3">Open Load</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row, index) => (
              <tr key={row.agent}>
                <td className="py-4 font-black text-slate-400">#{index + 1}</td>
                <td className="py-4 font-black">{row.agent}</td>
                <td className="py-4">
                  <span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs font-black text-[#223f7a]">
                    {row.score}/100
                  </span>
                </td>
                <td className="py-4 font-black">{row.quotes}</td>
                <td className="py-4 font-black text-emerald-700">{row.sold}</td>
                <td className="py-4 font-black">
                  {row.conversion.toFixed(1)}%
                </td>
                <td className="py-4 font-black">
                  {row.efficiency.toFixed(1)}%
                </td>
                <td className="py-4 font-black">
                  {formatDuration(row.avgPrice)}
                </td>
                <td className="py-4 font-black">
                  {row.docCoverage.toFixed(1)}%
                </td>
                <td className="py-4 font-black text-amber-700">{row.taken}</td>
                <td className="py-4 font-black text-violet-700">
                  {row.workload}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportShell>
  );
}

function WorkloadCapacityReport({ rows }: { rows: WorkloadRow[] }) {
  return (
    <ReportShell
      eyebrow="Workload Capacity"
      title="Who is carrying work right now"
      note="Combines active quotes, service tasks, pending pricing, and unaccepted assignments."
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="py-3">Agent</th>
              <th className="py-3">Status</th>
              <th className="py-3">Active Quotes</th>
              <th className="py-3">Pending</th>
              <th className="py-3">Activations</th>
              <th className="py-3">Changes</th>
              <th className="py-3">Payments</th>
              <th className="py-3">Unaccepted</th>
              <th className="py-3">Total Load</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.agent}>
                <td className="py-4 font-black">{row.agent}</td>
                <td className="py-4 capitalize">
                  <span className="inline-flex items-center gap-2 font-black">
                    <StatusDot status={row.status} />
                    {row.status === "break" ? "Break / Lunch" : row.status}
                  </span>
                </td>
                <td className="py-4 font-black">{row.activeQuotes}</td>
                <td className="py-4 font-black text-blue-700">{row.pending}</td>
                <td className="py-4 font-black text-emerald-700">
                  {row.activations}
                </td>
                <td className="py-4 font-black text-violet-700">
                  {row.changes}
                </td>
                <td className="py-4 font-black text-amber-700">
                  {row.payments}
                </td>
                <td className="py-4 font-black text-rose-700">
                  {row.unaccepted}
                </td>
                <td className="py-4 font-black text-[#223f7a]">{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportShell>
  );
}

function QueueHealthReport({
  rows,
  settings,
  customerServiceUsers,
  onUpdate,
}: {
  rows: QueueHealthRow[];
  settings: WorkDeskSettings;
  customerServiceUsers: CustomerServiceUser[];
  onUpdate: (enabled: boolean, profileId: string | null) => Promise<void>;
}) {
  const [selectedProfileId, setSelectedProfileId] = useState(
    settings.customerServiceProfileId || "",
  );
  const [saving, setSaving] = useState(false);

  async function save(enabled: boolean) {
    if (enabled && !selectedProfileId) return;
    setSaving(true);
    try {
      await onUpdate(enabled, selectedProfileId || null);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-[28px] border border-cyan-200 bg-gradient-to-br from-white to-cyan-50 p-6 shadow-sm">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
          <div className="max-w-3xl">
            <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-cyan-700">
              <UsersRound className="h-4 w-4" /> Customer Service Overflow
            </div>
            <h3 className="mt-2 text-xl font-black text-slate-950">
              Let agents hand off Activations and Changes when workload builds
              up
            </h3>
            <p className="mt-2 text-sm font-semibold leading-6 text-slate-600">
              The agent must first take the Additional Workload turn. A Customer
              Service handoff then records a workload pass, requires a reason
              and detailed note, and does not move the queue a second time.
            </p>
          </div>
          <span
            className={cn(
              "w-fit rounded-full px-3 py-1.5 text-xs font-black",
              settings.customerServiceOverflowEnabled
                ? "bg-emerald-100 text-emerald-800"
                : "bg-slate-200 text-slate-600",
            )}
          >
            {settings.customerServiceOverflowEnabled ? "Enabled" : "Disabled"}
          </span>
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-[1fr_auto_auto]">
          <select
            value={selectedProfileId}
            onChange={(event) => setSelectedProfileId(event.target.value)}
            className="field"
            aria-label="Customer Service assignee"
          >
            <option value="">Select Customer Service assignee</option>
            {customerServiceUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · @{user.username} · {user.activeCount} open
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={saving || !selectedProfileId}
            onClick={() => void save(true)}
            className="rounded-xl bg-cyan-700 px-5 py-3 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving
              ? "Saving..."
              : settings.customerServiceOverflowEnabled
                ? "Save Assignee"
                : "Enable Overflow"}
          </button>
          <button
            type="button"
            disabled={saving || !settings.customerServiceOverflowEnabled}
            onClick={() => void save(false)}
            className="rounded-xl border border-slate-200 bg-white px-5 py-3 text-sm font-black text-slate-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Disable
          </button>
        </div>
        {settings.customerServiceProfileName ? (
          <p className="mt-3 text-xs font-bold text-cyan-800">
            Current assignee: {settings.customerServiceProfileName}
            {settings.customerServiceProfileUsername
              ? ` · @${settings.customerServiceProfileUsername}`
              : ""}
          </p>
        ) : null}
        <p className="mt-2 text-xs font-semibold text-slate-500">
          Only accounts created with the Customer Service role appear here.
          Customer Service users never enter the three sales rotations.
        </p>
      </section>

      <ReportShell
        eyebrow="Queue Health"
        title="Rotation health and queue behavior"
        note="Shows current owner, available coverage, claims, passes, and stolen-quote activity by queue."
      >
        <div className="grid gap-4 xl:grid-cols-3">
          {rows.map((row) => (
            <div
              key={row.rotation}
              className="rounded-2xl border border-slate-200 p-5"
            >
              <div className="flex items-center justify-between">
                <p className="font-black">{row.rotation}</p>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-black",
                    row.health === "Healthy"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-rose-50 text-rose-700",
                  )}
                >
                  {row.health}
                </span>
              </div>
              <p className="mt-4 text-sm font-bold text-slate-500">Current</p>
              <p className="text-2xl font-black text-[#223f7a]">
                {row.current}
              </p>
              <div className="mt-5 grid grid-cols-2 gap-3 text-sm">
                <p>
                  <strong>{row.eligible}</strong>
                  <br />
                  Eligible
                </p>
                <p>
                  <strong>{row.available}</strong>
                  <br />
                  Available
                </p>
                <p>
                  <strong>{row.claims}</strong>
                  <br />
                  Claims
                </p>
                <p>
                  <strong>{row.passes}</strong>
                  <br />
                  Passes
                </p>
                <p>
                  <strong>{row.taken}</strong>
                  <br />
                  Stolen
                </p>
              </div>
            </div>
          ))}
        </div>
      </ReportShell>
    </div>
  );
}

function MissedTurnsReport({ rows }: { rows: MissedTurnRow[] }) {
  return (
    <ReportShell
      eyebrow="Missed Turns"
      title="Current turns lost after the rescue timer"
      note="Shows when the current agent's single 3-minute response period expired and another eligible employee stole the quote."
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3">Missed Agent</th>
                <th className="py-3">Total</th>
                <th className="py-3">WhatsApp</th>
                <th className="py-3">RingCentral</th>
                <th className="py-3">Eventually Sold</th>
                <th className="py-3">Still Pending/Active</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.agent}>
                  <td className="py-4 font-black">{row.agent}</td>
                  <td className="py-4 font-black text-rose-700">
                    {row.missed}
                  </td>
                  <td className="py-4 font-black text-emerald-700">
                    {row.whatsapp}
                  </td>
                  <td className="py-4 font-black text-blue-700">
                    {row.ringcentral}
                  </td>
                  <td className="py-4 font-black text-emerald-700">
                    {row.sold}
                  </td>
                  <td className="py-4 font-black text-amber-700">
                    {row.pending}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReport
          title="No missed turns"
          note="No rescue timers expired and resulted in a stolen quote during this period."
        />
      )}
    </ReportShell>
  );
}

function PassBehaviorReport({ rows }: { rows: PassBehaviorRow[] }) {
  return (
    <ReportShell
      eyebrow="Pass Behavior"
      title="Turn pass activity"
      note="Shows who passed, which queues were affected, and the reasons entered."
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3">Agent</th>
                <th className="py-3">Passes</th>
                <th className="py-3">WhatsApp</th>
                <th className="py-3">RingCentral</th>
                <th className="py-3">Workload</th>
                <th className="py-3">Top Reasons</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.agent}>
                  <td className="py-4 font-black">{row.agent}</td>
                  <td className="py-4 font-black text-rose-700">{row.total}</td>
                  <td className="py-4 font-black">{row.whatsapp}</td>
                  <td className="py-4 font-black">{row.ringcentral}</td>
                  <td className="py-4 font-black">{row.workload}</td>
                  <td className="py-4 text-xs font-semibold text-slate-500">
                    {row.reasons.slice(0, 3).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReport
          title="No passes"
          note="No turns were passed in this date range."
        />
      )}
    </ReportShell>
  );
}

function DocumentationQualityReport({ rows }: { rows: DocumentationRow[] }) {
  return (
    <ReportShell
      eyebrow="Documentation Quality"
      title="Notes and quote documentation"
      note="Measures quote note coverage and note writing by employee."
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            <tr>
              <th className="py-3">Agent</th>
              <th className="py-3">Notes Written</th>
              <th className="py-3">Quotes</th>
              <th className="py-3">Quotes with Notes</th>
              <th className="py-3">Coverage</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.agent}>
                <td className="py-4 font-black">{row.agent}</td>
                <td className="py-4 font-black text-[#223f7a]">{row.notes}</td>
                <td className="py-4 font-black">{row.quotes}</td>
                <td className="py-4 font-black text-emerald-700">
                  {row.withNotes}
                </td>
                <td className="py-4">
                  <span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">
                    {row.coverage.toFixed(1)}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ReportShell>
  );
}

function SourceRiskReport({
  rows,
  salespersonRows,
}: {
  rows: SourceRiskRow[];
  salespersonRows: SourceSalespersonRow[];
}) {
  const [sourceFilter, setSourceFilter] = useState("all");
  const [salespersonFilter, setSalespersonFilter] = useState("all");

  const sourceOptions = useMemo(
    () =>
      Array.from(new Set(salespersonRows.map((row) => row.source))).sort(
        (left, right) => left.localeCompare(right),
      ),
    [salespersonRows],
  );

  const salespersonOptions = useMemo(() => {
    if (sourceFilter === "all") return [];

    return Array.from(
      new Set(
        salespersonRows
          .filter((row) => row.source === sourceFilter)
          .map((row) => row.salesperson),
      ),
    ).sort((left, right) => left.localeCompare(right));
  }, [salespersonRows, sourceFilter]);

  const filteredSalespersonRows = useMemo(
    () =>
      salespersonRows
        .filter(
          (row) =>
            (sourceFilter === "all" || row.source === sourceFilter) &&
            (salespersonFilter === "all" ||
              row.salesperson === salespersonFilter),
        )
        .sort(
          (left, right) =>
            right.sold - left.sold ||
            right.conversion - left.conversion ||
            right.quotes - left.quotes ||
            left.source.localeCompare(right.source) ||
            left.salesperson.localeCompare(right.salesperson),
        ),
    [salespersonFilter, salespersonRows, sourceFilter],
  );

  const filteredSourceRows = useMemo(() => {
    if (salespersonFilter === "all") {
      return rows.filter(
        (row) => sourceFilter === "all" || row.name === sourceFilter,
      );
    }

    const grouped = new Map<
      string,
      {
        name: string;
        quotes: number;
        sold: number;
        notSold: number;
        pending: number;
      }
    >();

    filteredSalespersonRows.forEach((row) => {
      const current = grouped.get(row.source) || {
        name: row.source,
        quotes: 0,
        sold: 0,
        notSold: 0,
        pending: 0,
      };

      current.quotes += row.quotes;
      current.sold += row.sold;
      current.notSold += row.notSold;
      current.pending += row.pending;
      grouped.set(row.source, current);
    });

    return Array.from(grouped.values()).map((row) => {
      const finalized = row.sold + row.notSold;

      return {
        ...row,
        finalized,
        efficiency: row.quotes ? (finalized / row.quotes) * 100 : 0,
        conversion: finalized ? (row.sold / finalized) * 100 : 0,
      };
    });
  }, [
    filteredSalespersonRows,
    rows,
    salespersonFilter,
    sourceFilter,
  ]);

  const topSeller = filteredSalespersonRows[0];
  const activeFilterLabel =
    sourceFilter === "all"
      ? "all sources"
      : salespersonFilter === "all"
        ? sourceFilter
        : `${sourceFilter} · ${salespersonFilter}`;

  return (
    <div className="space-y-5">
      <ReportShell
        eyebrow="Source Intelligence Filters"
        title="Dealer and salesperson performance"
        note="Select the dealer first, then narrow the report to one salesperson. Salespeople are ranked by Sold quotes, conversion, and quote volume."
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(240px,0.8fr)]">
          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">
              1. Dealer / Source
            </span>
            <select
              value={sourceFilter}
              onChange={(event) => {
                setSourceFilter(event.target.value);
                setSalespersonFilter("all");
              }}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 outline-none focus:border-[#6b84b5] focus:ring-4 focus:ring-[#eef3fb]"
            >
              <option value="all">All dealers / sources</option>
              {sourceOptions.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-400">
              2. Salesperson
            </span>
            <select
              value={salespersonFilter}
              onChange={(event) => setSalespersonFilter(event.target.value)}
              disabled={sourceFilter === "all"}
              className="mt-2 w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-black text-slate-800 outline-none disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 focus:border-[#6b84b5] focus:ring-4 focus:ring-[#eef3fb]"
            >
              <option value="all">
                {sourceFilter === "all"
                  ? "Select a dealer first"
                  : "All salespeople"}
              </option>
              {salespersonOptions.map((salesperson) => (
                <option key={salesperson} value={salesperson}>
                  {salesperson}
                </option>
              ))}
            </select>
          </label>

          <div className="rounded-2xl border border-[#c9d5e9] bg-[#f3f6fb] p-4">
            <p className="text-[10px] font-black uppercase tracking-[0.16em] text-[#4d6aa8]">
              Top salesperson
            </p>
            {topSeller ? (
              <>
                <p className="mt-2 text-lg font-black text-[#17305f]">
                  {topSeller.salesperson}
                </p>
                <p className="mt-1 text-xs font-bold text-slate-500">
                  {topSeller.source}
                </p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-black">
                  <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-emerald-800">
                    {topSeller.sold} Sold
                  </span>
                  <span className="rounded-full bg-white px-2.5 py-1 text-[#223f7a]">
                    {topSeller.conversion.toFixed(1)}% conversion
                  </span>
                </div>
              </>
            ) : (
              <p className="mt-2 text-sm font-semibold text-slate-500">
                No salesperson activity for this selection.
              </p>
            )}
          </div>
        </div>
      </ReportShell>

      <RankedReportTable
        title={`Source Performance · ${activeFilterLabel}`}
        rows={filteredSourceRows}
      />

      <ReportShell
        eyebrow="Salesperson by Dealer"
        title="Who is selling more for each source"
        note="The table starts with the salesperson and can be narrowed by dealer and salesperson using the controls above."
      >
        {filteredSalespersonRows.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3 pr-5">Salesperson</th>
                  <th className="py-3 pr-5">Dealer / Source</th>
                  <th className="py-3 pr-5">Category</th>
                  <th className="py-3 pr-5">Quotes</th>
                  <th className="py-3 pr-5">Sold</th>
                  <th className="py-3 pr-5">Not Sold</th>
                  <th className="py-3 pr-5">Price Sent</th>
                  <th className="py-3 pr-5">Conversion</th>
                  <th className="py-3 pr-5">Taken</th>
                  <th className="py-3">Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredSalespersonRows.map((row) => (
                  <tr key={`${row.source}-${row.salesperson}`}>
                    <td className="py-4 pr-5">
                      <p className="font-black text-[#17305f]">
                        {row.salesperson}
                      </p>
                    </td>
                    <td className="py-4 pr-5 font-bold">{row.source}</td>
                    <td className="py-4 pr-5">
                      <span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs font-black text-[#223f7a]">
                        {row.category}
                      </span>
                    </td>
                    <td className="py-4 pr-5 font-black">{row.quotes}</td>
                    <td className="py-4 pr-5 font-black text-emerald-700">
                      {row.sold}
                    </td>
                    <td className="py-4 pr-5 font-black text-rose-700">
                      {row.notSold}
                    </td>
                    <td className="py-4 pr-5 font-black text-amber-700">
                      {row.pending}
                    </td>
                    <td className="py-4 pr-5 font-black">
                      {row.conversion.toFixed(1)}%
                    </td>
                    <td className="py-4 pr-5 font-black text-amber-700">
                      {row.taken}
                    </td>
                    <td className="py-4 font-black text-slate-600">
                      {row.notes}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyReport
            title="No salesperson activity"
            note="No quotes match the selected dealer and salesperson filters."
          />
        )}
      </ReportShell>
    </div>
  );
}

function ServiceControlReport({
  activations,
  changes,
  payments,
}: {
  activations: WorkItem[];
  changes: WorkItem[];
  payments: WorkItem[];
}) {
  const items = [...activations, ...changes, ...payments].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Activations"
          value={activations.length}
          note="Service workload"
          icon={<CheckCircle2 className="h-5 w-5 text-emerald-700" />}
          tone="bg-emerald-50"
        />
        <SummaryCard
          label="Changes"
          value={changes.length}
          note="Service workload"
          icon={<Pencil className="h-5 w-5 text-violet-700" />}
          tone="bg-violet-50"
        />
        <SummaryCard
          label="Payments"
          value={payments.length}
          note="No-turn activity"
          icon={<CircleDollarSign className="h-5 w-5 text-amber-700" />}
          tone="bg-amber-50"
        />
      </div>
      <ServiceActivityReport items={items} />
    </div>
  );
}

function ActivationAuditReport({
  activations,
  activationEvents,
  outcomes,
}: {
  activations: WorkItem[];
  activationEvents: QuoteActivity[];
  outcomes: QuoteOutcome[];
}) {
  const sold = outcomes.filter((outcome) => outcome.decision === "sold").length;
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Sold Quotes"
          value={sold}
          note="Final sold decisions"
          icon={<CircleDollarSign className="h-5 w-5 text-emerald-700" />}
          tone="bg-emerald-50"
        />
        <SummaryCard
          label="Activation Tasks"
          value={activations.length}
          note="Taken as workload"
          icon={<CheckCircle2 className="h-5 w-5 text-cyan-700" />}
          tone="bg-cyan-50"
        />
        <SummaryCard
          label="Activation Logs"
          value={activationEvents.length}
          note="Quote log events"
          icon={<ListChecks className="h-5 w-5 text-[#223f7a]" />}
          tone="bg-[#eef3fb]"
        />
      </div>
      <ReportShell
        eyebrow="Activation Audit"
        title="Recent activation work"
        note="Shows activation tasks and whether they are still open or completed."
      >
        {activations.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="py-3">Customer</th>
                  <th className="py-3">Source</th>
                  <th className="py-3">Agent</th>
                  <th className="py-3">Status</th>
                  <th className="py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activations.map((item) => (
                  <tr key={item.id}>
                    <td className="py-4 font-black">{item.customer}</td>
                    <td className="py-4 text-slate-600">{item.dealer}</td>
                    <td className="py-4 font-bold">{item.assignedAgent}</td>
                    <td className="py-4 capitalize">{item.status}</td>
                    <td className="py-4 text-xs text-slate-500">
                      {formatDateTime(item.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyReport
            title="No activations"
            note="Activation work will appear here."
          />
        )}
      </ReportShell>
    </div>
  );
}

function ManagerInterventionReport({ rows }: { rows: ManagerActivityRow[] }) {
  return (
    <ReportShell
      eyebrow="Manager Interventions"
      title="Assignments, reassignments, and control actions"
      note="Tracks management involvement and the note trail behind it."
    >
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3">Date</th>
                <th className="py-3">Action</th>
                <th className="py-3">Manager</th>
                <th className="py-3">Assigned Agent</th>
                <th className="py-3">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="py-4 text-xs text-slate-500">
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className="py-4 font-black">{row.eventType}</td>
                  <td className="py-4">
                    <p className="font-bold">{row.actorName}</p>
                    <p className="text-xs text-slate-400">
                      @{row.actorUsername}
                    </p>
                  </td>
                  <td className="py-4 font-bold">{row.assignedAgent || "—"}</td>
                  <td className="py-4 text-xs font-semibold text-slate-500">
                    {row.details
                      ? JSON.stringify(row.details).slice(0, 160)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReport
          title="No manager interventions"
          note="Assignments and reassignments will appear here when recorded."
        />
      )}
    </ReportShell>
  );
}

function IntegrityReport({ issues }: { issues: IntegrityIssue[] }) {
  return (
    <ReportShell
      eyebrow="Data Integrity"
      title="Possible duplicates and workflow inconsistencies"
      note="Flags records that may need correction before reports are trusted."
    >
      {issues.length ? (
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="py-3">Level</th>
                <th className="py-3">Issue</th>
                <th className="py-3">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {issues.map((row, index) => (
                <tr key={`${row.issue}-${index}`}>
                  <td className="py-4">
                    <span
                      className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-black",
                        row.severity === "critical"
                          ? "bg-rose-50 text-rose-700"
                          : "bg-amber-50 text-amber-700",
                      )}
                    >
                      {row.severity}
                    </span>
                  </td>
                  <td className="py-4 font-black">{row.issue}</td>
                  <td className="py-4 text-slate-600">{row.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyReport
          title="No integrity issues"
          note="No major duplicate or workflow consistency issues were detected."
        />
      )}
    </ReportShell>
  );
}

function SystemHealthReport({ checks }: { checks: SystemCheck[] }) {
  return (
    <ReportShell
      eyebrow="System Health"
      title="Production checks"
      note="Basic configuration and live-data health indicators."
    >
      <div className="grid gap-4 md:grid-cols-2">
        {checks.map((check) => (
          <div
            key={check.check}
            className="rounded-2xl border border-slate-200 p-5"
          >
            <div className="flex items-center justify-between">
              <p className="font-black">{check.check}</p>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-black",
                  check.status
                    ? "bg-emerald-50 text-emerald-700"
                    : "bg-rose-50 text-rose-700",
                )}
              >
                {check.status ? "OK" : "Check"}
              </span>
            </div>
            <p className="mt-2 text-sm font-semibold text-slate-500">
              {check.detail}
            </p>
          </div>
        ))}
      </div>
    </ReportShell>
  );
}

function ExportButton({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-between rounded-2xl border border-slate-200 p-4 text-left transition hover:-translate-y-0.5 hover:border-[#b8c7e1] hover:shadow-md"
    >
      <div>
        <p className="text-sm font-black">{label}</p>
        <p className="mt-1 text-xs font-semibold text-slate-400">CSV / Excel</p>
      </div>
      <Download className="h-5 w-5 text-[#223f7a]" />
    </button>
  );
}
