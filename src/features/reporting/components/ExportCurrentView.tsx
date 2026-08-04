'use client';

/**
 * The single export control.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 18.1-18.7, 19.7
 *
 * One control, four formats, replacing eight per-report buttons. Every format is produced
 * server-side by POST /api/reports/sales/export, which re-runs the same RPCs the screen
 * used. That is what makes "the export matches the screen" structural rather than a
 * thing to remember: there is one query path, and the browser never recomputes a total
 * for a file.
 */

import { useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import type { ReportFilters } from '../types';
import { toFilterPayload } from '../url-state';

const FORMATS: ReadonlyArray<{ id: string; label: string; note: string }> = [
  { id: 'summary_csv', label: 'Summary CSV', note: 'The totals on screen' },
  { id: 'records_csv', label: 'Underlying records CSV', note: 'Every record behind them' },
  { id: 'xlsx', label: 'Excel workbook', note: 'Summary and records as two sheets' },
  { id: 'pdf', label: 'PDF snapshot', note: 'The summary as a printable page' },
];

export function ExportCurrentView({ filters }: { filters: ReportFilters }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(format: string) {
    setBusy(format);
    setError(null);
    try {
      const response = await fetch('/api/reports/sales/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          format,
          view: filters.view,
          sort: filters.sortColumn ?? 'created_at_desc',
          filters: toFilterPayload(filters),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Export failed with status ${response.status}.`);
      }

      const blob = await response.blob();
      const disposition = response.headers.get('content-disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename = match?.[1] ?? `sales-report-${filters.startDate}-to-${filters.endDate}`;

      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={ui.btnPrimary}
        aria-expanded={open}
      >
        Export Current View
      </button>

      {open ? (
        <div className="absolute right-0 top-12 z-30 w-80 rounded-2xl border border-slate-200 bg-white p-4 shadow-lg">
          <p className={ui.sectionTitle}>Export</p>
          <p className="mt-1 text-xs font-semibold leading-5 text-slate-500">
            Uses the active view, mode, period, hours segment, filters and sort order.
            The totals will match the screen.
          </p>
          {error !== null ? <p className={`${ui.error} mt-3`}>{error}</p> : null}
          <div className="mt-3 space-y-2">
            {FORMATS.map((format) => (
              <button
                key={format.id}
                type="button"
                disabled={busy !== null}
                onClick={() => void run(format.id)}
                className="flex w-full items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5 text-left transition hover:border-[#b8c7e1] hover:bg-[#f8faff] disabled:opacity-50"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-black text-slate-900">
                    {format.label}
                  </span>
                  <span className="block text-[11px] font-semibold text-slate-400">
                    {format.note}
                  </span>
                </span>
                {busy === format.id ? (
                  <span className="shrink-0 text-xs font-black text-slate-400">…</span>
                ) : null}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setOpen(false)} className={`${ui.btnGhost} mt-2 w-full`}>
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
