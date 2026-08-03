'use client';

// Cancellation manager actions — task 16.11 (Requirements 8.1, 8.4, 8.5, 14.17, 22.3, 26.4).
//
// One collapsed control hosting the six manager surfaces of the Cancellations tab: the import
// wizard, message template editing, the automatic-sending kill switch, the unmatched producer and
// customer review, reassignment, and imported-data correction. A profile outside Manager_Role
// renders zero nodes — the control is absent from the DOM rather than present and disabled — and
// `super_admin` holds every `manager` permission, so the gate is the shared `isBroadManagerRole`
// predicate and never a bare `role === 'manager'` (Requirements 22.3, 22.5).
//
// Card shell, `nhwd-shared/ui` tokens, the `role="alert"` / `aria-describedby` / `aria-invalid`
// wiring, the "a rejection keeps every entered value on screen" rule, and the `onChanged` callback
// all follow the landed cancellations siblings `./CancellationContactPanel` and
// `./CancellationPaymentReport`, and the collapsed-panel structure follows Phase 1's
// `renewals/RenewalManagerActions`.
//
// **This file reimplements nothing.** Every read and write goes through `./api`, `./manager-api`,
// or the already-built import pipeline under `./import/`; there is no `getSupabase()` call and no
// `.rpc(...)` call here. In particular the five preview counts, the rejected list, the duplicate
// list, the unmatched producer labels, and the unmatched customer rows are all read straight off
// `ImportPreview` and off the stored import run — none of them is recounted here.
//
// **Readings recorded with this task.**
//
//  1. *The wizard is a five-stage machine, and a stage only advances on a manager action.*
//     `upload → classification → mapping → preview → complete`. Nothing is written before the
//     confirmation at the end of `preview`, which is Requirement 8.5's "zero Cancellation_Case rows
//     and zero Contact_Recipient rows until a manager confirms the displayed import preview". Going
//     back a stage keeps the parsed file, so a mapping override costs no re-upload.
//  2. *Created versus updated is a database read, so it is read — and said so when it fails.*
//     `buildImportPreview` is pure and previews every accepted row as a create unless it is handed
//     the stored identities. The pipeline's own `fetchExistingCaseState` supplies them, so the
//     preview is built twice: once to learn which policy numbers the file claims, then again with
//     the stored identities and stored contact values. If that read fails the preview is still
//     shown, with a sentence saying the split could not be established, rather than a create count
//     presented as fact (Requirements 9.2, 9.3).
//  3. *The assignment mapping is read before the preview, not during the load.* Requirement 9.7
//     records every producer label that left a case unassigned, and only the assignment lookup can
//     find the mapping misses. `buildImportBatchPayload` merges them with the `(Deleted)` labels the
//     preview already found, so the wizard shows the same list the import run will store, and the
//     lookup is handed to `loadImportBatch` so it is not read a second time.
//  4. *Template editing writes a new version and never touches a stored one.* The editor loads the
//     highest stored version of the selected template as its starting values and saves through
//     `manager-api.saveTemplateVersion`, which inserts `version + 1`. Every existing
//     Communication_Record keeps pointing at the exact words it was sent with (Requirement 14.17).
//     A blank required field is refused by `manager-summaries.templateDraftRejection` before the
//     insert, with every entered value left on screen.
//  5. *The kill switch shows what it stored.* `api.setAutomaticSendingEnabled` stores the new value,
//     the changing profile, and the change time, and returns the stored row; the panel renders the
//     returned `updated_by` and `updated_at` rather than the value it asked for, so what is on
//     screen is what is in the database (Requirement 26.4). Times render as a fixed UTC string so
//     the first client paint cannot disagree with the server about the reader's time zone.
//  6. *The review panel reads the most recent completed import.* This session's completion summary
//     where there is one, otherwise the newest recorded run, both read through the one function
//     `manager-summaries.summarizeImportRun` so the recorded-history view and the completion summary
//     cannot drift apart (Requirement 8.8).
//
// **Deliberately not here.** A Case_Status override belongs to task 16.10
// (`./CancellationVerificationPanel`), which already carries the Requirement 22.4 reason text and
// the Requirement 22.10 role split. Adding a second override control on this surface would give the
// agency two competing ways to write the same column.

import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ChevronDown,
  FileUp,
  ListChecks,
  LoaderCircle,
  MailCheck,
  PowerOff,
  ShieldCheck,
  SquarePen,
  UploadCloud,
  UserCheck,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

import { isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { ui } from '../nhwd-shared/ui';
import {
  assignCancellationCase,
  getCancellationSettings,
  listCancellationAssignees,
  listCancellationImportRuns,
  listCancellationTemplates,
  listTemplateVersions,
  setAutomaticSendingEnabled,
  type CancellationAssignee,
  type CancellationCase,
  type CancellationImportRun,
  type CancellationSettings,
  type CancellationTemplateWithVersions,
} from './api';
import {
  classifyParsedFile,
  MAX_IMPORT_DATA_ROWS,
  MAX_IMPORT_FILE_BYTES,
  type ClassifiedImportFile,
  type ImportFileRejection,
} from './import/classify';
import { parseCsv, type ParsedCsv } from './import/csv';
import type { ProducerLabelEntry } from './import/fields';
import {
  buildImportBatchPayload,
  buildProducerAssignmentLookup,
  fetchExistingCaseState,
  fetchProducerAssignmentMapping,
  loadImportBatch,
  previewPolicyNumbers,
  type ProducerAssignmentEntry,
  type ProducerAssignmentLookup,
} from './import/loader';
import {
  applyOverride,
  COLUMNS_BY_SET,
  confirmMapping,
  proposeMapping,
  type CancellationColumn,
  type ConfirmedMapping,
  type MappingBlockReason,
  type MappingDraft,
} from './import/mapping';
import { previewParsedFile, type ImportPreview } from './import/preview';
import {
  correctImportedCaseData,
  saveTemplateVersion,
  type ImportedDataCorrectionInput,
} from './manager-api';
import {
  groupProducerLabels,
  summarizeImportRun,
  templateDraft,
  templateDraftRejection,
  TEMPLATE_TEXT_FIELDS,
  type ImportRunSummary,
  type TemplateDraft,
  type TemplateTextFieldKey,
} from './manager-summaries';

// ---------------------------------------------------------------------------
// The six controls
// ---------------------------------------------------------------------------

export type CancellationManagerPanelId =
  | 'import'
  | 'templates'
  | 'sending'
  | 'review'
  | 'reassign'
  | 'correct';

interface ManagerAction {
  readonly id: CancellationManagerPanelId;
  readonly label: string;
  readonly hint: string;
  readonly Icon: LucideIcon;
}

/** The six manager surfaces of task 16.11, in the order the task lists them. */
export const CANCELLATION_MANAGER_ACTIONS: readonly ManagerAction[] = [
  {
    id: 'import',
    label: 'Import cancellation report',
    hint: 'Upload, classify, map columns, review the preview, then confirm',
    Icon: UploadCloud,
  },
  {
    id: 'templates',
    label: 'Message templates',
    hint: 'Saving a change stores a new version; no stored version is ever changed',
    Icon: MailCheck,
  },
  {
    id: 'sending',
    label: 'Automatic sending',
    hint: 'Turn automatic touchpoint sending on or off for every cancellation',
    Icon: PowerOff,
  },
  {
    id: 'review',
    label: 'Review unmatched rows',
    hint: 'Producer labels and customers the most recent import could not match',
    Icon: ListChecks,
  },
  {
    id: 'reassign',
    label: 'Reassign cancellation',
    hint: 'Move one cancellation to another employee',
    Icon: UserCheck,
  },
  {
    id: 'correct',
    label: 'Correct imported data',
    hint: 'Fix imported policy, date, customer, amount, and producer values',
    Icon: SquarePen,
  },
];

export const CANCELLATION_MANAGER_ACTION_LABELS: readonly string[] = CANCELLATION_MANAGER_ACTIONS.map(
  (action) => action.label,
);

// ---------------------------------------------------------------------------
// The import wizard state machine — reading 1
// ---------------------------------------------------------------------------

/**
 * The five stages of the import wizard. Nothing is written before a manager confirms at the end of
 * `preview` (Requirement 8.5).
 */
export type ImportWizardStage = 'upload' | 'classification' | 'mapping' | 'preview' | 'complete';

/** The stages in order, for the progress list. */
export const IMPORT_WIZARD_STAGES = [
  { stage: 'upload', label: 'Choose file' },
  { stage: 'classification', label: 'Classification' },
  { stage: 'mapping', label: 'Column mapping' },
  { stage: 'preview', label: 'Preview' },
  { stage: 'complete', label: 'Completed' },
] as const satisfies readonly { stage: ImportWizardStage; label: string }[];

/** Zero-based position of a stage, for "is this stage reached" rendering. */
export function importWizardStageIndex(stage: ImportWizardStage): number {
  return IMPORT_WIZARD_STAGES.findIndex((entry) => entry.stage === stage);
}

/** What one confirmed import did, as the completion summary reads it back — reading 6. */
export interface ImportCompletion {
  summary: ImportRunSummary;
  /** Row elements sent to the loader: the rows that create or update a case (Req 9.2, 9.3). */
  rowsSent: number;
  /** Rows whose producer label resolved to an employee (Requirement 9.6). */
  rowsAssigned: number;
  /** Cases the post-load escalation evaluation raised at least one reason on (Req 20.10). */
  casesEscalated: number;
  /** True where the post-load escalation evaluation ran at all. */
  escalationsEvaluated: boolean;
}

// ---------------------------------------------------------------------------
// Rejection and notice sentences
// ---------------------------------------------------------------------------

/** Requirement 8.1 and 26.4: the sentence a refused attempt by a non-manager would read. */
export const MANAGER_ROLE_REJECTION =
  'Importing a cancellation report, saving a message template, changing the automatic sending setting, reassigning a cancellation, and correcting imported data all require a manager or super admin. Nothing was changed.';

/** Requirement 8.1: the accepted upload, stated next to the file input. */
export const UPLOAD_LIMITS_SENTENCE = `A cancellation report is a CSV file whose first row is a header row, no larger than ${megabytes(
  MAX_IMPORT_FILE_BYTES,
)}, carrying 1 to ${MAX_IMPORT_DATA_ROWS.toLocaleString('en-US')} data rows.`;

/** Reading 2: the sentence a failed existing-state read leaves on the preview. */
export const PREVIEW_SPLIT_UNKNOWN =
  'The stored cancellations could not be read, so every accepted row is counted below as a row that will create a case. The import itself still records the true created and updated counts.';

// ---------------------------------------------------------------------------
// Pure formatting helpers
// ---------------------------------------------------------------------------

/** Megabytes of a byte count, for the upload limit sentence. */
function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * A stored instant as `YYYY-MM-DD HH:MM UTC` — reading 5.
 *
 * Deliberately not `toLocaleString`: this value renders on the first paint from a prop, and a
 * locale-dependent or zone-dependent format would let the server and the browser disagree.
 */
export function formatInstant(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'an unrecorded time';
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  return `${instant.toISOString().slice(0, 10)} ${instant.toISOString().slice(11, 16)} UTC`;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(value: number, singular: string, many = `${singular}s`): string {
  return value === 1 ? singular : many;
}

function failureText(caught: unknown, fallback: string): string {
  return caught instanceof Error && caught.message !== '' ? caught.message : fallback;
}

/** The correction draft of one case, every value as stored and none normalized here. */
export function correctionDraft(row?: CancellationCase | null): ImportedDataCorrectionInput {
  return {
    policyNumber: row?.policy_number ?? '',
    cancellationEffectiveDate: row?.cancellation_effective_date ?? '',
    customerName: row?.customer_name ?? '',
    clientIdentifier: row?.client_identifier ?? '',
    carrier: row?.carrier ?? '',
    cancellationReason: row?.cancellation_reason ?? '',
    amountDue: row?.amount_due === null || row?.amount_due === undefined ? '' : String(row.amount_due),
    producerLabel: row?.producer_label ?? '',
  };
}

/** The eight import-sourced values a manager may correct (Requirement 22.3). */
const CORRECTION_FIELDS = [
  { key: 'policyNumber', label: 'Policy number', required: true, hint: null },
  {
    key: 'cancellationEffectiveDate',
    label: 'Cancellation effective date',
    required: true,
    hint: 'YYYY-MM-DD or M/D/YYYY, read exactly as the import reads it.',
  },
  { key: 'customerName', label: 'Customer name', required: false, hint: null },
  {
    key: 'clientIdentifier',
    label: 'Client identifier',
    required: false,
    hint: 'The customer matching key is recomputed from this value and the customer name.',
  },
  { key: 'carrier', label: 'Carrier', required: false, hint: null },
  { key: 'cancellationReason', label: 'Cancellation reason', required: false, hint: null },
  { key: 'amountDue', label: 'Amount due', required: false, hint: 'Leave blank to clear the stored amount.' },
  { key: 'producerLabel', label: 'Producer label', required: false, hint: null },
] as const satisfies readonly {
  key: keyof ImportedDataCorrectionInput;
  label: string;
  required: boolean;
  hint: string | null;
}[];

/** How many detail rows one list renders before it says how many are left. */
const MAX_LISTED_ROWS = 50;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type CancellationManagerChangeKind =
  | 'import_loaded'
  | 'template_version_saved'
  | 'automatic_sending_changed'
  | 'case_reassigned'
  | 'imported_data_corrected';

/** What one successful manager write changed, for the container's refetch. */
export interface CancellationManagerChange {
  kind: CancellationManagerChangeKind;
  /** The cases the write touched by id, where the write named them. */
  caseIds: string[];
  /** `cancellation_import_runs.id` for a completed import, else `null`. */
  importRunId: string | null;
  /** The template version written for `template_version_saved`, else `null` (Req 14.17). */
  templateVersion: number | null;
  /** The stored setting after `automatic_sending_changed`, else `null` (Req 26.4). */
  automaticSendingEnabled: boolean | null;
  /** True where the container owes the touched cases an escalation re-evaluation. */
  escalationReevaluationDue: boolean;
}

export interface CancellationManagerActionsProps {
  /**
   * The signed-in profile's role. Anything outside `manager` and `super_admin` renders zero nodes:
   * no control, no wrapper, no disabled button (Requirements 22.3, 22.5, 26.4).
   */
  role: AppRole;
  /** Cases in the container's read scope, for the reassignment and correction pickers. */
  cases?: readonly CancellationCase[];
  /** Assignable employees; read here through `listCancellationAssignees` when absent. */
  assignees?: readonly CancellationAssignee[];
  /** Recorded import runs, newest first. `importRuns[0]` is the most recent — reading 6. */
  importRuns?: readonly CancellationImportRun[];
  /** The four templates with their versions; read here through `listCancellationTemplates` when absent. */
  templates?: readonly CancellationTemplateWithVersions[];
  /** The settings row carrying the kill switch; read here through `getCancellationSettings` when absent. */
  settings?: CancellationSettings | null;
  /**
   * The assignment mapping entries, where the container already holds them. Absent, the mapping is
   * read at preview time so Requirement 9.7's unmatched labels can be shown before confirmation.
   */
  assignments?: readonly ProducerAssignmentEntry[];
  /** The row selected in the list, offered as the default target of the case actions. */
  selectedCaseId?: string | null;
  /** A profile id to a display name, for the stored kill-switch profile — reading 5. */
  resolveProfileName?: (profileId: string) => string | null | undefined;
  /** Raised after each successful write so the container refetches. */
  onChanged?: (change: CancellationManagerChange) => void | Promise<void>;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Small presentation helpers
// ---------------------------------------------------------------------------

function CountGrid({
  items,
  className = 'mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5',
}: {
  items: readonly (readonly [string, number])[];
  className?: string;
}) {
  return (
    <dl className={className}>
      {items.map(([label, value]) => (
        <div key={label} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
          <dt className={ui.statLabel}>{label}</dt>
          <dd className="mt-1 text-2xl font-black tabular-nums text-slate-950">{count(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One detail list of the preview or of a recorded run, capped and always saying its own length. */
function DetailList({
  title,
  emptyText,
  entries,
}: {
  title: string;
  emptyText: string;
  entries: readonly { key: string; text: string }[];
}) {
  const shown = entries.slice(0, MAX_LISTED_ROWS);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4">
      <h5 className="text-sm font-black text-slate-900">
        {title}: {count(entries.length)}
      </h5>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs font-semibold text-slate-500">{emptyText}</p>
      ) : (
        <>
          <ul className="mt-2 space-y-1">
            {shown.map((entry) => (
              <li key={entry.key} className="text-xs font-semibold text-slate-700">
                {entry.text}
              </li>
            ))}
          </ul>
          {entries.length > shown.length ? (
            <p className="mt-2 text-xs font-bold text-slate-500">
              and {count(entries.length - shown.length)} more, all recorded on the import audit entry.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/** The five counts and the four detail lists of one run summary or preview (Requirements 8.5, 8.8). */
function RunDetail({
  rowsTotal,
  rowsCreated,
  rowsUpdated,
  rowsRejected,
  rowsDuplicate,
  rejected,
  duplicates,
  producerLabels,
  unmatchedCustomers,
}: {
  rowsTotal: number;
  rowsCreated: number;
  rowsUpdated: number;
  rowsRejected: number;
  rowsDuplicate: number;
  rejected: readonly { row_number: number; reason: string }[];
  duplicates: readonly { row_number: number; duplicate_of_row_number: number }[];
  producerLabels: readonly ProducerLabelEntry[];
  unmatchedCustomers: readonly { row_number: number }[];
}) {
  return (
    <>
      <CountGrid
        items={[
          ['Data rows', rowsTotal],
          ['Will create', rowsCreated],
          ['Will update', rowsUpdated],
          ['Rejected', rowsRejected],
          ['Duplicates', rowsDuplicate],
        ]}
      />
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <DetailList
          title="Rejected rows"
          emptyText="Every data row passed validation."
          entries={rejected.map((entry) => ({
            key: `rejected-${entry.row_number}`,
            text: `Row ${count(entry.row_number)}: ${entry.reason}`,
          }))}
        />
        <DetailList
          title="Duplicate rows"
          emptyText="No two rows carried the same policy number and cancellation effective date."
          entries={duplicates.map((entry) => ({
            key: `duplicate-${entry.row_number}`,
            text: `Row ${count(entry.row_number)} repeats row ${count(
              entry.duplicate_of_row_number,
            )} and is excluded from creation and update.`,
          }))}
        />
        <DetailList
          title="Unmatched producer labels"
          emptyText="Every producer label matched an employee in the assignment mapping."
          entries={groupProducerLabels(producerLabels).map((group) => ({
            key: `producer-${group.label}-${group.firstRowNumber}`,
            text: `${group.label === '' ? '(blank label)' : group.label} — ${count(
              group.rowNumbers.length,
            )} ${plural(group.rowNumbers.length, 'row')}, first at row ${count(group.firstRowNumber)}`,
          }))}
        />
        <DetailList
          title="Unmatched customers"
          emptyText="Every row produced a customer matching key."
          entries={unmatchedCustomers.map((entry) => ({
            key: `customer-${entry.row_number}`,
            text: `Row ${count(
              entry.row_number,
            )} carries neither a client identifier nor a customer name, so it loads with no matched customer and is excluded from combined messages.`,
          }))}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CancellationManagerActions({
  role,
  cases = [],
  assignees: assigneesProp,
  importRuns: importRunsProp,
  templates: templatesProp,
  settings: settingsProp,
  assignments,
  selectedCaseId = null,
  resolveProfileName,
  onChanged,
  disabled = false,
}: CancellationManagerActionsProps) {
  const isManager = isBroadManagerRole(role);
  const baseId = useId();
  const menuId = `${baseId}-menu`;

  const [menuOpen, setMenuOpen] = useState(false);
  const [panel, setPanel] = useState<CancellationManagerPanelId | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Loaded configuration, used only where the container supplied none.
  const [loadedAssignees, setLoadedAssignees] = useState<readonly CancellationAssignee[]>([]);
  const [loadedRuns, setLoadedRuns] = useState<readonly CancellationImportRun[]>([]);
  const [loadedTemplates, setLoadedTemplates] = useState<readonly CancellationTemplateWithVersions[]>([]);
  const [loadedSettings, setLoadedSettings] = useState<CancellationSettings | null>(null);

  // The import wizard — reading 1.
  const [stage, setStage] = useState<ImportWizardStage>('upload');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [classified, setClassified] = useState<ClassifiedImportFile | null>(null);
  const [fileRejection, setFileRejection] = useState<ImportFileRejection | null>(null);
  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [blockReasons, setBlockReasons] = useState<readonly MappingBlockReason[]>([]);
  const [confirmed, setConfirmed] = useState<ConfirmedMapping | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewProducerLabels, setPreviewProducerLabels] = useState<readonly ProducerLabelEntry[]>([]);
  const [previewCaveat, setPreviewCaveat] = useState<string | null>(null);
  const [lookup, setLookup] = useState<ProducerAssignmentLookup | null>(null);
  const [completion, setCompletion] = useState<ImportCompletion | null>(null);

  // Template editing — reading 4.
  const [templateId, setTemplateId] = useState('');
  const [templateEdit, setTemplateEdit] = useState<TemplateDraft | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);

  // The kill switch — reading 5.
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Reassignment and correction.
  const [assignTarget, setAssignTarget] = useState('');
  const [assignTo, setAssignTo] = useState('');
  const [assignError, setAssignError] = useState<string | null>(null);
  const [correctTarget, setCorrectTarget] = useState('');
  const [correction, setCorrection] = useState<ImportedDataCorrectionInput>(() => correctionDraft());
  const [correctError, setCorrectError] = useState<string | null>(null);
  const [caseQuery, setCaseQuery] = useState('');

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const assigneeList = assigneesProp ?? loadedAssignees;
  const importRuns = importRunsProp ?? loadedRuns;
  const templates = templatesProp ?? loadedTemplates;
  const settings = settingsProp ?? loadedSettings;
  const busy = disabled || pending !== null;

  // Configuration the container did not supply is read once, per surface, and a failure is stated
  // rather than swallowed.
  useEffect(() => {
    if (!isManager || assigneesProp !== undefined) return;
    let live = true;
    void listCancellationAssignees()
      .then((people) => {
        if (live) setLoadedAssignees(people);
      })
      .catch((caught: unknown) => {
        if (live) setError(failureText(caught, 'The assignable employees could not be loaded.'));
      });
    return () => {
      live = false;
    };
  }, [assigneesProp, isManager]);

  useEffect(() => {
    if (!isManager || importRunsProp !== undefined) return;
    let live = true;
    void listCancellationImportRuns()
      .then((runs) => {
        if (live) setLoadedRuns(runs);
      })
      .catch((caught: unknown) => {
        if (live) setError(failureText(caught, 'The import history could not be loaded.'));
      });
    return () => {
      live = false;
    };
  }, [importRunsProp, isManager]);

  useEffect(() => {
    if (!isManager || templatesProp !== undefined) return;
    let live = true;
    void listCancellationTemplates()
      .then((rows) => {
        if (live) setLoadedTemplates(rows);
      })
      .catch((caught: unknown) => {
        if (live) setTemplateError(failureText(caught, 'The message templates could not be loaded.'));
      });
    return () => {
      live = false;
    };
  }, [templatesProp, isManager]);

  useEffect(() => {
    if (!isManager || settingsProp !== undefined) return;
    let live = true;
    void getCancellationSettings()
      .then((row) => {
        if (live) setLoadedSettings(row);
      })
      .catch((caught: unknown) => {
        if (live) setSettingsError(failureText(caught, 'The cancellation settings could not be loaded.'));
      });
    return () => {
      live = false;
    };
  }, [settingsProp, isManager]);

  const caseOptions = useMemo(() => {
    const needle = caseQuery.trim().toLowerCase();
    const matched = cases.filter(
      (row) =>
        needle === '' ||
        `${row.customer_name ?? ''} ${row.policy_number} ${row.carrier ?? ''}`.toLowerCase().includes(needle),
    );
    return matched.slice(0, 200);
  }, [caseQuery, cases]);

  /** The most recent completed import: this session's, else the newest recorded run — reading 6. */
  const reviewRun: ImportRunSummary | null = useMemo(() => {
    if (completion !== null) return completion.summary;
    const newest = importRuns[0];
    return newest === undefined ? null : summarizeImportRun(newest);
  }, [completion, importRuns]);

  /**
   * Runs one write. A success shows the notice and raises `onChanged`; a failure sends the message
   * to the field it belongs to and clears no draft, so every entered value stays on screen.
   */
  async function perform(
    key: string,
    write: () => Promise<{ notice: string; change: CancellationManagerChange } | null>,
    fail: (message: string) => void,
    fallback: string,
  ): Promise<void> {
    setPending(key);
    setError(null);
    setNotice(null);
    try {
      const result = await write();
      if (result === null) return;
      if (mountedRef.current) setNotice(result.notice);
      await onChanged?.(result.change);
    } catch (caught) {
      if (mountedRef.current) fail(failureText(caught, fallback));
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }

  function openPanel(next: CancellationManagerPanelId): void {
    setError(null);
    setNotice(null);
    if (panel === next) {
      setPanel(null);
      return;
    }
    if (next === 'reassign') {
      const target = assignTarget !== '' ? assignTarget : (selectedCaseId ?? '');
      setAssignTarget(target);
      setAssignTo(cases.find((row) => row.id === target)?.assigned_to ?? '');
      setAssignError(null);
    }
    if (next === 'correct') {
      const target = correctTarget !== '' ? correctTarget : (selectedCaseId ?? '');
      setCorrectTarget(target);
      setCorrection(correctionDraft(cases.find((row) => row.id === target)));
      setCorrectError(null);
    }
    if (next === 'templates' && templateEdit === null && templates.length > 0) {
      selectTemplate(templates[0].id, templates);
    }
    setPanel(next);
  }

  // -------------------------------------------------------------------------
  // The import wizard (Requirements 8.1, 8.4, 8.5, 8.13, 9.2, 9.3, 9.4, 9.7, 9.11)
  // -------------------------------------------------------------------------

  function resetWizard(): void {
    setStage('upload');
    setFileName('');
    setParsed(null);
    setClassified(null);
    setFileRejection(null);
    setDraft(null);
    setBlockReasons([]);
    setConfirmed(null);
    setPreview(null);
    setPreviewProducerLabels([]);
    setPreviewCaveat(null);
    setLookup(null);
    setCompletion(null);
    setError(null);
  }

  /** Upload: parse, then apply every file-level condition of Requirements 8.1 and 8.13. */
  async function loadFile(file: File | null): Promise<void> {
    if (file === null) return;
    setError(null);
    setNotice(null);
    setFileRejection(null);
    setPending('file');
    try {
      const parsedFile = parseCsv(await file.text());
      const result = classifyParsedFile(parsedFile, file.size);
      if (!mountedRef.current) return;
      setFileName(file.name);
      if (!result.ok) {
        // Requirement 8.13: the whole file is refused, nothing is written, and the message names
        // the unmet condition and the required column names.
        setFileRejection(result);
        setParsed(null);
        setClassified(null);
        setStage('upload');
        return;
      }
      setParsed(parsedFile);
      setClassified(result);
      setDraft(null);
      setConfirmed(null);
      setPreview(null);
      setCompletion(null);
      setStage('classification');
    } catch (caught) {
      if (mountedRef.current) setError(failureText(caught, 'The cancellation report could not be read.'));
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }

  /** Classification result accepted: propose one target column per file header (Requirement 8.4). */
  function startMapping(): void {
    if (classified === null || parsed === null) return;
    setDraft(proposeMapping(classified.columnSet, parsed.header));
    setBlockReasons([]);
    setStage('mapping');
  }

  /** One manager override of one proposal (Requirement 8.4). */
  function changeMapping(headerIndex: number, column: CancellationColumn | null): void {
    if (draft === null) return;
    try {
      setDraft(applyOverride(draft, headerIndex, column));
      setBlockReasons([]);
    } catch (caught) {
      setError(failureText(caught, 'That column mapping could not be applied.'));
    }
  }

  /**
   * Confirm the mapping and build the preview — readings 2 and 3.
   *
   * Blocked while either identity column is unmapped (Requirement 8.4). Nothing is written: the
   * two reads establish the created/updated split and the unmatched producer labels so the numbers
   * on screen are the numbers the import will record.
   */
  async function buildPreview(): Promise<void> {
    if (draft === null || parsed === null) return;
    setError(null);
    setNotice(null);
    const result = confirmMapping(draft);
    if (!result.confirmed) {
      setBlockReasons(result.blockReasons);
      return;
    }
    setBlockReasons([]);
    setPending('preview');
    try {
      const mapping = result.mapping;
      const firstPass = previewParsedFile(mapping, parsed);

      let built = firstPass;
      let caveat: string | null = null;
      const existing = await fetchExistingCaseState(previewPolicyNumbers(firstPass));
      if (existing.ok) {
        built = previewParsedFile(mapping, parsed, {
          existingIdentities: existing.state.identities,
          existingContactValues: existing.state.contactValues,
        });
      } else {
        caveat = PREVIEW_SPLIT_UNKNOWN;
      }

      let resolvedLookup: ProducerAssignmentLookup;
      if (assignments !== undefined) {
        resolvedLookup = buildProducerAssignmentLookup(assignments);
      } else {
        const mappingRead = await fetchProducerAssignmentMapping();
        if (!mappingRead.ok) {
          if (mountedRef.current) setError(mappingRead.failure.message);
          return;
        }
        resolvedLookup = mappingRead.mapping.byNormalizedLabel;
      }

      const payload = buildImportBatchPayload(built, resolvedLookup);
      if (!mountedRef.current) return;
      setConfirmed(mapping);
      setPreview(built);
      setPreviewProducerLabels(payload.unmatchedProducerLabels);
      setPreviewCaveat(caveat);
      setLookup(resolvedLookup);
      setStage('preview');
    } catch (caught) {
      if (mountedRef.current) setError(failureText(caught, 'The import preview could not be built.'));
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }

  /** Confirmation: the one call that writes (Requirements 8.5, 8.7, 8.8, 8.9). */
  async function confirmImport(): Promise<void> {
    if (confirmed === null || preview === null) return;
    setPending('import');
    setError(null);
    setNotice(null);
    try {
      const result = await loadImportBatch({
        fileName,
        mapping: confirmed,
        preview,
        assignments: lookup ?? undefined,
      });
      if (!result.ok) {
        // Nothing was written; the preview and every list stay on screen.
        if (mountedRef.current) setError(result.failure.message);
        return;
      }
      const done: ImportCompletion = {
        summary: summarizeImportRun(result.outcome.run),
        rowsSent: result.outcome.rowsSent,
        rowsAssigned: result.outcome.rowsAssigned,
        casesEscalated: result.outcome.escalations.casesEscalated,
        escalationsEvaluated: result.outcome.escalations.ran,
      };
      if (mountedRef.current) {
        setCompletion(done);
        setStage('complete');
        setNotice(
          `${fileName} was imported. ${count(done.summary.rowsCreated)} created, ${count(
            done.summary.rowsUpdated,
          )} updated, ${count(done.summary.rowsRejected)} rejected, ${count(
            done.summary.rowsDuplicate,
          )} duplicate.`,
        );
      }
      await onChanged?.({
        kind: 'import_loaded',
        caseIds: [],
        importRunId: done.summary.id,
        templateVersion: null,
        automaticSendingEnabled: null,
        escalationReevaluationDue: !done.escalationsEvaluated,
      });
    } catch (caught) {
      if (mountedRef.current) setError(failureText(caught, 'The cancellation import could not be completed.'));
    } finally {
      if (mountedRef.current) setPending(null);
    }
  }

  // -------------------------------------------------------------------------
  // Template editing (Requirement 14.17) — reading 4
  // -------------------------------------------------------------------------

  function selectTemplate(nextId: string, source: readonly CancellationTemplateWithVersions[] = templates): void {
    setTemplateId(nextId);
    setTemplateError(null);
    const template = source.find((row) => row.id === nextId);
    setTemplateEdit(template === undefined ? null : templateDraft(template.id, template.versions));
  }

  function editSegment(language: string, key: TemplateTextFieldKey, value: string): void {
    setTemplateEdit((current) =>
      current === null
        ? current
        : {
            ...current,
            languages: current.languages.map((segment) =>
              segment.language === language ? { ...segment, [key]: value } : segment,
            ),
          },
    );
    setTemplateError(null);
  }

  function editFallback(language: string, token: string, value: string): void {
    setTemplateEdit((current) =>
      current === null
        ? current
        : {
            ...current,
            languages: current.languages.map((segment) =>
              segment.language === language
                ? { ...segment, fallbackText: { ...segment.fallbackText, [token]: value } }
                : segment,
            ),
          },
    );
    setTemplateError(null);
  }

  async function submitTemplate(): Promise<void> {
    if (templateEdit === null) {
      setTemplateError('Choose a message template to edit. Nothing was saved.');
      return;
    }
    const rejection = templateDraftRejection(templateEdit);
    if (rejection !== null) {
      setTemplateError(rejection);
      return;
    }
    await perform(
      'template',
      async () => {
        const saved = await saveTemplateVersion({
          templateId: templateEdit.templateId,
          segments: templateEdit.languages.map((segment) => ({
            language: segment.language,
            subject: segment.subject,
            body: segment.body,
            cancellationStatement: segment.cancellationStatement,
            contactRequest: segment.contactRequest,
            fallbackText: Object.fromEntries(
              segment.fallbackTokens.map((token) => [token, segment.fallbackText[token] ?? '']),
            ),
          })),
        });
        // Reload the versions so the editor is based on the version that was just written, and so a
        // second save writes the next number rather than colliding.
        const versions = await listTemplateVersions(templateEdit.templateId);
        if (mountedRef.current) {
          setTemplateEdit(templateDraft(templateEdit.templateId, versions));
          setLoadedTemplates((current) =>
            current.map((row) => (row.id === templateEdit.templateId ? { ...row, versions } : row)),
          );
        }
        return {
          notice: `Version ${count(saved.version)} of this template was saved. Version ${count(
            saved.previousVersion,
          )} is unchanged, and every message already sent still reads exactly as it was sent.`,
          change: {
            kind: 'template_version_saved' as const,
            caseIds: [],
            importRunId: null,
            templateVersion: saved.version,
            automaticSendingEnabled: null,
            escalationReevaluationDue: false,
          },
        };
      },
      setTemplateError,
      'The message template could not be saved.',
    );
  }

  // -------------------------------------------------------------------------
  // The automatic-sending kill switch (Requirement 26.4) — reading 5
  // -------------------------------------------------------------------------

  async function toggleAutomaticSending(next: boolean): Promise<void> {
    setSettingsError(null);
    await perform(
      'sending',
      async () => {
        const stored = await setAutomaticSendingEnabled(next);
        if (mountedRef.current) setLoadedSettings(stored);
        const who =
          stored.updated_by === null
            ? 'an unrecorded profile'
            : (resolveProfileName?.(stored.updated_by) ??
              assigneeList.find((person) => person.id === stored.updated_by)?.display_name ??
              `profile ${stored.updated_by}`);
        return {
          notice: `Automatic touchpoint sending is ${
            stored.automatic_sending_enabled ? 'enabled' : 'disabled'
          } for every cancellation. Stored against ${who} at ${formatInstant(stored.updated_at)}.${
            stored.automatic_sending_enabled
              ? ''
              : ' Send Reminder Now and Retry Failed Communication keep working.'
          }`,
          change: {
            kind: 'automatic_sending_changed' as const,
            caseIds: [],
            importRunId: null,
            templateVersion: null,
            automaticSendingEnabled: stored.automatic_sending_enabled,
            escalationReevaluationDue: false,
          },
        };
      },
      setSettingsError,
      'The automatic sending setting could not be changed.',
    );
  }

  // -------------------------------------------------------------------------
  // Reassignment and imported-data correction (Requirement 22.3)
  // -------------------------------------------------------------------------

  async function submitReassign(): Promise<void> {
    setAssignError(null);
    const row = cases.find((entry) => entry.id === assignTarget);
    if (row === undefined) {
      setAssignError('Choose the cancellation to reassign. Nothing was changed.');
      return;
    }
    const person = assigneeList.find((entry) => entry.id === assignTo);
    if (assignTo !== '' && person === undefined) {
      setAssignError('Choose an employee, or choose "Clear the assignment". Nothing was changed.');
      return;
    }
    await perform(
      'reassign',
      async () => {
        const stored = await assignCancellationCase(row.id, assignTo === '' ? null : assignTo);
        return {
          notice:
            assignTo === ''
              ? `${row.policy_number} now has no assigned employee.`
              : `${row.policy_number} is assigned to ${person?.display_name ?? 'the selected employee'}. A later import will not move it.`,
          change: {
            kind: 'case_reassigned' as const,
            caseIds: [stored.id],
            importRunId: null,
            templateVersion: null,
            automaticSendingEnabled: null,
            escalationReevaluationDue: true,
          },
        };
      },
      setAssignError,
      'The cancellation assignment could not be saved.',
    );
  }

  async function submitCorrection(): Promise<void> {
    setCorrectError(null);
    const row = cases.find((entry) => entry.id === correctTarget);
    if (row === undefined) {
      setCorrectError('Choose the cancellation to correct. Nothing was changed.');
      return;
    }
    await perform(
      'correct',
      async () => {
        const result = await correctImportedCaseData(row.id, correction);
        if (result.changedColumns.length === 0) {
          if (mountedRef.current) {
            setCorrectError('Every value already matches what is stored. Nothing was changed.');
          }
          return null;
        }
        return {
          notice: `${count(result.changedColumns.length)} imported ${plural(
            result.changedColumns.length,
            'value',
          )} corrected on ${result.values.policy_number}: ${result.changedColumns.join(
            ', ',
          )}. One audit timeline entry records the previous and new value of each.`,
          change: {
            kind: 'imported_data_corrected' as const,
            caseIds: [row.id],
            importRunId: null,
            templateVersion: null,
            automaticSendingEnabled: null,
            escalationReevaluationDue: true,
          },
        };
      },
      setCorrectError,
      'The imported cancellation data could not be corrected.',
    );
  }

  // Requirement 22.3 and 26.4: zero nodes for a profile outside Manager_Role. Not a disabled
  // control, not an empty wrapper — nothing at all.
  if (!isManager) return null;

  const stageIndex = importWizardStageIndex(stage);
  const activeAction = CANCELLATION_MANAGER_ACTIONS.find((action) => action.id === panel) ?? null;
  const panelId = `${baseId}-panel`;
  const employeeOptions = assigneeList.map((person) => (
    <option key={person.id} value={person.id}>
      {person.display_name} · {person.initials} · {person.role.replace(/_/g, ' ')}
    </option>
  ));

  return (
    <section className={`${ui.card} ${ui.cardPad} space-y-4`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h3 className="font-black text-slate-950">Manager actions</h3>
            <p className="mt-1 max-w-3xl text-sm font-semibold text-slate-500">
              Importing, template changes, the automatic-sending switch, unmatched-row review,
              reassignment, and imported-data correction. Every change is recorded with your profile
              and the time, and no stored communication is ever changed.
            </p>
          </div>
        </div>
        <button
          type="button"
          className={ui.btnSecondary}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          {menuOpen ? 'Hide manager actions' : 'Show manager actions'}
          <ChevronDown className={`h-4 w-4 transition ${menuOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {/* The live region stays mounted so a result is announced whether or not a panel is open. */}
      <p aria-live="polite" className="sr-only">
        {notice ?? ''}
      </p>

      {menuOpen ? (
        <div id={menuId} className="space-y-4">
          <div role="group" aria-label="Manager actions" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {CANCELLATION_MANAGER_ACTIONS.map(({ id, label, hint, Icon }) => (
              <button
                key={id}
                type="button"
                aria-expanded={panel === id}
                aria-controls={panelId}
                onClick={() => openPanel(id)}
                className={`flex items-start gap-3 rounded-2xl border px-3 py-3 text-left transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[#eef3fb] ${
                  panel === id
                    ? 'border-[#223f7a] bg-[#f8faff]'
                    : 'border-slate-200 bg-white hover:border-[#8da4cf] hover:bg-[#f8faff]'
                }`}
              >
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span>
                  <span className="block text-sm font-black text-slate-900">{label}</span>
                  <span className="mt-0.5 block text-xs font-semibold text-slate-500">{hint}</span>
                </span>
              </button>
            ))}
          </div>

          {notice !== null ? (
            <p className={ui.success}>
              <CheckCircle2 className="mr-2 inline h-4 w-4" aria-hidden="true" />
              {notice}
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className={ui.error}>
              <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
              {error}
            </p>
          ) : null}

          {activeAction !== null ? (
            <div id={panelId} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className={ui.sectionTitle}>Manager action</p>
                  <h4 className="mt-1 text-lg font-black text-slate-950">{activeAction.label}</h4>
                  <p className="mt-1 max-w-3xl text-sm font-semibold text-slate-500">{activeAction.hint}</p>
                </div>
                <button type="button" className={ui.btnGhost} onClick={() => setPanel(null)}>
                  <X className="h-4 w-4" aria-hidden="true" />
                  Close
                </button>
              </div>

              {/* ------------------------------------------------------------ */}
              {/* Import wizard                                                */}
              {/* ------------------------------------------------------------ */}
              {panel === 'import' ? (
                <div className="mt-4 space-y-4">
                  <ol className="flex flex-wrap gap-2">
                    {IMPORT_WIZARD_STAGES.map((entry, index) => (
                      <li
                        key={entry.stage}
                        aria-current={entry.stage === stage ? 'step' : undefined}
                        className={`${ui.badge} ${
                          entry.stage === stage
                            ? ui.badgeTone.info
                            : index < stageIndex
                              ? ui.badgeTone.success
                              : ui.badgeTone.neutral
                        }`}
                      >
                        {index + 1}. {entry.label}
                        {index < stageIndex ? ' — done' : entry.stage === stage ? ' — current' : ''}
                      </li>
                    ))}
                  </ol>

                  {/* Stage 1: upload (Requirements 8.1, 8.13) */}
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <label className={ui.label} htmlFor={`${baseId}-file`}>
                      Cancellation report CSV file
                    </label>
                    <p id={`${baseId}-file-hint`} className="mt-1 text-xs font-semibold text-slate-500">
                      {UPLOAD_LIMITS_SENTENCE}
                    </p>
                    <input
                      id={`${baseId}-file`}
                      type="file"
                      accept=".csv,text/csv"
                      className="mt-2 block w-full text-sm font-semibold"
                      disabled={busy}
                      aria-invalid={fileRejection !== null}
                      aria-describedby={`${baseId}-file-hint${
                        fileRejection !== null ? ` ${baseId}-file-error` : ''
                      }`}
                      onChange={(event) => void loadFile(event.target.files?.[0] ?? null)}
                    />
                    {fileName !== '' ? (
                      <p className="mt-2 text-xs font-bold text-slate-500">Selected file: {fileName}</p>
                    ) : null}
                    {fileRejection !== null ? (
                      <div id={`${baseId}-file-error`} role="alert" className={`${ui.error} mt-3`}>
                        <p className="flex gap-2">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>{fileRejection.message}</span>
                        </p>
                        <p className="mt-2 text-xs font-bold">
                          Nothing was written: zero cancellations and zero contact rows were created,
                          and every stored row is unchanged.
                        </p>
                      </div>
                    ) : null}
                  </div>

                  {/* Stage 2: classification result (Requirements 8.2, 8.3) */}
                  {stage !== 'upload' && classified !== null ? (
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <h5 className="text-sm font-black text-slate-900">Classification result</h5>
                      <p className="mt-1 text-sm font-semibold text-slate-600">
                        The header row names the <strong>{classified.columnSet}</strong> column set, and
                        the file carries {count(classified.dataRowCount)}{' '}
                        {plural(classified.dataRowCount, 'data row')}.
                      </p>
                      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
                        <div>
                          <dt className={ui.statLabel}>Columns found ({count(classified.presentColumns.length)})</dt>
                          <dd className="mt-1 text-xs font-semibold text-slate-700">
                            {classified.presentColumns.join(', ')}
                          </dd>
                        </div>
                        <div>
                          <dt className={ui.statLabel}>Columns absent ({count(classified.absentColumns.length)})</dt>
                          <dd className="mt-1 text-xs font-semibold text-slate-700">
                            {classified.absentColumns.length === 0
                              ? 'None — every column of the set is present.'
                              : `${classified.absentColumns.join(', ')} — each is treated as an absent value for every row.`}
                          </dd>
                        </div>
                      </dl>
                      {stage === 'classification' ? (
                        <button
                          type="button"
                          className={`${ui.btnPrimary} mt-3`}
                          disabled={busy}
                          onClick={startMapping}
                        >
                          <ListChecks className="h-4 w-4" aria-hidden="true" />
                          Continue to column mapping
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Stage 3: mapping overrides (Requirement 8.4) */}
                  {(stage === 'mapping' || stage === 'preview' || stage === 'complete') && draft !== null ? (
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <h5 className="text-sm font-black text-slate-900">Column mapping</h5>
                      <p className="mt-1 text-sm font-semibold text-slate-600">
                        Each file header is proposed against the column of the {draft.columnSet} set whose
                        name matches it, ignoring case and surrounding spaces. Change any proposal below.
                        A header left unmapped still reaches the database inside the stored raw row.
                      </p>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {draft.assignments.map((assignment) => {
                          const selectId = `${baseId}-map-${assignment.headerIndex}`;
                          const changed = assignment.column !== assignment.proposedColumn;
                          return (
                            <div key={selectId}>
                              <label className={ui.label} htmlFor={selectId}>
                                {assignment.header === ''
                                  ? `Column ${count(assignment.headerIndex + 1)} (blank header)`
                                  : assignment.header}
                              </label>
                              <select
                                id={selectId}
                                className={ui.select}
                                disabled={busy || stage !== 'mapping'}
                                value={assignment.column ?? ''}
                                onChange={(event) =>
                                  changeMapping(
                                    assignment.headerIndex,
                                    event.target.value === ''
                                      ? null
                                      : (event.target.value as CancellationColumn),
                                  )
                                }
                              >
                                <option value="">Do not import this column</option>
                                {COLUMNS_BY_SET[draft.columnSet].map((column) => (
                                  <option key={column} value={column}>
                                    {column}
                                  </option>
                                ))}
                              </select>
                              <p className="mt-1 text-xs font-semibold text-slate-500">
                                {changed
                                  ? `Changed from ${assignment.proposedColumn ?? 'unmapped'}`
                                  : assignment.proposedColumn === null
                                    ? 'No column name matched this header'
                                    : 'Matched automatically'}
                              </p>
                            </div>
                          );
                        })}
                      </div>

                      {blockReasons.length > 0 ? (
                        <div role="alert" className={`${ui.error} mt-3`}>
                          <ul className="space-y-1">
                            {blockReasons.map((reason) => (
                              <li key={reason.code} className="flex gap-2">
                                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                                <span>{reason.message}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {stage === 'mapping' ? (
                        <button
                          type="button"
                          className={`${ui.btnPrimary} mt-3`}
                          disabled={busy}
                          onClick={() => void buildPreview()}
                        >
                          {pending === 'preview' ? (
                            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <FileUp className="h-4 w-4" aria-hidden="true" />
                          )}
                          {pending === 'preview' ? 'Building the preview…' : 'Confirm mapping and preview'}
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Stage 4: preview and confirmation (Requirement 8.5) */}
                  {(stage === 'preview' || stage === 'complete') && preview !== null ? (
                    <div className="rounded-2xl border border-slate-200 bg-white p-4">
                      <h5 className="text-sm font-black text-slate-900">Import preview</h5>
                      <p className="mt-1 text-sm font-semibold text-slate-600">
                        Nothing has been written yet: zero cancellations and zero contact rows exist from
                        this file until you confirm below.
                      </p>
                      {previewCaveat !== null ? (
                        <p className={`${ui.info} mt-3`}>{previewCaveat}</p>
                      ) : null}
                      <RunDetail
                        rowsTotal={preview.rowsTotal}
                        rowsCreated={preview.rowsCreated}
                        rowsUpdated={preview.rowsUpdated}
                        rowsRejected={preview.rowsRejected}
                        rowsDuplicate={preview.rowsDuplicate}
                        rejected={preview.rejectedRows}
                        duplicates={preview.duplicateRows}
                        producerLabels={previewProducerLabels}
                        unmatchedCustomers={preview.unmatchedCustomerRows}
                      />
                      <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-xl border border-slate-200 px-3 py-2">
                          <dt className={ui.statLabel}>Rows with no amount due</dt>
                          <dd className="mt-1 text-lg font-black tabular-nums text-slate-950">
                            {count(preview.amountDueAbsentRows.length)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-slate-200 px-3 py-2">
                          <dt className={ui.statLabel}>Contact rows marked invalid</dt>
                          <dd className="mt-1 text-lg font-black tabular-nums text-slate-950">
                            {count(preview.invalidContactCount)}
                          </dd>
                        </div>
                        <div className="rounded-xl border border-slate-200 px-3 py-2">
                          <dt className={ui.statLabel}>Contacts beyond the per-case cap</dt>
                          <dd className="mt-1 text-lg font-black tabular-nums text-slate-950">
                            {count(preview.contactOverflowCount)}
                          </dd>
                        </div>
                      </dl>

                      {stage === 'preview' ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            className={ui.btnPrimary}
                            disabled={busy}
                            onClick={() => void confirmImport()}
                          >
                            {pending === 'import' ? (
                              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                            ) : (
                              <UploadCloud className="h-4 w-4" aria-hidden="true" />
                            )}
                            {pending === 'import'
                              ? 'Importing…'
                              : `Confirm and import ${count(
                                  preview.rowsCreated + preview.rowsUpdated,
                                )} ${plural(preview.rowsCreated + preview.rowsUpdated, 'row')}`}
                          </button>
                          <button
                            type="button"
                            className={ui.btnSecondary}
                            disabled={busy}
                            onClick={() => setStage('mapping')}
                          >
                            <ListChecks className="h-4 w-4" aria-hidden="true" />
                            Back to column mapping
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Stage 5: completion summary (Requirement 8.8) */}
                  {stage === 'complete' && completion !== null ? (
                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
                      <h5 className="flex items-center gap-2 text-sm font-black text-emerald-900">
                        <BadgeCheck className="h-4 w-4" aria-hidden="true" />
                        Import completed
                      </h5>
                      <p className="mt-1 text-sm font-semibold text-emerald-900">
                        {completion.summary.fileName} was recorded as the {completion.summary.columnSet}{' '}
                        column set at {formatInstant(completion.summary.completedAt)}.{' '}
                        {count(completion.rowsSent)} {plural(completion.rowsSent, 'row')} were sent,{' '}
                        {count(completion.rowsAssigned)} of them resolved to an employee, and{' '}
                        {completion.escalationsEvaluated
                          ? `${count(completion.casesEscalated)} ${plural(
                              completion.casesEscalated,
                              'case',
                            )} raised an escalation.`
                          : 'the escalation evaluation was skipped for this run.'}
                      </p>
                      <RunDetail
                        rowsTotal={completion.summary.rowsTotal}
                        rowsCreated={completion.summary.rowsCreated}
                        rowsUpdated={completion.summary.rowsUpdated}
                        rowsRejected={completion.summary.rowsRejected}
                        rowsDuplicate={completion.summary.rowsDuplicate}
                        rejected={completion.summary.rejectedRows}
                        duplicates={completion.summary.duplicateRows}
                        producerLabels={completion.summary.unmatchedProducerLabels}
                        unmatchedCustomers={completion.summary.unmatchedCustomerRows}
                      />
                      <button type="button" className={`${ui.btnSecondary} mt-3`} onClick={resetWizard}>
                        <FileUp className="h-4 w-4" aria-hidden="true" />
                        Import another file
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {/* ------------------------------------------------------------ */}
              {/* Message templates (Requirement 14.17)                        */}
              {/* ------------------------------------------------------------ */}
              {panel === 'templates' ? (
                <form
                  noValidate
                  aria-busy={pending === 'template'}
                  className="mt-4 space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitTemplate();
                  }}
                >
                  <p className={ui.info}>
                    Saving stores a new version of the selected template. No stored version is changed and
                    none is removed, so every message already sent still reads exactly as it was sent.
                  </p>

                  <div>
                    <label className={ui.label} htmlFor={`${baseId}-template`}>
                      Template
                    </label>
                    <select
                      id={`${baseId}-template`}
                      className={ui.select}
                      disabled={busy}
                      value={templateId}
                      onChange={(event) => selectTemplate(event.target.value)}
                    >
                      <option value="">Choose a template</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>
                          {template.name} · {template.touchpoint}
                        </option>
                      ))}
                    </select>
                    {templates.length === 0 ? (
                      <p className="mt-2 text-xs font-semibold text-slate-500">
                        No message templates were returned.
                      </p>
                    ) : null}
                  </div>

                  {templateEdit !== null ? (
                    <>
                      <p className="text-sm font-bold text-slate-700">
                        Editing from version {count(templateEdit.baseVersion)}. Saving writes version{' '}
                        {count(templateEdit.baseVersion + 1)}.
                      </p>
                      {templateEdit.languages.length === 0 ? (
                        <p className={ui.empty}>
                          This template has no stored version to base a new version on.
                        </p>
                      ) : null}
                      {templateEdit.languages.map((segment) => (
                        <fieldset
                          key={segment.language}
                          className="rounded-2xl border border-slate-200 bg-white p-4"
                        >
                          <legend className="px-1 text-sm font-black text-slate-900">
                            {segment.language}
                          </legend>
                          <div className="space-y-3">
                            {TEMPLATE_TEXT_FIELDS.map((field) => {
                              const fieldId = `${baseId}-tpl-${segment.language}-${field.key}`;
                              return (
                                <div key={field.key}>
                                  <label className={ui.label} htmlFor={fieldId}>
                                    {field.label} (required)
                                  </label>
                                  <textarea
                                    id={fieldId}
                                    className={ui.textarea}
                                    disabled={busy}
                                    rows={field.key === 'body' ? 6 : 2}
                                    value={segment[field.key]}
                                    onChange={(event) =>
                                      editSegment(segment.language, field.key, event.target.value)
                                    }
                                  />
                                </div>
                              );
                            })}
                            {segment.fallbackTokens.length > 0 ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                {segment.fallbackTokens.map((token) => {
                                  const tokenId = `${baseId}-fb-${segment.language}-${token}`;
                                  return (
                                    <div key={token}>
                                      <label className={ui.label} htmlFor={tokenId}>
                                        Fallback text for {token}
                                      </label>
                                      <input
                                        id={tokenId}
                                        className={ui.input}
                                        disabled={busy}
                                        value={segment.fallbackText[token] ?? ''}
                                        onChange={(event) =>
                                          editFallback(segment.language, token, event.target.value)
                                        }
                                      />
                                      <p className="mt-1 text-xs font-semibold text-slate-500">
                                        Left blank, this token renders zero characters.
                                      </p>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        </fieldset>
                      ))}
                    </>
                  ) : null}

                  {templateError !== null ? (
                    <p id={`${baseId}-template-error`} role="alert" className={ui.error}>
                      <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                      {templateError}
                    </p>
                  ) : null}

                  <button
                    type="submit"
                    className={ui.btnPrimary}
                    disabled={busy || templateEdit === null || templateEdit.languages.length === 0}
                    aria-describedby={templateError !== null ? `${baseId}-template-error` : undefined}
                  >
                    {pending === 'template' ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <MailCheck className="h-4 w-4" aria-hidden="true" />
                    )}
                    {pending === 'template'
                      ? 'Saving a new version…'
                      : `Save as version ${count((templateEdit?.baseVersion ?? 0) + 1)}`}
                  </button>
                </form>
              ) : null}

              {/* ------------------------------------------------------------ */}
              {/* Automatic sending kill switch (Requirement 26.4)             */}
              {/* ------------------------------------------------------------ */}
              {panel === 'sending' ? (
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl border border-slate-200 bg-white p-4">
                    <p className={ui.statLabel}>Current setting</p>
                    <p className="mt-1 flex items-center gap-2 text-lg font-black text-slate-950">
                      {settings === null ? (
                        'Not loaded'
                      ) : (
                        <>
                          <span
                            className={`${ui.badge} ${
                              settings.automatic_sending_enabled ? ui.badgeTone.success : ui.badgeTone.danger
                            }`}
                          >
                            {settings.automatic_sending_enabled ? 'Enabled' : 'Disabled'}
                          </span>
                          Automatic touchpoint sending for every cancellation
                        </>
                      )}
                    </p>
                    {settings !== null ? (
                      <p className="mt-2 text-sm font-semibold text-slate-600">
                        Last changed by{' '}
                        {settings.updated_by === null
                          ? 'an unrecorded profile'
                          : (resolveProfileName?.(settings.updated_by) ??
                            assigneeList.find((person) => person.id === settings.updated_by)?.display_name ??
                            `profile ${settings.updated_by}`)}{' '}
                        at {formatInstant(settings.updated_at)}.
                      </p>
                    ) : null}
                    <p className="mt-2 text-xs font-semibold text-slate-500">
                      While automatic sending is disabled the scheduler sends nothing automatically and
                      creates no communication rows for the touchpoints it would have sent. Send Reminder
                      Now and Retry Failed Communication keep working.
                    </p>
                  </div>

                  {settingsError !== null ? (
                    <p id={`${baseId}-sending-error`} role="alert" className={ui.error}>
                      <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                      {settingsError}
                    </p>
                  ) : null}

                  <button
                    type="button"
                    className={settings?.automatic_sending_enabled === true ? ui.btnDanger : ui.btnPrimary}
                    disabled={busy || settings === null}
                    aria-describedby={settingsError !== null ? `${baseId}-sending-error` : undefined}
                    onClick={() => void toggleAutomaticSending(!(settings?.automatic_sending_enabled ?? true))}
                  >
                    {pending === 'sending' ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <PowerOff className="h-4 w-4" aria-hidden="true" />
                    )}
                    {pending === 'sending'
                      ? 'Storing the setting…'
                      : settings?.automatic_sending_enabled === true
                        ? 'Disable automatic sending for every cancellation'
                        : 'Enable automatic sending for every cancellation'}
                  </button>
                </div>
              ) : null}

              {/* ------------------------------------------------------------ */}
              {/* Unmatched producer and customer review                       */}
              {/* ------------------------------------------------------------ */}
              {panel === 'review' ? (
                <div className="mt-4 space-y-3">
                  {reviewRun === null ? (
                    <p className={ui.empty}>No import has been recorded yet.</p>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-slate-600">
                        The most recent completed import: {reviewRun.fileName}, {reviewRun.columnSet} column
                        set, {formatInstant(reviewRun.completedAt)}.
                      </p>
                      <RunDetail
                        rowsTotal={reviewRun.rowsTotal}
                        rowsCreated={reviewRun.rowsCreated}
                        rowsUpdated={reviewRun.rowsUpdated}
                        rowsRejected={reviewRun.rowsRejected}
                        rowsDuplicate={reviewRun.rowsDuplicate}
                        rejected={reviewRun.rejectedRows}
                        duplicates={reviewRun.duplicateRows}
                        producerLabels={reviewRun.unmatchedProducerLabels}
                        unmatchedCustomers={reviewRun.unmatchedCustomerRows}
                      />
                      {reviewRun.unmatchedCustomerRows.length > 0 ? (
                        <div className="rounded-2xl border border-slate-200 bg-white p-4">
                          <h5 className="text-sm font-black text-slate-900">
                            Cancellations left with no matched customer
                          </h5>
                          <ul className="mt-2 space-y-2">
                            {reviewRun.unmatchedCustomerRows.slice(0, MAX_LISTED_ROWS).map((entry) => {
                              const row = cases.find(
                                (candidate) =>
                                  candidate.import_run_id === reviewRun.id &&
                                  candidate.source_row_number === entry.row_number,
                              );
                              return (
                                <li
                                  key={`unmatched-case-${entry.row_number}`}
                                  className="flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-slate-700"
                                >
                                  <span>
                                    Row {count(entry.row_number)}
                                    {row === undefined
                                      ? ' — not in your loaded list'
                                      : ` — ${row.policy_number}, ${row.customer_name ?? 'no customer name'}`}
                                  </span>
                                  {row === undefined ? null : (
                                    <button
                                      type="button"
                                      className={ui.btnGhost}
                                      onClick={() => {
                                        setCorrectTarget(row.id);
                                        setCorrection(correctionDraft(row));
                                        setCorrectError(null);
                                        setPanel('correct');
                                      }}
                                    >
                                      <SquarePen className="h-4 w-4" aria-hidden="true" />
                                      Correct this row
                                    </button>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

              {/* ------------------------------------------------------------ */}
              {/* Reassignment (Requirement 22.3)                              */}
              {/* ------------------------------------------------------------ */}
              {panel === 'reassign' ? (
                <form
                  noValidate
                  aria-busy={pending === 'reassign'}
                  className="mt-4 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitReassign();
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={ui.label} htmlFor={`${baseId}-case-search`}>
                        Find a cancellation
                      </label>
                      <input
                        id={`${baseId}-case-search`}
                        className={ui.input}
                        disabled={busy}
                        placeholder="Customer, policy number, or carrier"
                        value={caseQuery}
                        onChange={(event) => setCaseQuery(event.target.value)}
                      />
                    </div>
                    <div>
                      <label className={ui.label} htmlFor={`${baseId}-assign-target`}>
                        Cancellation to reassign
                      </label>
                      <select
                        id={`${baseId}-assign-target`}
                        className={ui.select}
                        disabled={busy}
                        value={assignTarget}
                        aria-invalid={assignError !== null}
                        aria-describedby={assignError !== null ? `${baseId}-assign-error` : undefined}
                        onChange={(event) => {
                          setAssignTarget(event.target.value);
                          setAssignTo(
                            cases.find((row) => row.id === event.target.value)?.assigned_to ?? '',
                          );
                          setAssignError(null);
                        }}
                      >
                        <option value="">Choose a cancellation</option>
                        {caseOptions.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.policy_number} · {row.customer_name ?? 'no customer name'} ·{' '}
                            {row.cancellation_effective_date}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className={ui.label} htmlFor={`${baseId}-assign-to`}>
                      Assign to
                    </label>
                    <select
                      id={`${baseId}-assign-to`}
                      className={ui.select}
                      disabled={busy}
                      value={assignTo}
                      onChange={(event) => {
                        setAssignTo(event.target.value);
                        setAssignError(null);
                      }}
                    >
                      <option value="">Clear the assignment</option>
                      {employeeOptions}
                    </select>
                    <p className="mt-1 text-xs font-semibold text-slate-500">
                      A manager assignment outranks a later import: the next import leaves it in place.
                    </p>
                  </div>

                  {assignError !== null ? (
                    <p id={`${baseId}-assign-error`} role="alert" className={ui.error}>
                      <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                      {assignError}
                    </p>
                  ) : null}

                  <button type="submit" className={ui.btnPrimary} disabled={busy}>
                    {pending === 'reassign' ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <UserCheck className="h-4 w-4" aria-hidden="true" />
                    )}
                    {pending === 'reassign' ? 'Saving the assignment…' : 'Save assignment'}
                  </button>
                </form>
              ) : null}

              {/* ------------------------------------------------------------ */}
              {/* Imported-data correction (Requirement 22.3)                  */}
              {/* ------------------------------------------------------------ */}
              {panel === 'correct' ? (
                <form
                  noValidate
                  aria-busy={pending === 'correct'}
                  className="mt-4 space-y-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submitCorrection();
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={ui.label} htmlFor={`${baseId}-correct-search`}>
                        Find a cancellation
                      </label>
                      <input
                        id={`${baseId}-correct-search`}
                        className={ui.input}
                        disabled={busy}
                        placeholder="Customer, policy number, or carrier"
                        value={caseQuery}
                        onChange={(event) => setCaseQuery(event.target.value)}
                      />
                    </div>
                    <div>
                      <label className={ui.label} htmlFor={`${baseId}-correct-target`}>
                        Cancellation to correct
                      </label>
                      <select
                        id={`${baseId}-correct-target`}
                        className={ui.select}
                        disabled={busy}
                        value={correctTarget}
                        aria-invalid={correctError !== null}
                        aria-describedby={correctError !== null ? `${baseId}-correct-error` : undefined}
                        onChange={(event) => {
                          setCorrectTarget(event.target.value);
                          setCorrection(correctionDraft(cases.find((row) => row.id === event.target.value)));
                          setCorrectError(null);
                        }}
                      >
                        <option value="">Choose a cancellation</option>
                        {caseOptions.map((row) => (
                          <option key={row.id} value={row.id}>
                            {row.policy_number} · {row.customer_name ?? 'no customer name'} ·{' '}
                            {row.cancellation_effective_date}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {correctTarget === '' ? null : (
                    <>
                      <p className={ui.info}>
                        Values are read exactly as the import reads them. The customer matching key is
                        recomputed, and a corrected policy number or effective date moves the
                        cancellation&apos;s identity, so a collision with an existing cancellation is
                        refused with nothing changed.
                      </p>
                      <div className={ui.fieldRow}>
                        {CORRECTION_FIELDS.map((field) => {
                          const fieldId = `${baseId}-correct-${field.key}`;
                          return (
                            <div key={field.key}>
                              <label className={ui.label} htmlFor={fieldId}>
                                {field.label}
                                {field.required ? ' (required)' : ''}
                              </label>
                              <input
                                id={fieldId}
                                className={ui.input}
                                disabled={busy}
                                value={correction[field.key]}
                                aria-describedby={field.hint === null ? undefined : `${fieldId}-hint`}
                                onChange={(event) => {
                                  setCorrection((current) => ({
                                    ...current,
                                    [field.key]: event.target.value,
                                  }));
                                  setCorrectError(null);
                                }}
                              />
                              {field.hint === null ? null : (
                                <p id={`${fieldId}-hint`} className="mt-1 text-xs font-semibold text-slate-500">
                                  {field.hint}
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {correctError !== null ? (
                    <p id={`${baseId}-correct-error`} role="alert" className={ui.error}>
                      <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
                      {correctError}
                    </p>
                  ) : null}

                  <button type="submit" className={ui.btnPrimary} disabled={busy || correctTarget === ''}>
                    {pending === 'correct' ? (
                      <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <SquarePen className="h-4 w-4" aria-hidden="true" />
                    )}
                    {pending === 'correct' ? 'Saving the correction…' : 'Save corrections'}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
