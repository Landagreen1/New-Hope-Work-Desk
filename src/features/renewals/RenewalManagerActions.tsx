'use client';

// Renewal manager actions (Requirements 6.1 to 6.7, 7.1, 7.2, 7.4).
//
// One collapsed control revealing exactly six actions — Import renewals, Assignment mapping,
// Reassign renewal, Correct imported data, Review unmatched assignments, View all employees — and
// no other renewal action. A profile outside Manager_Role renders zero nodes: the menu is absent
// from the DOM rather than disabled (Req 6.2), and `super_admin` holds Manager_Role through the
// shared `isBroadManagerRole` predicate so this check cannot drift (Req 6.4). This file absorbs the
// whole of the retired `PowerBiRenewalImport.tsx`: CSV parse, column mapping, row normalization,
// required-column and duplicate-key validation, the import call, assignment alias upsert and
// delete, and unmatched-label review. Every read and write goes through `api.ts` — zero direct
// Supabase access, zero renewal database function calls (Req 7.2).

import { AlertTriangle, CheckCircle2, ChevronDown, FileUp, Link2, ListChecks, Pencil, RefreshCw, ShieldCheck, Unlink, UploadCloud, UserCheck, UsersRound, X, type LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';
import { ui } from '../nhwd-shared/ui';
import {
  assignRenewal, buildNormalizedRows, deleteRenewalAssignmentAlias, extractDistinctAssignmentLabels, guessMapping,
  importBatch, listRenewalAssignees, managerUpdateRecord, normalizeAssignmentLabel, normalizeDate, parseCsv,
  upsertRenewalAssignmentAlias, type ImportBatchResult, type NormalizedImportRow, type RenewalAssignee,
  type RenewalAssignmentAlias, type RenewalImportRun, type RenewalRecord,
} from './api';

type PanelId = 'import' | 'mapping' | 'reassign' | 'correct' | 'unmatched' | 'employees';
type ImportFieldKey = Exclude<keyof NormalizedImportRow, 'raw'>;
type ImportField = { key: ImportFieldKey; label: string };

/** The six controls of Requirement 6.1, in that order. */
const MANAGER_ACTIONS: readonly { id: PanelId; label: string; hint: string; Icon: LucideIcon }[] = [
  { id: 'import', label: 'Import renewals', hint: 'Upload the renewal CSV and synchronize the workload', Icon: UploadCloud },
  { id: 'mapping', label: 'Assignment mapping', hint: 'Link each imported responsible name to an employee', Icon: Link2 },
  { id: 'reassign', label: 'Reassign renewal', hint: 'Move one renewal to another employee', Icon: UserCheck },
  { id: 'correct', label: 'Correct imported data', hint: 'Fix imported policy, premium, and contact values', Icon: Pencil },
  { id: 'unmatched', label: 'Review unmatched assignments', hint: 'Labels the latest import could not assign', Icon: ListChecks },
  { id: 'employees', label: 'View all employees', hint: 'Active Sales and Customer Service accounts', Icon: UsersRound },
];

export const MANAGER_ACTION_LABELS: readonly string[] = MANAGER_ACTIONS.map((action) => action.label);

/** The six columns the import requires, keyed as `NormalizedImportRow` fields. */
const REQUIRED_FIELDS: readonly ImportField[] = [
  { key: 'customer_name', label: 'Named Insured' }, { key: 'carrier', label: 'Company' },
  { key: 'line_of_business', label: 'LOB' }, { key: 'policy_number', label: 'Policy#' },
  { key: 'renewal_date', label: 'Renewal Date' }, { key: 'assigned_name', label: 'Asignacion TXT' },
];

/** Columns mapped only when a later export carries them. */
const OPTIONAL_FIELDS: readonly ImportField[] = [
  { key: 'customer_phone', label: 'Phone' }, { key: 'customer_email', label: 'Email' },
  { key: 'hawksoft_client_id', label: 'HawkSoft Client ID' }, { key: 'notice_call_date', label: 'Aviso Call' },
  { key: 'notes', label: 'Notes' }, { key: 'eft', label: 'EFT' }, { key: 'requote', label: 'REQUOTE' },
  { key: 'requote_note', label: 'NOTA REQUOTE' }, { key: 'premium_current', label: 'Current Premium' },
  { key: 'premium_renewal', label: 'Renewal Premium' },
];

/** Every key names the `renewal_records` column of the same name, so drafts read straight off a record. */
type CorrectionKey =
  | 'customer_name' | 'policy_number' | 'renewal_date' | 'carrier' | 'line_of_business'
  | 'hawksoft_client_id' | 'customer_phone' | 'customer_email' | 'premium_current' | 'premium_renewal';
type CorrectionDraft = Record<CorrectionKey, string>;

/** The manager-editable columns `renewal_manager_update` accepts, unchanged from the pre-revision form. */
const CORRECTION_FIELDS: readonly {
  key: CorrectionKey; label: string; type: 'text' | 'date' | 'tel' | 'email' | 'number'; required?: true;
}[] = [
  { key: 'customer_name', label: 'Customer name', type: 'text', required: true },
  { key: 'policy_number', label: 'Policy number', type: 'text', required: true },
  { key: 'renewal_date', label: 'Renewal date', type: 'date', required: true },
  { key: 'carrier', label: 'Carrier', type: 'text' }, { key: 'line_of_business', label: 'Line of business', type: 'text' },
  { key: 'hawksoft_client_id', label: 'HawkSoft client ID', type: 'text' },
  { key: 'customer_phone', label: 'Customer phone', type: 'tel' }, { key: 'customer_email', label: 'Customer email', type: 'email' },
  { key: 'premium_current', label: 'Current premium', type: 'number' }, { key: 'premium_renewal', label: 'Renewal premium', type: 'number' },
];

/** The four counts held after an import, plus the unmatched labels (Req 6.5, 6.6). */
export interface RenewalImportSummary {
  ok: boolean;
  /** Reported failure reason on an error, `null` on completion. */
  reason: string | null;
  inserted: number; updated: number; skipped: number; assigned: number;
  unmatchedLabels: readonly string[];
}

/** Every reported count renders as a non-negative integer, and as zero when absent (Req 6.5). */
export function importCount(value: number | null | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : 0;
}

/** Distinct, trimmed, non-empty labels in reported order. */
function distinctLabels(values: readonly string[] | null | undefined): string[] {
  const seen = new Map<string, string>();
  for (const value of values ?? []) {
    const label = (value ?? '').trim();
    const key = normalizeAssignmentLabel(label);
    if (label && key && !seen.has(key)) seen.set(key, label);
  }
  return Array.from(seen.values());
}

export function summarizeImport(result: ImportBatchResult): RenewalImportSummary {
  return {
    ok: true, reason: null, inserted: importCount(result.rows_inserted), updated: importCount(result.rows_updated),
    skipped: importCount(result.rows_skipped), assigned: importCount(result.rows_assigned),
    unmatchedLabels: distinctLabels(result.unmatched_assignees),
  };
}

/** An import error reports all four counts as zero and leaves every existing record unchanged (Req 6.6). */
export function summarizeImportFailure(reason: string): RenewalImportSummary {
  return { ok: false, reason, inserted: 0, updated: 0, skipped: 0, assigned: 0, unmatchedLabels: [] };
}

function failureText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message ? caught.message : fallback;
}

