'use client';

/**
 * The Sales Reporting Center shell.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 2.1-2.8, 3.7, 8.7, 9.6, 9.7, 10.1, 19.1, 19.6
 *
 * Four views, one filter bar, one drawer. The shell owns the router and the data
 * fetching; the views are presentational and take rows as props.
 *
 * Everything that shapes what is on screen lives in the URL, so a refresh restores the
 * report, browser Back walks the filter history, and a manager can paste a link into
 * chat and have a colleague see the same thing. That last point is why the URL is the
 * state rather than React state with the URL as a side effect.
 *
 * Nothing in this component aggregates. Every number comes from an RPC.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { ui } from './nhwd-shared-bridge';
import type { ProfileLite } from '../nhwd-shared/client';
import { METRIC_DEFINITIONS, REPORT_VIEWS } from './definitions';
import {
  fetchAfterHoursSummary,
  fetchAgentRows,
  fetchFilterOptions,
  fetchIntegrityFlags,
  fetchLifecycle,
  fetchNeedsAttention,
  fetchSourceRows,
  fetchSummary,
  recordIntegrityReview,
  runIntegrityDetection,
} from './api';
import { ExportCurrentView } from './components/ExportCurrentView';
import { RecordDrawer } from './components/RecordDrawer';
import { ReportingFilters } from './components/ReportingFilters';
import { AgentsReport } from './views/AgentsReport';
import { IntegrityReport } from './views/IntegrityReport';
import { OverviewReport } from './views/OverviewReport';
import { SourcesReport } from './views/SourcesReport';
import type {
  AfterHoursSummary,
  AgentReportRow,
  DrawerTarget,
  FilterOptions,
  IntegrityFlagRow,
  LifecycleSummary,
  MetricId,
  NeedsAttentionRow,
  ReportFilters,
  ReportSummary,
  ReportView,
  ReviewAction,
  SourceReportRow,
} from './types';
import { businessToday, parseReportUrl, writeReportUrl } from './url-state';

const VIEW_LABELS: Record<ReportView, string> = {
  overview: 'Overview',
  agents: 'Agents',
  sources: 'Sources',
  integrity: 'Review & Integrity',
};

/** Filter changes are debounced so typing in a date field does not fire a query per keystroke. */
const FILTER_DEBOUNCE_MS = 300;

