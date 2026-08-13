'use client';

// Imports: the manager-only collector upload surface (Requirements 2.1, 2.2, 2.3, 11.1 to 11.3).
//
// Two primary paths, one per collector export, each of which needs no column mapping because the
// header is a fixed contract (Requirements 2.1, 2.2). The legacy imports stay where they are — the
// renewal Power BI wizard inside `RenewalManagerActions`, the two-file eficacia/avisos wizard inside
// `CancellationManagerActions` — and this surface links to them rather than reimplementing either
// (task 11.3).
//
// The shape of the flow is Requirement 2.3: choose a file, read the preview, then confirm. Nothing is
// written before the confirm, and the preview is computed entirely in the browser from the parsed
// file, so a manager can inspect a file they are unsure about and simply walk away.
//
// Requirement 11.2 is the reason the result panel separates two things a single "imported
// successfully" number would conflate: how many rows loaded, and how each row came to be owned.

import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Info,
  RefreshCw,
  ShieldAlert,
  UploadCloud,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { canManageRenewals } from '@/lib/permissions';
import { ModuleShell } from '../nhwd-shared/ModuleShell';
import type { ProfileLite } from '../nhwd-shared/types';
import { ui } from '../nhwd-shared/ui';
import { parseCsv } from '../cancellations/import/csv';
import { listRenewalImportRuns } from '../renewals/api';
import type { RenewalImportRun } from '../renewals/api';
import { listCancellationImportRuns } from '../cancellations/api';
import type { CancellationImportRun } from '../cancellations/api';
import { failureText } from '../renewals/format';
import {
  importCancellationCollectorBatch,
  importRenewalCollectorBatch,
  type CancellationCollectorImportResult,
  type RenewalCollectorImportResult,
} from './api';
import {
  buildCancellationCollectorPayload,
  buildCollectorPreview,
  buildRenewalCollectorPayload,
  classifyCollectorFile,
  readCollectorRows,
  type ClassifiedCollectorFile,
  type CollectorImportPreview,
  type CollectorRow,
} from './collector';

/** An uploaded collector export may be no larger than this, matching the cancellation importer. */
const MAX_FILE_BYTES = 25 * 1_048_576;

interface LoadedFile {
  classified: ClassifiedCollectorFile;
  rows: readonly CollectorRow[];
  preview: CollectorImportPreview;
}

type ImportResult =
  | { domain: 'renewal'; result: RenewalCollectorImportResult }
  | { domain: 'cancellation'; result: CancellationCollectorImportResult };

export interface PolicyFollowUpImportsProps {
  initialProfile: ProfileLite;
  embedded?: boolean;
}

