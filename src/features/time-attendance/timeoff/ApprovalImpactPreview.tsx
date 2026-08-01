// src/features/time-attendance/timeoff/ApprovalImpactPreview.tsx
// What approving one time-off request would do to staffing, date by date and —
// where a date is staffed in stages — interval by interval.
//
// This is Requirement 9, criteria 1 through 6 and 14. Every figure in here is the
// Coverage_Service's own, read from `/api/coverage/impact?request_id=…`, which is
// `getCoverage` in projected mode with the request handed to it as a *proposed*
// absence. Nothing is computed in this component:
//
// | shown                                    | read from                        | criterion |
// | ---------------------------------------- | -------------------------------- | --------- |
// | a row per date in the requested range    | `coverage.dates`                 | 9.1       |
// | scheduled − approved − proposed          | `projection.available`           | 9.2       |
// | projected available, required, status     | `projection.*`, `CoverageBadge`  | 9.3       |
// | per-interval available and required      | `intervals`                      | 9.4, 9.5  |
// | availability from schedules, not clocks  | the projected read takes none    | 9.6       |
// | a date with no projection states why     | `unavailable.reason`             | 9.14      |
//
// ## Why the preview and the commit cannot disagree
//
// `pto-service.decide` projects the approved dates through the same `getCoverage`
// call with the same proposed absence before it commits, and answers with the
// projection again afterwards — by then the request is an approved absence rather
// than a proposed one, which is the same subtraction. So the figure displayed
// here is the figure the guard blocks on and the figure the next read returns
// (Correctness Property 17). The shortfalls are read the same way: through
// `collectShortfalls`, the domain function the service also calls, over the
// statuses the service already assigned.
//
// ## Which dates count
//
// The preview lists every date in the requested range, because that is what
// criterion 1 asks for. The *guard* only counts the dates the contemplated
// decision would approve, which is what `approvedDates` names: approving part of
// a request cannot create a shortfall on a date it declines. A date outside that
// set is still shown — an administrator comparing a partial approval against the
// whole request needs to see both — and is labelled as excluded.
//
// ## Intervals, and when they are shown
//
// Criterion 4 asks for the per-interval breakdown where a date defines more than
// one distinct scheduled start or end instant. `buildCoverageIntervals` pairs
// consecutive distinct boundaries, so a date whose shifts all begin and end
// together yields exactly one interval and a date with any additional distinct
// boundary yields more than one. `intervals.length > 1` is therefore the same
// test, read off the partition rather than re-derived from the schedule rows.
//
// Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.14, 22.5, 22.6, 22.7, 22.12,
// 22.14, 22.15, 22.16

'use client';

import type { CoverageInterval } from '../domain/coverage';
import { collectShortfalls, type ApprovalImpactDate, type CoverageShortfall } from '../domain/pto';
import type { ComputedCoverageDate, ImpactResponse } from '../server/coverage-service';
import type { ApiFailure } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { CoverageBadge } from '../shared/CoverageBadge';
import { formatTimeOfDay, formatWorkDate } from '../shared/format';
import { colorRoleToken } from '../shared/tokens';
import type { AsyncResourceStatus } from '../shared/useAsyncResource';
import { hasCoverageFigures, UNCONFIGURED_REQUIREMENT } from './CoverageDateDrawer';

/**
 * The shortfalls an approval of `approvedDates` would create.
 *
 * The same three steps `pto-service.shortfallsForApproval` takes: keep the dates
 * the decision approves, keep the ones that carry figures, and hand the
 * projection and its intervals to `collectShortfalls`. The rule — what counts as
 * below the minimum, and that an unconfigured slot never does — is the domain's,
 * so the drawer's guard and the service's guard cannot disagree about the same
 * projection.
 *
 * A date the read could not project contributes no shortfall. Nothing is known
 * about it, and treating an unknown as a breach would block an approval on
 * missing data; the row states the reason instead (criterion 14).
 *
 * Requirements: 9.3, 9.4, 10.9
 */
export function impactShortfalls(
  impact: ImpactResponse | null,
  approvedDates: ReadonlySet<string>,
): CoverageShortfall[] {
  if (impact === null) return [];

  const dates: ApprovalImpactDate[] = impact.coverage.dates
    .filter(hasCoverageFigures)
    .filter((date) => approvedDates.has(date.workDate))
    .map((date) => ({ coverage: date.projection, intervals: date.intervals }));

  return collectShortfalls(dates);
}

