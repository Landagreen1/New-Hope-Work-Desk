"use client";

import {
  AlertTriangle,
  CalendarRange,
  CheckCircle2,
  FileUp,
  History,
  Link2,
  RefreshCw,
  ShieldCheck,
  Unlink,
  UploadCloud,
  UsersRound,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
} from "react";

import { ModuleShell } from "../nhwd-shared/ModuleShell";
import type { ProfileLite } from "../nhwd-shared/types";
import { ui } from "../nhwd-shared/ui";
import {
  buildNormalizedRows,
  deleteRenewalAssignmentAlias,
  extractDistinctAssignmentLabels,
  guessMapping,
  importBatch,
  listRenewalAssignees,
  listRenewalAssignmentAliases,
  listRenewalImportRuns,
  listRenewalSyncExceptions,
  normalizeAssignmentLabel,
  parseCsv,
  upsertRenewalAssignmentAlias,
  type ImportBatchResult,
  type NormalizedImportRow,
  type RenewalAssignee,
  type RenewalAssignmentAlias,
  type RenewalImportRun,
  type RenewalSyncException,
} from "./api";

const REQUIRED_FIELDS: Array<{
  key: keyof NormalizedImportRow;
  label: string;
}> = [
  { key: "customer_name", label: "Named Insured" },
  { key: "carrier", label: "Company" },
  { key: "line_of_business", label: "LOB" },
  { key: "policy_number", label: "Policy#" },
  { key: "renewal_date", label: "Renewal Date" },
  { key: "assigned_name", label: "Asignacion TXT" },
];

