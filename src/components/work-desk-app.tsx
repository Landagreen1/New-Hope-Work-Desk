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
  Download,
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
import type {
  Agent,
  AlertNotification,
  DashboardData,
  SourceOption,
  AssignmentMethod,
  AvailabilityStatus,
  PassEvent,
  PendingPricingItem,
  PerformanceRow,
  NotSoldReason,
  QuoteOutcome,
  RotationKind,
  SessionProfile,
  WorkItem,
  WorkType,
} from "@/lib/types";

const workTypeLabels: Record<WorkType, string> = {
  new_quote: "New Quote",
  requote: "Requote",
  activation: "Activation",
  change: "Change",
  whatsapp_update: "WhatsApp Update",
};

const methodStyles: Record<AssignmentMethod, { label: string; className: string }> = {
  whatsapp_turn: { label: "WhatsApp Turn", className: "bg-emerald-50 text-emerald-700 ring-emerald-200" },
  ringcentral_turn: { label: "RingCentral Turn", className: "bg-blue-50 text-blue-700 ring-blue-200" },
  workload_turn: { label: "Workload Turn", className: "bg-violet-50 text-violet-700 ring-violet-200" },
  owner: { label: "Owner", className: "bg-sky-50 text-sky-700 ring-sky-200" },
  update_log: { label: "Update · No Turn", className: "bg-amber-50 text-amber-800 ring-amber-200" },
  manager_manual: { label: "Manager Assigned", className: "bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-200" },
  manual_quote: { label: "Manual Quote · No Turn", className: "bg-slate-100 text-slate-700 ring-slate-200" },
};

const rotationConfig: Record<RotationKind, {
  title: string;
  shortTitle: string;
  description: string;
  action: string;
  icon: React.ReactNode;
  accent: string;
  soft: string;
  ring: string;
  button: string;
}> = {
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
  return agentAccentCycle[(agent.rotationPosition - 1) % agentAccentCycle.length];
}

type ModalType = "whatsapp_quote" | "ringcentral_quote" | "workload_turn" | "whatsapp_update" | "manual_quote" | "manager_assign_quote" | "quote_result" | "not_sold_reason" | null;
type AgentTab = "desk" | "pricing" | "performance";
type ManagerTab = "overview" | "tasks" | "pricing" | "quotes" | "reports" | "team" | "sources" | "users";
type ReportView = "executive" | "agents" | "timing" | "channels" | "sources" | "followup" | "activity";
type ManagerQuoteStage = "active" | "pending" | "finalized";

type AdminUserAccount = {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  role: "agent" | "manager";
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

type PerformanceMetricKey = "whatsappQuotes" | "ringCentralQuotes" | "workloadTurns" | "whatsappUpdates" | "manualQuotes" | "soldQuotes" | "passedTurns";
const performanceMetricKeys: PerformanceMetricKey[] = ["whatsappQuotes", "ringCentralQuotes", "workloadTurns", "whatsappUpdates", "manualQuotes", "soldQuotes", "passedTurns"];

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
  return [...agentList].sort((a, b) => queuePosition(a, rotation) - queuePosition(b, rotation));
}

function nextEligibleAgent(agentList: Agent[], currentId: string, rotation: RotationKind) {
  const queue = orderedAgents(agentList, rotation);
  const currentIndex = queue.findIndex((agent) => agent.id === currentId);
  if (currentIndex < 0) return currentId;
  for (let step = 1; step <= queue.length; step += 1) {
    const candidate = queue[(currentIndex + step) % queue.length];
    if (candidate.availability === "available" && rotationEligibility(candidate, rotation)) return candidate.id;
  }
  return currentId;
}

function upcomingAgents(agentList: Agent[], currentId: string, rotation: RotationKind, count = 3) {
  const output: Agent[] = [];
  let pointer = currentId;
  while (output.length < count && output.length < agentList.length - 1) {
    const nextId = nextEligibleAgent(agentList, pointer, rotation);
    if (nextId === currentId || output.some((agent) => agent.id === nextId)) break;
    const agent = agentList.find((item) => item.id === nextId);
    if (!agent) break;
    output.push(agent);
    pointer = nextId;
  }
  return output;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function daysSince(value: string) {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
}

function durationMinutes(start?: string, end?: string) {
  if (!start || !end) return null;
  return Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 60_000);
}