export function SalesReportingCenter({
  initialProfile,
  onOpenQuoteLog,
}: {
  initialProfile: ProfileLite;
  onOpenQuoteLog?: (sourceWorkItemId: string) => void;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const today = useMemo(() => businessToday(), []);

  const parsed = useMemo(
    () => parseReportUrl(new URLSearchParams(searchParams.toString()), today),
    [searchParams, today],
  );
  const filters = parsed.filters;

  const [options, setOptions] = useState<FilterOptions | null>(null);
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [lifecycle, setLifecycle] = useState<LifecycleSummary | null>(null);
  const [needsAttention, setNeedsAttention] = useState<NeedsAttentionRow[]>([]);
  const [agentRows, setAgentRows] = useState<AgentReportRow[]>([]);
  const [sourceRows, setSourceRows] = useState<SourceReportRow[]>([]);
  const [afterHours, setAfterHours] = useState<AfterHoursSummary | null>(null);
  const [flagRows, setFlagRows] = useState<IntegrityFlagRow[]>([]);
  const [flagTotal, setFlagTotal] = useState(0);
  const [savedFilter, setSavedFilter] = useState('All Open Flags');
  const [flagPage, setFlagPage] = useState(1);
  const [detectionBusy, setDetectionBusy] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  const [drawerFilters, setDrawerFilters] = useState<ReportFilters>(filters);

  const canReview = options?.can_manage_sales ?? false;
  const requestToken = useRef(0);

  /** Push a new filter state through the URL. The URL is the state. */
  const applyFilters = useCallback(
    (next: ReportFilters) => {
      const query = writeReportUrl(next, today);
      router.push(query.length > 0 ? `?${query}` : '?', { scroll: false });
    },
    [router, today],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await fetchFilterOptions();
        if (!cancelled) setOptions(loaded);
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Unable to load filter options.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // One effect loads whatever the active view needs. Debounced, and guarded with a token
  // so a slow earlier response cannot overwrite a newer one.
  useEffect(() => {
    const token = ++requestToken.current;
    const timer = setTimeout(() => {
      void (async () => {
        setLoading(true);
        setError(null);
        try {
          if (filters.view === 'integrity') {
            const flags = await fetchIntegrityFlags(filters, savedFilter, flagPage, 25);
            if (token !== requestToken.current) return;
            setFlagRows(flags.rows);
            setFlagTotal(flags.totalCount);
          } else {
            const [
              summaryData,
              lifecycleData,
              attentionData,
              agents,
              sources,
              afterHoursData,
            ] = await Promise.all([
              fetchSummary(filters),
              filters.mode === 'cohort'
                ? fetchLifecycle(filters)
                : Promise.resolve<LifecycleSummary>({ authorized: true }),
              fetchNeedsAttention(filters),
              fetchAgentRows(filters),
              fetchSourceRows(filters),
              fetchAfterHoursSummary(filters),
            ]);
            if (token !== requestToken.current) return;
            setSummary(summaryData);
            setLifecycle(lifecycleData);
            setNeedsAttention(attentionData);
            setAgentRows(agents);
            setSourceRows(sources);
            setAfterHours(afterHoursData);
          }
        } catch (caught) {
          if (token !== requestToken.current) return;
          setError(caught instanceof Error ? caught.message : 'The report query failed.');
        } finally {
          if (token === requestToken.current) setLoading(false);
        }
      })();
    }, FILTER_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.view,
    filters.mode,
    filters.startDate,
    filters.endDate,
    filters.compareToPreviousPeriod,
    filters.hoursSegment,
    filters.afterHoursDimensions.join(','),
    filters.agentProfileIds.join(','),
    filters.dealerIds.join(','),
    filters.salespersonIds.join(','),
    filters.channels.join(','),
    filters.quoteKinds.join(','),
    filters.assignmentMethods.join(','),
    filters.statuses.join(','),
    filters.outcomes.join(','),
    savedFilter,
    flagPage,
  ]);

  function openDrawer(metricId: string, label: string, scoped: ReportFilters = filters) {
    const definition =
      metricId in METRIC_DEFINITIONS
        ? METRIC_DEFINITIONS[metricId as MetricId].definition
        : `The records counted by ${label} for the active filters.`;
    setDrawerFilters(scoped);
    setDrawerTarget({ metricId, label, definition });
  }

  async function handleReview(flagId: string, action: ReviewAction, explanation: string) {
    const result = await recordIntegrityReview(flagId, action, explanation.length > 0 ? explanation : null);
    if (!result.success) {
      throw new Error(result.error ?? 'The review decision was refused.');
    }
    const flags = await fetchIntegrityFlags(filters, savedFilter, flagPage, 25);
    setFlagRows(flags.rows);
    setFlagTotal(flags.totalCount);
  }

  async function handleDetection() {
    setDetectionBusy(true);
    try {
      await runIntegrityDetection(filters.startDate, filters.endDate);
      const flags = await fetchIntegrityFlags(filters, savedFilter, flagPage, 25);
      setFlagRows(flags.rows);
      setFlagTotal(flags.totalCount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The scan failed.');
    } finally {
      setDetectionBusy(false);
    }
  }

  const unauthorized = options !== null && options.authorized === false;

  if (unauthorized) {
    return (
      <div className={ui.page}>
        <p className={ui.error}>
          You do not have access to the Sales Reporting Center.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className={ui.pageTitle}>Sales Reporting Center</h2>
          <p className={ui.pageSubtitle}>
            One reporting surface. Every number opens the records behind it.
          </p>
        </div>
        <ExportCurrentView filters={filters} />
      </div>

      {/* Four views, in order, Overview first. */}
      <nav aria-label="Report views" className="flex flex-wrap gap-1 rounded-2xl bg-slate-100 p-1.5">
        {REPORT_VIEWS.map((view) => (
          <button
            key={view}
            type="button"
            onClick={() => {
              // Switching view keeps every filter and closes the drawer.
              setDrawerTarget(null);
              applyFilters({ ...filters, view, page: 1 });
            }}
            className={`rounded-xl px-4 py-2.5 text-sm font-black transition ${
              filters.view === view
                ? 'bg-[#223f7a] text-white shadow-sm'
                : 'text-slate-600 hover:bg-white'
            }`}
            aria-current={filters.view === view ? 'page' : undefined}
          >
            {VIEW_LABELS[view]}
          </button>
        ))}
      </nav>

      <ReportingFilters
        filters={filters}
        options={options}
        onChange={applyFilters}
        droppedKeys={parsed.droppedKeys}
        timeZone={summary?.timezone ?? 'America/New_York'}
      />

      {error !== null ? (
        <div className={ui.error}>
          {error}
          <button
            type="button"
            onClick={() => applyFilters({ ...filters })}
            className="ml-3 underline"
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <p className={ui.empty}>Loading {VIEW_LABELS[filters.view]}…</p>
      ) : filters.view === 'overview' ? (
        <OverviewReport
          filters={filters}
          summary={summary}
          lifecycle={lifecycle}
          needsAttention={needsAttention}
          agentRows={agentRows}
          sourceRows={sourceRows}
          afterHours={afterHours}
          onSelectMetric={(metricId) =>
            openDrawer(metricId, METRIC_DEFINITIONS[metricId]?.label ?? metricId)
          }
          onSelectCondition={(conditionKey, label) => openDrawer(conditionKey, label)}
          onNavigateToView={(view) => applyFilters({ ...filters, view, page: 1 })}
        />
      ) : filters.view === 'agents' ? (
        <AgentsReport
          rows={agentRows}
          sortKey={filters.sortColumn}
          onSortChange={(key) => applyFilters({ ...filters, sortColumn: key })}
          onSelectMetric={(metricId, agentProfileId, agentName) =>
            openDrawer(
              metricId,
              `${METRIC_DEFINITIONS[metricId]?.label ?? metricId} — ${agentName}`,
              { ...filters, agentProfileIds: [agentProfileId] },
            )
          }
        />
      ) : filters.view === 'sources' ? (
        <SourcesReport
          rows={sourceRows}
          onSelectMetric={(metricId, dealerId, sourceName) =>
            openDrawer(
              metricId,
              `${METRIC_DEFINITIONS[metricId]?.label ?? metricId} — ${sourceName}`,
              dealerId === null ? filters : { ...filters, dealerIds: [dealerId] },
            )
          }
        />
      ) : (
        <IntegrityReport
          rows={flagRows}
          totalCount={flagTotal}
          savedFilter={savedFilter}
          onSavedFilterChange={(next) => {
            setSavedFilter(next);
            setFlagPage(1);
          }}
          page={flagPage}
          pageSize={25}
          onPageChange={setFlagPage}
          canReview={canReview}
          onReview={handleReview}
          onRunDetection={handleDetection}
          detectionBusy={detectionBusy}
          onOpenQuoteLog={onOpenQuoteLog}
        />
      )}

      {/* Legacy Reports stay reachable and unchanged until the comparison is done. */}
      <section className={`${ui.card} ${ui.cardPad}`}>
        <p className={ui.sectionTitle}>Legacy Reports</p>
        <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-600">
          The twenty-four original reports are still available, unchanged, under
          <span className="font-black text-slate-800"> Sales → Legacy Reports</span>. They
          stay there until their values have been compared against this centre for a full
          reporting period. Where the two disagree the difference is a definition change,
          not a defect, and it is recorded in the spec&rsquo;s comparison document.
        </p>
        <p className="mt-2 text-xs font-semibold text-slate-400">
          Signed in as {initialProfile.display_name}.
        </p>
      </section>

      <RecordDrawer
        target={drawerTarget}
        filters={drawerFilters}
        onClose={() => setDrawerTarget(null)}
        onOpenQuoteLog={onOpenQuoteLog}
      />
    </div>
  );
}

export default SalesReportingCenter;
