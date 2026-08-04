'use client';

/**
 * The right-side drawer holding the records behind a number.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 10.1-10.8, 16.2
 *
 * One drawer serves every view. It is opened with a metric key, and it asks the server
 * for that metric's own records using the same filters that produced the number, so the
 * drawer and the KPI cannot disagree. Nothing here recomputes a total.
 *
 * Every quote row carries a Log action opening the Quote Activity timeline. That is the
 * workspace standard, and in the reports it replaces only three of twenty-four views
 * honoured it.
 */

import { useEffect, useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import { fetchRecords } from '../api';
import {
  EM_DASH,
  assignmentMethodLabel,
  formatCount,
  formatDateTime,
  formatMinutes,
  lifecycleLabel,
  notSoldReasonLabel,
  outcomeTone,
} from '../derive';
import type { DrawerTarget, QuoteRecordRow, ReportFilters } from '../types';

const PAGE_SIZE = 25;

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">
        {label}
      </p>
      <p className="mt-0.5 truncate text-sm font-bold text-slate-800">{value}</p>
    </div>
  );
}

function RecordCard({
  row,
  onOpenLog,
}: {
  row: QuoteRecordRow;
  onOpenLog: ((sourceWorkItemId: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-black text-slate-950">
            {row.customer_name ?? 'Unnamed customer'}
          </p>
          <p className="mt-0.5 truncate text-xs font-semibold text-slate-500">
            {row.dealer_name ?? 'No source recorded'}
            {row.salesperson_name !== null ? ` · ${row.salesperson_name}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={`${ui.badge} ${ui.badgeTone[outcomeTone(row.final_outcome)]}`}
          >
            {row.final_outcome === 'sold'
              ? 'Sold'
              : row.final_outcome === 'not_sold'
                ? 'Not Sold'
                : lifecycleLabel(row.lifecycle_stage)}
          </span>
          {onOpenLog !== undefined ? (
            <button
              type="button"
              onClick={() => onOpenLog(row.quote_id)}
              className="rounded-xl border border-[#c9d5e9] bg-[#f3f6fb] px-3 py-1.5 text-xs font-black text-[#223f7a] hover:bg-[#e7eef9]"
            >
              Log
            </button>
          ) : null}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label="Created" value={formatDateTime(row.created_at)} />
        <Field label="Pricing sent" value={formatDateTime(row.first_pricing_sent_at)} />
        <Field label="Finalized" value={formatDateTime(row.finalized_at)} />
        <Field label="Time to pricing" value={formatMinutes(row.minutes_to_pricing)} />
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {row.is_requote ? (
          <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Requote</span>
        ) : (
          <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>New Quote</span>
        )}
        <span className={`${ui.badge} ${ui.badgeTone.neutral}`}>
          {assignmentMethodLabel(row.assignment_method)}
        </span>
        {row.is_manual_quote ? (
          <span className={`${ui.badge} ${ui.badgeTone.progress}`}>Manual Quote</span>
        ) : null}
        {row.is_cs_intake ? (
          <span className={`${ui.badge} ${ui.badgeTone.cyan}`}>CS intake</span>
        ) : null}
        {row.received_after_hours ? (
          <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Received after hours</span>
        ) : null}
        {row.worked_after_hours ? (
          <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Worked after hours</span>
        ) : null}
        {row.finalized_after_hours ? (
          <span className={`${ui.badge} ${ui.badgeTone.violet}`}>Finalized after hours</span>
        ) : null}
        {row.attribution_conflict ? (
          <span className={`${ui.badge} ${ui.badgeTone.danger}`}>Attribution conflict</span>
        ) : null}
        {row.finalized_without_pricing ? (
          <span className={`${ui.badge} ${ui.badgeTone.danger}`}>No pricing evidence</span>
        ) : null}
        {row.not_sold_without_reason ? (
          <span className={`${ui.badge} ${ui.badgeTone.danger}`}>No Not Sold reason</span>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="mt-3 text-xs font-black text-[#223f7a] hover:underline"
        aria-expanded={expanded}
      >
        {expanded ? 'Hide attribution and history' : 'Show attribution and history'}
      </button>

      {expanded ? (
        <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
          {/* Requirement 6.10: who did what, reported as five distinct roles. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Created by" value={row.created_by_name ?? EM_DASH} />
            <Field label="Claimed by" value={row.claimed_by_name ?? EM_DASH} />
            <Field label="Assigned agent" value={row.assigned_agent_name ?? EM_DASH} />
            <Field label="Priced by" value={row.pricing_employee_name ?? EM_DASH} />
            <Field label="Outcome entered by" value={row.outcome_employee_name ?? EM_DASH} />
            <Field label="Sales credit" value={row.sales_credit_name ?? EM_DASH} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Field label="Channel" value={row.channel ?? 'Unknown'} />
            <Field label="Accepted" value={formatDateTime(row.accepted_at)} />
            <Field label="Notes" value={formatCount(row.notes_count)} />
            <Field label="Follow-ups" value={formatCount(row.follow_up_count)} />
          </div>
          {row.final_outcome === 'not_sold' ? (
            <Field label="Not Sold reason" value={notSoldReasonLabel(row.not_sold_reason)} />
          ) : null}
          {/* Requirement 16.2: name a field that changed after creation. */}
          {row.source_change_count > 0 || row.salesperson_change_count > 0 ? (
            <p className={ui.info}>
              Recorded changes after creation:{' '}
              {row.source_change_count > 0
                ? `source changed ${row.source_change_count} time${row.source_change_count === 1 ? '' : 's'}`
                : ''}
              {row.source_change_count > 0 && row.salesperson_change_count > 0 ? '; ' : ''}
              {row.salesperson_change_count > 0
                ? `salesperson changed ${row.salesperson_change_count} time${row.salesperson_change_count === 1 ? '' : 's'}`
                : ''}
              . Only changes made through a reassignment are recorded, so this is a
              floor rather than a total.
            </p>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function RecordDrawer({
  target,
  filters,
  onClose,
  onOpenQuoteLog,
}: {
  target: DrawerTarget | null;
  filters: ReportFilters;
  onClose: () => void;
  onOpenQuoteLog?: (sourceWorkItemId: string) => void;
}) {
  const [rows, setRows] = useState<QuoteRecordRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const metricId = target?.metricId ?? null;

  /**
   * Load whenever the metric, the filters or the page changes.
   *
   * The page is not reset here. The shell gives this component a key derived from the
   * metric and the filters, so a new number remounts it with page 1 already set. Reaching
   * for setPage inside an effect would mean a second render pass every time the drawer
   * opened, for a value that was already correct.
   */
  useEffect(() => {
    if (metricId === null) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchRecords(
          filters,
          metricId,
          page,
          PAGE_SIZE,
          filters.sortColumn ?? 'created_at_desc',
        );
        if (cancelled) return;
        setRows(result.rows);
        setTotalCount(result.totalCount);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : 'Unable to load these records.');
        setRows([]);
        setTotalCount(0);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metricId, filters, page, reloadToken]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (target === null) return null;

  const lastPage = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const firstOnPage = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const lastOnPage = Math.min(page * PAGE_SIZE, totalCount);

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true"
         aria-label={`Records behind ${target.label}`}>
      <button
        type="button"
        onClick={onClose}
        className="flex-1 bg-slate-900/30"
        aria-label="Close the record list"
      />
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        <div className="border-b border-slate-200 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className={ui.sectionTitle}>Underlying records</p>
              <h3 className="mt-1 text-xl font-black text-slate-950">{target.label}</h3>
            </div>
            <button type="button" onClick={onClose} className={ui.btnGhost}>
              Close
            </button>
          </div>
          {/* Requirement 10.6: state the definition the drawer was opened from. */}
          <p className="mt-2 text-xs font-semibold leading-5 text-slate-500">
            {target.definition}
          </p>
          <p className="mt-2 text-[11px] font-bold text-slate-400">
            {filters.startDate} to {filters.endDate} ·{' '}
            {filters.mode === 'cohort' ? 'Quote Cohort' : 'Operational Activity'} ·{' '}
            {filters.hoursSegment === 'all' ? 'All hours' : filters.hoursSegment}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error !== null ? (
            <div className={ui.error}>
              {error}
              <button
                type="button"
                onClick={() => setReloadToken((value) => value + 1)}
                className="ml-3 underline"
              >
                Retry
              </button>
            </div>
          ) : loading ? (
            <p className={ui.empty}>Loading records…</p>
          ) : rows.length === 0 ? (
            <p className={ui.empty}>
              No records produced this number for the active filters.
            </p>
          ) : (
            <ul className="space-y-3">
              {rows.map((row) => (
                <RecordCard key={row.quote_id} row={row} onOpenLog={onOpenQuoteLog} />
              ))}
            </ul>
          )}
        </div>

        {/* Requirement 10.7: the total beside the page being shown. */}
        <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-5 py-3">
          <p className="text-xs font-bold text-slate-500">
            {totalCount === 0
              ? 'No matching records'
              : `Showing ${formatCount(firstOnPage)}–${formatCount(lastOnPage)} of ${formatCount(totalCount)}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1 || loading}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              className={ui.btnSecondary}
            >
              Previous
            </button>
            <span className="text-xs font-black text-slate-500">
              {page} / {lastPage}
            </span>
            <button
              type="button"
              disabled={page >= lastPage || loading}
              onClick={() => setPage((value) => value + 1)}
              className={ui.btnSecondary}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