const OPTIONAL_FIELDS: Array<{
  key: keyof NormalizedImportRow;
  label: string;
}> = [
  { key: "customer_phone", label: "Phone" },
  { key: "customer_email", label: "Email" },
  { key: "hawksoft_client_id", label: "HawkSoft Client ID" },
  { key: "notice_call_date", label: "Aviso Call" },
  { key: "notes", label: "Notes" },
  { key: "eft", label: "EFT" },
  { key: "requote", label: "REQUOTE" },
  { key: "requote_note", label: "NOTA REQUOTE" },
  { key: "premium_current", label: "Current Premium" },
  { key: "premium_renewal", label: "Renewal Premium" },
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(`${value}T00:00:00`).toLocaleDateString();
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function assigneeLabel(person: RenewalAssignee): string {
  const role =
    person.role === "customer_service" ? "Customer Service" : "Sales Agent";
  return `@${person.username || person.display_name} · ${person.display_name} · ${role}`;
}

function normalizedKey(row: NormalizedImportRow): string {
  return `${row.policy_number.trim().toLowerCase()}|${row.renewal_date}`;
}

function FieldMapping({
  fields,
  headers,
  mapping,
  onChange,
}: {
  fields: Array<{ key: keyof NormalizedImportRow; label: string }>;
  headers: string[];
  mapping: Record<string, string>;
  onChange: (field: string, header: string) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {fields.map((field) => (
        <label key={field.key}>
          <span className={ui.label}>{field.label}</span>
          <select
            className={ui.select}
            value={mapping[field.key] || ""}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              onChange(field.key, event.target.value)
            }
          >
            <option value="">Do not import</option>
            {headers.map((header) => (
              <option key={header} value={header}>
                {header}
              </option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}

export default function PowerBiRenewalImport({
  initialProfile: profile,
  embedded = false,
}: {
  initialProfile: ProfileLite;
  embedded?: boolean;
}) {
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [assignees, setAssignees] = useState<RenewalAssignee[]>([]);
  const [aliases, setAliases] = useState<RenewalAssignmentAlias[]>([]);
  const [recentRuns, setRecentRuns] = useState<RenewalImportRun[]>([]);
  const [syncExceptions, setSyncExceptions] = useState<
    RenewalSyncException[]
  >([]);
  const [assignmentSelections, setAssignmentSelections] = useState<
    Record<string, string>
  >({});
  const [savingLabel, setSavingLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingReferenceData, setLoadingReferenceData] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ImportBatchResult | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const normalizedRows = useMemo(
    () => buildNormalizedRows(headers, rawRows, mapping),
    [headers, rawRows, mapping],
  );

  const assignmentLabels = useMemo(
    () => extractDistinctAssignmentLabels(normalizedRows),
    [normalizedRows],
  );

  const aliasByLabel = useMemo(
    () =>
      new Map(
        aliases.map((alias) => [alias.normalized_label, alias] as const),
      ),
    [aliases],
  );

  const assignmentCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of normalizedRows) {
      const label = row.assigned_name?.trim();
      if (!label) continue;
      const key = normalizeAssignmentLabel(label);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }, [normalizedRows]);

  const missingRequiredMappings = useMemo(
    () =>
      REQUIRED_FIELDS.filter((field) => !mapping[field.key]).map(
        (field) => field.label,
      ),
    [mapping],
  );

  const duplicateKeys = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of normalizedRows) {
      const key = normalizedKey(row);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return Array.from(counts.entries())
      .filter(([, count]) => count > 1)
      .map(([key, count]) => ({ key, count }));
  }, [normalizedRows]);

  const dateWindow = useMemo(() => {
    const dates = normalizedRows
      .map((row) => row.renewal_date)
      .filter(Boolean)
      .sort();
    return {
      minimum: dates[0] || null,
      maximum: dates.length ? dates[dates.length - 1] : null,
    };
  }, [normalizedRows]);

  const unmatchedFileRows = Math.max(rawRows.length - normalizedRows.length, 0);
  const linkedLabels = assignmentLabels.filter((label) =>
    aliasByLabel.has(normalizeAssignmentLabel(label)),
  );
  const unlinkedLabels = assignmentLabels.filter(
    (label) => !aliasByLabel.has(normalizeAssignmentLabel(label)),
  );

  const importBlockedReason = missingRequiredMappings.length
    ? `Map the required columns: ${missingRequiredMappings.join(", ")}.`
    : !normalizedRows.length
      ? "Choose a CSV containing valid renewal policies."
      : duplicateKeys.length
        ? "Remove duplicate Policy# + Renewal Date combinations before importing."
        : null;

  const canImport = Boolean(headers.length) && !busy && !importBlockedReason;
  const importButtonLabel = busy
    ? "Importing and assigning…"
    : `Import & Assign ${normalizedRows.length} Renewal${
        normalizedRows.length === 1 ? "" : "s"
      }`;

  const loadReferenceData = useCallback(async () => {
    if (profile.role !== "manager" && profile.role !== "super_admin") return;
    setLoadingReferenceData(true);
    setError(null);
    try {
      const [people, savedAliases, runs, exceptions] = await Promise.all([
        listRenewalAssignees(),
        listRenewalAssignmentAliases(),
        listRenewalImportRuns(),
        listRenewalSyncExceptions(),
      ]);
      setAssignees(people);
      setAliases(savedAliases);
      setRecentRuns(runs);
      setSyncExceptions(exceptions);
      setLastUpdated(new Date());
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Power BI renewal reference data could not be loaded.",
      );
    } finally {
      setLoadingReferenceData(false);
    }
  }, [profile.role]);

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  useEffect(() => {
    setAssignmentSelections((current) => {
      const next = { ...current };
      for (const label of assignmentLabels) {
        const key = normalizeAssignmentLabel(label);
        const alias = aliasByLabel.get(key);
        if (!next[key] && alias) next[key] = alias.profile_id;
      }
      return next;
    });
  }, [aliasByLabel, assignmentLabels]);

  async function loadFile(file: File | null) {
    if (!file) return;
    setError(null);
    setNotice(null);
    setResult(null);

    const parsed = parseCsv(await file.text());
    if (!parsed.headers.length) {
      setError("The CSV did not contain a header row.");
      return;
    }

    const guessed = guessMapping(parsed.headers);
    setFileName(file.name);
    setHeaders(parsed.headers);
    setRawRows(parsed.rows);
    setMapping(guessed);
  }

  function changeMapping(field: string, header: string) {
    setMapping((current) => {
      const next = { ...current };
      if (header) next[field] = header;
      else delete next[field];
      return next;
    });
    setResult(null);
  }

  async function saveAssignmentLink(label: string) {
    const key = normalizeAssignmentLabel(label);
    const profileId = assignmentSelections[key];
    if (!profileId) {
      setError(`Choose a Work Desk username for ${label}.`);
      return;
    }

    setSavingLabel(key);
    setError(null);
    setNotice(null);
    try {
      const saved = await upsertRenewalAssignmentAlias(label, profileId);
      const person = assignees.find((item) => item.id === profileId);
      setNotice(
        `${label} is linked to @${person?.username || person?.display_name || "selected user"}. ${saved.rows_assigned} existing open renewal${saved.rows_assigned === 1 ? "" : "s"} were assigned or synchronized.`,
      );
      await loadReferenceData();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The assignment link could not be saved.",
      );
    } finally {
      setSavingLabel(null);
    }
  }

  async function removeAssignmentLink(alias: RenewalAssignmentAlias) {
    setSavingLabel(alias.normalized_label);
    setError(null);
    setNotice(null);
    try {
      await deleteRenewalAssignmentAlias(alias.id);
      setAssignmentSelections((current) => ({
        ...current,
        [alias.normalized_label]: "",
      }));
      setNotice(
        `${alias.import_label} is no longer linked automatically. Historical assignments were preserved.`,
      );
      await loadReferenceData();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The assignment link could not be removed.",
      );
    } finally {
      setSavingLabel(null);
    }
  }

  async function commitImport() {
    if (missingRequiredMappings.length) {
      setError(
        `Map these required columns before importing: ${missingRequiredMappings.join(", ")}.`,
      );
      return;
    }
    if (!normalizedRows.length) {
      setError("No valid policy rows were found after column mapping.");
      return;
    }
    if (duplicateKeys.length) {
      setError(
        "The file contains duplicate Policy# + Renewal Date combinations. Correct the export before importing.",
      );
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const imported = await importBatch(fileName, mapping, normalizedRows);
      setResult(imported);
      setNotice(
        "Monthly renewal synchronization completed. Closed records were preserved and missing policies were flagged for Manager review rather than cancelled automatically.",
      );
      await loadReferenceData();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The renewal file could not be imported.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (profile.role !== "manager" && profile.role !== "super_admin") {
    return (
      <div className={ui.page}>
        <div className={ui.error}>
          Only Management can upload and synchronize the Power BI renewal
          report.
        </div>
      </div>
    );
  }

  return (
    <ModuleShell
      title="Power BI Renewal Upload"
      subtitle="Upload the recurring renewal CSV, link Asignacion TXT names to Sales or Customer Service usernames, update the 120-day workload, and review policies missing from the latest monthly export."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={() => void loadReferenceData()}
      embedded={embedded}
    >
      <div className="space-y-5">
        {error ? <div className={ui.error}>{error}</div> : null}
        {notice ? <div className={ui.success}>{notice}</div> : null}

        <section className="grid gap-4 xl:grid-cols-4">
          <div className={ui.stat}>
            <p className={ui.statLabel}>Active usernames</p>
            <p className={ui.statValue}>{assignees.length}</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Sales Agents + Customer Service
            </p>
          </div>
          <div className={ui.stat}>
            <p className={ui.statLabel}>Saved name links</p>
            <p className={ui.statValue}>{aliases.length}</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Reused on every future upload
            </p>
          </div>
          <div className={ui.stat}>
            <p className={ui.statLabel}>Latest-file exceptions</p>
            <p
              className={`mt-1 text-3xl font-black ${
                syncExceptions.length ? "text-amber-700" : "text-emerald-700"
              }`}
            >
              {syncExceptions.length}
            </p>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Missing from the newest report
            </p>
          </div>
          <div className={ui.stat}>
            <p className={ui.statLabel}>Import history</p>
            <p className={ui.statValue}>{recentRuns.length}</p>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              Most recent synchronized files
            </p>
          </div>
        </section>

        <section className={`${ui.card} ${ui.cardPad}`}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
                <UploadCloud className="h-5 w-5" />
              </div>
              <div>
                <p className={ui.sectionTitle}>Monthly synchronization</p>
                <h2 className="mt-1 text-xl font-black">
                  Upload the Power BI renewal CSV
                </h2>
                <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                  The report may cover approximately 120 days. The importer
                  derives the actual date window from each file, matches
                  policies by Policy# + Renewal Date, updates open records,
                  preserves closed records, and flags policies that disappear
                  from a later monthly export.
                </p>
              </div>
            </div>
            <button
              type="button"
              className={ui.btnSecondary}
              onClick={() => void loadReferenceData()}
              disabled={loadingReferenceData}
            >
              <RefreshCw
                className={`h-4 w-4 ${
                  loadingReferenceData ? "animate-spin" : ""
                }`}
              />
              Refresh usernames
            </button>
          </div>

          <label className="mt-5 block cursor-pointer rounded-2xl border-2 border-dashed border-[#b5c4df] bg-[#f8faff] p-8 text-center transition hover:border-[#7890ba] hover:bg-[#eef3fb]">
            <FileUp className="mx-auto h-9 w-9 text-[#223f7a]" />
            <p className="mt-3 font-black text-slate-900">
              Choose the monthly CSV export
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Expected core columns: Named Insured, Company, LOB, Policy#,
              Renewal Date, and Asignacion TXT.
            </p>
            <input
              type="file"
              accept=".csv,text/csv"
              className="mt-4 block w-full text-sm font-semibold"
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                void loadFile(event.target.files?.[0] || null)
              }
            />
          </label>

          {fileName ? (
            <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-[#c9d5e9] bg-white px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">
                  Selected file
                </p>
                <p className="mt-1 font-black text-slate-900">{fileName}</p>
              </div>
              <p className="text-sm font-bold text-[#223f7a]">
                Next: confirm assignments, then use Import &amp; Assign Renewals.
              </p>
            </div>
          ) : null}
        </section>

        {headers.length ? (
          <>
            <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
              <div className={ui.stat}>
                <p className={ui.statLabel}>File rows</p>
                <p className={ui.statValue}>{rawRows.length}</p>
              </div>
              <div className={ui.stat}>
                <p className={ui.statLabel}>Valid policies</p>
                <p className={ui.statValue}>{normalizedRows.length}</p>
              </div>
              <div className={ui.stat}>
                <p className={ui.statLabel}>Responsible names</p>
                <p className={ui.statValue}>{assignmentLabels.length}</p>
              </div>
              <div className={ui.stat}>
                <p className={ui.statLabel}>Linked names</p>
                <p className={ui.statValue}>{linkedLabels.length}</p>
              </div>
              <div className={ui.stat}>
                <p className={ui.statLabel}>Unlinked names</p>
                <p
                  className={`mt-1 text-3xl font-black ${
                    unlinkedLabels.length
                      ? "text-amber-700"
                      : "text-emerald-700"
                  }`}
                >
                  {unlinkedLabels.length}
                </p>
              </div>
              <div className={ui.stat}>
                <p className={ui.statLabel}>File date window</p>
                <p className="mt-1 text-sm font-black text-slate-900">
                  {formatDate(dateWindow.minimum)}
                </p>
                <p className="text-xs font-bold text-slate-400">
                  through {formatDate(dateWindow.maximum)}
                </p>
              </div>
            </section>

            {unmatchedFileRows || duplicateKeys.length ? (
              <div className={ui.error}>
                <p className="font-black">File validation requires review.</p>
                {unmatchedFileRows ? (
                  <p className="mt-1 text-sm font-semibold">
                    {unmatchedFileRows} row
                    {unmatchedFileRows === 1 ? "" : "s"} did not contain all
                    required policy values.
                  </p>
                ) : null}
                {duplicateKeys.length ? (
                  <p className="mt-1 text-sm font-semibold">
                    {duplicateKeys.length} duplicate Policy# + Renewal Date
                    combination{duplicateKeys.length === 1 ? "" : "s"} were
                    found. The import is blocked until the export is corrected.
                  </p>
                ) : null}
              </div>
            ) : (
              <div className={ui.success}>
                <CheckCircle2 className="mr-2 inline h-4 w-4" />
                File validation passed: all valid policy keys are unique.
              </div>
            )}

            <section
              id="powerbi-import-action"
              className="rounded-[28px] border-2 border-[#7890ba] bg-gradient-to-br from-[#eef3fb] to-white p-5 shadow-sm"
            >
              <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex items-start gap-3">
                  <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#223f7a] text-white">
                    <ShieldCheck className="h-5 w-5" />
                  </div>
                  <div>
                    <p className={ui.sectionTitle}>Final import action</p>
                    <h3 className="mt-1 text-xl font-black text-slate-950">
                      Import and assign the renewal workload
                    </h3>
                    <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
                      Saved Asignacion TXT links assign policies automatically to
                      Sales Agents or Customer Service. The {unlinkedLabels.length}
                      unlinked name{unlinkedLabels.length === 1 ? "" : "s"} will
                      remain visible but unassigned until you create and link the
                      username.
                    </p>
                    <p
                      className={`mt-2 text-sm font-black ${
                        importBlockedReason ? "text-amber-700" : "text-emerald-700"
                      }`}
                    >
                      {importBlockedReason ||
                        `${normalizedRows.length} valid policies are ready to synchronize.`}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  className={`${ui.btnPrimary} min-h-12 shrink-0 px-6 text-base`}
                  disabled={!canImport}
                  onClick={() => void commitImport()}
                >
                  <UploadCloud className="h-5 w-5" />
                  {importButtonLabel}
                </button>
              </div>
            </section>

            <section className={`${ui.card} ${ui.cardPad}`}>
              <details open>
                <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  <p className={ui.sectionTitle}>Column mapping</p>
                  <h3 className="mt-1 text-xl font-black">
                    Confirm the fixed export format
                  </h3>
                  <p className="mt-1 text-sm font-semibold text-slate-500">
                    The six columns in the supplied report are recognized
                    automatically. Expand optional fields only when Power BI
                    adds them later.
                  </p>
                </summary>
                <div className="mt-5 border-t border-slate-100 pt-5">
                  <FieldMapping
                    fields={REQUIRED_FIELDS}
                    headers={headers}
                    mapping={mapping}
                    onChange={changeMapping}
                  />
                </div>
              </details>

              <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70">
                <summary className="cursor-pointer list-none px-4 py-4 [&::-webkit-details-marker]:hidden">
                  <p className="font-black text-slate-900">
                    Optional future columns
                  </p>
                  <p className="mt-1 text-xs font-semibold text-slate-500">
                    Phone, email, HawkSoft Client ID, notes, premiums and
                    contact fields improve follow-up but are not required.
                  </p>
                </summary>
                <div className="border-t border-slate-200 bg-white p-4">
                  <FieldMapping
                    fields={OPTIONAL_FIELDS}
                    headers={headers}
                    mapping={mapping}
                    onChange={changeMapping}
                  />
                </div>
              </details>
            </section>

            <section className={`${ui.card} ${ui.cardPad}`}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="flex items-start gap-3">
                  <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-violet-50 text-violet-700">
                    <UsersRound className="h-5 w-5" />
                  </div>
                  <div>
                    <p className={ui.sectionTitle}>
                      Asignacion TXT → Work Desk username
                    </p>
                    <h3 className="mt-1 text-xl font-black">
                      Link each responsible name once
                    </h3>
                    <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                      Each saved link may point to an active Sales Agent or
                      Customer Service employee. The link is reused on every
                      monthly file. Users that do not exist yet may remain
                      unlinked until their accounts are created.
                    </p>
                  </div>
                </div>
                <div
                  className={`rounded-2xl px-4 py-3 text-sm font-black ${
                    unlinkedLabels.length
                      ? "bg-amber-50 text-amber-800"
                      : "bg-emerald-50 text-emerald-800"
                  }`}
                >
                  {unlinkedLabels.length
                    ? `${unlinkedLabels.length} name${unlinkedLabels.length === 1 ? "" : "s"} still need a username`
                    : "Every name in this file is linked"}
                </div>
              </div>

              <div className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
                {assignmentLabels.map((label) => {
                  const key = normalizeAssignmentLabel(label);
                  const alias = aliasByLabel.get(key);
                  const selectedProfileId =
                    assignmentSelections[key] || alias?.profile_id || "";
                  const linkedPerson = assignees.find(
                    (person) => person.id === alias?.profile_id,
                  );

                  return (
                    <div
                      key={key}
                      className="grid gap-4 bg-white p-4 xl:grid-cols-[minmax(180px,.65fr)_minmax(280px,1.35fr)_auto] xl:items-center"
                    >
                      <div>
                        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-400">
                          {assignmentCounts.get(key) || 0} policies
                        </p>
                        <p className="mt-1 text-lg font-black text-slate-900">
                          {label}
                        </p>
                        <p
                          className={`mt-1 text-xs font-bold ${
                            alias ? "text-emerald-700" : "text-amber-700"
                          }`}
                        >
                          {alias
                            ? `Saved: @${linkedPerson?.username || linkedPerson?.display_name || "inactive user"}`
                            : "Not linked yet"}
                        </p>
                      </div>

                      <select
                        className={ui.select}
                        value={selectedProfileId}
                        onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                          setAssignmentSelections((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      >
                        <option value="">
                          Leave unlinked until the user is created
                        </option>
                        <optgroup label="Sales Agents">
                          {assignees
                            .filter((person) => person.role === "agent")
                            .map((person) => (
                              <option key={person.id} value={person.id}>
                                {assigneeLabel(person)}
                              </option>
                            ))}
                        </optgroup>
                        <optgroup label="Customer Service">
                          {assignees
                            .filter(
                              (person) =>
                                person.role === "customer_service",
                            )
                            .map((person) => (
                              <option key={person.id} value={person.id}>
                                {assigneeLabel(person)}
                              </option>
                            ))}
                        </optgroup>
                      </select>

                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={ui.btnPrimary}
                          disabled={
                            !selectedProfileId || savingLabel === key
                          }
                          onClick={() => void saveAssignmentLink(label)}
                        >
                          <Link2 className="h-4 w-4" />
                          {savingLabel === key ? "Saving…" : "Save link"}
                        </button>
                        {alias ? (
                          <button
                            type="button"
                            className={ui.btnGhost}
                            disabled={savingLabel === key}
                            onClick={() => void removeAssignmentLink(alias)}
                          >
                            <Unlink className="h-4 w-4" />
                            Remove
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {!assignmentLabels.length ? (
                  <div className={ui.empty}>
                    No responsible names were found in the mapped Asignacion
                    TXT column.
                  </div>
                ) : null}
              </div>
            </section>

            <section className={`${ui.card} overflow-hidden`}>
              <div className={ui.cardHeader}>
                <div>
                  <p className={ui.sectionTitle}>Preview</p>
                  <h3 className="mt-1 text-xl font-black">
                    First 20 valid policies
                  </h3>
                </div>
                <p className="text-xs font-bold text-slate-400">
                  {fileName}
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className={ui.table}>
                  <thead>
                    <tr>
                      <th className={ui.th}>Named Insured</th>
                      <th className={ui.th}>Company / LOB</th>
                      <th className={ui.th}>Policy#</th>
                      <th className={ui.th}>Renewal Date</th>
                      <th className={ui.th}>Asignacion TXT</th>
                      <th className={ui.th}>Username status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {normalizedRows.slice(0, 20).map((row, index) => {
                      const alias = row.assigned_name
                        ? aliasByLabel.get(
                            normalizeAssignmentLabel(row.assigned_name),
                          )
                        : undefined;
                      const person = assignees.find(
                        (item) => item.id === alias?.profile_id,
                      );
                      return (
                        <tr
                          key={`${row.policy_number}-${row.renewal_date}-${index}`}
                        >
                          <td className={ui.td}>
                            <p className="font-black">{row.customer_name}</p>
                          </td>
                          <td className={ui.td}>
                            <p className="font-bold">{row.carrier || "—"}</p>
                            <p className="mt-1 text-xs text-slate-400">
                              {row.line_of_business || "—"}
                            </p>
                          </td>
                          <td className={ui.td}>
                            <p className="font-bold">{row.policy_number}</p>
                          </td>
                          <td className={ui.td}>
                            {formatDate(row.renewal_date)}
                          </td>
                          <td className={ui.td}>
                            <p className="font-bold">
                              {row.assigned_name || "Unassigned"}
                            </p>
                          </td>
                          <td className={ui.td}>
                            <span
                              className={`${ui.badge} ${
                                alias
                                  ? ui.badgeTone.success
                                  : ui.badgeTone.progress
                              }`}
                            >
                              {alias
                                ? `@${person?.username || person?.display_name || "linked user"}`
                                : "Needs link"}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>

            <section className={`${ui.card} ${ui.cardPad}`}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <p className={ui.sectionTitle}>Commit synchronization</p>
                  <h3 className="mt-1 text-xl font-black">
                    Update the renewal workload
                  </h3>
                  <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">
                    The first v0.9.11 upload establishes the monthly baseline.
                    Later uploads flag previously seen open policies that are
                    absent from the latest file&apos;s date window. They are
                    not cancelled automatically.
                  </p>
                </div>
                <button
                  type="button"
                  className={ui.btnPrimary}
                  disabled={!canImport}
                  onClick={() => void commitImport()}
                >
                  <ShieldCheck className="h-4 w-4" />
                  {importButtonLabel}
                </button>
              </div>
            </section>
          </>
        ) : null}

        {result ? (
          <section className={`${ui.card} ${ui.cardPad}`}>
            <div className="flex items-start gap-3">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-emerald-50 text-emerald-700">
                <CheckCircle2 className="h-5 w-5" />
              </div>
              <div>
                <p className={ui.sectionTitle}>Latest synchronization result</p>
                <h3 className="mt-1 text-xl font-black">
                  {result.rows_inserted} new · {result.rows_updated} updated ·{" "}
                  {result.rows_assigned || 0} assigned
                </h3>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  {result.rows_closed_preserved || 0} closed records preserved ·{" "}
                  {result.rows_missing_in_window || 0} missing from latest file ·{" "}
                  {result.rows_restored_present || 0} restored to present.
                </p>
                {result.unmatched_assignees?.length ? (
                  <div className="mt-4 rounded-2xl bg-amber-50 p-4 text-sm font-bold text-amber-800">
                    Still unlinked: {result.unmatched_assignees.join(", ")}.
                    Create the users, click Refresh usernames, then save each
                    link. Current open records will synchronize automatically.
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        <section className="grid gap-5 xl:grid-cols-2">
          <div className={`${ui.card} overflow-hidden`}>
            <div className={ui.cardHeader}>
              <div>
                <p className={ui.sectionTitle}>Monthly change review</p>
                <h3 className="mt-1 text-xl font-black">
                  Missing from latest report
                </h3>
                <p className="mt-1 text-sm font-semibold text-slate-500">
                  Review these records in HawkSoft before marking them
                  cancelled, rewritten, or otherwise closed.
                </p>
              </div>
              <span
                className={`${ui.badge} ${
                  syncExceptions.length
                    ? ui.badgeTone.progress
                    : ui.badgeTone.success
                }`}
              >
                {syncExceptions.length}
              </span>
            </div>
            <div className="max-h-[520px] divide-y divide-slate-100 overflow-auto">
              {syncExceptions.slice(0, 100).map((record) => (
                <div key={record.id} className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-black text-slate-900">
                        {record.customer_name}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">
                        {record.policy_number} ·{" "}
                        {formatDate(record.renewal_date)}
                      </p>
                      <p className="mt-1 text-xs font-semibold text-slate-400">
                        {record.carrier || "Carrier not recorded"} ·{" "}
                        {record.assigned_import_label ||
                          "No imported responsible name"}
                      </p>
                    </div>
                    <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
                  </div>
                </div>
              ))}
              {!syncExceptions.length ? (
                <div className={ui.empty}>
                  No previously imported open policies are missing from the
                  latest synchronized date window.
                </div>
              ) : null}
            </div>
          </div>

          <div className={`${ui.card} overflow-hidden`}>
            <div className={ui.cardHeader}>
              <div>
                <p className={ui.sectionTitle}>Import history</p>
                <h3 className="mt-1 text-xl font-black">
                  Recent Power BI files
                </h3>
              </div>
              <History className="h-5 w-5 text-[#223f7a]" />
            </div>
            <div className="max-h-[520px] divide-y divide-slate-100 overflow-auto">
              {recentRuns.map((run) => (
                <details key={run.id} className="group">
                  <summary className="cursor-pointer list-none p-4 [&::-webkit-details-marker]:hidden">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <p className="font-black text-slate-900">
                          {run.file_name}
                        </p>
                        <p className="mt-1 text-xs font-semibold text-slate-500">
                          {formatDate(run.file_date_min)} through{" "}
                          {formatDate(run.file_date_max)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-black text-slate-700">
                          {run.rows_total} rows
                        </p>
                        <p className="mt-1 text-xs text-slate-400">
                          {formatDateTime(run.created_at)}
                        </p>
                      </div>
                    </div>
                  </summary>
                  <div className="grid grid-cols-2 gap-3 border-t border-slate-100 bg-slate-50 p-4 text-sm sm:grid-cols-4">
                    <div>
                      <p className="text-xs font-black uppercase text-slate-400">
                        New
                      </p>
                      <p className="mt-1 font-black">{run.rows_inserted}</p>
                    </div>
                    <div>
                      <p className="text-xs font-black uppercase text-slate-400">
                        Updated
                      </p>
                      <p className="mt-1 font-black">{run.rows_updated}</p>
                    </div>
                    <div>
                      <p className="text-xs font-black uppercase text-slate-400">
                        Assigned
                      </p>
                      <p className="mt-1 font-black">{run.rows_assigned}</p>
                    </div>
                    <div>
                      <p className="text-xs font-black uppercase text-slate-400">
                        Missing
                      </p>
                      <p className="mt-1 font-black">
                        {run.rows_missing_in_window}
                      </p>
                    </div>
                  </div>
                </details>
              ))}
              {!recentRuns.length ? (
                <div className={ui.empty}>
                  No v0.9.11 monthly synchronization runs have been recorded.
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className={`${ui.card} ${ui.cardPad}`}>
          <div className="flex items-start gap-3">
            <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-blue-50 text-blue-700">
              <CalendarRange className="h-5 w-5" />
            </div>
            <div>
              <p className={ui.sectionTitle}>Recommended future columns</p>
              <h3 className="mt-1 text-xl font-black">
                Information that would improve the renewal process
              </h3>
              <p className="mt-1 text-sm font-semibold leading-6 text-slate-500">
                The supplied six-column report is enough to create and assign
                the workload. Adding customer phone, email, HawkSoft Client ID,
                current premium, renewal premium, policy status, cancellation
                effective date, preferred language, and last-modified timestamp
                would reduce the need to open HawkSoft for every contact.
              </p>
            </div>
          </div>
        </section>
      </div>
    </ModuleShell>
  );
}