function formatDuration(minutes: number | null) {
  if (minutes === null || Number.isNaN(minutes)) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)}h`;
  return `${(minutes / 1440).toFixed(1)}d`;
}

function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

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
  const csv = [headers.map(csvEscape).join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Avatar({ agent, size = "md" }: { agent: Agent; size?: "sm" | "md" | "lg" }) {
  const sizes = { sm: "h-8 w-8 text-xs", md: "h-10 w-10 text-sm", lg: "h-14 w-14 text-base" };
  return (
    <div className={cn("grid shrink-0 place-items-center rounded-2xl bg-gradient-to-br font-black text-white shadow-sm", sizes[size], accentForAgent(agent))} aria-label={agent.name}>
      {agent.initials}
    </div>
  );
}

function StatusDot({ status }: { status: AvailabilityStatus }) {
  return <span className={cn("inline-block h-2.5 w-2.5 rounded-full", status === "available" && "bg-emerald-500", status === "break" && "bg-amber-500", status === "unavailable" && "bg-slate-400")} />;
}

function MethodBadge({ method }: { method: AssignmentMethod }) {
  const style = methodStyles[method];
  return <span className={cn("inline-flex rounded-full px-2.5 py-1 text-[11px] font-black ring-1", style.className)}>{style.label}</span>;
}

function Modal({ open, title, subtitle, onClose, children }: { open: boolean; title: string; subtitle?: string; onClose: () => void; children: React.ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/45 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className="w-full max-w-xl overflow-hidden rounded-[28px] border border-white/70 bg-white shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between border-b border-slate-100 px-6 py-5">
          <div><h2 className="text-xl font-black tracking-tight text-slate-950">{title}</h2>{subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}</div>
          <button onClick={onClose} className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 block text-xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</span>{children}</label>;
}

function normalizeSourceSearch(value: string) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function SourceCombobox({ sources, required = true, allowEmpty = false }: { sources: SourceOption[]; required?: boolean; allowEmpty?: boolean }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = normalizeSourceSearch(query);
    if (!needle) return sources.slice(0, 12);
    return sources
      .map((dealer) => {
        const normalized = normalizeSourceSearch(dealer.name);
        const score = normalized === needle ? 0 : normalized.startsWith(needle) ? 1 : normalized.includes(needle) ? 2 : dealer.name.toLowerCase().includes(query.toLowerCase()) ? 3 : 99;
        return { dealer, score };
      })
      .filter((row) => row.score < 99)
      .sort((a, b) => a.score - b.score || a.dealer.name.localeCompare(b.dealer.name))
      .slice(0, 12)
      .map((row) => row.dealer);
  }, [sources, query]);

  function updateQuery(value: string) {
    setQuery(value);
    setOpen(true);
    const normalized = normalizeSourceSearch(value);
    const exact = sources.find((dealer) => normalizeSourceSearch(dealer.name) === normalized);
    if (exact) {
      setSelectedId(exact.id);
    } else {
      setSelectedId("");
    }
  }

  function chooseSource(dealer: SourceOption) {
    setSelectedId(dealer.id);
    setQuery(dealer.name);
    setOpen(false);
  }

  return (
    <div className="relative">
      <select name="dealer" required={required} value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="sr-only" aria-hidden="true" tabIndex={-1}>
        <option value="">{allowEmpty ? "Direct / No source" : "Select source"}</option>
        {sources.map((dealer) => <option key={dealer.id} value={dealer.id}>{dealer.name}</option>)}
      </select>
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          placeholder={allowEmpty ? "Paste or type source name (optional)" : "Paste or start typing source name"}
          autoComplete="off"
          className="field" style={{ paddingLeft: "3rem", paddingRight: "2.75rem" }}
        />
        {selectedId ? <Check className="pointer-events-none absolute right-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-emerald-600" /> : null}
      </div>
      {selectedId ? <p className="mt-1.5 text-xs font-bold text-emerald-700">Source matched and selected.</p> : query && !matches.length ? <p className="mt-1.5 text-xs font-bold text-amber-700">No source found. Ask management to add it to the Sources list.</p> : <p className="mt-1.5 text-xs font-semibold text-slate-400">Paste the source name from WhatsApp or type a few letters.</p>}
      {open && (matches.length || (!query && allowEmpty)) ? (
        <div className="absolute z-50 mt-2 max-h-72 w-full overflow-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-2xl">
          {allowEmpty ? <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { setSelectedId(""); setQuery(""); setOpen(false); }} className="w-full rounded-xl px-3 py-2.5 text-left text-sm font-bold text-slate-500 hover:bg-slate-50">Direct / No source</button> : null}
          {matches.map((dealer) => (
            <button key={dealer.id} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => chooseSource(dealer)} className={cn("flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left text-sm font-bold hover:bg-[#f3f6fb]", selectedId === dealer.id && "bg-[#eef3fb] text-[#223f7a]")}>
              <span>{dealer.name}</span>{selectedId === dealer.id ? <Check className="h-4 w-4" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TabBar<T extends string>({ tabs, value, onChange }: { tabs: Array<{ id: T; label: string; icon: React.ReactNode; badge?: number }>; value: T; onChange: (value: T) => void }) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">
      {tabs.map((tab) => (
        <button key={tab.id} onClick={() => onChange(tab.id)} className={cn("flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black transition", value === tab.id ? "bg-[#223f7a] text-white shadow-sm" : "text-slate-500 hover:bg-[#f3f6fb] hover:text-[#223f7a]")}>
          {tab.icon}{tab.label}{tab.badge ? <span className={cn("rounded-full px-2 py-0.5 text-[10px]", value === tab.id ? "bg-white/15 text-white" : "bg-rose-50 text-rose-700")}>{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

function RotationCard({ variant, current, upcoming, isMyTurn, onAction, onPass }: { variant: RotationKind; current: Agent; upcoming: Agent[]; isMyTurn: boolean; onAction: () => void; onPass: () => void }) {
  const config = rotationConfig[variant];
  return (
    <section className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className={cn("flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em]", config.accent)}>{config.icon}{config.shortTitle}</div>
          <p className="mt-1 text-xs font-semibold text-slate-400">{config.description}</p>
        </div>
        <span className={cn("rounded-full px-2.5 py-1 text-[10px] font-black ring-1", isMyTurn ? "bg-red-50 text-red-700 ring-red-200" : cn(config.soft, config.accent, config.ring))}>{isMyTurn ? "YOUR TURN" : "LIVE"}</span>
      </div>
      <div className="mt-5 flex items-center gap-3">
        <Avatar agent={current} />
        <div className="min-w-0 flex-1"><p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Current</p><p className="truncate text-xl font-black tracking-tight">{current.name}</p></div>
      </div>
      <div className="mt-4 flex items-center gap-2 overflow-hidden text-xs font-bold text-slate-500">
        <span>Next</span><ChevronRight className="h-3.5 w-3.5" />{upcoming.slice(0, 2).map((agent) => <span key={agent.id} className="rounded-lg bg-slate-50 px-2 py-1">{agent.name}</span>)}
      </div>
      <div className="mt-5 flex gap-2">
        <button onClick={onAction} disabled={!isMyTurn} className={cn("flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-3 text-xs font-black transition", isMyTurn ? `${config.button} text-white` : "cursor-not-allowed bg-slate-100 text-slate-400")}>{variant === "workload" ? <BriefcaseBusiness className="h-4 w-4" /> : <Zap className="h-4 w-4" />}{config.action}</button>
        {isMyTurn ? <button onClick={onPass} className="rounded-xl border border-slate-200 px-3 text-xs font-black text-slate-600 hover:bg-slate-50">Pass</button> : null}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, note, icon, tone }: { label: string; value: string | number; note?: string; icon: React.ReactNode; tone: string }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className={cn("grid h-10 w-10 place-items-center rounded-2xl", tone)}>{icon}</div>
      <p className="mt-4 text-xs font-black uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className="mt-1 text-3xl font-black tracking-tight text-slate-950">{value}</p>
      {note ? <p className="mt-1 text-xs font-semibold text-slate-500">{note}</p> : null}
    </div>
  );
}

function MetricCard({ icon, label, value, average, rank, tone }: { icon: React.ReactNode; label: string; value: number; average: number; rank: number; tone: string }) {
  const above = value >= average;
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between"><div className={cn("grid h-10 w-10 place-items-center rounded-2xl", tone)}>{icon}</div><span className={cn("rounded-full px-2.5 py-1 text-[11px] font-black", above ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500")}>#{rank}</span></div>
      <p className="mt-5 text-sm font-bold text-slate-500">{label}</p>
      <div className="mt-1 flex items-end gap-3"><span className="text-3xl font-black tracking-tight text-slate-950">{value}</span><span className="pb-1 text-xs font-bold text-slate-400">Team avg {average.toFixed(1)}</span></div>
    </div>
  );
}

function EmptyState({ title, note }: { title: string; note: string }) {
  return <div className="rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center"><CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" /><p className="mt-3 font-black text-slate-800">{title}</p><p className="mt-1 text-sm text-slate-500">{note}</p></div>;
}

export function WorkDeskApp({ sessionProfile, initialData }: { sessionProfile: SessionProfile; initialData: DashboardData }) {
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [agentList, setAgentList] = useState(initialData.agents);
  const [sourceList, setSourceList] = useState<SourceOption[]>(initialData.sources);
  const [workItems, setWorkItems] = useState<WorkItem[]>(initialData.workItems);
  const [pendingPricing, setPendingPricing] = useState<PendingPricingItem[]>(initialData.pendingPricing);
  const [quoteOutcomes, setQuoteOutcomes] = useState<QuoteOutcome[]>(initialData.quoteOutcomes);
  const [notifications, setNotifications] = useState<AlertNotification[]>(initialData.notifications);
  const [performance, setPerformance] = useState<PerformanceRow[]>(initialData.performance);
  const [passEvents, setPassEvents] = useState<PassEvent[]>(initialData.passEvents);
  const [agentTab, setAgentTab] = useState<AgentTab>("desk");
  const [managerTab, setManagerTab] = useState<ManagerTab>("overview");
  const [whatsappCurrentId, setWhatsappCurrentId] = useState(initialData.rotations.whatsapp);
  const [ringCentralCurrentId, setRingCentralCurrentId] = useState(initialData.rotations.ringcentral);
  const [workloadCurrentId, setWorkloadCurrentId] = useState(initialData.rotations.workload);
  const [modal, setModal] = useState<ModalType>(null);
  const [quoteResultItemId, setQuoteResultItemId] = useState<string | null>(null);
  const [notSoldTarget, setNotSoldTarget] = useState<NotSoldTarget>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => typeof window !== "undefined" && "Notification" in window && window.localStorage.getItem("nhwd-alerts-enabled") === "true" && Notification.permission === "granted");
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const seenNotificationIds = useRef(new Set(initialData.notifications.filter((item) => item.readAt).map((item) => item.id)));

  const currentUserId = sessionProfile.id;
  const isManager = sessionProfile.role === "manager";
  const currentUser = agentList.find((agent) => agent.id === currentUserId);
  const whatsappCurrent = agentList.find((agent) => agent.id === whatsappCurrentId) ?? agentList[0];
  const ringCentralCurrent = agentList.find((agent) => agent.id === ringCentralCurrentId) ?? agentList[0];
  const workloadCurrent = agentList.find((agent) => agent.id === workloadCurrentId) ?? agentList[0];
  const myActiveWork = currentUser ? workItems.filter((item) => item.assignedAgent === currentUser.name && isActiveTask(item)) : [];
  const myPendingPricing = currentUser ? pendingPricing.filter((item) => item.assignedAgent === currentUser.name) : [];
  const myRecentActivity = currentUser ? workItems.filter((item) => item.assignedAgent === currentUser.name && item.status !== "active").slice(0, 8) : [];
  const quoteResultItem = workItems.find((item) => item.id === quoteResultItemId) ?? null;
  const unreadNotifications = notifications.filter((item) => !item.readAt);

  const emptyPerformance: PerformanceRow = { agentId: currentUserId, whatsappQuotes: 0, ringCentralQuotes: 0, workloadTurns: 0, whatsappUpdates: 0, manualQuotes: 0, soldQuotes: 0, ownedActivations: 0, ownedChanges: 0, requotes: 0, passedTurns: 0 };
  const myPerformance = performance.find((row) => row.agentId === currentUserId) ?? emptyPerformance;
  const performanceMetrics = useMemo(() => performanceMetricKeys.map((key) => {
    const values = performance.map((row) => Number(row[key]));
    const value = Number(myPerformance[key]);
    const average = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : 0;
    return { key, value, average, rank: values.length ? [...values].sort((a, b) => b - a).indexOf(value) + 1 : 1 };
  }), [myPerformance, performance]);

  const todayKey = dateInputValue(new Date());
  const dailyEfficiencyByAgent = useMemo(() => {
    const rows = new Map<string, { total: number; finalized: number; efficiency: number }>();
    for (const agent of agentList) rows.set(agent.name, { total: 0, finalized: 0, efficiency: 0 });

    const addQuote = (agentName: string, createdAt: string, finalized: boolean) => {
      if (!withinDateRange(createdAt, todayKey, todayKey)) return;
      const row = rows.get(agentName) ?? { total: 0, finalized: 0, efficiency: 0 };
      row.total += 1;
      if (finalized) row.finalized += 1;
      row.efficiency = row.total ? (row.finalized / row.total) * 100 : 0;
      rows.set(agentName, row);
    };

    workItems.filter(isQuote).forEach((item) => addQuote(item.assignedAgent, item.createdAt, false));
    pendingPricing.forEach((item) => addQuote(item.assignedAgent, item.quoteCreatedAt, false));
    quoteOutcomes.forEach((item) => addQuote(item.assignedAgent, item.quoteCreatedAt, true));
    return rows;
  }, [agentList, pendingPricing, quoteOutcomes, todayKey, workItems]);

  const myEfficiency = currentUser ? dailyEfficiencyByAgent.get(currentUser.name)?.efficiency ?? 0 : 0;
  const efficiencyValues = agentList.map((agent) => dailyEfficiencyByAgent.get(agent.name)?.efficiency ?? 0);
  const efficiencyAverage = efficiencyValues.length ? efficiencyValues.reduce((sum, value) => sum + value, 0) / efficiencyValues.length : 0;
  const efficiencyRank = efficiencyValues.length ? [...efficiencyValues].sort((a, b) => b - a).indexOf(myEfficiency) + 1 : 1;

  const applyDashboardData = useCallback((data: DashboardData) => {
    setAgentList(data.agents);
    setSourceList(data.sources);
    setWorkItems(data.workItems);
    setPendingPricing(data.pendingPricing);
    setQuoteOutcomes(data.quoteOutcomes);
    setNotifications(data.notifications);
    setPerformance(data.performance);
    setPassEvents(data.passEvents);
    setWhatsappCurrentId(data.rotations.whatsapp);
    setRingCentralCurrentId(data.rotations.ringcentral);
    setWorkloadCurrentId(data.rotations.workload);
  }, []);

  const refreshLiveData = useCallback(async () => {
    try {
      const data = await loadDashboardData(supabase);
      applyDashboardData(data);
    } catch (caught) {
      showToast(caught instanceof Error ? caught.message : "Unable to refresh live data.");
    }
  }, [applyDashboardData, supabase]);

  useEffect(() => {
    const channel = supabase
      .channel("work-desk-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "profiles" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "dealers" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "rotation_state" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "work_items" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "pending_pricing_quotes" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "quote_outcomes" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "user_notifications" }, scheduleRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "turn_events" }, scheduleRefresh)
      .subscribe();

    function scheduleRefresh() {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      refreshTimer.current = window.setTimeout(() => { void refreshLiveData(); }, 180);
    }

    return () => {
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
      void supabase.removeChannel(channel);
    };
  }, [refreshLiveData, supabase]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  function showToast(message: string) { setToast(message); }

  async function runRpc(name: string, args: Record<string, unknown>, successMessage: string) {
    const { error } = await supabase.rpc(name, args);
    if (error) {
      showToast(error.message);
      return false;
    }
    await refreshLiveData();
    showToast(successMessage);
    return true;
  }

  function playAlertSound() {
    try {
      const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioContextCtor) return;
      const context = new AudioContextCtor();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
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
    if (!("Notification" in window)) return showToast("This browser does not support desktop notifications.");
    const permission = await Notification.requestPermission();
    const enabled = permission === "granted";
    setNotificationsEnabled(enabled);
    window.localStorage.setItem("nhwd-alerts-enabled", enabled ? "true" : "false");
    if (enabled) playAlertSound();
    showToast(enabled ? "Desktop alerts enabled. Turn and assignment alerts are active." : "Notification permission was not granted.");
  }

  useEffect(() => {
    const newlyArrived = notifications.filter((item) => !seenNotificationIds.current.has(item.id));
    if (!newlyArrived.length) return;

    newlyArrived.forEach((item) => seenNotificationIds.current.add(item.id));
    const latest = newlyArrived[0];
    showToast(`${latest.title}: ${latest.message}`);

    if (notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
      new Notification(latest.title, { body: latest.message, tag: latest.id });
      playAlertSound();
    }
  }, [notifications, notificationsEnabled]);

  async function markNotificationsRead() {
    const success = await runRpc("mark_my_notifications_read", {}, "Alerts marked as read.");
    if (success) setNotificationPanelOpen(false);
  }

  async function handleAvailability(status: AvailabilityStatus) {
    await runRpc("set_my_availability", { p_status: status }, `Status changed to ${status === "break" ? "Break / Lunch" : status}.`);
  }

  async function handlePass(rotation: RotationKind) {
    const reason = window.prompt("Why are you passing this turn?", "Current workload");
    if (!reason?.trim()) return;
    await runRpc("pass_my_turn", { p_rotation: rotation, p_reason: reason.trim() }, `${rotationConfig[rotation].title} turn passed.`);
  }

  function openQuoteResult(itemId: string) {
    setQuoteResultItemId(itemId);
    setModal("quote_result");
  }

  async function acceptAssignedItem(item: WorkItem) {
    await runRpc("accept_my_assigned_item", { p_work_item_id: item.id }, `${item.customer} accepted. Your work timer is now running.`);
  }

  async function completeWorkItem(item: WorkItem) {
    if (!item.acceptedAt) return showToast("Accept this assignment before completing it.");
    if (isQuote(item)) return openQuoteResult(item.id);
    await runRpc("complete_my_service_item", { p_work_item_id: item.id, p_status: "completed" }, "Task marked completed. No rotation moved.");
  }

  async function finalizeActiveQuote(status: "price_sent" | "sold") {
    if (!quoteResultItem || !isQuote(quoteResultItem)) return;
    const success = status === "price_sent"
      ? await runRpc("move_my_quote_to_pending_pricing", { p_work_item_id: quoteResultItem.id }, "Price sent. Quote moved out of active workload and into Pending Pricing.")
      : await runRpc("finalize_my_active_quote", { p_work_item_id: quoteResultItem.id, p_decision: "sold", p_not_sold_reason: null, p_not_sold_reason_other: null }, "Quote marked Sold.");
    if (success) {
      setModal(null);
      setQuoteResultItemId(null);
    }
  }

  async function finalizePendingPricingSold(item: PendingPricingItem) {
    await runRpc("finalize_pending_pricing_quote", { p_pending_id: item.id, p_decision: "sold", p_not_sold_reason: null, p_not_sold_reason_other: null }, `${item.customer} marked Sold.`);
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

    const args = { p_decision: "not_sold", p_not_sold_reason: reason, p_not_sold_reason_other: reason === "other" ? other : null };
    const success = notSoldTarget.kind === "active"
      ? await runRpc("finalize_my_active_quote", { p_work_item_id: notSoldTarget.item.id, ...args }, "Quote marked Not Sold.")
      : await runRpc("finalize_pending_pricing_quote", { p_pending_id: notSoldTarget.item.id, ...args }, `${notSoldTarget.item.customer} marked Not Sold.`);

    if (success) {
      setModal(null);
      setQuoteResultItemId(null);
      setNotSoldTarget(null);
    }
  }

  async function submitWhatsappQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer"));
    const success = await runRpc("claim_whatsapp_quote", { p_customer_name: customer, p_dealer_id: dealerId }, "New WhatsApp quote logged. The rotation advanced.");
    if (success) setModal(null);
  }

  async function submitRingCentralQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer"));
    const workType = String(formData.get("quoteType")) as "new_quote" | "requote";
    const success = await runRpc("claim_ringcentral_quote", { p_customer_name: customer, p_dealer_id: dealerId, p_work_type: workType }, `${workTypeLabels[workType]} logged. The RingCentral rotation advanced.`);
    if (success) setModal(null);
  }

  async function submitWorkloadTurn(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer"));
    const workType = String(formData.get("workType")) as "activation" | "change";
    const ownerId = String(formData.get("owner") || "");
    const changeType = String(formData.get("changeType") || "");
    const success = await runRpc("claim_workload_turn", { p_customer_name: customer, p_dealer_id: dealerId, p_work_type: workType, p_original_owner_profile_id: ownerId || null, p_change_type: changeType || null }, `${workTypeLabels[workType]} logged. The Additional Workload rotation advanced.`);
    if (success) setModal(null);
  }

  async function submitWhatsappUpdate(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer"));
    const ownerId = String(formData.get("owner") || "");
    const note = String(formData.get("note") || "");
    const success = await runRpc("log_whatsapp_update", { p_customer_name: customer, p_dealer_id: dealerId, p_original_owner_profile_id: ownerId || null, p_note: note }, "WhatsApp update logged. No rotation moved.");
    if (success) setModal(null);
  }

  async function submitManualQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer") || "");
    const workType = String(formData.get("quoteType")) as "new_quote" | "requote";
    const inputMethod = String(formData.get("inputMethod"));
    const success = await runRpc("log_manual_quote", { p_customer_name: customer, p_dealer_id: dealerId || null, p_work_type: workType, p_received_through: inputMethod }, "Manual quote recorded for reporting. No rotation moved.");
    if (success) setModal(null);
  }

  async function submitManagerAssignedQuote(formData: FormData) {
    const customer = String(formData.get("customer"));
    const dealerId = String(formData.get("dealer") || "");
    const workType = String(formData.get("quoteType")) as "new_quote" | "requote";
    const inputMethod = String(formData.get("inputMethod"));
    const assignedProfileId = String(formData.get("assignedAgent"));
    const note = String(formData.get("note") || "");
    const agent = agentList.find((candidate) => candidate.id === assignedProfileId);
    const success = await runRpc(
      "manager_create_and_assign_quote",
      { p_customer_name: customer, p_dealer_id: dealerId || null, p_work_type: workType, p_received_through: inputMethod, p_assigned_profile_id: assignedProfileId, p_note: note || null },
      `Quote created and assigned to ${agent?.name || "the selected agent"}.`
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
    await runRpc("manager_reassign_work_item", { p_work_item_id: itemId, p_new_profile_id: profileId, p_reason: "Manager reassignment from Open Tasks" }, `Task reassigned to ${agent?.name || "selected agent"}.`);
  }

  async function managerReassignPending(itemId: string, profileId: string) {
    const agent = agentList.find((candidate) => candidate.id === profileId);
    await runRpc("manager_reassign_pending_pricing", { p_pending_id: itemId, p_new_profile_id: profileId, p_reason: "Manager reassignment from Pending Pricing" }, `Pricing follow-up reassigned to ${agent?.name || "selected agent"}.`);
  }

  async function managerDeleteQuote(stage: ManagerQuoteStage, quoteId: string, customer: string) {
    const reason = window.prompt(`Why are you deleting the quote for ${customer}? This reason will be kept in the audit log.`);
    if (!reason?.trim()) return;
    if (!window.confirm(`Permanently delete the ${customer} quote from Work Desk and all performance reports? This cannot be undone.`)) return;
    await runRpc(
      "manager_delete_quote",
      { p_quote_stage: stage, p_quote_id: quoteId, p_reason: reason.trim() },
      `${customer} quote deleted.`
    );
  }

  async function managerSetRotation(rotation: RotationKind, profileId: string) {
    await runRpc("manager_set_rotation_current", { p_rotation: rotation, p_profile_id: profileId, p_reason: "Manager changed rotation from Overview" }, `${rotationConfig[rotation].shortTitle} rotation changed.`);
  }

  async function managerToggleRotation(agent: Agent, rotation: RotationKind) {
    const current = rotation === "whatsapp" ? agent.whatsappActive : rotation === "ringcentral" ? agent.ringCentralActive : agent.workloadActive;
    await runRpc("manager_set_rotation_eligibility", { p_profile_id: agent.id, p_rotation: rotation, p_active: !current, p_reason: "Manager changed rotation eligibility from Team Controls" }, `${agent.name} ${!current ? "activated in" : "paused from"} the ${rotationConfig[rotation].shortTitle} rotation.`);
  }

  async function managerSetQueueOrder(rotation: RotationKind, profileIds: string[]) {
    await runRpc("manager_set_queue_order", { p_rotation: rotation, p_profile_ids: profileIds }, `${rotationConfig[rotation].shortTitle} queue order saved.`);
  }

  const agentTabs: Array<{ id: AgentTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: "desk", label: "My Desk", icon: <Gauge className="h-4 w-4" />, badge: myActiveWork.length },
    { id: "pricing", label: "Pending Pricing", icon: <Clock3 className="h-4 w-4" />, badge: myPendingPricing.length },
    { id: "performance", label: "Performance", icon: <TrendingUp className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen bg-[#f3f5f9] text-slate-950">
      {toast ? <div className="fixed right-5 top-5 z-[60] flex max-w-md items-center gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-bold text-slate-700 shadow-xl"><CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" />{toast}</div> : null}

      <header className="sticky top-0 z-30 border-b border-[#dbe3f0] bg-white/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1700px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Image src="/new-hope-logo-horizontal.png" alt="New Hope Insurance" width={190} height={48} className="h-10 w-auto object-contain" priority />
            <div className="hidden border-l border-slate-200 pl-4 md:block"><h1 className="font-black tracking-tight text-[#17305f]">Work Desk</h1><p className="text-xs font-semibold text-slate-400">Sales operations · Three live rotations</p></div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <button onClick={() => setNotificationPanelOpen((open) => !open)} className="relative inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50">
                <Bell className="h-4 w-4" />Alerts
                {unreadNotifications.length ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-rose-600 px-1 text-[10px] text-white">{unreadNotifications.length}</span> : null}
              </button>
              {notificationPanelOpen ? (
                <div className="absolute right-0 top-12 z-50 w-[380px] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
                  <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3"><div><p className="text-sm font-black text-slate-900">Alerts</p><p className="text-[11px] font-semibold text-slate-400">Turns and manager assignments</p></div>{unreadNotifications.length ? <button onClick={() => void markNotificationsRead()} className="text-[11px] font-black text-[#223f7a]">Mark all read</button> : null}</div>
                  {!notificationsEnabled ? <div className="border-b border-slate-100 bg-amber-50 px-4 py-3"><p className="text-xs font-bold text-amber-800">Desktop notifications and sound are off.</p><button onClick={() => void enableNotifications()} className="mt-2 rounded-lg bg-amber-500 px-3 py-2 text-[11px] font-black text-white">Enable Desktop Alerts</button></div> : null}
                  <div className="max-h-96 overflow-auto">
                    {notifications.length ? notifications.slice(0, 12).map((item) => <div key={item.id} className={cn("border-b border-slate-100 px-4 py-3 last:border-b-0", !item.readAt && "bg-[#f3f6fb]")}><div className="flex items-start gap-3"><div className={cn("mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl", item.type === "turn" ? "bg-emerald-50 text-emerald-700" : "bg-blue-50 text-blue-700")}><Bell className="h-4 w-4" /></div><div><p className="text-sm font-black text-slate-900">{item.title}</p><p className="mt-1 text-xs font-semibold leading-5 text-slate-500">{item.message}</p><p className="mt-1 text-[10px] font-bold text-slate-400">{formatDateTime(item.createdAt)}</p></div></div></div>) : <div className="p-6 text-center text-sm font-semibold text-slate-400">No alerts yet.</div>}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="hidden rounded-xl bg-slate-50 px-3 py-2 text-right sm:block"><p className="text-xs font-black text-slate-800">{sessionProfile.displayName}</p><p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{sessionProfile.role === "manager" ? "Management" : `@${sessionProfile.username}`}</p></div>
            <button onClick={handleSignOut} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-600 transition hover:bg-slate-50" title="Sign out"><LogOut className="h-4 w-4" /><span className="hidden sm:inline">Sign out</span></button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1700px] px-4 py-6 sm:px-6 lg:px-8">
        {!isManager && currentUser ? (
          <div className="space-y-5">
            <section className="flex flex-col gap-4 rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-center gap-4"><Avatar agent={currentUser} size="lg" /><div><p className="text-xs font-black uppercase tracking-[0.18em] text-slate-400">Working as</p><h2 className="mt-1 text-2xl font-black tracking-tight">{currentUser.name}</h2><p className="mt-1 text-sm font-semibold text-slate-500">{myActiveWork.length} active task{myActiveWork.length === 1 ? "" : "s"} · {myPendingPricing.length} awaiting source decision</p></div></div>
              <div className="flex flex-wrap items-center gap-2"><div className="mr-2 flex items-center gap-2 text-xs font-black uppercase tracking-wider text-slate-400"><Activity className="h-4 w-4" /> My status</div>{([ ["available", "Available", "bg-emerald-600 text-white"], ["break", "Break / Lunch", "bg-amber-500 text-white"], ["unavailable", "Unavailable", "bg-slate-700 text-white"] ] as const).map(([status, label, activeClass]) => <button key={status} onClick={() => handleAvailability(status)} className={cn("rounded-xl px-3 py-2 text-xs font-black transition", currentUser.availability === status ? activeClass : "bg-white text-slate-500 ring-1 ring-slate-200 hover:bg-slate-50")}>{label}</button>)}<p className="w-full pt-1 text-[11px] font-semibold text-slate-400 lg:text-right">Daily start: the first eligible agent to click Available starts each queue for the day.</p></div>
            </section>

            <TabBar tabs={agentTabs} value={agentTab} onChange={setAgentTab} />

            {agentTab === "desk" ? (
              <div className="space-y-6">
                <section className="grid gap-5 xl:grid-cols-3">
                  <RotationCard variant="whatsapp" current={whatsappCurrent} upcoming={upcomingAgents(agentList, whatsappCurrentId, "whatsapp")} isMyTurn={currentUserId === whatsappCurrentId} onAction={() => setModal("whatsapp_quote")} onPass={() => handlePass("whatsapp")} />
                  <RotationCard variant="ringcentral" current={ringCentralCurrent} upcoming={upcomingAgents(agentList, ringCentralCurrentId, "ringcentral")} isMyTurn={currentUserId === ringCentralCurrentId} onAction={() => setModal("ringcentral_quote")} onPass={() => handlePass("ringcentral")} />
                  <RotationCard variant="workload" current={workloadCurrent} upcoming={upcomingAgents(agentList, workloadCurrentId, "workload")} isMyTurn={currentUserId === workloadCurrentId} onAction={() => setModal("workload_turn")} onPass={() => handlePass("workload")} />
                </section>

                <section className="grid gap-5 xl:grid-cols-[1.45fr_.55fr]">
                  <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-col gap-3 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
                      <div>
                        <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><ListChecks className="h-4 w-4" /> My Active Tasks</div>
                        <h3 className="mt-1 text-xl font-black">Work that needs your attention</h3>
                        <p className="mt-1 text-sm text-slate-500">Price-sent quotes move to Pending Pricing and stop counting as workload.</p>
                      </div>
                      <span className="rounded-full bg-[#eef3fb] px-3 py-1.5 text-xs font-black text-[#223f7a] ring-1 ring-[#c9d5e9]">{myActiveWork.length} active</span>
                    </div>
                    <div className="p-5">
                      {myActiveWork.length ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          {myActiveWork.map((item) => (
                            <div key={item.id} className="rounded-2xl border border-slate-200 p-4 transition hover:border-[#b5c4df] hover:shadow-sm">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="flex flex-wrap items-center gap-2"><span className="font-black text-slate-900">{item.customer}</span><MethodBadge method={item.assignmentMethod} /></div>
                                  <p className="mt-1 text-sm font-semibold text-slate-500">{workTypeLabels[item.workType]} · {item.dealer}</p>
                                  <p className="mt-2 text-xs font-semibold text-slate-400">Assigned {formatDateTime(item.assignedAt)}</p>
                                  {item.acceptedAt ? <p className="mt-1 text-xs font-semibold text-emerald-700">Accepted {formatDateTime(item.acceptedAt)}</p> : <p className="mt-1 text-xs font-black text-amber-700">Awaiting your acceptance</p>}
                                </div>
                                {item.acceptedAt ? <button onClick={() => completeWorkItem(item)} className="rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white transition hover:bg-[#17305f]">{isQuote(item) ? "Quote Status" : "Complete"}</button> : <button onClick={() => void acceptAssignedItem(item)} className="rounded-xl bg-amber-500 px-3 py-2 text-xs font-black text-white transition hover:bg-amber-600">Accept</button>}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : <EmptyState title="No active tasks" note="You are caught up. Price-sent quotes stay in the separate follow-up list." />}
                    </div>
                  </div>

                  <div className="space-y-5">
                    <div className="rounded-[28px] border border-[#c9d5e9] bg-[#f3f6fb] p-6 shadow-sm">
                      <div className="flex items-center justify-between"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]">Quick Actions</p><h3 className="mt-1 text-xl font-black">Log no-turn work</h3></div><Sparkles className="h-5 w-5 text-[#4d6aa8]" /></div>
                      <div className="mt-5 grid gap-3">
                        <button onClick={() => setModal("whatsapp_update")} className="group rounded-2xl border border-white bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]"><RefreshCw className="h-5 w-5" /></div><div><p className="font-black text-slate-900">Log WhatsApp Update</p><p className="mt-1 text-xs font-semibold text-slate-500">Activity only. No turn moves.</p></div></div></button>
                        <button onClick={() => setModal("manual_quote")} className="group rounded-2xl border border-white bg-white p-4 text-left transition hover:-translate-y-0.5 hover:shadow-md"><div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]"><FilePlus2 className="h-5 w-5" /></div><div><p className="font-black text-slate-900">Submit Manual Quote</p><p className="mt-1 text-xs font-semibold text-slate-500">Outside normal channels. Reporting only.</p></div></div></button>
                      </div>
                    </div>

                    <div className="rounded-[28px] bg-[#223f7a] p-6 text-white shadow-sm">
                      <div className="flex items-center justify-between"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-blue-200">At a glance</p><h3 className="mt-1 text-xl font-black">Your follow-up</h3></div><ClipboardList className="h-5 w-5 text-blue-200" /></div>
                      <div className="mt-5 grid grid-cols-2 gap-3"><div className="rounded-2xl bg-white/10 p-4"><p className="text-3xl font-black">{myActiveWork.length}</p><p className="mt-1 text-xs font-bold text-blue-100">Active tasks</p></div><div className="rounded-2xl bg-white/10 p-4"><p className="text-3xl font-black">{myPendingPricing.length}</p><p className="mt-1 text-xs font-bold text-blue-100">Pricing follow-ups</p></div></div>
                      <button onClick={() => setAgentTab("pricing")} className="mt-4 w-full rounded-xl bg-white px-3 py-2.5 text-xs font-black text-[#223f7a]">Open Pending Pricing</button>
                    </div>
                  </div>
                </section>

                <section className="rounded-[28px] border border-slate-200 bg-white shadow-sm">
                  <div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Recent Activity</p><h3 className="mt-1 text-xl font-black">Completed updates and tasks</h3></div>
                  <div className="divide-y divide-slate-100">{myRecentActivity.length ? myRecentActivity.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 px-6 py-4"><div><p className="font-black text-slate-800">{item.customer}</p><p className="mt-1 text-sm text-slate-500">{workTypeLabels[item.workType]} · {item.note || item.dealer}</p></div><div className="text-right"><MethodBadge method={item.assignmentMethod} /><p className="mt-2 text-xs font-semibold text-slate-400">{formatDateTime(item.completedAt || item.createdAt)}</p></div></div>) : <div className="p-5"><EmptyState title="No recent activity" note="Completed work will appear here." /></div>}</div>
                </section>
              </div>
            ) : null}

            {agentTab === "pricing" ? (
              <section className="rounded-[28px] border border-blue-200 bg-white shadow-sm">
                <div className="flex flex-col gap-3 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between"><div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-blue-600"><Clock3 className="h-4 w-4" /> Pending Pricing</div><h3 className="mt-1 text-xl font-black">Waiting for source confirmation</h3><p className="mt-1 text-sm text-slate-500">These quotes are not counted as active workload.</p></div><span className="rounded-full bg-blue-50 px-3 py-1.5 text-xs font-black text-blue-700 ring-1 ring-blue-200">{myPendingPricing.length} waiting</span></div>
                <div className="p-5">{myPendingPricing.length ? <div className="grid gap-3 xl:grid-cols-2">{myPendingPricing.map((item) => <div key={item.id} className="rounded-2xl border border-blue-100 bg-blue-50/40 p-4"><div className="flex items-start justify-between gap-3"><div><p className="font-black text-slate-900">{item.customer}</p><p className="mt-1 text-sm font-semibold text-slate-500">{workTypeLabels[item.workType]} · {item.dealer}</p><p className="mt-2 text-xs font-bold text-blue-700">Price sent {formatDateTime(item.priceSentAt)} · {daysSince(item.priceSentAt)} day{daysSince(item.priceSentAt) === 1 ? "" : "s"} waiting</p></div><MethodBadge method={item.assignmentMethod} /></div><div className="mt-4 flex gap-2"><button onClick={() => void finalizePendingPricingSold(item)} className="flex-1 rounded-xl bg-emerald-600 px-3 py-2.5 text-xs font-black text-white">Sold</button><button onClick={() => requestNotSold({ kind: "pending", item })} className="flex-1 rounded-xl bg-rose-50 px-3 py-2.5 text-xs font-black text-rose-700 ring-1 ring-rose-200">Not Sold</button></div></div>)}</div> : <EmptyState title="No quotes waiting on a decision" note="When you mark a quote Price Sent, it will move here." />}</div>
              </section>
            ) : null}

            {agentTab === "performance" ? (
              <section className="space-y-5">
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
                  {performanceMetrics.map((metric) => {
                    const setup = {
                      whatsappQuotes: ["WhatsApp Quotes", <MessageCircleMore className="h-5 w-5 text-emerald-700" key="i" />, "bg-emerald-50"],
                      ringCentralQuotes: ["RC Quotes", <PhoneCall className="h-5 w-5 text-blue-700" key="i" />, "bg-blue-50"],
                      workloadTurns: ["Workload", <Layers3 className="h-5 w-5 text-violet-700" key="i" />, "bg-violet-50"],
                      whatsappUpdates: ["WA Updates", <RefreshCw className="h-5 w-5 text-amber-700" key="i" />, "bg-amber-50"],
                      manualQuotes: ["Manual Quotes", <FilePlus2 className="h-5 w-5 text-slate-700" key="i" />, "bg-slate-100"],
                      soldQuotes: ["Sold Quotes", <CircleDollarSign className="h-5 w-5 text-emerald-700" key="i" />, "bg-emerald-50"],
                      passedTurns: ["Turns Passed", <SkipForward className="h-5 w-5 text-rose-700" key="i" />, "bg-rose-50"],
                    }[metric.key] as [string, React.ReactNode, string];
                    return <MetricCard key={metric.key} label={setup[0]} icon={setup[1]} tone={setup[2]} value={metric.value} average={metric.average} rank={metric.rank} />;
                  })}
                  <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between"><div className="grid h-10 w-10 place-items-center rounded-2xl bg-cyan-50"><Gauge className="h-5 w-5 text-cyan-700" /></div><span className="rounded-full bg-cyan-50 px-2.5 py-1 text-[11px] font-black text-cyan-700">#{efficiencyRank}</span></div>
                    <p className="mt-5 text-sm font-bold text-slate-500">Completion Efficiency</p>
                    <div className="mt-1 flex items-end gap-3"><span className="text-3xl font-black tracking-tight text-slate-950">{myEfficiency.toFixed(1)}%</span><span className="pb-1 text-xs font-bold text-slate-400">Team avg {efficiencyAverage.toFixed(1)}%</span></div>
                    <p className="mt-2 text-[11px] font-semibold text-slate-400">Final Sold/Not Sold decisions ÷ all quotes received today.</p>
                  </div>
                </div>
                <TeamPerformanceTable agentList={agentList} performance={performance} currentUserId={currentUserId} efficiencyByAgent={dailyEfficiencyByAgent} />
              </section>
            ) : null}
          </div>
        ) : (
          <ManagerView
            agentList={agentList}
            sourceList={sourceList}
            workItems={workItems}
            pendingPricing={pendingPricing}
            quoteOutcomes={quoteOutcomes}
            performance={performance}
            passEvents={passEvents}
            whatsappCurrentId={whatsappCurrentId}
            ringCentralCurrentId={ringCentralCurrentId}
            workloadCurrentId={workloadCurrentId}
            managerTab={managerTab}
            setManagerTab={setManagerTab}
            finalizePendingPricingSold={finalizePendingPricingSold}
            onRequestNotSold={(item) => requestNotSold({ kind: "pending", item })}
            onOpenAssignQuote={() => setModal("manager_assign_quote")}
            onReassignWork={managerReassignWork}
            onReassignPending={managerReassignPending}
            onDeleteQuote={managerDeleteQuote}
            onSetRotation={managerSetRotation}
            onToggleRotation={managerToggleRotation}
            onSetQueueOrder={managerSetQueueOrder}
          />
        )}
      </main>

      <Modal open={modal === "whatsapp_quote"} title="Take WhatsApp New Quote" subtitle="This advances only the WhatsApp rotation." onClose={() => setModal(null)}>
        <form action={submitWhatsappQuote} className="space-y-4 p-6"><Field label="Customer name"><input name="customer" required className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-emerald-400" /></Field><Field label="Source"><SourceCombobox sources={sourceList} /></Field><button className="w-full rounded-xl bg-emerald-600 px-4 py-3 font-black text-white">Confirm New Quote</button></form>
      </Modal>

      <Modal open={modal === "ringcentral_quote"} title="Take RingCentral Quote" subtitle="New quotes and requotes advance only the RingCentral rotation." onClose={() => setModal(null)}>
        <form action={submitRingCentralQuote} className="space-y-4 p-6"><Field label="Customer name"><input name="customer" required className="w-full rounded-xl border border-slate-200 px-4 py-3 outline-none focus:border-blue-400" /></Field><Field label="Source"><SourceCombobox sources={sourceList} /></Field><Field label="Quote type"><select name="quoteType" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option value="new_quote">New Quote</option><option value="requote">Requote</option></select></Field><button className="w-full rounded-xl bg-blue-600 px-4 py-3 font-black text-white">Confirm RingCentral Turn</button></form>
      </Modal>

      <Modal open={modal === "workload_turn"} title="Take Additional Workload" subtitle="This advances only the Additional Workload rotation." onClose={() => setModal(null)}>
        <form action={submitWorkloadTurn} className="space-y-4 p-6"><Field label="Customer name"><input name="customer" required className="w-full rounded-xl border border-slate-200 px-4 py-3" /></Field><Field label="Source"><SourceCombobox sources={sourceList} /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Work type"><select name="workType" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option value="activation">Activation</option><option value="change">Change</option></select></Field><Field label="Original owner"><select name="owner" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option value="">Unknown / none</option>{agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field></div><Field label="Change type (optional)"><select name="changeType" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option value="">Not applicable</option><option>Add Vehicle</option><option>Remove Vehicle</option><option>Add Driver</option><option>Remove Driver</option><option>Change Coverage</option><option>Other Policy Change</option></select></Field><button className="w-full rounded-xl bg-violet-600 px-4 py-3 font-black text-white">Confirm Workload Turn</button></form>
      </Modal>

      <Modal open={modal === "whatsapp_update"} title="Log WhatsApp Quote Update" subtitle="Recorded in activity only. No rotation changes." onClose={() => setModal(null)}>
        <form action={submitWhatsappUpdate} className="space-y-4 p-6"><Field label="Customer name"><input name="customer" required className="w-full rounded-xl border border-slate-200 px-4 py-3" /></Field><Field label="Source"><SourceCombobox sources={sourceList} /></Field><Field label="Original owner"><select name="owner" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option value="">Unknown</option>{agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></Field><Field label="What was updated?"><textarea name="note" required rows={3} className="w-full rounded-xl border border-slate-200 px-4 py-3" /></Field><button className="w-full rounded-xl bg-amber-500 px-4 py-3 font-black text-white">Log Update</button></form>
      </Modal>

      <Modal open={modal === "manual_quote"} title="Submit Manual Quote" subtitle="For quotes outside the three normal rotations. Recorded for reporting and does not consume a turn." onClose={() => setModal(null)}>
        <form action={submitManualQuote} className="space-y-4 p-6"><div className="rounded-2xl bg-slate-50 p-4 text-sm font-semibold text-slate-600">No rotation will move when this quote is submitted.</div><Field label="Customer name"><input name="customer" required className="w-full rounded-xl border border-slate-200 px-4 py-3" /></Field><Field label="Source"><SourceCombobox sources={sourceList} /></Field><div className="grid gap-4 sm:grid-cols-2"><Field label="Quote type"><select name="quoteType" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option value="new_quote">New Quote</option><option value="requote">Requote</option></select></Field><Field label="Input method"><select name="inputMethod" className="w-full rounded-xl border border-slate-200 bg-white px-4 py-3"><option>Phone call</option><option>Walk-in / Client in office</option><option>Referral</option><option>Email</option><option>Website</option><option>Other</option></select></Field></div><button className="w-full rounded-xl bg-slate-950 px-4 py-3 font-black text-white">Submit Manual Quote</button></form>
      </Modal>

      <Modal open={modal === "manager_assign_quote"} title="Create & Assign Quote" subtitle="Create a quote for any agent. No rotation moves." onClose={() => setModal(null)}>
        <form action={submitManagerAssignedQuote} className="space-y-4 p-6">
          <div className="rounded-2xl bg-[#f3f6fb] p-4 text-sm font-semibold text-[#223f7a]">The selected agent will receive an in-app and desktop alert. The time they take the quote is recorded separately from the assignment time.</div>
          <Field label="Customer name"><input name="customer" required className="field" /></Field>
          <Field label="Source"><SourceCombobox sources={sourceList} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Quote type"><select name="quoteType" className="field"><option value="new_quote">New Quote</option><option value="requote">Requote</option></select></Field>
            <Field label="Input method"><select name="inputMethod" className="field"><option>WhatsApp</option><option>RingCentral</option><option>Phone call</option><option>Walk-in / Client in office</option><option>Email</option><option>Referral</option><option>Website</option><option>Other</option></select></Field>
          </div>
          <Field label="Assign to agent"><select name="assignedAgent" required className="field">{agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.availability === "available" ? "Available" : agent.availability === "break" ? "Lunch" : "Unavailable"}</option>)}</select></Field>
          <Field label="Manager note (optional)"><textarea name="note" rows={3} className="field" placeholder="Anything the agent should know about this quote" /></Field>
          <button className="w-full rounded-xl bg-[#223f7a] px-4 py-3 font-black text-white hover:bg-[#17305f]">Create & Assign Quote</button>
        </form>
      </Modal>

      <Modal open={modal === "not_sold_reason"} title="Why was this quote not sold?" subtitle="Choose the best reason so management can report on lost opportunities." onClose={() => { setModal(null); setNotSoldTarget(null); }}>
        <form action={submitNotSoldReason} className="space-y-4 p-6">
          <div className="rounded-2xl bg-rose-50 p-4"><p className="font-black text-rose-900">{notSoldTarget?.item.customer}</p><p className="mt-1 text-sm font-semibold text-rose-700">This will close the quote as Not Sold.</p></div>
          <Field label="Not Sold reason">
            <select name="reason" className="field" defaultValue="price_too_high">
              <option value="price_too_high">Price too high</option>
              <option value="chose_another_option">Customer chose another option</option>
              <option value="no_response">No response from customer / source</option>
              <option value="no_longer_needed">Customer no longer needs coverage</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Other reason (required only when Other is selected)"><textarea name="otherReason" rows={3} className="field" placeholder="Type the reason here" /></Field>
          <button className="w-full rounded-xl bg-rose-600 px-4 py-3 font-black text-white hover:bg-rose-700">Confirm Not Sold</button>
        </form>
      </Modal>

      <Modal open={modal === "quote_result"} title="Quote Final Decision" subtitle="Price Sent moves the quote out of your active workload and into management follow-up." onClose={() => { setModal(null); setQuoteResultItemId(null); }}>
        <div className="p-6"><div className="rounded-2xl bg-slate-50 p-4"><p className="font-black">{quoteResultItem?.customer}</p><p className="mt-1 text-sm text-slate-500">{quoteResultItem ? workTypeLabels[quoteResultItem.workType] : "Quote"} · {quoteResultItem?.dealer}</p></div><div className="mt-5 grid gap-3"><button onClick={() => void finalizeActiveQuote("price_sent")} className="flex items-center justify-between rounded-2xl border border-blue-200 bg-blue-50 p-4 text-left"><div><p className="font-black text-blue-900">Price Sent</p><p className="mt-1 text-xs font-semibold text-blue-700">Remove from active workload and add to Pending Pricing.</p></div><Send className="h-5 w-5 text-blue-600" /></button><button onClick={() => void finalizeActiveQuote("sold")} className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-left"><div><p className="font-black text-emerald-900">Sold</p><p className="mt-1 text-xs font-semibold text-emerald-700">Close immediately as a sale.</p></div><CircleDollarSign className="h-5 w-5 text-emerald-600" /></button><button onClick={() => { if (quoteResultItem) requestNotSold({ kind: "active", item: quoteResultItem }); }} className="flex items-center justify-between rounded-2xl border border-rose-200 bg-rose-50 p-4 text-left"><div><p className="font-black text-rose-900">Not Sold</p><p className="mt-1 text-xs font-semibold text-rose-700">Close without a sale.</p></div><XCircle className="h-5 w-5 text-rose-600" /></button></div></div>
      </Modal>
    </div>
  );
}

function TeamPerformanceTable({ agentList, performance, currentUserId, efficiencyByAgent }: { agentList: Agent[]; performance: PerformanceRow[]; currentUserId: string; efficiencyByAgent: Map<string, { total: number; finalized: number; efficiency: number }> }) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Live Team Comparison</p><h3 className="mt-1 text-xl font-black">Activity and availability by agent</h3><p className="mt-1 text-sm text-slate-500">See who is available and whether an unavailable teammate still has active work that may need coverage. Completion Efficiency counts only quotes with a final Sold or Not Sold decision as completed.</p></div>
      <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Open Tasks</th><th className="px-5 py-3">WA Quotes</th><th className="px-5 py-3">RC Quotes</th><th className="px-5 py-3">Workload</th><th className="px-5 py-3">WA Updates</th><th className="px-5 py-3">Manual</th><th className="px-5 py-3">Sold</th><th className="px-5 py-3">Efficiency</th><th className="px-5 py-3">Turns Passed</th></tr></thead><tbody className="divide-y divide-slate-100">{agentList.map((agent) => { const row = performance.find((item) => item.agentId === agent.id) ?? { agentId: agent.id, whatsappQuotes: 0, ringCentralQuotes: 0, workloadTurns: 0, whatsappUpdates: 0, manualQuotes: 0, soldQuotes: 0, ownedActivations: 0, ownedChanges: 0, requotes: 0, passedTurns: 0 }; const efficiency = efficiencyByAgent.get(agent.name)?.efficiency ?? 0; const statusLabel = agent.availability === "available" ? "Available" : agent.availability === "break" ? "Break / Lunch" : "Unavailable"; const statusStyle = agent.availability === "available" ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : agent.availability === "break" ? "bg-amber-50 text-amber-700 ring-amber-200" : "bg-slate-100 text-slate-600 ring-slate-200"; const needsCoverage = agent.availability !== "available" && agent.activeCount > 0; return <tr key={agent.id} className={cn(agent.id === currentUserId ? "bg-[#f3f6fb]" : needsCoverage ? "bg-amber-50/40" : "hover:bg-slate-50")}><td className="px-5 py-4"><div className="flex items-center gap-3"><Avatar agent={agent} size="sm" /><p className="font-black">{agent.name}</p></div></td><td className="px-5 py-4"><span className={cn("inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-black ring-1", statusStyle)}><StatusDot status={agent.availability} />{statusLabel}</span></td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", needsCoverage ? "bg-amber-100 text-amber-800" : agent.activeCount ? "bg-[#eef3fb] text-[#223f7a]" : "bg-slate-100 text-slate-500")}>{agent.activeCount}{needsCoverage ? " · needs coverage" : ""}</span></td><td className="px-5 py-4 font-black">{row.whatsappQuotes}</td><td className="px-5 py-4 font-black">{row.ringCentralQuotes}</td><td className="px-5 py-4 font-black">{row.workloadTurns}</td><td className="px-5 py-4 font-black">{row.whatsappUpdates}</td><td className="px-5 py-4 font-black">{row.manualQuotes}</td><td className="px-5 py-4 font-black text-emerald-700">{row.soldQuotes}</td><td className="px-5 py-4"><span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">{efficiency.toFixed(1)}%</span></td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", row.passedTurns ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500")}>{row.passedTurns}</span></td></tr>; })}</tbody></table></div>
    </section>
  );
}


function ManagerView({
  agentList,
  sourceList,
  workItems,
  pendingPricing,
  quoteOutcomes,
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
  onSetRotation,
  onToggleRotation,
  onSetQueueOrder,
}: {
  agentList: Agent[];
  sourceList: SourceOption[];
  workItems: WorkItem[];
  pendingPricing: PendingPricingItem[];
  quoteOutcomes: QuoteOutcome[];
  performance: PerformanceRow[];
  passEvents: PassEvent[];
  whatsappCurrentId: string;
  ringCentralCurrentId: string;
  workloadCurrentId: string;
  managerTab: ManagerTab;
  setManagerTab: (tab: ManagerTab) => void;
  finalizePendingPricingSold: (item: PendingPricingItem) => Promise<void>;
  onRequestNotSold: (item: PendingPricingItem) => void;
  onOpenAssignQuote: () => void;
  onReassignWork: (itemId: string, profileId: string) => Promise<void>;
  onReassignPending: (itemId: string, profileId: string) => Promise<void>;
  onDeleteQuote: (stage: ManagerQuoteStage, quoteId: string, customer: string) => Promise<void>;
  onSetRotation: (rotation: RotationKind, profileId: string) => Promise<void>;
  onToggleRotation: (agent: Agent, rotation: RotationKind) => Promise<void>;
  onSetQueueOrder: (rotation: RotationKind, profileIds: string[]) => Promise<void>;
}) {
  const [reportView, setReportView] = useState<ReportView>("executive");
  const [quoteSearch, setQuoteSearch] = useState("");
  const [managerNow] = useState(() => Date.now());
  const today = new Date();
  const weekAgo = new Date();
  weekAgo.setDate(today.getDate() - 6);
  const [reportStart, setReportStart] = useState(dateInputValue(weekAgo));
  const [reportEnd, setReportEnd] = useState(dateInputValue(today));
  const activeTasks = workItems.filter(isActiveTask);

  const openCountByAgent = useMemo(() => activeTasks.reduce<Record<string, number>>((acc, item) => { acc[item.assignedAgent] = (acc[item.assignedAgent] ?? 0) + 1; return acc; }, {}), [activeTasks]);
  const maxWorkload = Object.entries(openCountByAgent).sort((a, b) => b[1] - a[1])[0];
  const stalePricing = pendingPricing.filter((item) => daysSince(item.priceSentAt) >= 1);
  const awaitingAcceptance = activeTasks.filter((item) => !item.acceptedAt);
  const staleAssignments = awaitingAcceptance.filter((item) => (managerNow - new Date(item.assignedAt).getTime()) >= 5 * 60_000);
  const unavailableWithWork = agentList.filter((agent) => agent.availability === "unavailable" && (openCountByAgent[agent.name] ?? 0) > 0);
  const managerAlerts = [
    ...(awaitingAcceptance.length ? [`${awaitingAcceptance.length} assigned item${awaitingAcceptance.length === 1 ? " is" : "s are"} waiting for agent acceptance.`] : []),
    ...(staleAssignments.length ? [`${staleAssignments.length} assignment${staleAssignments.length === 1 ? " has" : "s have"} been waiting more than 5 minutes for acceptance.`] : []),
    ...(pendingPricing.length ? [`${pendingPricing.length} quotes are waiting on source confirmation.`] : []),
    ...(stalePricing.length ? [`${stalePricing.length} pending pricing items should be followed up today.`] : []),
    ...(unavailableWithWork.length ? [`${unavailableWithWork.length} unavailable agent${unavailableWithWork.length === 1 ? " has" : "s have"} active tasks.`] : []),
    ...(maxWorkload ? [`${maxWorkload[0]} currently has the highest active workload: ${maxWorkload[1]} tasks.`] : []),
  ];

  const quoteRecords = useMemo(() => {
    const rows = [
      ...workItems.filter(isQuote).map((item) => ({
        id: item.id,
        stage: "active" as const,
        status: "Active",
        statusDate: item.createdAt,
        customer: item.customer,
        source: item.dealer,
        agent: item.assignedAgent,
        workType: item.workType,
        receivedThrough: item.receivedThrough || "Unknown",
      })),
      ...pendingPricing.map((item) => ({
        id: item.id,
        stage: "pending" as const,
        status: "Price Sent",
        statusDate: item.priceSentAt,
        customer: item.customer,
        source: item.dealer,
        agent: item.assignedAgent,
        workType: item.workType,
        receivedThrough: item.receivedThrough || "Unknown",
      })),
      ...quoteOutcomes.map((item) => ({
        id: item.id,
        stage: "finalized" as const,
        status: item.decision === "sold" ? "Sold" : "Not Sold",
        statusDate: item.finalizedAt,
        customer: item.customer,
        source: item.dealer,
        agent: item.assignedAgent,
        workType: item.workType,
        receivedThrough: item.receivedThrough || "Unknown",
      })),
    ];
    return rows.sort((a, b) => new Date(b.statusDate).getTime() - new Date(a.statusDate).getTime());
  }, [pendingPricing, quoteOutcomes, workItems]);

  const visibleQuoteRecords = useMemo(() => {
    const needle = quoteSearch.trim().toLowerCase();
    if (!needle) return quoteRecords;
    return quoteRecords.filter((item) => [item.customer, item.source, item.agent, item.status, item.receivedThrough, workTypeLabels[item.workType]].some((value) => value.toLowerCase().includes(needle)));
  }, [quoteRecords, quoteSearch]);

  const tabs: Array<{ id: ManagerTab; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: "overview", label: "Overview", icon: <ShieldCheck className="h-4 w-4" /> },
    { id: "tasks", label: "Open Tasks", icon: <ClipboardList className="h-4 w-4" />, badge: activeTasks.length },
    { id: "pricing", label: "Pending Pricing", icon: <Clock3 className="h-4 w-4" />, badge: pendingPricing.length },
    { id: "quotes", label: "Quote Records", icon: <Table2 className="h-4 w-4" />, badge: quoteRecords.length },
    { id: "reports", label: "Reports", icon: <BarChart3 className="h-4 w-4" /> },
    { id: "team", label: "Team Controls", icon: <Settings2 className="h-4 w-4" /> },
    { id: "sources", label: "Sources", icon: <Store className="h-4 w-4" />, badge: sourceList.length },
    { id: "users", label: "Users", icon: <UserPlus className="h-4 w-4" /> },
  ];

  function setPreset(kind: "today" | "yesterday" | "week" | "month") {
    const end = new Date();
    const start = new Date();
    if (kind === "yesterday") { start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); }
    if (kind === "week") start.setDate(start.getDate() - 6);
    if (kind === "month") start.setDate(1);
    setReportStart(dateInputValue(start));
    setReportEnd(dateInputValue(end));
  }

  const reportData = useMemo(() => {
    const activeQuotes = workItems.filter((item) => isQuote(item) && withinDateRange(item.createdAt, reportStart, reportEnd)).map((item) => ({
      id: item.id, createdAt: item.createdAt, assignedAt: item.assignedAt, acceptedAt: item.acceptedAt, priceSentAt: undefined as string | undefined, finalizedAt: undefined as string | undefined, customer: item.customer, dealer: item.dealer, workType: item.workType as "new_quote" | "requote", agent: item.assignedAgent, method: item.assignmentMethod, channel: item.receivedThrough || "Unknown", lifecycle: "Active", decision: "", notSoldReason: undefined as string | undefined,
    }));
    const pending = pendingPricing.filter((item) => withinDateRange(item.quoteCreatedAt, reportStart, reportEnd)).map((item) => ({
      id: item.id, createdAt: item.quoteCreatedAt, assignedAt: item.assignedAt, acceptedAt: item.acceptedAt, priceSentAt: item.priceSentAt, finalizedAt: undefined as string | undefined, customer: item.customer, dealer: item.dealer, workType: item.workType, agent: item.assignedAgent, method: item.assignmentMethod, channel: item.receivedThrough || "Unknown", lifecycle: "Price Sent", decision: "", notSoldReason: undefined as string | undefined,
    }));
    const outcomes = quoteOutcomes.filter((item) => withinDateRange(item.quoteCreatedAt, reportStart, reportEnd)).map((item) => ({
      id: item.id, createdAt: item.quoteCreatedAt, assignedAt: item.assignedAt, acceptedAt: item.acceptedAt, priceSentAt: item.priceSentAt, finalizedAt: item.finalizedAt, customer: item.customer, dealer: item.dealer, workType: item.workType, agent: item.assignedAgent, method: item.assignmentMethod, channel: item.receivedThrough || "Unknown", lifecycle: item.decision === "sold" ? "Sold" : "Not Sold", decision: item.decision, notSoldReason: item.decision === "not_sold" ? (item.notSoldReason === "other" ? item.notSoldReasonOther || "Other" : item.notSoldReason ? notSoldReasonLabels[item.notSoldReason] : "Unknown") : undefined,
    }));
    const quotes = [...activeQuotes, ...pending, ...outcomes];
    const service = workItems.filter((item) => !isQuote(item) && withinDateRange(item.createdAt, reportStart, reportEnd));
    const sold = quotes.filter((item) => item.lifecycle === "Sold").length;
    const notSold = quotes.filter((item) => item.lifecycle === "Not Sold").length;
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

    const averageDuration = (values: Array<number | null>) => {
      const valid = values.filter((value): value is number => value !== null);
      return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
    };

    const timingByAgent = agentList.map((agent) => {
      const rows = timingRows.filter((item) => item.agent === agent.name);
      return {
        agent: agent.name,
        quotes: rows.length,
        accepted: rows.filter((item) => item.acceptedAt).length,
        avgAccept: averageDuration(rows.map((item) => item.timeToAccept)),
        avgPrice: averageDuration(rows.map((item) => item.timeToPrice)),
        avgFinal: averageDuration(rows.map((item) => item.timeToFinal)),
        avgPriceDecision: averageDuration(rows.map((item) => item.priceToDecision)),
        avgTotalCycle: averageDuration(rows.map((item) => item.totalCycle)),
      };
    }).sort((a, b) => (a.avgFinal ?? Number.POSITIVE_INFINITY) - (b.avgFinal ?? Number.POSITIVE_INFINITY));

    const byAgent = agentList.map((agent) => {
      const rows = quotes.filter((item) => item.agent === agent.name);
      const serviceRows = service.filter((item) => item.assignedAgent === agent.name);
      const agentSold = rows.filter((item) => item.lifecycle === "Sold").length;
      const agentNotSold = rows.filter((item) => item.lifecycle === "Not Sold").length;
      const agentDecided = agentSold + agentNotSold;
      const passes = passEvents.filter((event) => event.actorAgentId === agent.id && withinDateRange(event.createdAt, reportStart, reportEnd)).length;
      return {
        agent: agent.name,
        quotes: rows.length,
        whatsapp: rows.filter((item) => item.method === "whatsapp_turn").length,
        ringcentral: rows.filter((item) => item.method === "ringcentral_turn").length,
        manual: rows.filter((item) => item.method === "manual_quote").length,
        workload: serviceRows.filter((item) => item.assignmentMethod === "workload_turn").length,
        updates: serviceRows.filter((item) => item.assignmentMethod === "update_log").length,
        sold: agentSold,
        notSold: agentNotSold,
        finalized: agentDecided,
        pending: rows.filter((item) => item.lifecycle === "Price Sent").length,
        passes,
        efficiency: rows.length ? (agentDecided / rows.length) * 100 : 0,
        conversion: agentDecided ? (agentSold / agentDecided) * 100 : 0,
      };
    }).sort((a, b) => b.quotes - a.quotes);

    const group = (key: "channel" | "dealer") => {
      const map = new Map<string, { name: string; quotes: number; sold: number; notSold: number; pending: number }>();
      quotes.forEach((item) => {
        const name = item[key];
        const row = map.get(name) || { name, quotes: 0, sold: 0, notSold: 0, pending: 0 };
        row.quotes += 1;
        if (item.lifecycle === "Sold") row.sold += 1;
        if (item.lifecycle === "Not Sold") row.notSold += 1;
        if (item.lifecycle === "Price Sent") row.pending += 1;
        map.set(name, row);
      });
      return Array.from(map.values()).map((row) => {
        const finalized = row.sold + row.notSold;
        return { ...row, finalized, efficiency: row.quotes ? (finalized / row.quotes) * 100 : 0, conversion: finalized ? (row.sold / finalized) * 100 : 0 };
      }).sort((a, b) => b.quotes - a.quotes);
    };

    const notSoldReasonMap = new Map<string, number>();
    outcomes.filter((item) => item.lifecycle === "Not Sold").forEach((item) => {
      const reason = item.notSoldReason || "Unknown";
      notSoldReasonMap.set(reason, (notSoldReasonMap.get(reason) || 0) + 1);
    });
    const notSoldReasons = Array.from(notSoldReasonMap.entries()).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    const pendingInRange = pendingPricing.filter((item) => withinDateRange(item.priceSentAt, reportStart, reportEnd));
    const totalPasses = passEvents.filter((event) => withinDateRange(event.createdAt, reportStart, reportEnd)).length;
    return { quotes, timingRows, timingByAgent, notSoldReasons, service, sold, notSold, finalized, efficiency, conversion, pendingInRange, totalPasses, byAgent, byChannel: group("channel"), bySource: group("dealer") };
  }, [agentList, passEvents, pendingPricing, quoteOutcomes, reportEnd, reportStart, workItems]);

  function exportAllQuotes() {
    downloadCsv(`quotes-${reportStart}-to-${reportEnd}.csv`, reportData.timingRows.map((row) => ({
      "Quote Created": formatDateTime(row.createdAt),
      "Assigned At": formatDateTime(row.assignedAt),
      "Accepted At": row.acceptedAt ? formatDateTime(row.acceptedAt) : "",
      "Price Sent At": row.priceSentAt ? formatDateTime(row.priceSentAt) : "",
      "Final Decision At": row.finalizedAt ? formatDateTime(row.finalizedAt) : "",
      Customer: row.customer,
      Source: row.dealer,
      Type: workTypeLabels[row.workType],
      Agent: row.agent,
      "Input Method": row.channel,
      Status: row.lifecycle,
      "Not Sold Reason": row.notSoldReason || "",
      "Minutes Assign to Take": row.timeToAccept === null ? "" : Math.round(row.timeToAccept),
      "Minutes Take to Price": row.timeToPrice === null ? "" : Math.round(row.timeToPrice),
      "Minutes Take to Final": row.timeToFinal === null ? "" : Math.round(row.timeToFinal),
      "Minutes Price to Decision": row.priceToDecision === null ? "" : Math.round(row.priceToDecision),
      "Total Cycle Minutes": row.totalCycle === null ? "" : Math.round(row.totalCycle),
    })));
  }

  function exportPendingPricing() {
    downloadCsv(`pending-pricing-${dateInputValue(new Date())}.csv`, pendingPricing.map((item) => ({ "Price Sent": formatDateTime(item.priceSentAt), "Days Waiting": daysSince(item.priceSentAt), Customer: item.customer, Source: item.dealer, Type: workTypeLabels[item.workType], Agent: item.assignedAgent, "Input Method": item.receivedThrough || "" })));
  }

  function exportAgentReport() {
    downloadCsv(`agent-performance-${reportStart}-to-${reportEnd}.csv`, reportData.byAgent.map((row) => ({ Agent: row.agent, Quotes: row.quotes, "Finalized Quotes": row.finalized, WhatsApp: row.whatsapp, RingCentral: row.ringcentral, Manual: row.manual, "Workload Turns": row.workload, "WhatsApp Updates": row.updates, "Turns Passed": row.passes, Sold: row.sold, "Not Sold": row.notSold, "Price Sent": row.pending, "Efficiency %": row.efficiency.toFixed(1), "Conversion %": row.conversion.toFixed(1) })));
  }

  function exportSourceReport() {
    downloadCsv(`source-performance-${reportStart}-to-${reportEnd}.csv`, reportData.bySource.map((row) => ({ Source: row.name, Quotes: row.quotes, "Finalized Quotes": row.finalized, Sold: row.sold, "Not Sold": row.notSold, "Price Sent": row.pending, "Efficiency %": row.efficiency.toFixed(1), "Conversion %": row.conversion.toFixed(1) })));
  }

  function exportServiceActivity() {
    downloadCsv(`service-activity-${reportStart}-to-${reportEnd}.csv`, reportData.service.map((item) => ({ Date: formatDateTime(item.createdAt), Customer: item.customer, Source: item.dealer, Type: workTypeLabels[item.workType], Agent: item.assignedAgent, Method: methodStyles[item.assignmentMethod].label, Status: item.status })));
  }

  function exportTimingReport() {
    downloadCsv(`quote-timing-${reportStart}-to-${reportEnd}.csv`, reportData.timingByAgent.map((row) => ({
      Agent: row.agent,
      Quotes: row.quotes,
      Accepted: row.accepted,
      "Avg Assignment to Acceptance": formatDuration(row.avgAccept),
      "Avg Acceptance to Price": formatDuration(row.avgPrice),
      "Avg Acceptance to Final Decision": formatDuration(row.avgFinal),
      "Avg Price Sent to Decision": formatDuration(row.avgPriceDecision),
      "Avg Total Quote Cycle": formatDuration(row.avgTotalCycle),
    })));
  }

  return (
    <div className="space-y-5">
      <TabBar tabs={tabs} value={managerTab} onChange={setManagerTab} />

      {managerTab === "overview" ? (
        <div className="space-y-5">
          <section className="flex flex-col gap-4 rounded-[28px] border border-[#c9d5e9] bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><FilePlus2 className="h-4 w-4" /> Manager Quick Action</div><h2 className="mt-1 text-2xl font-black tracking-tight">Create and assign a quote</h2><p className="mt-1 text-sm text-slate-500">Assign a quote directly to any agent. No queue moves, and the assignment timestamp starts immediately.</p></div>
            <button onClick={onOpenAssignQuote} className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-[#223f7a] px-5 py-3 text-sm font-black text-white hover:bg-[#17305f]"><UserPlus className="h-4 w-4" /> Create & Assign Quote</button>
          </section>

          <section className="rounded-[28px] border border-amber-200 bg-amber-50 p-6 shadow-sm">
            <div className="flex items-start gap-3"><Bell className="mt-0.5 h-5 w-5 text-amber-700" /><div className="min-w-0 flex-1"><div className="flex items-center justify-between gap-3"><div><p className="font-black text-amber-950">Manager alerts</p><p className="mt-1 text-xs font-semibold text-amber-700">Updates automatically when live work, availability, or pricing follow-up changes.</p></div><span className="inline-flex items-center gap-2 rounded-full bg-white/70 px-2.5 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-700 ring-1 ring-amber-200"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> Live</span></div>{managerAlerts.length ? <ul className="mt-4 grid gap-3 md:grid-cols-2 text-sm font-semibold text-amber-900">{managerAlerts.map((alert) => <li key={alert} className="flex gap-2 rounded-2xl bg-white/55 p-3"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />{alert}</li>)}</ul> : <p className="mt-4 rounded-2xl bg-white/55 p-4 text-sm font-bold text-emerald-700">No operational alerts right now.</p>}</div></div>
          </section>

          <section>
            <div className="mb-4"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Rotation Control</p><h2 className="mt-1 text-2xl font-black tracking-tight">Current turns</h2><p className="mt-1 text-sm text-slate-500">Change a rotation only when management needs to correct the order.</p></div>
            <div className="grid gap-5 xl:grid-cols-3">
              {([ ["whatsapp", whatsappCurrentId], ["ringcentral", ringCentralCurrentId], ["workload", workloadCurrentId] ] as const).map(([kind, currentId]) => { const current = agentList.find((agent) => agent.id === currentId) ?? agentList[0]; const config = rotationConfig[kind]; return <div key={kind} className="rounded-[26px] border border-slate-200 bg-white p-5 shadow-sm"><div className={cn("flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em]", config.accent)}>{config.icon}{config.title}</div><div className="mt-4 flex items-center gap-3"><Avatar agent={current} /><div><p className="text-xs font-bold text-slate-400">Current</p><p className="font-black">{current.name}</p></div></div><select value={currentId} onChange={(event) => void onSetRotation(kind, event.target.value)} className="mt-4 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-black">{agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>; })}
            </div>
          </section>
        </div>
      ) : null}

      {managerTab === "tasks" ? (
        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">All Open Tasks</p><h3 className="mt-1 text-xl font-black">Redistribute active work</h3><p className="mt-1 text-sm text-slate-500">Pending pricing is intentionally excluded from workload.</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-slate-100 px-3 py-1.5 text-xs font-black text-slate-600">{activeTasks.length} open</span><button onClick={onOpenAssignQuote} className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-4 py-2.5 text-xs font-black text-white"><FilePlus2 className="h-4 w-4" /> Create & Assign Quote</button></div></div>
          <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Work</th><th className="px-5 py-3">Owner</th><th className="px-5 py-3">Assigned</th><th className="px-5 py-3">Acceptance</th><th className="px-5 py-3">Source</th><th className="px-5 py-3">Assigned</th></tr></thead><tbody className="divide-y divide-slate-100">{activeTasks.map((item) => <tr key={item.id}><td className="px-5 py-4"><p className="font-black">{item.customer}</p><p className="mt-1 text-xs text-slate-400">{item.dealer}</p></td><td className="px-5 py-4"><p className="font-bold">{workTypeLabels[item.workType]}</p><div className="mt-2"><MethodBadge method={item.assignmentMethod} /></div></td><td className="px-5 py-4 text-slate-600">{item.originalOwner || "—"}</td><td className="px-5 py-4"><select value={agentList.find((agent) => agent.name === item.assignedAgent)?.id || ""} onChange={(event) => void onReassignWork(item.id, event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black">{agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></td><td className="px-5 py-4">{item.acceptedAt ? <div><span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-black text-emerald-700">Accepted</span><p className="mt-2 text-[10px] font-semibold text-slate-400">{formatDateTime(item.acceptedAt)}</p></div> : <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-black text-amber-700">Awaiting acceptance</span>}</td><td className="px-5 py-4 text-slate-600">{item.receivedThrough}</td><td className="px-5 py-4 text-xs font-semibold text-slate-400">{formatDateTime(item.assignedAt)}</td></tr>)}</tbody></table></div>
        </section>
      ) : null}

      {managerTab === "pricing" ? (
        <section className="overflow-hidden rounded-[28px] border border-blue-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 lg:flex-row lg:items-center lg:justify-between"><div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-blue-600"><Clock3 className="h-4 w-4" /> Pending Pricing Follow-Up</div><h3 className="mt-1 text-xl font-black">Management follow-up list</h3><p className="mt-1 text-sm text-slate-500">Pull this list at the end of the day and follow up the next business day.</p></div><button onClick={exportPendingPricing} className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-black text-white"><Download className="h-4 w-4" /> Export Pending CSV</button></div>
          <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-blue-50/60 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Price Sent</th><th className="px-5 py-3">Age</th><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Source</th><th className="px-5 py-3">Decision</th></tr></thead><tbody className="divide-y divide-slate-100">{pendingPricing.map((item) => <tr key={item.id} className={daysSince(item.priceSentAt) >= 2 ? "bg-amber-50/40" : ""}><td className="px-5 py-4"><p className="font-black">{item.customer}</p><p className="mt-1 text-xs text-slate-400">{item.dealer} · {workTypeLabels[item.workType]}</p></td><td className="px-5 py-4 text-xs font-semibold text-slate-600">{formatDateTime(item.priceSentAt)}</td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", daysSince(item.priceSentAt) >= 2 ? "bg-amber-100 text-amber-800" : "bg-blue-50 text-blue-700")}>{daysSince(item.priceSentAt)} day{daysSince(item.priceSentAt) === 1 ? "" : "s"}</span></td><td className="px-5 py-4"><select value={agentList.find((agent) => agent.name === item.assignedAgent)?.id || ""} onChange={(event) => void onReassignPending(item.id, event.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-black">{agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></td><td className="px-5 py-4 text-slate-600">{item.receivedThrough}</td><td className="px-5 py-4"><div className="flex gap-2"><button onClick={() => void finalizePendingPricingSold(item)} className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black text-white">Sold</button><button onClick={() => onRequestNotSold(item)} className="rounded-lg bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 ring-1 ring-rose-200">Not Sold</button></div></td></tr>)}</tbody></table></div>
        </section>
      ) : null}

      {managerTab === "quotes" ? (
        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><Table2 className="h-4 w-4" /> Quote Records</div>
              <h3 className="mt-1 text-xl font-black">Manage every quote status</h3>
              <p className="mt-1 text-sm text-slate-500">Delete incorrect or test quotes from Active, Pending Pricing, Sold, or Not Sold. Deleted quotes stop counting in performance and reports.</p>
            </div>
            <div className="relative w-full lg:max-w-md">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={quoteSearch} onChange={(event) => setQuoteSearch(event.target.value)} placeholder="Search customer, source, agent, status..." className="field" style={{ paddingLeft: "3rem" }} />
            </div>
          </div>
          <div className="border-b border-amber-100 bg-amber-50 px-6 py-3 text-xs font-semibold text-amber-900">Deletion is manager-only, requires a reason, and is permanently recorded in the audit log.</div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Source / Input</th><th className="px-5 py-3">Last Status</th><th className="px-5 py-3">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {visibleQuoteRecords.map((item) => {
                  const statusClass = item.status === "Sold" ? "bg-emerald-50 text-emerald-700" : item.status === "Not Sold" ? "bg-rose-50 text-rose-700" : item.status === "Price Sent" ? "bg-blue-50 text-blue-700" : "bg-amber-50 text-amber-700";
                  return <tr key={`${item.stage}-${item.id}`} className="hover:bg-slate-50"><td className="px-5 py-4"><p className="font-black text-slate-900">{item.customer}</p><p className="mt-1 text-xs text-slate-400">{item.source}</p></td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", statusClass)}>{item.status}</span></td><td className="px-5 py-4 font-bold text-slate-600">{workTypeLabels[item.workType]}</td><td className="px-5 py-4 font-bold text-slate-700">{item.agent}</td><td className="px-5 py-4"><p className="font-semibold text-slate-600">{item.source}</p><p className="mt-1 text-xs text-slate-400">{item.receivedThrough}</p></td><td className="px-5 py-4 text-xs font-semibold text-slate-500">{formatDateTime(item.statusDate)}</td><td className="px-5 py-4"><button onClick={() => void onDeleteQuote(item.stage, item.id, item.customer)} className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 transition hover:bg-rose-100"><Trash2 className="h-4 w-4" /> Delete</button></td></tr>;
                })}
              </tbody>
            </table>
          </div>
          {!visibleQuoteRecords.length ? <div className="p-8 text-center text-sm font-semibold text-slate-500">No quote records match your search.</div> : null}
        </section>
      ) : null}

      {managerTab === "reports" ? (
        <section className="space-y-5">
          <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between"><div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><BarChart3 className="h-4 w-4" /> Reports Center</div><h2 className="mt-2 text-2xl font-black">Operational and sales intelligence</h2><p className="mt-1 text-sm text-slate-500">Select any date range, then analyze or export the filtered data.</p></div><div className="flex flex-wrap items-end gap-3"><Field label="Start date"><input type="date" value={reportStart} onChange={(event) => setReportStart(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" /></Field><Field label="End date"><input type="date" value={reportEnd} onChange={(event) => setReportEnd(event.target.value)} className="rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-bold" /></Field></div></div>
            <div className="mt-5 flex flex-wrap gap-2"><button onClick={() => setPreset("today")} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">Today</button><button onClick={() => setPreset("yesterday")} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">Yesterday</button><button onClick={() => setPreset("week")} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">Last 7 Days</button><button onClick={() => setPreset("month")} className="rounded-xl bg-slate-100 px-3 py-2 text-xs font-black text-slate-600">This Month</button><span className="ml-auto text-xs font-bold text-slate-400">Showing {formatDate(`${reportStart}T12:00:00`)} – {formatDate(`${reportEnd}T12:00:00`)}</span></div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5"><SummaryCard label="Quotes" value={reportData.quotes.length} note="All input methods" icon={<ClipboardList className="h-5 w-5 text-[#223f7a]" />} tone="bg-[#eef3fb]" /><SummaryCard label="Finalized" value={reportData.finalized} note="Sold + Not Sold" icon={<CheckCircle2 className="h-5 w-5 text-cyan-700" />} tone="bg-cyan-50" /><SummaryCard label="Efficiency" value={`${reportData.efficiency.toFixed(1)}%`} note="Finalized ÷ all quotes" icon={<Gauge className="h-5 w-5 text-cyan-700" />} tone="bg-cyan-50" /><SummaryCard label="Sold" value={reportData.sold} note="Final decisions" icon={<CircleDollarSign className="h-5 w-5 text-emerald-700" />} tone="bg-emerald-50" /><SummaryCard label="Not Sold" value={reportData.notSold} note="Final decisions" icon={<XCircle className="h-5 w-5 text-rose-700" />} tone="bg-rose-50" /><SummaryCard label="Conversion" value={`${reportData.conversion.toFixed(1)}%`} note="Sold ÷ finalized" icon={<TrendingUp className="h-5 w-5 text-[#223f7a]" />} tone="bg-[#eef3fb]" /><SummaryCard label="Pending Now" value={pendingPricing.length} note="Current follow-up list" icon={<Clock3 className="h-5 w-5 text-amber-700" />} tone="bg-amber-50" /><SummaryCard label="Turns Passed" value={reportData.totalPasses} note="Selected date range" icon={<SkipForward className="h-5 w-5 text-rose-700" />} tone="bg-rose-50" /><SummaryCard label="Service Activity" value={reportData.service.length} note="Updates + service work" icon={<BriefcaseBusiness className="h-5 w-5 text-violet-700" />} tone="bg-violet-50" /></div>

          <div className="flex gap-1 overflow-x-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm">{([ ["executive", "Executive", <Gauge className="h-4 w-4" key="i" />], ["agents", "Agents", <UsersRound className="h-4 w-4" key="i" />], ["timing", "Quote Timing", <Clock3 className="h-4 w-4" key="i" />], ["channels", "Input Methods", <PieChart className="h-4 w-4" key="i" />], ["sources", "Sources", <Table2 className="h-4 w-4" key="i" />], ["followup", "Follow-Up", <Clock3 className="h-4 w-4" key="i" />], ["activity", "Service Activity", <Activity className="h-4 w-4" key="i" />] ] as Array<[ReportView, string, React.ReactNode]>).map(([id, label, icon]) => <button key={id} onClick={() => setReportView(id)} className={cn("flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-black", reportView === id ? "bg-[#223f7a] text-white" : "text-slate-500 hover:bg-slate-50")}>{icon}{label}</button>)}</div>

          {reportView === "executive" ? <ExecutiveReport reportData={reportData} pendingPricing={pendingPricing} /> : null}
          {reportView === "agents" ? <AgentOperationsReport rows={reportData.byAgent} /> : null}
          {reportView === "timing" ? <QuoteTimingReport rows={reportData.timingByAgent} details={reportData.timingRows} /> : null}
          {reportView === "channels" ? <RankedReportTable title="Input Method Performance" rows={reportData.byChannel} /> : null}
          {reportView === "sources" ? <RankedReportTable title="Source Performance" rows={reportData.bySource} /> : null}
          {reportView === "followup" ? <FollowUpReport pendingPricing={reportData.pendingInRange} /> : null}
          {reportView === "activity" ? <ServiceActivityReport items={reportData.service} /> : null}

          <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Exports</p><h3 className="mt-1 text-xl font-black">Download report data</h3><p className="mt-1 text-sm text-slate-500">CSV files open directly in Excel.</p></div><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-6"><ExportButton label="All Quote Data" onClick={exportAllQuotes} /><ExportButton label="Quote Timing" onClick={exportTimingReport} /><ExportButton label="Pending Pricing" onClick={exportPendingPricing} /><ExportButton label="Agent Performance" onClick={exportAgentReport} /><ExportButton label="Source Performance" onClick={exportSourceReport} /><ExportButton label="Service Activity" onClick={exportServiceActivity} /></div></section>
        </section>
      ) : null}

      {managerTab === "sources" ? <SourceAdminPanel /> : null}

      {managerTab === "users" ? <UserAdminPanel /> : null}

      {managerTab === "team" ? (
        <div className="space-y-5">
          <QueueOrderPanel agentList={agentList} onSave={onSetQueueOrder} />
        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 p-6">
            <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Team Controls</p>
            <h3 className="mt-1 text-xl font-black">Availability and rotation eligibility</h3>
            <p className="mt-2 max-w-4xl text-sm text-slate-500"><strong className="text-[#223f7a]">Active</strong> means the agent is eligible for that queue. When the agent is on Lunch or Unavailable, the queue shows <strong>Skipped</strong> and the rotation automatically moves around them. Their eligibility is preserved until they return.</p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">WhatsApp</th><th className="px-5 py-3">RingCentral</th><th className="px-5 py-3">Workload</th><th className="px-5 py-3">Active Tasks</th><th className="px-5 py-3">Pending Pricing</th><th className="px-5 py-3">Passes Today</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {agentList.map((agent) => {
                  const performanceRow = performance.find((row) => row.agentId === agent.id);
                  const queueCells = ([
                    ["whatsapp", "whatsappActive"],
                    ["ringcentral", "ringCentralActive"],
                    ["workload", "workloadActive"],
                  ] as const);
                  return (
                    <tr key={agent.id}>
                      <td className="px-5 py-4"><div className="flex items-center gap-3"><Avatar agent={agent} size="sm" /><p className="font-black">{agent.name}</p></div></td>
                      <td className="px-5 py-4"><span className="inline-flex items-center gap-2 text-xs font-black capitalize"><StatusDot status={agent.availability} />{agent.availability === "break" ? "Break / Lunch" : agent.availability}</span></td>
                      {queueCells.map(([rotation, key]) => {
                        const eligible = agent[key];
                        const skipped = eligible && agent.availability !== "available";
                        const label = !eligible ? "Paused" : skipped ? `Skipped · ${agent.availability === "break" ? "Lunch" : "Unavailable"}` : "Active";
                        const style = !eligible ? "bg-slate-100 text-slate-500" : skipped ? (agent.availability === "break" ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-600") : "bg-[#eef3fb] text-[#223f7a]";
                        return <td key={key} className="px-5 py-4"><button onClick={() => void onToggleRotation(agent, rotation)} className={cn("rounded-full px-3 py-1.5 text-xs font-black", style)} title={eligible ? "Click to pause this agent from the queue" : "Click to activate this agent in the queue"}>{label}</button></td>;
                      })}
                      <td className="px-5 py-4 font-black">{openCountByAgent[agent.name] ?? 0}</td>
                      <td className="px-5 py-4 font-black text-[#223f7a]">{pendingPricing.filter((item) => item.assignedAgent === agent.name).length}</td>
                      <td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", performanceRow?.passedTurns ? "bg-rose-50 text-rose-700" : "bg-slate-100 text-slate-500")}>{performanceRow?.passedTurns ?? 0}</span></td>
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
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadSources = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("dealers")
      .select("id,name,notes,is_active,created_at")
      .order("name");
    if (loadError) {
      setError(loadError.message);
    } else {
      setSources((data ?? []) as SourceAdminRow[]);
      setError("");
    }
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => { void loadSources(); }, 0);
    const channel = supabase
      .channel("dealer-admin-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "dealers" }, () => void loadSources())
      .subscribe();
    return () => { window.clearTimeout(initialLoad); void supabase.removeChannel(channel); };
  }, [loadSources, supabase]);

  const visibleSources = useMemo(() => {
    const needle = normalizeSourceSearch(search);
    if (!needle) return dealers;
    return dealers.filter((dealer) => normalizeSourceSearch(dealer.name).includes(needle) || normalizeSourceSearch(dealer.notes ?? "").includes(needle));
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
    if (cleanName.length < 2) return setError("Source name must contain at least two characters.");

    const normalized = normalizeSourceSearch(cleanName);
    const duplicate = dealers.find((dealer) => dealer.id !== editingId && normalizeSourceSearch(dealer.name) === normalized);
    if (duplicate) return setError(`A source named “${duplicate.name}” already exists.`);

    setSaving(true);
    setError("");
    setMessage("");
    const payload = { name: cleanName, notes: notes.trim() || null };
    const result = editingId
      ? await supabase.from("dealers").update(payload).eq("id", editingId)
      : await supabase.from("dealers").insert(payload);
    setSaving(false);

    if (result.error) return setError(result.error.message);
    setMessage(editingId ? "Source updated." : "Source created and immediately available to agents.");
    clearForm();
    await loadSources();
  }

  async function toggleSource(dealer: SourceAdminRow) {
    const action = dealer.is_active ? "deactivate" : "reactivate";
    if (dealer.is_active && !window.confirm(`Deactivate ${dealer.name}? Historical reports will remain unchanged.`)) return;
    const { error: updateError } = await supabase.from("dealers").update({ is_active: !dealer.is_active }).eq("id", dealer.id);
    if (updateError) return setError(updateError.message);
    setMessage(`${dealer.name} ${action === "deactivate" ? "deactivated" : "reactivated"}.`);
    if (editingId === dealer.id) clearForm();
    await loadSources();
  }

  return (
    <div className="space-y-5">
      <section className="grid gap-5 xl:grid-cols-[.62fr_1.38fr]">
        <div className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]"><Store className="h-5 w-5" /></div>
            <div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Source Administration</p><h3 className="mt-1 text-xl font-black">{editingId ? "Edit source" : "Create a source"}</h3></div>
          </div>
          <p className="mt-3 text-sm text-slate-500">Only management can change this directory. Active sources appear instantly in every agent quote form.</p>
          {error ? <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div> : null}
          {message ? <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700">{message}</div> : null}
          <form onSubmit={saveSource} className="mt-6 space-y-4">
            <Field label="Source name"><input value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} className="field" placeholder="Paste or type the official source name" /></Field>
            <Field label="Management notes (optional)"><textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={4} maxLength={500} className="field" placeholder="Internal note, location, alternate name, or contact detail" /></Field>
            <div className="flex gap-2">
              <button disabled={saving} className="flex flex-1 items-center justify-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3 font-black text-white transition hover:bg-[#17305f] disabled:opacity-60"><Check className="h-5 w-5" />{saving ? "Saving..." : editingId ? "Save Changes" : "Create Source"}</button>
              {editingId ? <button type="button" onClick={clearForm} className="rounded-2xl border border-slate-200 px-4 py-3 font-black text-slate-600 hover:bg-slate-50">Cancel</button> : null}
            </div>
          </form>
        </div>

        <div className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-100 p-6 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Source Directory</p><h3 className="mt-1 text-xl font-black">{dealers.length} sources</h3><p className="mt-1 text-sm text-slate-500">Deactivate old sources instead of deleting them so historical reports remain intact.</p></div>
            <div className="relative w-full sm:max-w-sm"><Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" /><input value={search} onChange={(event) => setSearch(event.target.value)} className="field" style={{ paddingLeft: "3rem" }} placeholder="Search source name or notes" /></div>
          </div>
          <div className="max-h-[650px] overflow-auto">
            {loading ? <div className="p-8 text-sm font-semibold text-slate-500">Loading sources...</div> : visibleSources.length ? (
              <div className="divide-y divide-slate-100">
                {visibleSources.map((dealer) => (
                  <div key={dealer.id} className={cn("flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between", !dealer.is_active && "bg-slate-50/80")}>
                    <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className={cn("font-black", !dealer.is_active && "text-slate-500")}>{dealer.name}</p><span className={cn("rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wider", dealer.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-200 text-slate-600")}>{dealer.is_active ? "Active" : "Inactive"}</span></div>{dealer.notes ? <p className="mt-1 text-sm text-slate-500">{dealer.notes}</p> : <p className="mt-1 text-xs font-semibold text-slate-400">No notes</p>}</div>
                    <div className="flex shrink-0 gap-2"><button onClick={() => startEdit(dealer)} className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a] hover:bg-[#f3f6fb]"><Pencil className="h-4 w-4" /> Edit</button><button onClick={() => void toggleSource(dealer)} className={cn("inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black", dealer.is_active ? "bg-rose-50 text-rose-700 ring-1 ring-rose-200" : "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200")}>{dealer.is_active ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}{dealer.is_active ? "Deactivate" : "Reactivate"}</button></div>
                  </div>
                ))}
              </div>
            ) : <div className="p-6"><EmptyState title="No sources found" note="Adjust the search or create a new source." /></div>}
          </div>
        </div>
      </section>
    </div>
  );
}

function QueueOrderPanel({ agentList, onSave }: { agentList: Agent[]; onSave: (rotation: RotationKind, profileIds: string[]) => Promise<void> }) {
  const liveOrders = useMemo<Record<RotationKind, string[]>>(() => ({
    whatsapp: orderedAgents(agentList, "whatsapp").map((agent) => agent.id),
    ringcentral: orderedAgents(agentList, "ringcentral").map((agent) => agent.id),
    workload: orderedAgents(agentList, "workload").map((agent) => agent.id),
  }), [agentList]);
  const [drafts, setDrafts] = useState<Record<RotationKind, string[]>>(liveOrders);
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
    setDrafts((current) => ({ ...current, ringcentral: [...current.whatsapp], workload: [...current.whatsapp] }));
    setMessage("WhatsApp order copied into the other two drafts. Save the queues to apply it.");
  }

  async function saveAll() {
    setSaving("all");
    for (const rotation of ["whatsapp", "ringcentral", "workload"] as RotationKind[]) await onSave(rotation, drafts[rotation]);
    setSaving(null);
    setMessage("All three queue orders saved.");
  }

  return (
    <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><Layers3 className="h-4 w-4" /> Queue Order</div><h3 className="mt-1 text-xl font-black">Organize each rotation independently</h3><p className="mt-1 max-w-3xl text-sm text-slate-500">The three queues may use the same order or completely different orders. Reordering a queue does not move the current turn; it changes who comes next.</p></div>
        <div className="flex flex-wrap gap-2"><button onClick={copyWhatsappToAll} className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a] hover:bg-[#f3f6fb]"><Copy className="h-4 w-4" /> Copy WhatsApp to other queues</button><button disabled={saving !== null} onClick={() => void saveAll()} className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white hover:bg-[#17305f] disabled:opacity-60"><Check className="h-4 w-4" />{saving === "all" ? "Saving..." : "Save All"}</button></div>
      </div>
      {message ? <div className="mt-4 rounded-2xl bg-[#eef3fb] px-4 py-3 text-sm font-bold text-[#223f7a]">{message}</div> : null}
      <div className="mt-6 grid gap-5 xl:grid-cols-3">
        {(["whatsapp", "ringcentral", "workload"] as RotationKind[]).map((rotation) => {
          const config = rotationConfig[rotation];
          return (
            <div key={rotation} className="overflow-hidden rounded-3xl border border-slate-200">
              <div className={cn("border-b p-4", config.soft)}><div className={cn("flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em]", config.accent)}>{config.icon}{config.title}</div><p className="mt-1 text-xs font-semibold text-slate-500">Drag-free controls for reliable ordering.</p></div>
              <div className="divide-y divide-slate-100">
                {drafts[rotation].map((agentId, index) => {
                  const agent = agentList.find((item) => item.id === agentId);
                  if (!agent) return null;
                  return (
                    <div key={agent.id} className="flex items-center gap-3 p-3">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-slate-100 text-xs font-black text-slate-500">{index + 1}</span>
                      <Avatar agent={agent} size="sm" />
                      <div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{agent.name}</p><p className="mt-0.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">{rotationEligibility(agent, rotation) ? (agent.availability === "available" ? "Active" : agent.availability === "break" ? "Skipped · Lunch" : "Skipped · Unavailable") : "Paused"}</p></div>
                      <div className="flex gap-1"><button disabled={index === 0} onClick={() => move(rotation, index, -1)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-25" aria-label={`Move ${agent.name} up`}><ArrowUp className="h-4 w-4" /></button><button disabled={index === drafts[rotation].length - 1} onClick={() => move(rotation, index, 1)} className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 disabled:opacity-25" aria-label={`Move ${agent.name} down`}><ArrowDown className="h-4 w-4" /></button></div>
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-slate-100 p-3"><button disabled={saving !== null} onClick={() => void save(rotation)} className={cn("w-full rounded-xl px-3 py-2.5 text-xs font-black text-white disabled:opacity-60", config.button)}>{saving === rotation ? "Saving..." : `Save ${config.shortTitle} Order`}</button></div>
            </div>
          );
        })}
      </div>
      <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-semibold text-amber-900"><strong>Daily start rule:</strong> the first eligible agent to click Available each business day starts that queue. Normally the same first agent starts all three queues; a manager-paused agent will not start the queue they are paused from.</div>
    </section>
  );
}

function UserAdminPanel() {
  const [users, setUsers] = useState<AdminUserAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [credential, setCredential] = useState<TemporaryCredential | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/users", { cache: "no-store" });
      const payload = await response.json() as { users?: AdminUserAccount[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Unable to load users.");
      setUsers(payload.users ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/admin/users", { cache: "no-store" })
      .then(async (response) => {
        const payload = await response.json() as { users?: AdminUserAccount[]; error?: string };
        if (!response.ok) throw new Error(payload.error || "Unable to load users.");
        return payload.users ?? [];
      })
      .then((rows) => { if (active) setUsers(rows); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Unable to load users."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError("");
    setCredential(null);
    const form = new FormData(event.currentTarget);
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
      const payload = await response.json() as { user?: AdminUserAccount; temporaryPassword?: string; error?: string };
      if (!response.ok || !payload.user || !payload.temporaryPassword) throw new Error(payload.error || "Unable to create user.");
      setCredential({ username: payload.user.username, displayName: payload.user.display_name, temporaryPassword: payload.temporaryPassword });
      event.currentTarget.reset();
      await loadUsers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to create user.");
    } finally {
      setSaving(false);
    }
  }

  async function resetPassword(user: AdminUserAccount) {
    if (!window.confirm(`Reset ${user.display_name}'s password and require a new password at next sign-in?`)) return;
    setResettingId(user.id);
    setError("");
    setCredential(null);
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: user.id }),
      });
      const payload = await response.json() as { username?: string; displayName?: string; temporaryPassword?: string; error?: string };
      if (!response.ok || !payload.username || !payload.displayName || !payload.temporaryPassword) throw new Error(payload.error || "Unable to reset password.");
      setCredential({ username: payload.username, displayName: payload.displayName, temporaryPassword: payload.temporaryPassword });
      await loadUsers();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reset password.");
    } finally {
      setResettingId(null);
    }
  }

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
  }

  return (
    <div className="space-y-5">
      {credential ? (
        <section className="rounded-[28px] border border-[#b8c7e1] bg-[#eef3fb] p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div><div className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-[#223f7a]"><KeyRound className="h-4 w-4" /> Temporary Credential</div><h3 className="mt-1 text-xl font-black text-[#17305f]">Give this to {credential.displayName}</h3><p className="mt-1 text-sm font-semibold text-slate-600">The temporary password is shown only here. The user must create a private password at the next sign-in.</p></div>
            <button onClick={() => setCredential(null)} className="self-start rounded-xl border border-[#b8c7e1] bg-white px-3 py-2 text-xs font-black text-[#223f7a]">Dismiss</button>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-2">
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#d5deed]"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Username</p><div className="mt-2 flex items-center justify-between gap-3"><code className="font-black text-[#223f7a]">{credential.username}</code><button onClick={() => void copyText(credential.username)} className="rounded-lg p-2 text-[#223f7a] hover:bg-[#eef3fb]" aria-label="Copy username"><Copy className="h-4 w-4" /></button></div></div>
            <div className="rounded-2xl bg-white p-4 ring-1 ring-[#d5deed]"><p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Temporary Password</p><div className="mt-2 flex items-center justify-between gap-3"><code className="break-all font-black text-[#223f7a]">{credential.temporaryPassword}</code><button onClick={() => void copyText(credential.temporaryPassword)} className="rounded-lg p-2 text-[#223f7a] hover:bg-[#eef3fb]" aria-label="Copy password"><Copy className="h-4 w-4" /></button></div></div>
          </div>
        </section>
      ) : null}

      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700">{error}</div> : null}

      <div className="grid gap-5 xl:grid-cols-[.72fr_1.28fr]">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-3"><div className="grid h-11 w-11 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]"><UserPlus className="h-5 w-5" /></div><div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">User Administration</p><h3 className="mt-1 text-xl font-black">Create a new login</h3></div></div>
          <p className="mt-3 text-sm text-slate-500">New agents are added at the end of all three queue orders and start as Unavailable. Managers never enter the rotations.</p>
          <form onSubmit={createUser} className="mt-6 space-y-4">
            <Field label="Full name"><input name="displayName" required maxLength={80} className="field" placeholder="Example: Ana Lopez" /></Field>
            <div className="grid gap-4 sm:grid-cols-2"><Field label="Username"><input name="username" required minLength={3} maxLength={30} className="field" placeholder="analopez" /></Field><Field label="Initials"><input name="initials" maxLength={4} className="field uppercase" placeholder="AL" /></Field></div>
            <Field label="Role"><select name="role" className="field"><option value="agent">Agent</option><option value="manager">Manager</option></select></Field>
            <button disabled={saving} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#223f7a] px-4 py-3 font-black text-white transition hover:bg-[#17305f] disabled:opacity-60"><UserPlus className="h-5 w-5" />{saving ? "Creating..." : "Create User"}</button>
          </form>
        </section>

        <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 p-6"><div><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Accounts</p><h3 className="mt-1 text-xl font-black">Usernames and password resets</h3><p className="mt-1 text-sm text-slate-500">Password resets create a new temporary password and force a private password change at the next sign-in.</p></div><button onClick={() => { setLoading(true); void loadUsers(); }} className="rounded-xl border border-slate-200 p-2.5 text-[#223f7a] hover:bg-[#f3f6fb]" aria-label="Refresh users"><RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /></button></div>
          <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-[#f3f6fb] text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">User</th><th className="px-5 py-3">Username</th><th className="px-5 py-3">Role</th><th className="px-5 py-3">Password Status</th><th className="px-5 py-3">Action</th></tr></thead><tbody className="divide-y divide-slate-100">{users.map((user) => <tr key={user.id}><td className="px-5 py-4"><div className="flex items-center gap-3"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#223f7a] text-xs font-black text-white">{user.initials}</div><div><p className="font-black">{user.display_name}</p><p className="mt-1 text-xs text-slate-400">Created {formatDate(user.created_at)}</p></div></div></td><td className="px-5 py-4"><code className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-black text-[#223f7a]">{user.username}</code></td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", user.role === "manager" ? "bg-[#eef3fb] text-[#223f7a]" : "bg-slate-100 text-slate-600")}>{user.role === "manager" ? "Manager" : "Agent"}</span></td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", user.must_change_password ? "bg-amber-50 text-amber-700" : "bg-emerald-50 text-emerald-700")}>{user.must_change_password ? "Temporary" : "Private password set"}</span></td><td className="px-5 py-4"><button disabled={resettingId === user.id} onClick={() => void resetPassword(user)} className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-3 py-2 text-xs font-black text-[#223f7a] hover:bg-[#f3f6fb] disabled:opacity-50"><KeyRound className="h-4 w-4" />{resettingId === user.id ? "Resetting..." : "Reset Password"}</button></td></tr>)}</tbody></table></div>
          {loading && !users.length ? <div className="p-6 text-sm font-semibold text-slate-500">Loading users...</div> : null}
        </section>
      </div>
    </div>
  );
}