/**
 * True when this date's staffing changes during the day, so the per-interval
 * figures of criterion 4 apply.
 *
 * Read off the partition rather than from the schedule rows: more than one
 * interval is exactly what more than one distinct boundary produces.
 */
export function showsIntervals(date: ComputedCoverageDate): boolean {
  return date.intervals.length > 1;
}

/** One labelled figure: a small caption over the value. */
function Figure({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="min-w-[4.5rem]">
      <dt className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">{label}</dt>
      <dd className={`text-[13px] font-black ${muted ? 'text-slate-300' : 'text-slate-800'}`}>
        {value}
      </dd>
    </div>
  );
}

/**
 * One Coverage_Interval: a start time, an end time, an available count, and a
 * required count, which is the four fields criterion 5 names, with the status
 * those counts produced.
 *
 * The bounds are ISO instants read in the organisation's zone through
 * `formatTimeOfDay`, which goes to `domain/work-date.ts` — the module's one zone
 * conversion. An overnight shift's end therefore reads as the following day's
 * wall clock rather than as an impossible hour.
 */
function IntervalRow({ interval, timeZone }: { interval: CoverageInterval; timeZone: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-slate-100 bg-white px-2.5 py-1.5">
      <span className="text-[12px] font-bold text-slate-700">
        {formatTimeOfDay(interval.start, timeZone)} {'\u2013'}{' '}
        {formatTimeOfDay(interval.end, timeZone)}
      </span>
      <CoverageBadge
        status={interval.status}
        available={interval.availableStaff}
        requiredStaff={interval.requiredStaff}
      />
    </li>
  );
}

/**
 * One requested date: the projection with the absence counted, and the intervals
 * inside it where the day is staffed in stages.
 *
 * Requirements: 9.3, 9.4, 9.5
 */