export default function PolicyFollowUpImports({
  initialProfile: profile,
  embedded = false,
}: PolicyFollowUpImportsProps) {
  const manage = canManageRenewals(profile.role);

  const [file, setFile] = useState<LoadedFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [renewalRuns, setRenewalRuns] = useState<readonly RenewalImportRun[]>([]);
  const [cancellationRuns, setCancellationRuns] = useState<readonly CancellationImportRun[]>([]);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadRuns = useCallback(() => {
    if (!manage) return;
    void Promise.all([
      listRenewalImportRuns(12).catch(() => [] as RenewalImportRun[]),
      listCancellationImportRuns().catch(() => [] as CancellationImportRun[]),
    ]).then(([renewals, cancellations]) => {
      setRenewalRuns(renewals);
      setCancellationRuns(cancellations);
      setLastUpdated(new Date());
    });
  }, [manage]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  /** Reads and previews an uploaded file. Nothing is written; this is all in the browser. */
  const openFile = useCallback(async (chosen: File | null) => {
    setError(null);
    setResult(null);
    if (chosen === null) return;

    if (chosen.size > MAX_FILE_BYTES) {
      setError(`That file is larger than the ${Math.round(MAX_FILE_BYTES / 1_048_576)} MB limit. Nothing was read.`);
      return;
    }

    try {
      const parsed = parseCsv(await chosen.text());
      const classified = classifyCollectorFile({
        fileName: chosen.name,
        header: [...parsed.header],
        dataRowCount: parsed.rows.length,
      });

      if (!classified.ok) {
        setFile(null);
        setError(classified.message);
        return;
      }

      const rows = readCollectorRows(classified, parsed.rows);
      setFile({ classified, rows, preview: buildCollectorPreview(classified, rows) });
    } catch (caught) {
      setFile(null);
      setError(failureText(caught, 'That file could not be read as a collector export.'));
    }
  }, []);

  /** Requirement 2.3: the mutation happens here, after the manager has read the preview. */
  const confirmImport = useCallback(async () => {
    if (file === null) return;
    setBusy(true);
    setError(null);
    try {
      if (file.classified.domain === 'renewal') {
        const payload = buildRenewalCollectorPayload(file.rows);
        const imported = await importRenewalCollectorBatch(file.classified.fileName, payload);
        setResult({ domain: 'renewal', result: imported });
      } else {
        const payload = buildCancellationCollectorPayload(file.rows);
        const imported = await importCancellationCollectorBatch({
          fileName: file.classified.fileName,
          header: file.classified.header,
          rows: payload,
        });
        setResult({ domain: 'cancellation', result: imported });
      }
      setFile(null);
      loadRuns();
    } catch (caught) {
      setError(failureText(caught, 'The collector file could not be imported. Nothing was written.'));
    } finally {
      setBusy(false);
    }
  }, [file, loadRuns]);

  const preview = file?.preview ?? null;

  /** Requirement 11.3: the rows a manager will want to inspect before confirming. */
  const lineageSamples = useMemo(
    () => (file?.rows ?? []).filter((row) => row.reviewReasons.length > 0).slice(0, 10),
    [file],
  );

  if (!manage) {
    return (
      <ModuleShell title="Imports" subtitle="Policy follow-up" role={profile.role} embedded={embedded}>
        <div className={ui.error}>Imports are available to managers and super admins.</div>
      </ModuleShell>
    );
  }

  return (
    <ModuleShell
      title="Imports"
      subtitle="Upload a collector export, read what it will do, then confirm."
      role={profile.role}
      lastUpdated={lastUpdated}
      onRefresh={loadRuns}
      embedded={embedded}
    >
      <div className="space-y-4">
        {error ? (
          <p role="alert" className={ui.error}>
            <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />{error}
          </p>
        ) : null}

        {/* ── The two primary paths (task 11.2) */}
        <section className={`${ui.card} p-5`}>
          <h3 className="text-sm font-black text-slate-900">Collector exports</h3>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">
            Both consolidated exports are recognized by their header, so there is no column mapping
            step. The Spanish source values are kept exactly as the collector wrote them and
            translated for the people doing the work.
          </p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 transition hover:border-[#8da4cf] hover:bg-[#f8faff]">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]">
                <UploadCloud className="h-4 w-4" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-black text-slate-900">Renewals export</span>
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">
                  consolidado_renovaciones_*.csv
                </span>
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => { void openFile(event.target.files?.[0] ?? null); event.target.value = ''; }}
              />
            </label>

            <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3 transition hover:border-[#8da4cf] hover:bg-[#f8faff]">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#eef3fb] text-[#223f7a]">
                <FileUp className="h-4 w-4" aria-hidden="true" />
              </span>
              <span>
                <span className="block text-sm font-black text-slate-900">Pending cancellations export</span>
                <span className="mt-0.5 block text-xs font-semibold text-slate-500">
                  consolidado_cancelaciones_*.csv
                </span>
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                className="sr-only"
                onChange={(event) => { void openFile(event.target.files?.[0] ?? null); event.target.value = ''; }}
              />
            </label>
          </div>

          {/* task 11.3: the legacy paths stay available and stay secondary. */}
          <details className="mt-3 rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2">
            <summary className="cursor-pointer text-xs font-black text-slate-700">
              Legacy imports
            </summary>
            <p className="mt-2 text-xs font-semibold text-slate-600">
              The Power BI / HawkSoft renewal import is under Manager actions on the Renewals tab. The
              two-file eficacia and avisos cancellation import is under Import Cancellations on the
              Pending Cancellations tab. Both are unchanged and both still work; the collector exports
              above are the path to prefer.
            </p>
          </details>
        </section>

        {/* ── The preview (Requirement 2.3) */}
        {preview !== null && file !== null ? (
          <section className={`${ui.card} p-5`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-black text-slate-900">
                  {file.classified.domain === 'renewal' ? 'Renewals' : 'Pending cancellations'} export
                  preview
                </h3>
                <p className="mt-0.5 text-xs font-bold text-slate-500">{preview.fileName}</p>
              </div>
              <button type="button" className={ui.btnGhost} onClick={() => setFile(null)}>
                <X className="h-4 w-4" aria-hidden="true" />Discard
              </button>
            </div>

            <p className={`${ui.info} mt-3`}>
              <Info className="mr-2 inline h-4 w-4" aria-hidden="true" />
              Nothing has been written yet. Read the counts below and confirm to import.
            </p>

            <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {([
                ['Rows in file', preview.totalRows],
                ['Will import', preview.importableRows],
                ['Rejected', preview.rejectedRows],
                ['Duplicate identities in file', preview.duplicateIdentitiesInFile],
                ['Exact customer match', preview.matchExact],
                ['Probable match', preview.matchProbable],
                ['No match', preview.matchNone],
                ['Unrecognized match result', preview.matchUnrecognized],
                ['Missing phone', preview.missingPhone],
                ['Missing email', preview.missingEmail],
                ['Held for review', preview.reviewRequiredRows],
                ['No carrier, so no owner', preview.rowsWithoutIdentity],
              ] as const).map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                  <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">{label}</dt>
                  <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                    {value.toLocaleString('en-US')}
                  </dd>
                </div>
              ))}

              {file.classified.domain === 'renewal' ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2">
                  <dt className="text-[10px] font-black uppercase tracking-wide text-amber-900">
                    Carrier non-renewal
                  </dt>
                  <dd className="mt-0.5 text-xl font-black tabular-nums text-amber-900">
                    {preview.carrierNonRenewalRows.toLocaleString('en-US')}
                  </dd>
                </div>
              ) : (
                <>
                  <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                    <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                      Pending
                    </dt>
                    <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                      {preview.pendingCancellationRows.toLocaleString('en-US')}
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                    <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                      Paid signals
                    </dt>
                    <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                      {preview.paidSignalRows.toLocaleString('en-US')}
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                    <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                      Cancelled signals
                    </dt>
                    <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                      {preview.cancelledSignalRows.toLocaleString('en-US')}
                    </dd>
                  </div>
                  <div className="rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2">
                    <dt className="text-[10px] font-black uppercase tracking-wide text-amber-900">
                      Estimated dates
                    </dt>
                    <dd className="mt-0.5 text-xl font-black tabular-nums text-amber-900">
                      {preview.estimatedCancellationDates.toLocaleString('en-US')}
                    </dd>
                  </div>
                </>
              )}
            </dl>

            {/* Carrier distribution (Requirement 2.3) */}
            <div className="mt-4">
              <p className={ui.sectionTitle}>Carriers in this file</p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {preview.carrierDistribution.map((entry) => (
                  <li
                    key={entry.carrierKey}
                    className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700"
                  >
                    {entry.carrier} · {entry.rows.toLocaleString('en-US')}
                  </li>
                ))}
              </ul>
            </div>

            {/* Producer labels (Requirement 2.3) */}
            {preview.producerLabels.length > 0 ? (
              <div className="mt-4">
                <p className={ui.sectionTitle}>Producer labels in this file</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  A label the assignment mapping does not recognize leaves its policies for you to
                  assign; the import will report which ones.
                </p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {preview.producerLabels.map((label) => (
                    <li
                      key={label}
                      className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-bold text-slate-700"
                    >
                      {label}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Unrecognized source values (Requirements 1.3, 2.3) */}
            {preview.unrecognizedSourceValues.length > 0 ? (
              <div className="mt-4">
                <p className={ui.sectionTitle}>Record types Work Desk does not recognize</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  These rows will import and stay visible, with the raw value preserved, but they are
                  held back from automatic customer messaging until you review them.
                </p>
                <ul className="mt-2 space-y-1">
                  {preview.unrecognizedSourceValues.map((entry) => (
                    <li key={entry.raw} className="text-xs font-bold text-slate-700">
                      “{entry.raw}” · {entry.rows.toLocaleString('en-US')} rows
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Rejections, by row number and reason */}
            {preview.rejections.length > 0 ? (
              <div className="mt-4">
                <p className={ui.sectionTitle}>Rows that cannot be imported</p>
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  One unreadable row aborts nothing; the rest of the file still imports.
                </p>
                <ul className="mt-2 space-y-1">
                  {preview.rejections.slice(0, 20).map((entry) => (
                    <li key={entry.rowNumber} className="text-xs font-bold text-slate-700">
                      Row {entry.rowNumber}: {entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {/* Requirement 11.3: the lineage of a sample of the held rows, by name. */}
            {lineageSamples.length > 0 ? (
              <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50/70 px-3 py-2">
                <summary className="cursor-pointer text-xs font-black text-slate-700">
                  Source detail for {lineageSamples.length} of the rows held for review
                </summary>
                <ul className="mt-2 space-y-2">
                  {lineageSamples.map((row) => (
                    <li key={row.rowNumber} className="text-xs font-semibold text-slate-600">
                      <span className="font-black text-slate-900">
                        Row {row.rowNumber} · {row.customerName ?? 'no named insured'} · Policy{' '}
                        {row.policyNumber ?? 'none'}
                      </span>
                      <br />
                      Source file {row.lineage.upstreamFileName ?? preview.fileName}, row{' '}
                      {row.lineage.upstreamRowNumber ?? row.rowNumber}. Raw record type “
                      {row.lineage.rawRecordType ?? 'empty'}” read as {row.sourceState.label}. Match “
                      {row.lineage.rawMatchStatus ?? 'empty'}” read as {row.match.label}.
                      {row.lineage.warning ? ` Collector warning: ${row.lineage.warning}.` : ''}
                      <br />
                      {row.reviewReasons.map((reason) => reason.message).join(' ')}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className={ui.btnPrimary}
                disabled={busy || preview.importableRows === 0}
                onClick={() => void confirmImport()}
              >
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Import {preview.importableRows.toLocaleString('en-US')} rows
              </button>
              <button type="button" className={ui.btnGhost} onClick={() => setFile(null)}>
                Cancel
              </button>
            </div>
          </section>
        ) : null}

        {/* ── The result (Requirement 11.2) */}
        {result !== null ? (
          <section className={`${ui.card} p-5`} role="status">
            <h3 className="flex items-center gap-2 text-sm font-black text-emerald-800">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              {result.domain === 'renewal' ? 'Renewals' : 'Pending cancellations'} import completed
            </h3>

            {result.domain === 'renewal' ? (
              <>
                <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {([
                    ['Rows read', result.result.rows_total],
                    ['Created', result.result.rows_inserted],
                    ['Updated', result.result.rows_updated],
                    ['Skipped', result.result.rows_skipped],
                    ['Closed, left alone', result.result.rows_closed_preserved],
                    ['Held for review', result.result.rows_review_required],
                    ['Carrier non-renewal', result.result.rows_carrier_nonrenewal],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                      <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                        {label}
                      </dt>
                      <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                        {Number(value ?? 0).toLocaleString('en-US')}
                      </dd>
                    </div>
                  ))}
                </dl>

                {/* Requirement 11.2: importing and assigning are different questions. */}
                <p className={`${ui.sectionTitle} mt-4`}>How each policy came to be owned</p>
                <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {([
                    ['Manager lock kept', result.result.assignment.manager_locked],
                    ['Existing owner kept', result.result.assignment.existing_owner],
                    ['Producer mapping', result.result.assignment.producer_mapping],
                    ['Workload balancing', result.result.assignment.weighted_auto],
                    ['Ownership conflict', result.result.assignment.ownership_conflict],
                    ['Left for manager review', result.result.assignment.unassigned_review],
                  ] as const).map(([label, value]) => (
                    <div key={label} className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                      <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                        {label}
                      </dt>
                      <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                        {Number(value ?? 0).toLocaleString('en-US')}
                      </dd>
                    </div>
                  ))}
                </dl>

                {result.result.unmatched_producer_labels.length > 0 ? (
                  <div className="mt-3">
                    <p className="flex items-center gap-2 text-sm font-black text-amber-900">
                      <ShieldAlert className="h-4 w-4" aria-hidden="true" />
                      Producer labels that map to nobody
                    </p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {result.result.unmatched_producer_labels.map((label) => (
                        <li
                          key={label}
                          className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-900"
                        >
                          {label}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            ) : (
              <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {([
                  ['Rows read', result.result.rows_total],
                  ['Created', result.result.rows_created],
                  ['Updated', result.result.rows_updated],
                  ['Rejected', result.result.rows_rejected],
                  ['Duplicate', result.result.rows_duplicate],
                  ['Invalid contacts', result.result.invalid_contact_count],
                ] as const).map(([label, value]) => (
                  <div key={label} className="rounded-2xl border border-slate-200 bg-white px-3 py-2">
                    <dt className="text-[10px] font-black uppercase tracking-wide text-slate-500">
                      {label}
                    </dt>
                    <dd className="mt-0.5 text-xl font-black tabular-nums text-slate-900">
                      {Number(value ?? 0).toLocaleString('en-US')}
                    </dd>
                  </div>
                ))}
              </dl>
            )}

            <button type="button" className={`${ui.btnGhost} mt-3`} onClick={() => setResult(null)}>
              <X className="h-4 w-4" aria-hidden="true" />Dismiss
            </button>
          </section>
        ) : null}

        {/* ── Recent runs (task 11.4) */}
        <section className={`${ui.card} overflow-hidden`}>
          <div className="flex items-center justify-between gap-3 px-5 py-4">
            <h3 className="text-sm font-black text-slate-900">Recent import runs</h3>
            <button type="button" className={ui.btnGhost} onClick={loadRuns}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />Refresh
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className={ui.table}>
              <thead>
                <tr>
                  <th className={ui.th}>Domain</th>
                  <th className={ui.th}>File</th>
                  <th className={ui.th}>Source</th>
                  <th className={ui.th}>Rows</th>
                  <th className={ui.th}>Created</th>
                  <th className={ui.th}>Updated</th>
                  <th className={ui.th}>Exceptions</th>
                  <th className={ui.th}>When</th>
                </tr>
              </thead>
              <tbody>
                {renewalRuns.length === 0 && cancellationRuns.length === 0 ? (
                  <tr><td className={ui.td} colSpan={8}>No import has been recorded yet.</td></tr>
                ) : null}

                {renewalRuns.map((run) => (
                  <tr key={`renewal:${run.id}`}>
                    <td className={ui.td}>Renewals</td>
                    <td className={`${ui.td} font-bold text-slate-900`}>{run.file_name}</td>
                    <td className={ui.td}>
                      {(run.column_mapping as Record<string, unknown> | null)?.source === 'renewal_collector'
                        ? 'Collector' : 'Legacy Power BI'}
                    </td>
                    <td className={`${ui.td} tabular-nums`}>{run.rows_total}</td>
                    <td className={`${ui.td} tabular-nums`}>{run.rows_inserted}</td>
                    <td className={`${ui.td} tabular-nums`}>{run.rows_updated}</td>
                    <td className={`${ui.td} tabular-nums`}>
                      {run.rows_skipped} skipped
                      {(run.unmatched_assignees ?? []).length > 0
                        ? ` · ${(run.unmatched_assignees ?? []).length} unmatched labels`
                        : ''}
                    </td>
                    <td className={ui.td}>{new Date(run.created_at).toLocaleString('en-US')}</td>
                  </tr>
                ))}

                {cancellationRuns.map((run) => (
                  <tr key={`cancellation:${run.id}`}>
                    <td className={ui.td}>Cancellations</td>
                    <td className={`${ui.td} font-bold text-slate-900`}>{run.file_name}</td>
                    <td className={ui.td}>
                      {run.column_set === 'collector' ? 'Collector' : `Legacy ${run.column_set}`}
                    </td>
                    <td className={`${ui.td} tabular-nums`}>{run.rows_total}</td>
                    <td className={`${ui.td} tabular-nums`}>{run.rows_created}</td>
                    <td className={`${ui.td} tabular-nums`}>{run.rows_updated}</td>
                    <td className={`${ui.td} tabular-nums`}>
                      {run.rows_rejected} rejected · {run.rows_duplicate} duplicate
                    </td>
                    <td className={ui.td}>{new Date(run.completed_at).toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </ModuleShell>
  );
}