function ExecutiveReport({ reportData, pendingPricing }: { reportData: { quotes: Array<{ lifecycle: string }>; byChannel: Array<{ name: string; quotes: number; sold: number; efficiency: number; conversion: number }>; byAgent: Array<{ agent: string; quotes: number; sold: number; efficiency: number; conversion: number }>; notSoldReasons: Array<{ name: string; count: number }> }; pendingPricing: PendingPricingItem[] }) {
  const maxChannel = Math.max(1, ...reportData.byChannel.map((row) => row.quotes));
  const oldest = [...pendingPricing].sort((a, b) => new Date(a.priceSentAt).getTime() - new Date(b.priceSentAt).getTime()).slice(0, 5);
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Quote Mix</p><h3 className="mt-1 text-xl font-black">Volume by channel</h3><div className="mt-5 space-y-4">{reportData.byChannel.slice(0, 6).map((row) => <div key={row.name}><div className="flex items-center justify-between text-sm"><span className="font-black text-slate-700">{row.name}</span><span className="font-black">{row.quotes}</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-[#4d6aa8]" style={{ width: `${(row.quotes / maxChannel) * 100}%` }} /></div></div>)}</div></section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Follow-Up Risk</p><h3 className="mt-1 text-xl font-black">Oldest pending pricing</h3><div className="mt-5 space-y-3">{oldest.length ? oldest.map((item) => <div key={item.id} className="flex items-center justify-between rounded-2xl bg-slate-50 p-4"><div><p className="font-black">{item.customer}</p><p className="mt-1 text-xs text-slate-500">{item.assignedAgent} · {item.dealer}</p></div><span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-black text-amber-800">{daysSince(item.priceSentAt)} days</span></div>) : <EmptyState title="No pending pricing" note="Nothing is waiting for source confirmation." />}</div></section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm xl:col-span-2"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Lost Opportunity Analysis</p><h3 className="mt-1 text-xl font-black">Top Not Sold reasons</h3><div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{reportData.notSoldReasons.length ? reportData.notSoldReasons.slice(0, 5).map((row) => <div key={row.name} className="rounded-2xl bg-rose-50 p-4"><p className="text-2xl font-black text-rose-700">{row.count}</p><p className="mt-1 text-xs font-bold text-rose-900">{row.name}</p></div>) : <div className="sm:col-span-2 xl:col-span-5"><EmptyState title="No Not Sold decisions" note="Reasons will appear here once agents close lost quotes." /></div>}</div></section>
      <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm xl:col-span-2"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Top Agents</p><h3 className="mt-1 text-xl font-black">Quote volume and conversion</h3><div className="mt-5 grid gap-3 md:grid-cols-3">{reportData.byAgent.slice(0, 3).map((row, index) => <div key={row.agent} className="rounded-2xl border border-slate-200 p-4"><span className="text-xs font-black text-slate-400">#{index + 1}</span><p className="mt-1 text-lg font-black">{row.agent}</p><div className="mt-4 grid grid-cols-4 gap-2 text-center"><div><p className="font-black">{row.quotes}</p><p className="text-[10px] font-bold text-slate-400">Quotes</p></div><div><p className="font-black text-emerald-700">{row.sold}</p><p className="text-[10px] font-bold text-slate-400">Sold</p></div><div><p className="font-black text-cyan-700">{row.efficiency.toFixed(0)}%</p><p className="text-[10px] font-bold text-slate-400">Eff.</p></div><div><p className="font-black text-blue-700">{row.conversion.toFixed(0)}%</p><p className="text-[10px] font-bold text-slate-400">Conv.</p></div></div></div>)}</div></section>
    </div>
  );
}

function AgentOperationsReport({ rows }: { rows: Array<{ agent: string; quotes: number; whatsapp: number; ringcentral: number; manual: number; workload: number; updates: number; passes: number; sold: number; notSold: number; finalized: number; pending: number; efficiency: number; conversion: number }> }) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Agent Distribution</p><h3 className="mt-1 text-xl font-black">Sales and operational activity</h3><p className="mt-1 text-sm text-slate-500">Efficiency = final Sold/Not Sold decisions ÷ all quotes. Pending Pricing is not counted as completed.</p></div><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Agent</th><th className="px-5 py-3">WA</th><th className="px-5 py-3">RC</th><th className="px-5 py-3">Manual</th><th className="px-5 py-3">Workload</th><th className="px-5 py-3">WA Updates</th><th className="px-5 py-3">Passes</th><th className="px-5 py-3">Finalized</th><th className="px-5 py-3">Sold</th><th className="px-5 py-3">Pending</th><th className="px-5 py-3">Efficiency</th><th className="px-5 py-3">Conversion</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.agent}><td className="px-5 py-4 font-black">{row.agent}</td><td className="px-5 py-4 font-black text-emerald-700">{row.whatsapp}</td><td className="px-5 py-4 font-black text-blue-700">{row.ringcentral}</td><td className="px-5 py-4 font-black">{row.manual}</td><td className="px-5 py-4 font-black text-violet-700">{row.workload}</td><td className="px-5 py-4 font-black text-amber-700">{row.updates}</td><td className="px-5 py-4 font-black text-rose-700">{row.passes}</td><td className="px-5 py-4 font-black text-cyan-700">{row.finalized}</td><td className="px-5 py-4 font-black text-emerald-700">{row.sold}</td><td className="px-5 py-4 font-black text-blue-700">{row.pending}</td><td className="px-5 py-4"><span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">{row.efficiency.toFixed(1)}%</span></td><td className="px-5 py-4"><span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs font-black text-[#223f7a]">{row.conversion.toFixed(1)}%</span></td></tr>)}</tbody></table></div></section>
  );
}