function DateRow({
  date,
  included,
  short,
  timeZone,
}: {
  date: ComputedCoverageDate;
  /** Whether the contemplated decision approves this date. */
  included: boolean;
  /** Whether a shortfall names this date or an interval inside it. */
  short: boolean;
  timeZone: string;
}) {
  const critical = colorRoleToken('critical');
  const { projection } = date;

  return (
    <li
      className={[
        'rounded-2xl border px-3 py-2.5',
        short ? `${critical.border} ${critical.surface}` : 'border-slate-200 bg-slate-50/70',
        included ? '' : 'opacity-70',
      ]
        .filter((part) => part !== '')
        .join(' ')}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-black text-slate-900">
          {formatWorkDate(date.workDate)}
          {date.closed && (
            <span className="ml-1.5 text-[11px] font-bold text-slate-400">
              {date.closedLabel ?? 'Closed'}
            </span>
          )}
        </span>
        <CoverageBadge
          status={projection.status}
          available={projection.available}
          requiredStaff={projection.requiredStaff}
        />
      </div>

      <dl className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
        <Figure label="Projected" value={String(projection.available)} />
        <Figure
          label="Required"
          value={
            projection.requiredStaff === null
              ? UNCONFIGURED_REQUIREMENT
              : String(projection.requiredStaff)
          }
          muted={projection.requiredStaff === null}
        />
        <Figure label="Scheduled" value={String(projection.scheduled)} />
        <Figure
          label="Approved off"
          value={String(projection.approvedAbsences)}
          muted={projection.approvedAbsences === 0}
        />
        <Figure
          label="This request"
          value={String(projection.proposedAbsences)}
          muted={projection.proposedAbsences === 0}
        />
      </dl>

      {!included && (
        <p className="mt-1 text-[11px] font-bold text-slate-400">
          Not part of the decision being composed, so it is not counted against the minimum.
        </p>
      )}

      {short && (
        <p className={`mt-1 text-[11px] font-black ${critical.text}`}>
          Below the required minimum with this absence counted.
        </p>
      )}

      {/* Criterion 4: the day is staffed in stages, so the figures are given per
          stage as well as for the date. */}
      {showsIntervals(date) && (
        <div className="mt-2">
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
            By interval
          </p>
          <ul className="mt-1 space-y-1">
            {date.intervals.map((interval) => (
              <IntervalRow
                key={`${interval.start}-${interval.end}`}
                interval={interval}
                timeZone={timeZone}
              />
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/** One date the projection could not be computed for (criterion 14). */
function UnavailableRow({ workDate, reason }: { workDate: string; reason: string }) {
  return (
    <li className="rounded-2xl border border-slate-200 bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] font-black text-slate-900">{formatWorkDate(workDate)}</span>
        <span className="text-[10px] font-black uppercase tracking-[0.12em] text-slate-400">
          No projection
        </span>
      </div>
      <p className="mt-0.5 text-[12px] font-semibold text-slate-500">{reason}</p>
      <p className="text-[11px] font-semibold text-slate-400">
        Every other requested date keeps its own figures.
      </p>
    </li>
  );
}

export interface ApprovalImpactPreviewProps {
  /** The impact read, or null while it is outstanding or switched off. */
  impact: ImpactResponse | null;
  /**
   * The dates the decision being composed would approve. Dates outside it are
   * displayed and excluded from the shortfall count.
   */
  approvedDates: ReadonlySet<string>;
  /** The shortfalls the guard is holding, so the rows and the guard agree. */
  shortfalls: readonly CoverageShortfall[];
  /** The read's state, from `useAsyncResource`. */
  status: AsyncResourceStatus;
  failure: ApiFailure | null;
  pending: boolean;
  onRetry: () => void;
  emptyMessage: string;
  /** The zone interval bounds are read in: the organisation's. */
  timeZone: string;
  /** Stated in place of the preview when the read is deliberately not made. */
  unavailableNote?: string | null;
}

/**
 * The Approval_Impact_Preview: what the request would cost, per date and per
 * interval.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.14
 */
export function ApprovalImpactPreview({
  impact,
  approvedDates,
  shortfalls,
  status,
  failure,
  pending,
  onRetry,
  emptyMessage,
  timeZone,
  unavailableNote = null,
}: ApprovalImpactPreviewProps) {
  const critical = colorRoleToken('critical');
  const dates = impact?.coverage.dates ?? [];

  // A date is short when a shortfall names it, whether the shortfall is the whole
  // date's or an interval's inside it. Both block, because criterion 9 of
  // Requirement 10 names both.
  const shortDates = new Set(shortfalls.map((shortfall) => shortfall.workDate));

  return (
    <section
      aria-labelledby="approval-impact-heading"
      className="rounded-2xl border border-slate-200 bg-white px-3.5 py-3"
    >
      <h3
        id="approval-impact-heading"
        className="text-xs font-black uppercase tracking-[0.14em] text-slate-500"
      >
        If this is approved
      </h3>
      <p className="mt-0.5 text-[11px] font-semibold text-slate-500">
        Employees carrying a published shift on each date, less those already away, less this
        request. Published schedules and absences only — no clock data.
      </p>

      {unavailableNote !== null ? (
        <p className="mt-2 text-[12px] font-semibold text-slate-500">{unavailableNote}</p>
      ) : (
        <div className="mt-2 space-y-2">
          <AsyncStateBlock
            status={status}
            failure={failure}
            pending={pending}
            onRetry={onRetry}
            subject="the coverage projection"
            message={emptyMessage}
          />

          {impact !== null && !impact.coverage.thresholdsConfigured && (
            <p className="text-[11px] font-semibold text-slate-400">
              No minimum staffing is configured, so every date reports a healthy status whatever the
              projection and no approval is blocked on coverage.
            </p>
          )}

          {shortfalls.length > 0 && (
            <p role="alert" className={`text-[12px] font-black ${critical.text}`}>
              {shortfalls.length} {shortfalls.length === 1 ? 'date or interval' : 'dates and intervals'}{' '}
              would fall below the required minimum.
            </p>
          )}

          {dates.length > 0 && (
            <ul className="space-y-2">
              {dates.map((date) =>
                hasCoverageFigures(date) ? (
                  <DateRow
                    key={date.workDate}
                    date={date}
                    included={approvedDates.has(date.workDate)}
                    short={shortDates.has(date.workDate)}
                    timeZone={timeZone}
                  />
                ) : (
                  <UnavailableRow
                    key={date.workDate}
                    workDate={date.workDate}
                    reason={date.unavailable.reason}
                  />
                ),
              )}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export default ApprovalImpactPreview;