function assigneeLabel(person: RenewalAssignee): string {
  const role = person.role === 'customer_service' ? 'Customer Service' : 'Sales Agent';
  return `@${person.username || person.display_name} · ${person.display_name} · ${role}`;
}

/** Occurrence count per key, skipping absent keys. */
function tally(keys: Iterable<string | null | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) || 0) + 1);
  return counts;
}

function correctionDraft(record?: RenewalRecord): CorrectionDraft {
  const draft = {} as CorrectionDraft;
  for (const { key } of CORRECTION_FIELDS) {
    const value = record?.[key];
    draft[key] = value === null || value === undefined ? '' : String(value);
  }
  return draft;
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal surface for one manager action: focus moves inside on open, Tab cycles within it, Escape
 * closes, and focus returns to the control that opened it.
 */
function ActionDialog({ title, hint, onClose, children }: { title: string; hint: string; onClose: () => void; children: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = panel.current;
    if (!node) return;
    const opener = document.activeElement as HTMLElement | null;
    const items = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
    (items()[0] ?? node).focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const focusable = items();
      if (focusable.length < 2) return;
      const [first] = focusable;
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
    node.addEventListener('keydown', onKeyDown);
    return () => { node.removeEventListener('keydown', onKeyDown); opener?.focus?.(); };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/40 p-4 sm:p-8">
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} className={`${ui.card} w-full max-w-5xl p-5 sm:p-6`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className={ui.sectionTitle}>Manager action</p>
            <h2 id={titleId} className="mt-1 text-xl font-black text-slate-950">{title}</h2>
            <p className="mt-1 max-w-3xl text-sm font-semibold leading-6 text-slate-500">{hint}</p>
          </div>
          <button type="button" className={ui.btnGhost} onClick={onClose}><X className="h-4 w-4" aria-hidden="true" />Close</button>
        </div>
        <div className="mt-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

/** Labelled select, so every manager control is a real focusable field with an accessible name. */
function SelectField({ label, value, onChange, children }: { label: string; value: string; onChange: (next: string) => void; children: ReactNode }) {
  return (
    <label>
      <span className={ui.label}>{label}</span>
      <select className={ui.select} value={value} onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}

function StatGrid({ items, className }: { items: readonly (readonly [string, ReactNode])[]; className: string }) {
  return (
    <dl className={className}>
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <dt className={ui.statLabel}>{label}</dt><dd className="mt-1 text-2xl font-black tabular-nums text-slate-950">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DataTable({ caption, heads, rows }: { caption: string; heads: readonly string[]; rows: readonly { key: string; cells: readonly ReactNode[] }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className={ui.table}>
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{heads.map((head) => <th key={head} scope="col" className={ui.th}>{head}</th>)}</tr></thead>
        <tbody>
          {rows.map((row) => <tr key={row.key}>{row.cells.map((cell, index) => <td key={`${row.key}-${index}`} className={ui.td}>{cell}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** Column mapping selects for one field group. */
function MappingSelects({ fields, headers, mapping, onChange }: {
  fields: readonly ImportField[]; headers: readonly string[]; mapping: Record<string, string>; onChange: (field: string, header: string) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {fields.map((field) => (
        <SelectField key={field.key} label={field.label} value={mapping[field.key] || ''} onChange={(header) => onChange(field.key, header)}>
          <option value="">Do not import</option>
          {headers.map((header) => <option key={header} value={header}>{header}</option>)}
        </SelectField>
      ))}
    </div>
  );
}

/** Renewal chooser shared by Reassign renewal and Correct imported data. */
function RecordPicker({ label, records, value, onChange }: {
  label: string; records: readonly RenewalRecord[]; value: string; onChange: (recordId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = records
      .filter((record) => !needle || `${record.customer_name} ${record.policy_number} ${record.carrier ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 200);
    const selected = records.find((record) => record.id === value);
    return selected && !shown.some((record) => record.id === value) ? [selected, ...shown] : shown;
  }, [query, records, value]);

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label>
        <span className={ui.label}>Find a renewal</span>
        <input className={ui.input} value={query} placeholder="Customer, policy number, or carrier" onChange={(event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value)} />
      </label>
      <SelectField label={label} value={value} onChange={onChange}>
        <option value="">Choose a renewal</option>
        {options.map((record) => <option key={record.id} value={record.id}>{record.customer_name} · {record.policy_number} · {record.renewal_date}</option>)}
      </SelectField>
    </div>
  );
}

export interface RenewalManagerActionsProps {
  /** Signed-in profile role. Anything outside Manager_Role renders nothing (Req 6.2, 6.4). */
  role: AppRole;
  /** Records in the container's read scope, used by the reassign and correction pickers. */
  records?: readonly RenewalRecord[];
  /** Saved import-label links, loaded by the container through `listRenewalAssignmentAliases`. */
  aliases?: readonly RenewalAssignmentAlias[];
  /** Employees; loaded here through `listRenewalAssignees` when the container supplies none. */
  assignees?: readonly RenewalAssignee[];
  /** Recorded import runs, newest first. `importRuns[0]` is the most recent import (Req 6.7). */
  importRuns?: readonly RenewalImportRun[];
  /** Row selected in the list, offered as the default target of the record actions. */
  selectedRecordId?: string | null;
  /** Raised after every successful write so the container can re-run its reads. */
  onChanged?: () => void | Promise<void>;
}

export default function RenewalManagerActions({
  role, records = [], aliases = [], assignees: assigneesProp, importRuns = [], selectedRecordId = null, onChanged,
}: RenewalManagerActionsProps) {
  const isManager = isBroadManagerRole(role);
  const menuId = useId();

  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<PanelId | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<RenewalImportSummary | null>(null);
  const [sessionUnmatched, setSessionUnmatched] = useState<readonly string[] | null>(null);

  const [selections, setSelections] = useState<Record<string, string>>({});
  const [savedAliases, setSavedAliases] = useState<readonly RenewalAssignmentAlias[]>([]);
  const [removedAliasIds, setRemovedAliasIds] = useState<readonly string[]>([]);
  const [loadedAssignees, setLoadedAssignees] = useState<readonly RenewalAssignee[]>([]);

  const [assignTarget, setAssignTarget] = useState(''); const [assignTo, setAssignTo] = useState('');
  const [correctTarget, setCorrectTarget] = useState(''); const [draft, setDraft] = useState<CorrectionDraft>(() => correctionDraft());

  const assignees = assigneesProp ?? loadedAssignees;

  useEffect(() => {
    if (!isManager || assigneesProp) return;
    let live = true;
    void listRenewalAssignees()
      .then((people) => { if (live) setLoadedAssignees(people); })
      .catch((caught: unknown) => { if (live) setError(failureText(caught, 'The employee list could not be loaded.')); });
    return () => { live = false; };
  }, [assigneesProp, isManager]);

  /** Alias rows saved or removed in this session win over the container snapshot. */
  const aliasByLabel = useMemo(() => {
    const byLabel = new Map<string, RenewalAssignmentAlias>();
    for (const alias of [...aliases, ...savedAliases]) byLabel.set(alias.normalized_label, alias);
    for (const [key, alias] of byLabel) if (removedAliasIds.includes(alias.id)) byLabel.delete(key);
    return byLabel;
  }, [aliases, removedAliasIds, savedAliases]);

  const normalizedRows = useMemo(() => buildNormalizedRows(headers, rawRows, mapping), [headers, rawRows, mapping]);
  const fileLabels = useMemo(() => extractDistinctAssignmentLabels(normalizedRows), [normalizedRows]);

  /** Every linkable label: the labels in the loaded file plus every saved link. */
  const mappingRows = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const label of [...fileLabels, ...Array.from(aliasByLabel.values(), (alias) => alias.import_label)]) {
      const key = normalizeAssignmentLabel(label);
      if (key && !byKey.has(key)) byKey.set(key, label);
    }
    return Array.from(byKey, ([key, label]) => ({ key, label })).sort((left, right) => left.label.localeCompare(right.label));
  }, [aliasByLabel, fileLabels]);

  /** Policies per responsible name in the loaded file. */
  const policiesPerLabel = useMemo(() => tally(normalizedRows.map((row) => normalizeAssignmentLabel(row.assigned_name?.trim() || ''))), [normalizedRows]);

  /** Rows still carrying an import label with no employee, counted per label (Req 6.7). */
  const unassignedPerLabel = useMemo(() => tally(records.map((row) => (row.assigned_to ? null : normalizeAssignmentLabel(row.assigned_import_label ?? '')))), [records]);
  const assignedPerEmployee = useMemo(() => tally(records.map((record) => record.assigned_to)), [records]);
  const duplicateKeys = useMemo(() => {
    const keys = normalizedRows.map((row) => `${row.policy_number.trim().toLowerCase()}|${row.renewal_date}`);
    return Array.from(tally(keys).values()).filter((count) => count > 1).length;
  }, [normalizedRows]);

  const missingRequired = REQUIRED_FIELDS.filter((field) => !mapping[field.key]).map((field) => field.label);
  const unlinkedLabels = fileLabels.filter((label) => !aliasByLabel.has(normalizeAssignmentLabel(label)));

  const blockedReason = missingRequired.length ? `Map the required columns: ${missingRequired.join(', ')}.`
    : !normalizedRows.length ? 'Choose a CSV containing valid renewal policies.'
      : duplicateKeys ? 'Remove duplicate Policy# + Renewal Date combinations before importing.' : null;

  /** Labels of the most recent completed import: this session's, else the newest recorded run (Req 6.7). */
  const unmatchedLabels = useMemo(() => sessionUnmatched ?? distinctLabels(importRuns[0]?.unmatched_assignees), [importRuns, sessionUnmatched]);

  const closePanel = useCallback(() => setPanel(null), []);

  function openPanel(next: PanelId) {
    setError(null); setNotice(null);
    if (next === 'reassign') {
      const target = assignTarget || selectedRecordId || '';
      setAssignTarget(target);
      setAssignTo(records.find((record) => record.id === target)?.assigned_to ?? '');
    }
    if (next === 'correct') {
      const target = correctTarget || selectedRecordId || '';
      setCorrectTarget(target);
      setDraft(correctionDraft(records.find((record) => record.id === target)));
    }
    setPanel(next);
  }

  /**
   * Every write path: one busy key, a success notice, and a failure message naming the attempted
   * renewal operation (Req 2.7). An action may return its own notice when it carries a count.
   */
  async function runAction(key: string, action: () => Promise<string | void>, success: string, failure: string) {
    setBusy(key); setError(null); setNotice(null);
    try {
      const reported = await action();
      setNotice(reported || success);
      await onChanged?.();
    } catch (caught) {
      setError(failureText(caught, failure));
    } finally {
      setBusy(null);
    }
  }

  async function loadFile(file: File | null) {
    if (!file) return;
    setError(null); setNotice(null);
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.headers.length) { setError('The CSV did not contain a header row.'); return; }
      setFileName(file.name);
      setHeaders(parsed.headers);
      setRawRows(parsed.rows);
      setMapping(guessMapping(parsed.headers));
    } catch (caught) {
      setError(failureText(caught, 'The renewal CSV could not be read.'));
    }
  }

  function changeMapping(field: string, header: string) {
    setMapping((current) => {
      const next = { ...current };
      if (header) next[field] = header;
      else delete next[field];
      return next;
    });
  }

  async function commitImport() {
    setSummary(null); // Starting an import clears the held summary (Req 6.5).
    if (blockedReason) { setError(blockedReason); return; }
    setBusy('import'); setError(null); setNotice(null);
    try {
      const next = summarizeImport(await importBatch(fileName, mapping, normalizedRows));
      setSummary(next);
      setSessionUnmatched(next.unmatchedLabels);
      setPanel(null);
      await onChanged?.();
    } catch (caught) {
      // Req 6.6: the reported reason with four zero counts. No record was written.
      setSummary(summarizeImportFailure(failureText(caught, 'The renewal file could not be imported.')));
      setPanel(null);
    } finally {
      setBusy(null);
    }
  }

  async function saveAliasLink(row: { key: string; label: string }, profileId: string) {
    if (!profileId) { setError(`Choose a Work Desk username for ${row.label}.`); return; }
    const person = assignees.find((item) => item.id === profileId);
    const username = person?.username || person?.display_name || 'the selected user';
    await runAction(row.key, async () => {
      const saved = await upsertRenewalAssignmentAlias(row.label, profileId);
      setSavedAliases((current) => [...current, saved.alias]);
      setRemovedAliasIds((current) => current.filter((id) => id !== saved.alias.id));
      const assigned = importCount(saved.rows_assigned);
      return `${row.label} is linked to @${username}. ${assigned} open renewal${assigned === 1 ? '' : 's'} `
        + 'were assigned or synchronized.';
    }, `${row.label} is linked to @${username}.`, 'The assignment link could not be saved.');
  }

  async function removeAliasLink(alias: RenewalAssignmentAlias) {
    await runAction(alias.normalized_label, async () => {
      await deleteRenewalAssignmentAlias(alias.id);
      setRemovedAliasIds((current) => [...current, alias.id]);
      setSelections((current) => ({ ...current, [alias.normalized_label]: '' }));
    }, `${alias.import_label} is no longer linked automatically. Historical assignments were preserved.`,
    'The assignment link could not be removed.');
  }

  async function submitReassign() {
    const record = records.find((item) => item.id === assignTarget);
    if (!record || !assignTo) { setError('Choose the renewal and the employee who will own it.'); return; }
    const person = assignees.find((item) => item.id === assignTo);
    await runAction('reassign', () => assignRenewal(record.id, assignTo),
      `${record.policy_number} is assigned to ${person?.display_name || 'the selected employee'}.`, 'The renewal assignment could not be saved.');
  }

  async function submitCorrection() {
    const record = records.find((item) => item.id === correctTarget);
    if (!record) { setError('Choose the renewal to correct.'); return; }
    const renewalDate = normalizeDate(draft.renewal_date);
    if (!draft.customer_name.trim() || !draft.policy_number.trim() || !renewalDate) {
      setError('Customer name, policy number, and a valid renewal date are required.'); return;
    }
    if ([draft.premium_current, draft.premium_renewal].some((value) => value.trim() !== '' && !Number.isFinite(Number(value)))) {
      setError('Current premium and renewal premium must be numbers.'); return;
    }
    const amount = (value: string) => (value.trim() === '' ? null : Number(value));
    await runAction('correction', () => managerUpdateRecord(record.id, {
      customer_name: draft.customer_name.trim(), policy_number: draft.policy_number.trim(), renewal_date: renewalDate,
      carrier: draft.carrier.trim() || null, line_of_business: draft.line_of_business.trim() || null,
      hawksoft_client_id: draft.hawksoft_client_id.trim() || null, customer_phone: draft.customer_phone.trim() || null,
      customer_email: draft.customer_email.trim() || null, premium_current: amount(draft.premium_current),
      premium_renewal: amount(draft.premium_renewal),
    }), 'Manager corrections saved and logged.', 'The manager correction could not be saved.');
  }

  // Requirement 6.2: no menu, no control, no wrapper for a profile outside Manager_Role.
  if (!isManager) return null;

  const active = MANAGER_ACTIONS.find((action) => action.id === panel) ?? null;
  const employeeOptions = assignees.map((person) => <option key={person.id} value={person.id}>{assigneeLabel(person)}</option>);

  // Icon plus text on every message, so no failure is carried by colour alone.
  const feedback = (
    <>
      {error ? <p role="alert" className={ui.error}><AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />{error}</p> : null}
      {notice ? <p role="status" className={ui.success}><CheckCircle2 className="mr-2 inline h-4 w-4" aria-hidden="true" />{notice}</p> : null}
    </>
  );

  return (
    <section className="space-y-3">
      <button type="button" aria-expanded={menuOpen} aria-controls={menuId} className={ui.btnSecondary} onClick={() => setMenuOpen((current) => !current)}>
        <ShieldCheck className="h-4 w-4" aria-hidden="true" />Manager actions
        <ChevronDown className={`h-4 w-4 transition ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {menuOpen ? (
        <div id={menuId} role="group" aria-label="Manager actions" className="grid gap-2 rounded-2xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-2 xl:grid-cols-3">
          {MANAGER_ACTIONS.map(({ id, label, hint, Icon }) => (
            <button key={id} type="button" onClick={() => openPanel(id)} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 text-left transition hover:border-[#8da4cf] hover:bg-[#f8faff] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eef3fb]">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]"><Icon className="h-4 w-4" aria-hidden="true" /></span>
              <span>
                <span className="block text-sm font-black text-slate-900">{label}</span>
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {/* The import summary is held outside the dialogs until it is dismissed or another import
          starts (Req 6.5). The live region stays mounted so the result is announced. */}
      <div aria-live="polite">
        {summary ? (
          <div role={summary.ok ? 'status' : 'alert'} className={`rounded-2xl border p-4 ${summary.ok ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
            <div className="flex items-start justify-between gap-4">
              <p className={`flex items-center gap-2 text-sm font-black ${summary.ok ? 'text-emerald-800' : 'text-rose-800'}`}>
                {summary.ok ? <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> : <AlertTriangle className="h-4 w-4" aria-hidden="true" />}
                {summary.ok ? 'Renewal import completed' : `Renewal import failed: ${summary.reason}`}
              </p>
              <button type="button" className={ui.btnGhost} onClick={() => setSummary(null)}><X className="h-4 w-4" aria-hidden="true" />Dismiss</button>
            </div>
            <StatGrid className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4" items={[
              ['Rows inserted', summary.inserted], ['Rows updated', summary.updated],
              ['Rows skipped', summary.skipped], ['Rows assigned', summary.assigned],
            ]} />
            <p className="mt-3 text-sm font-bold text-slate-700">Unmatched assignment labels: {summary.unmatchedLabels.length}</p>
            {summary.unmatchedLabels.length ? (
              <ul className="mt-2 flex flex-wrap gap-2">
                {summary.unmatchedLabels.map((label) => <li key={label} className={`${ui.badge} ${ui.badgeTone.progress}`}>{label}</li>)}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      {active ? (
        <ActionDialog title={active.label} hint={active.hint} onClose={closePanel}>
          {feedback}

          {panel === 'import' ? (
            <>
              <label className="block cursor-pointer rounded-2xl border-2 border-dashed border-[#b5c4df] bg-[#f8faff] p-6 text-center">
                <FileUp className="mx-auto h-8 w-8 text-[#223f7a]" aria-hidden="true" />
                <span className="mt-2 block font-black text-slate-900">Choose the renewal CSV export</span>
                <span className="mt-1 block text-xs font-semibold text-slate-500">Expected core columns: Named Insured, Company, LOB, Policy#, Renewal Date, Asignacion TXT.</span>
                <input type="file" accept=".csv,text/csv" className="mt-3 block w-full text-sm font-semibold" onChange={(event: ChangeEvent<HTMLInputElement>) => void loadFile(event.target.files?.[0] || null)} />
              </label>

              {headers.length ? (
                <>
                  <StatGrid className="grid grid-cols-2 gap-2 sm:grid-cols-5" items={[['File rows', rawRows.length], ['Valid policies', normalizedRows.length],
                    ['Responsible names', fileLabels.length], ['Unlinked names', unlinkedLabels.length], ['Duplicate keys', duplicateKeys]]} />
                  <p className="text-xs font-bold text-slate-500">Selected file: {fileName}</p>

                  <MappingSelects fields={REQUIRED_FIELDS} headers={headers} mapping={mapping} onChange={changeMapping} />
                  <details className="rounded-2xl border border-slate-200 bg-slate-50/70">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-black text-slate-900">Optional columns</summary>
                    <div className="border-t border-slate-200 bg-white p-4">
                      <MappingSelects fields={OPTIONAL_FIELDS} headers={headers} mapping={mapping} onChange={changeMapping} />
                    </div>
                  </details>

                  <p className={`text-sm font-black ${blockedReason ? 'text-amber-800' : 'text-emerald-800'}`}>
                    {blockedReason ? `Import blocked: ${blockedReason}` : `${normalizedRows.length} valid policies are ready to synchronize.`}
                  </p>
                  <button type="button" className={ui.btnPrimary} disabled={Boolean(blockedReason) || busy === 'import'} onClick={() => void commitImport()}>
                    <UploadCloud className="h-4 w-4" aria-hidden="true" />
                    {busy === 'import' ? 'Importing and assigning…' : `Import and assign ${normalizedRows.length} renewal${normalizedRows.length === 1 ? '' : 's'}`}
                  </button>

                  <DataTable caption="First twenty valid policies in the loaded file" heads={['Named Insured', 'Company / LOB', 'Policy#', 'Renewal Date', 'Asignacion TXT']}
                    rows={normalizedRows.slice(0, 20).map((row, index) => ({
                      key: `${row.policy_number}-${row.renewal_date}-${index}`,
                      cells: [row.customer_name, `${row.carrier || '—'} · ${row.line_of_business || '—'}`, row.policy_number, row.renewal_date, (
                        <>
                          {row.assigned_name || 'Unassigned'}
                          {row.assigned_name && !aliasByLabel.has(normalizeAssignmentLabel(row.assigned_name))
                            ? <span className={`ml-2 ${ui.badge} ${ui.badgeTone.progress}`}>Needs link</span> : null}
                        </>
                      )],
                    }))} />
                </>
              ) : null}
            </>
          ) : null}

          {panel === 'mapping' ? (
            <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
              {mappingRows.map((row) => {
                const alias = aliasByLabel.get(row.key);
                const linked = assignees.find((person) => person.id === alias?.profile_id);
                // The saved link is the default selection; an explicit choice overrides it.
                const selected = selections[row.key] ?? alias?.profile_id ?? '';
                return (
                  <div key={row.key} className="grid gap-3 bg-white p-4 xl:grid-cols-[minmax(180px,.7fr)_minmax(260px,1.3fr)_auto] xl:items-end">
                    <div>
                      <p className={ui.statLabel}>{policiesPerLabel.get(row.key) || 0} policies in this file</p>
                      <p className="mt-1 text-lg font-black text-slate-900">{row.label}</p>
                      <p className={`mt-1 text-xs font-bold ${alias ? 'text-emerald-700' : 'text-amber-800'}`}>
                        {alias ? `Saved: @${linked?.username || linked?.display_name || 'inactive user'}` : 'Not linked yet'}
                      </p>
                    </div>
                    <SelectField label={`Work Desk username for ${row.label}`} value={selected} onChange={(next) => setSelections((current) => ({ ...current, [row.key]: next }))}>
                      <option value="">Leave unlinked until the user is created</option>
                      {employeeOptions}
                    </SelectField>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" className={ui.btnPrimary} disabled={!selected || busy === row.key} onClick={() => void saveAliasLink(row, selected)}>
                        <Link2 className="h-4 w-4" aria-hidden="true" />{busy === row.key ? 'Saving…' : 'Save link'}
                      </button>
                      {alias ? (
                        <button type="button" className={ui.btnGhost} disabled={busy === row.key} onClick={() => void removeAliasLink(alias)}>
                          <Unlink className="h-4 w-4" aria-hidden="true" />Remove link
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {mappingRows.length ? null : (
                <p className={ui.empty}>No responsible names are saved yet. Load a renewal CSV under Import renewals to map its Asignacion TXT names.</p>
              )}
            </div>
          ) : null}

          {panel === 'reassign' ? (
            <>
              <RecordPicker label="Renewal to reassign" records={records} value={assignTarget} onChange={(id) => {
                setAssignTarget(id);
                setAssignTo(records.find((record) => record.id === id)?.assigned_to ?? '');
              }} />
              <SelectField label="Assign to" value={assignTo} onChange={setAssignTo}>
                <option value="">Choose an employee</option>
                {employeeOptions}
              </SelectField>
              <button type="button" className={ui.btnPrimary} disabled={!assignTarget || !assignTo || busy === 'reassign'} onClick={() => void submitReassign()}>
                <UserCheck className="h-4 w-4" aria-hidden="true" />{busy === 'reassign' ? 'Saving…' : 'Save assignment'}
              </button>
            </>
          ) : null}

          {panel === 'correct' ? (
            <>
              <RecordPicker label="Renewal to correct" records={records} value={correctTarget} onChange={(id) => {
                setCorrectTarget(id);
                setDraft(correctionDraft(records.find((record) => record.id === id)));
              }} />
              {correctTarget ? (
                <>
                  <div className={ui.fieldRow}>
                    {CORRECTION_FIELDS.map((field) => (
                      <label key={field.key}>
                        <span className={ui.label}>{field.label}{field.required ? ' (required)' : ''}</span>
                        <input className={ui.input} type={field.type} required={field.required} value={draft[field.key]}
                          step={field.type === 'number' ? '0.01' : undefined}
                          onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} />
                      </label>
                    ))}
                  </div>
                  <button type="button" className={ui.btnPrimary} disabled={busy === 'correction'} onClick={() => void submitCorrection()}>
                    <Pencil className="h-4 w-4" aria-hidden="true" />{busy === 'correction' ? 'Saving…' : 'Save corrections'}
                  </button>
                </>
              ) : null}
            </>
          ) : null}

          {panel === 'unmatched' ? (
            <>
              <p className="text-sm font-bold text-slate-700">Unmatched assignment labels in the most recent completed import: {unmatchedLabels.length}</p>
              <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200">
                {unmatchedLabels.map((label) => {
                  const unassigned = unassignedPerLabel.get(normalizeAssignmentLabel(label)) || 0;
                  return (
                    <li key={label} className="flex flex-wrap items-center justify-between gap-3 bg-white p-4">
                      <span className="font-black text-slate-900">{label}</span>
                      <span className={`${ui.badge} ${unassigned ? ui.badgeTone.progress : ui.badgeTone.success}`}>{unassigned} renewal{unassigned === 1 ? '' : 's'} left unassigned</span>
                    </li>
                  );
                })}
                {unmatchedLabels.length ? null : <li className={ui.empty}>The most recent completed import matched every assignment label to an employee.</li>}
              </ul>
            </>
          ) : null}

          {panel === 'employees' ? (
            <>
              {assigneesProp ? null : (
                <button type="button" className={ui.btnSecondary} disabled={busy === 'employees'}
                  onClick={() => void runAction('employees', async () => setLoadedAssignees(await listRenewalAssignees()), 'The employee list was refreshed.', 'The employee list could not be loaded.')}>
                  <RefreshCw className={`h-4 w-4 ${busy === 'employees' ? 'animate-spin' : ''}`} aria-hidden="true" />Refresh employees
                </button>
              )}
              <DataTable caption="Active Sales and Customer Service employees" heads={['Employee', 'Username', 'Role', 'Assigned renewals']}
                rows={assignees.map((person) => ({
                  key: person.id,
                  cells: [person.display_name, `@${person.username || person.display_name}`,
                    person.role === 'customer_service' ? 'Customer Service' : 'Sales Agent', assignedPerEmployee.get(person.id) || 0],
                }))} />
              {assignees.length ? null : <p className={ui.empty}>No active employees were returned.</p>}
            </>
          ) : null}
        </ActionDialog>
      ) : null}

      {panel === null ? feedback : null}
    </section>
  );
}
