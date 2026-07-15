"use client";

import {
  Activity,
  BriefcaseBusiness,
  CalendarDays,
  CheckCircle2,
  Download,
  RefreshCw,
  Search,
  Trash2,
  UserRoundCog,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getSupabase } from "../nhwd-shared/client";
import type { ProfileLite } from "../nhwd-shared/types";
import {
  listWorkloadAssignees,
  listWorkloadLog,
  reassignWorkload,
  voidWorkload,
  type WorkloadAssignee,
  type WorkloadLogRow,
  type WorkloadType,
} from "./api";

const TYPE_LABELS: Record<WorkloadType, string> = {
  activation: "Activation",
  change: "Change",
  payment: "Payment",
  whatsapp_update: "WhatsApp Update",
};

function dateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfDay(value: string): string {
  return new Date(`${value}T00:00:00`).toISOString();
}

function endOfDay(value: string): string {
  return new Date(`${value}T23:59:59.999`).toISOString();
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function correctionDescription(row: WorkloadLogRow["correction_history"][number]): string {
  const details = row.details || {};
  if (row.event_type === "workload_reassigned") {
    const from = typeof details.previous_name === "string" ? details.previous_name : "previous employee";
    const to = typeof details.new_name === "string" ? details.new_name : "new employee";
    const reason = typeof details.reason === "string" ? ` Reason: ${details.reason}` : "";
    return `Reassigned from ${from} to ${to}.${reason}`;
  }
  if (row.event_type === "workload_voided") {
    const reason = typeof details.reason === "string" ? details.reason : "No reason recorded";
    return `Deleted as a mistaken workload entry. Reason: ${reason}`;
  }
  return row.event_type.replaceAll("_", " ");
}

export default function WorkloadLog({
  initialProfile,
  embedded = false,
}: {
  initialProfile: ProfileLite;
  embedded?: boolean;
}) {
  const defaultFrom = new Date();
  defaultFrom.setDate(defaultFrom.getDate() - 30);

  const [fromDate, setFromDate] = useState(dateInputValue(defaultFrom));
  const [toDate, setToDate] = useState(dateInputValue(new Date()));
  const [includeVoided, setIncludeVoided] = useState(false);
  const [typeFilter, setTypeFilter] = useState<"all" | WorkloadType>("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<WorkloadLogRow[]>([]);
  const [assignees, setAssignees] = useState<WorkloadAssignee[]>([]);
  const [draftAssignee, setDraftAssignee] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [workloadRows, people] = await Promise.all([
        listWorkloadLog({
          from: startOfDay(fromDate),
          to: endOfDay(toDate),
          includeVoided,
        }),
        listWorkloadAssignees(),
      ]);
      setRows(workloadRows);
      setAssignees(people);
      setDraftAssignee(
        Object.fromEntries(
          workloadRows.map((row) => [row.id, row.assigned_profile_id]),
        ),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load workload history.");
    } finally {
      setLoading(false);
    }
  }, [fromDate, includeVoided, toDate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const channel = getSupabase()
      .channel("workload-management-log")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "work_items" },
        () => void refresh(),
      )
      .subscribe();

    return () => {
      void getSupabase().removeChannel(channel);
    };
  }, [refresh]);

  const filteredRows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (typeFilter !== "all" && row.work_type !== typeFilter) return false;
      if (assigneeFilter !== "all" && row.assigned_profile_id !== assigneeFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!needle) return true;
      return [
        row.customer_name,
        row.dealer_name,
        row.salesperson_name,
        row.assigned_name,
        row.assigned_username,
        row.change_type,
        row.note,
        row.received_through,
      ].some((value) => value?.toLowerCase().includes(needle));
    });
  }, [assigneeFilter, rows, search, statusFilter, typeFilter]);

  const summary = useMemo(() => {
    const visible = filteredRows.filter((row) => !row.is_voided);
    return {
      total: visible.length,
      activations: visible.filter((row) => row.work_type === "activation").length,
      changes: visible.filter((row) => row.work_type === "change").length,
      completed: visible.filter((row) => row.status === "completed").length,
      voided: filteredRows.filter((row) => row.is_voided).length,
    };
  }, [filteredRows]);

  async function handleReassign(row: WorkloadLogRow) {
    const profileId = draftAssignee[row.id];
    if (!profileId || profileId === row.assigned_profile_id) return;
    const reason = window.prompt(
      `Why are you reassigning ${row.customer_name}?`,
      "Assigned to the wrong employee",
    );
    if (!reason?.trim()) return;

    setBusyId(row.id);
    setError(null);
    try {
      await reassignWorkload(row.id, profileId, reason.trim());
      setNotice(`${row.customer_name} was reassigned.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to reassign workload.");
    } finally {
      setBusyId(null);
    }
  }

  async function handleVoid(row: WorkloadLogRow) {
    const reason = window.prompt(
      `Why should this ${TYPE_LABELS[row.work_type]} be deleted from workload reporting?`,
      "Logged by mistake",
    );
    if (!reason?.trim()) return;

    const confirmed = window.confirm(
      "This hides the workload record from normal reports and preserves an audit trail. It does not reverse a linked quote outcome. Continue?",
    );
    if (!confirmed) return;

    setBusyId(row.id);
    setError(null);
    try {
      await voidWorkload(row.id, reason.trim());
      setNotice(`${row.customer_name} was removed from workload reporting.`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to delete workload.");
    } finally {
      setBusyId(null);
    }
  }

  function exportCsv() {
    const headers = [
      "Created",
      "Customer",
      "Work Type",
      "Change Type",
      "Assigned Employee",
      "Username",
      "Role",
      "Source",
      "Salesperson",
      "Method",
      "Status",
      "Accepted",
      "Completed",
      "Notes",
      "Voided",
      "Void Reason",
    ];
    const lines = [
      headers.map(csvCell).join(","),
      ...filteredRows.map((row) =>
        [
          row.created_at,
          row.customer_name,
          TYPE_LABELS[row.work_type],
          row.change_type,
          row.assigned_name,
          row.assigned_username,
          row.assigned_role,
          row.dealer_name,
          row.salesperson_name,
          row.assignment_method,
          row.status,
          row.accepted_at,
          row.completed_at,
          row.note,
          row.is_voided ? "Yes" : "No",
          row.void_reason,
        ]
          .map(csvCell)
          .join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `workload-log-${fromDate}-to-${toDate}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const canManage = initialProfile.role === "manager";
  const canView = initialProfile.role === "manager" || initialProfile.role === "agent";

  if (!canView) {
    return (
      <div className="rounded-3xl border border-rose-200 bg-rose-50 p-6 font-bold text-rose-800">
        Workload history is available to Sales Agents and Managers.
      </div>
    );
  }

  return (
    <div
      className={
        embedded
          ? "space-y-5"
          : "mx-auto max-w-[1700px] space-y-5 px-4 pb-8 sm:px-6 lg:px-8"
      }
    >
      <section className="rounded-[28px] border border-[#c9d5e9] bg-gradient-to-br from-white to-[#eef3fb] p-6 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-[0.16em] text-[#526b9a]">
              {canManage ? "Workload Management" : "Workload Database"}
            </p>
            <h2 className="mt-1 text-2xl font-black tracking-tight text-slate-950">
              {canManage ? "Team workload log" : "Team workload history"}
            </h2>
            <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
              {canManage
                ? "Review workload volume and types, correct the assigned employee, and void records logged by mistake without deleting the audit history."
                : "Review the workload volume and types completed by you and the rest of the Sales team."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void refresh()}
              className="inline-flex items-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-4 py-2.5 text-sm font-black text-[#223f7a]"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              type="button"
              onClick={exportCsv}
              className="inline-flex items-center gap-2 rounded-xl bg-[#223f7a] px-4 py-2.5 text-sm font-black text-white"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>
      </section>

      {error ? <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 font-bold text-rose-800">{error}</div> : null}
      {notice ? <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 font-bold text-emerald-800">{notice}</div> : null}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {([
          { label: "Total Workload", value: summary.total, Icon: BriefcaseBusiness },
          { label: "Activations", value: summary.activations, Icon: Activity },
          { label: "Changes", value: summary.changes, Icon: UserRoundCog },
          { label: "Completed", value: summary.completed, Icon: CheckCircle2 },
          { label: "Voided", value: summary.voided, Icon: Trash2 },
        ] satisfies Array<{ label: string; value: number; Icon: LucideIcon }>).map(({ label, value, Icon }) => (
          <div key={label} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
            <Icon className="h-5 w-5 text-[#223f7a]" />
            <p className="mt-4 text-xs font-black uppercase tracking-wider text-slate-400">{label}</p>
            <p className="mt-1 text-3xl font-black text-slate-950">{value}</p>
          </div>
        ))}
      </section>

      <section className="rounded-[28px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-7">
          <label>
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">From</span>
            <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-semibold" />
          </label>
          <label>
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">To</span>
            <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-semibold" />
          </label>
          <label>
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">Type</span>
            <select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as "all" | WorkloadType)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-semibold">
              <option value="all">All workload types</option>
              {Object.entries(TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label>
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">Employee</span>
            <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-semibold">
              <option value="all">All employees</option>
              {assignees.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
            </select>
          </label>
          <label>
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">Status</span>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2.5 font-semibold">
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </label>
          <label className="xl:col-span-2">
            <span className="text-xs font-black uppercase tracking-wider text-slate-400">Search</span>
            <span className="relative mt-1 block">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Customer, employee, source, notes" className="w-full rounded-xl border border-slate-200 py-2.5 pl-10 pr-3 font-semibold" />
            </span>
          </label>
        </div>
        {canManage ? (
          <label className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-slate-600">
            <input type="checkbox" checked={includeVoided} onChange={(event) => setIncludeVoided(event.target.checked)} />
            Include records deleted as mistakes
          </label>
        ) : null}
      </section>

      <section className="overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 p-5">
          <div>
            <p className="text-xs font-black uppercase tracking-wider text-[#223f7a]">Workload Records</p>
            <h3 className="mt-1 text-xl font-black">{filteredRows.length} matching records</h3>
          </div>
          <CalendarDays className="h-5 w-5 text-slate-400" />
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1250px] w-full text-left text-sm">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Assigned</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3">{canManage ? "Management" : "Access"}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredRows.map((row) => (
                <tr key={row.id} className={row.is_voided ? "bg-rose-50/50 opacity-75" : ""}>
                  <td className="px-4 py-4 text-xs font-semibold text-slate-500">{formatDateTime(row.created_at)}</td>
                  <td className="px-4 py-4">
                    <p className="font-black text-slate-900">{row.customer_name}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-400">{row.received_through || row.assignment_method}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-black">{TYPE_LABELS[row.work_type]}</p>
                    <p className="mt-1 text-xs text-slate-500">{row.change_type || "—"}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-bold">{row.dealer_name || "No source"}</p>
                    <p className="mt-1 text-xs text-slate-500">{row.salesperson_name || "No salesperson"}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-black">{row.assigned_name || "Unknown"}</p>
                    <p className="mt-1 text-xs text-slate-500">{row.assigned_username ? `@${row.assigned_username}` : row.assigned_role || ""}</p>
                  </td>
                  <td className="px-4 py-4">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-black ${row.is_voided ? "bg-rose-100 text-rose-700" : row.status === "completed" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                      {row.is_voided ? "Deleted mistake" : row.status}
                    </span>
                    {row.void_reason ? <p className="mt-2 max-w-[220px] text-xs font-semibold text-rose-700">{row.void_reason}</p> : null}
                  </td>
                  <td className="px-4 py-4">
                    <p className="max-w-[280px] whitespace-pre-wrap text-xs font-semibold leading-5 text-slate-600">{row.note || "—"}</p>
                    {row.correction_history?.length ? (
                      <details className="mt-3 max-w-[320px] rounded-xl border border-slate-200 bg-slate-50 p-2.5">
                        <summary className="cursor-pointer text-xs font-black text-[#223f7a]">{row.correction_history.length} management correction{row.correction_history.length === 1 ? "" : "s"}</summary>
                        <div className="mt-2 space-y-2">
                          {row.correction_history.map((correction, index) => (
                            <div key={`${row.id}-${correction.created_at}-${index}`} className="rounded-lg bg-white p-2 text-xs font-semibold text-slate-600">
                              <p>{correctionDescription(correction)}</p>
                              <p className="mt-1 text-[10px] font-bold text-slate-400">{formatDateTime(correction.created_at)} · {correction.actor_name || "Manager"}</p>
                            </div>
                          ))}
                        </div>
                      </details>
                    ) : null}
                  </td>
                  <td className="px-4 py-4">
                    {!canManage ? (
                      <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-black text-slate-500">
                        Read only
                      </span>
                    ) : row.is_voided ? (
                      <span className="text-xs font-bold text-slate-400">No actions</span>
                    ) : (
                      <div className="min-w-[280px] space-y-2">
                        <div className="flex gap-2">
                          <select value={draftAssignee[row.id] || row.assigned_profile_id} onChange={(event) => setDraftAssignee((current) => ({ ...current, [row.id]: event.target.value }))} className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold">
                            {assignees.map((person) => <option key={person.id} value={person.id}>{person.display_name} · {person.role === "customer_service" ? "CS" : "Sales"}</option>)}
                          </select>
                          <button type="button" disabled={busyId === row.id || (draftAssignee[row.id] || row.assigned_profile_id) === row.assigned_profile_id} onClick={() => void handleReassign(row)} className="rounded-xl bg-[#223f7a] px-3 py-2 text-xs font-black text-white disabled:opacity-40">Reassign</button>
                        </div>
                        <button type="button" disabled={busyId === row.id} onClick={() => void handleVoid(row)} className="inline-flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-black text-rose-700">
                          <Trash2 className="h-3.5 w-3.5" /> Delete Mistake
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!filteredRows.length ? <div className="p-10 text-center font-bold text-slate-500">No workload records match these filters.</div> : null}
      </section>
    </div>
  );
}