function QuoteTimingReport({ rows, details }: {
  rows: Array<{ agent: string; quotes: number; accepted: number; avgAccept: number | null; avgPrice: number | null; avgFinal: number | null; avgPriceDecision: number | null; avgTotalCycle: number | null }>;
  details: Array<{ id: string; customer: string; dealer: string; agent: string; lifecycle: string; createdAt: string; assignedAt: string; acceptedAt?: string; priceSentAt?: string; finalizedAt?: string; timeToAccept: number | null; timeToPrice: number | null; timeToFinal: number | null; priceToDecision: number | null; totalCycle: number | null; notSoldReason?: string }>;
}) {
  const finalizedDetails = details.filter((item) => item.finalizedAt).sort((a, b) => new Date(b.finalizedAt || 0).getTime() - new Date(a.finalizedAt || 0).getTime());
  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Quote Cycle Timing</p><h3 className="mt-1 text-xl font-black">Average speed by agent</h3><p className="mt-1 text-sm text-slate-500">Measures assignment → quote taken, quote taken → price sent, and quote taken → final Sold/Not Sold decision.</p></div>
        <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Quotes</th><th className="px-5 py-3">Taken</th><th className="px-5 py-3">Assign → Take</th><th className="px-5 py-3">Take → Price</th><th className="px-5 py-3">Take → Final</th><th className="px-5 py-3">Price → Decision</th><th className="px-5 py-3">Total Cycle</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row) => <tr key={row.agent}><td className="px-5 py-4 font-black">{row.agent}</td><td className="px-5 py-4 font-black">{row.quotes}</td><td className="px-5 py-4 font-black text-emerald-700">{row.accepted}</td><td className="px-5 py-4 font-black text-amber-700">{formatDuration(row.avgAccept)}</td><td className="px-5 py-4 font-black text-blue-700">{formatDuration(row.avgPrice)}</td><td className="px-5 py-4 font-black text-cyan-700">{formatDuration(row.avgFinal)}</td><td className="px-5 py-4 font-black text-violet-700">{formatDuration(row.avgPriceDecision)}</td><td className="px-5 py-4 font-black text-[#223f7a]">{formatDuration(row.avgTotalCycle)}</td></tr>)}</tbody></table></div>
      </section>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Detailed Timeline</p><h3 className="mt-1 text-xl font-black">Recent finalized quotes</h3><p className="mt-1 text-sm text-slate-500">Every lifecycle timestamp is preserved for audit and coaching.</p></div>
        <div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Assigned</th><th className="px-5 py-3">Taken by Agent</th><th className="px-5 py-3">Price Sent</th><th className="px-5 py-3">Final Decision</th><th className="px-5 py-3">Outcome</th><th className="px-5 py-3">Cycle</th></tr></thead><tbody className="divide-y divide-slate-100">{finalizedDetails.slice(0, 100).map((item) => <tr key={item.id}><td className="px-5 py-4"><p className="font-black">{item.customer}</p><p className="mt-1 text-xs text-slate-400">{item.dealer}</p></td><td className="px-5 py-4 font-bold">{item.agent}</td><td className="px-5 py-4 text-xs text-slate-600">{formatDateTime(item.assignedAt)}</td><td className="px-5 py-4 text-xs text-slate-600">{item.acceptedAt ? formatDateTime(item.acceptedAt) : "—"}</td><td className="px-5 py-4 text-xs text-slate-600">{item.priceSentAt ? formatDateTime(item.priceSentAt) : "—"}</td><td className="px-5 py-4 text-xs text-slate-600">{item.finalizedAt ? formatDateTime(item.finalizedAt) : "—"}</td><td className="px-5 py-4"><span className={cn("rounded-full px-2.5 py-1 text-xs font-black", item.lifecycle === "Sold" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700")}>{item.lifecycle}</span>{item.notSoldReason ? <p className="mt-2 max-w-48 text-[10px] font-semibold text-slate-400">{item.notSoldReason}</p> : null}</td><td className="px-5 py-4 font-black text-[#223f7a]">{formatDuration(item.totalCycle)}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}


function RankedReportTable({ title, rows }: { title: string; rows: Array<{ name: string; quotes: number; sold: number; notSold: number; finalized: number; pending: number; efficiency: number; conversion: number }> }) {
  return (
    <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Comparative Report</p><h3 className="mt-1 text-xl font-black">{title}</h3><p className="mt-1 text-sm text-slate-500">Efficiency counts only Sold and Not Sold as completed; Price Sent remains pending.</p></div><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Rank</th><th className="px-5 py-3">Name</th><th className="px-5 py-3">Quotes</th><th className="px-5 py-3">Finalized</th><th className="px-5 py-3">Sold</th><th className="px-5 py-3">Not Sold</th><th className="px-5 py-3">Price Sent</th><th className="px-5 py-3">Efficiency</th><th className="px-5 py-3">Conversion</th></tr></thead><tbody className="divide-y divide-slate-100">{rows.map((row, index) => <tr key={row.name}><td className="px-5 py-4 font-black text-slate-400">#{index + 1}</td><td className="px-5 py-4 font-black">{row.name}</td><td className="px-5 py-4 font-black">{row.quotes}</td><td className="px-5 py-4 font-black text-cyan-700">{row.finalized}</td><td className="px-5 py-4 font-black text-emerald-700">{row.sold}</td><td className="px-5 py-4 font-black text-rose-700">{row.notSold}</td><td className="px-5 py-4 font-black text-blue-700">{row.pending}</td><td className="px-5 py-4"><span className="rounded-full bg-cyan-50 px-2.5 py-1 text-xs font-black text-cyan-700">{row.efficiency.toFixed(1)}%</span></td><td className="px-5 py-4"><span className="rounded-full bg-[#eef3fb] px-2.5 py-1 text-xs font-black text-[#223f7a]">{row.conversion.toFixed(1)}%</span></td></tr>)}</tbody></table></div></section>
  );
}


function FollowUpReport({ pendingPricing }: { pendingPricing: PendingPricingItem[] }) {
  const buckets = [
    { label: "Sent today", count: pendingPricing.filter((item) => daysSince(item.priceSentAt) === 0).length, tone: "bg-blue-50 text-blue-700" },
    { label: "1 day waiting", count: pendingPricing.filter((item) => daysSince(item.priceSentAt) === 1).length, tone: "bg-amber-50 text-amber-700" },
    { label: "2+ days waiting", count: pendingPricing.filter((item) => daysSince(item.priceSentAt) >= 2).length, tone: "bg-rose-50 text-rose-700" },
  ];
  return <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Aging Analysis</p><h3 className="mt-1 text-xl font-black">Pending pricing follow-up priority</h3><div className="mt-5 grid gap-4 sm:grid-cols-3">{buckets.map((bucket) => <div key={bucket.label} className={cn("rounded-2xl p-5", bucket.tone)}><p className="text-3xl font-black">{bucket.count}</p><p className="mt-1 text-sm font-black">{bucket.label}</p></div>)}</div><div className="mt-6 overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="py-3">Customer</th><th className="py-3">Source</th><th className="py-3">Agent</th><th className="py-3">Sent</th><th className="py-3">Age</th></tr></thead><tbody className="divide-y divide-slate-100">{[...pendingPricing].sort((a, b) => new Date(a.priceSentAt).getTime() - new Date(b.priceSentAt).getTime()).map((item) => <tr key={item.id}><td className="py-4 font-black">{item.customer}</td><td className="py-4 text-slate-600">{item.dealer}</td><td className="py-4 font-bold">{item.assignedAgent}</td><td className="py-4 text-slate-600">{formatDateTime(item.priceSentAt)}</td><td className="py-4 font-black text-amber-700">{daysSince(item.priceSentAt)} days</td></tr>)}</tbody></table></div></section>;
}

function ServiceActivityReport({ items }: { items: WorkItem[] }) {
  return <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-100 p-6"><p className="text-xs font-black uppercase tracking-[0.16em] text-slate-400">Non-Quote Activity</p><h3 className="mt-1 text-xl font-black">Updates, activations, and changes</h3></div><div className="overflow-x-auto"><table className="min-w-full text-left text-sm"><thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400"><tr><th className="px-5 py-3">Date</th><th className="px-5 py-3">Customer</th><th className="px-5 py-3">Type</th><th className="px-5 py-3">Agent</th><th className="px-5 py-3">Method</th><th className="px-5 py-3">Status</th></tr></thead><tbody className="divide-y divide-slate-100">{items.map((item) => <tr key={item.id}><td className="px-5 py-4 text-xs text-slate-500">{formatDateTime(item.createdAt)}</td><td className="px-5 py-4"><p className="font-black">{item.customer}</p><p className="mt-1 text-xs text-slate-400">{item.dealer}</p></td><td className="px-5 py-4 font-bold">{workTypeLabels[item.workType]}</td><td className="px-5 py-4 font-bold">{item.assignedAgent}</td><td className="px-5 py-4"><MethodBadge method={item.assignmentMethod} /></td><td className="px-5 py-4 capitalize text-slate-600">{item.status}</td></tr>)}</tbody></table></div></section>;
}

function ExportButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button onClick={onClick} className="flex items-center justify-between rounded-2xl border border-slate-200 p-4 text-left transition hover:-translate-y-0.5 hover:border-[#b8c7e1] hover:shadow-md"><div><p className="text-sm font-black">{label}</p><p className="mt-1 text-xs font-semibold text-slate-400">CSV / Excel</p></div><Download className="h-5 w-5 text-[#223f7a]" /></button>;
}
