// src/features/time-attendance/timeoff/CoverageCalendar.tsx
// Projected coverage as a date grid: which dates can absorb another absence, and
// which cannot.
//
// This is the centre pane of the Time Off & Coverage screen, and the seam
// `TimeOffCoverageScreen` calls `renderCoverage`. It answers Requirement 8:
//
// | asked for                                        | how                                        | criterion |
// | ------------------------------------------------ | ------------------------------------------ | --------- |
// | a monthly view and a two-week view, switchable    | `view` state, one grid builder each        | 8.1       |
// | the six per-date figures                          | four in the cell, two in the date drawer   | 8.2, 8.5  |
// | one status indicator, at most four numbers        | `CoverageBadge` plus the four-figure line  | 8.3       |
// | status by label or icon as well as colour         | `CoverageBadge`, which renders all three   | 8.4       |
// | a drawer on the selected date                     | `CoverageDateDrawer`                       | 8.5       |
// | the whole displayed range in a single request      | one `/api/coverage` read per grid          | 8.12      |
// | absences unnamed without the permission           | the response already withheld the names    | 8.13      |
//
// ## Six figures, four numbers
//
// Criterion 2 names six things a date carries and criterion 3 allows a cell one
// status indicator and four numbers. Two therefore have to move, and criterion 5
// says where: the minimum required coverage and the interval breakdown belong to
// the date's drawer. So a cell shows scheduled, approved off, pending, and
// projected available, and the requirement those are judged against is the first
// thing the drawer states.
//
// The date-of-month numeral is the cell's own name rather than one of the four
// figures. A calendar cell that did not say which date it was would not be a
// calendar cell.
//
// ## One request per displayed range, never one per date
//
// Criterion 12 asks for the whole displayed range in a single request, and
// `/api/coverage` answers a range with a fixed number of queries whatever its
// length. So the grid is computed first — including the leading and trailing days a
// month view borrows from its neighbouring months, because those are displayed and
// a reader comparing the 1st against the 31st before it needs both — and one read
// covers all of it. Changing the view or stepping a month is a different range and
// therefore a different read; nothing here loops over dates issuing requests.
//
// The read does not poll. Projected coverage moves when a schedule or a decision
// changes, not with the clock, and a month grid refreshing every minute would be a
// request per minute for a figure that had not moved. It refetches when the range
// or the department changes, and the screen refreshes it after a decision.
//
// ## A single bad date does not blank the month
//
// Per-date results carry an optional `unavailable: { reason }` rather than failing
// the range (Requirement 9, criterion 14). A cell with no figures says so and
// states its reason; the other thirty keep theirs.
//
// ## Where the view starts
//
// The anchor follows the screen, in this order: the requested dates of the
// selected request, so criterion 10's highlight is on a date the reader can
// actually see; then the window the Request_Inbox read over, so the calendar opens
// on the same dates as the queue beside it; then today in the business timezone.
// Stepping a month or switching the view sets the anchor by hand, and selecting a
// different request moves it again — a highlight outside the displayed range would
// be a highlight nobody can see.
//
// Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.12, 8.13, 9.14, 7.10, 22.5, 22.6,
// 22.7, 22.9, 22.12, 22.14, 22.15, 22.16

'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import type { Department } from '@/lib/permissions';

import type { DateRange } from '../domain/types';
import { addCalendarDays, consecutiveDates, workDateOf, zonedToInstant } from '../domain/work-date';
import type { CoverageDate, CoverageResponse } from '../server/coverage-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { CoverageBadge } from '../shared/CoverageBadge';
import { formatWorkDate, formatWorkDateLong, formatWorkMonth } from '../shared/format';
import { colorRoleToken } from '../shared/tokens';
import { useAsyncResource } from '../shared/useAsyncResource';
import { DEPARTMENT_LABELS } from '../types';
import { CoverageDateDrawer, hasCoverageFigures } from './CoverageDateDrawer';
import type { CoveragePaneContext } from './TimeOffCoverageScreen';

// ─── The two views ───────────────────────────────────────────────────────────

/**
 * The two arrangements of Requirement 8, criterion 1.
 *
 * `fortnight` rather than `two_week` because that is the noun the two-week view
 * is: fourteen consecutive dates beginning on the week containing the anchor.
 */
export type CoverageCalendarView = 'month' | 'fortnight';

/** Both views, in the order criterion 1 names them. */
export const COVERAGE_CALENDAR_VIEWS: readonly CoverageCalendarView[] = ['month', 'fortnight'];

const VIEW_LABELS: Record<CoverageCalendarView, string> = {
  month: 'Month',
  fortnight: 'Two weeks',
};

/** How many dates the two-week view shows. */
const FORTNIGHT_DAYS = 14;

/**
 * Weekday column headings, Sunday first.
 *
 * Sunday first because `staffing_thresholds.day_of_week` numbers Sunday 0, and a
 * grid whose columns ran Monday to Sunday would have its columns and the threshold
 * table's rows disagreeing about which day is which.
 */
const WEEKDAY_HEADINGS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The zone every date in this component is read in when none is supplied. */
const FALLBACK_TIME_ZONE = 'UTC';

// ─── Calendar arithmetic ─────────────────────────────────────────────────────
//
// All of it steps through `domain/work-date.ts`. `addCalendarDays` is the module's
// single calendar step and `zonedToInstant` its single date-to-instant conversion,
// so a grid crossing a daylight-saving transition still advances one date per cell
// and the weekday of a date is a property of the calendar rather than of the
// timezone the browser happens to be in.

/**
 * The weekday of a calendar date, 0 for Sunday.
 *
 * Anchored at midnight UTC, where every day is exactly 24 hours, so the answer
 * depends on neither the reader's zone nor the business zone — the weekday of the
 * 11th of August is the same fact everywhere. The same reading the
 * Coverage_Service takes for `dayOfWeek`, through the same function, so a column
 * and a threshold row cannot disagree.
 */
function weekdayOf(date: string): number {
  return zonedToInstant(date, '00:00:00', FALLBACK_TIME_ZONE).getUTCDay();
}

/** The Sunday at or before `date`. */
function weekStart(date: string): string {
  return addCalendarDays(date, -weekdayOf(date));
}

/** The first of the month `date` falls in. */
function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** The first of the month after the one `date` falls in. */
function nextMonthStart(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`;
}

/** One view's displayed dates, and the range they span. */
interface CalendarGrid {
  view: CoverageCalendarView;
  /** `YYYY-MM` of the anchored month, for the month view's focus test. */
  month: string;
  /** Both bounds inclusive: exactly what the one read asks for. */
  range: DateRange;
  /** Every displayed date, ascending. A multiple of seven, so the rows are whole. */
  dates: string[];
}

/**
 * The dates a view displays for an anchor.
 *
 * The month view shows whole weeks, so it borrows the days either side needed to
 * square the grid — between 28 and 42 dates. The two-week view shows fourteen from
 * the Sunday of the anchor's week. Both are well inside the range width the
 * coverage read accepts, so either is one request.
 *
 * Requirements: 8.1, 8.12
 */
export function calendarGrid(view: CoverageCalendarView, anchor: string): CalendarGrid {
  const month = anchor.slice(0, 7);

  if (view === 'fortnight') {
    const dates = consecutiveDates(weekStart(anchor), FORTNIGHT_DAYS);
    return {
      view,
      month,
      range: { from: dates[0], to: dates[dates.length - 1] },
      dates,
    };
  }

  const first = weekStart(monthStart(anchor));
  const lastOfMonth = addCalendarDays(nextMonthStart(anchor), -1);
  const last = addCalendarDays(lastOfMonth, 6 - weekdayOf(lastOfMonth));

  const dates: string[] = [];
  for (let cursor = first; cursor <= last; cursor = addCalendarDays(cursor, 1)) dates.push(cursor);

  return { view, month, range: { from: first, to: last }, dates };
}

/** The anchor one step earlier: the previous month, or the previous fortnight. */
function previousAnchor(view: CoverageCalendarView, anchor: string): string {
  return view === 'month'
    ? addCalendarDays(monthStart(anchor), -1)
    : addCalendarDays(anchor, -FORTNIGHT_DAYS);
}

/** The anchor one step later. */
function nextAnchor(view: CoverageCalendarView, anchor: string): string {
  return view === 'month' ? nextMonthStart(anchor) : addCalendarDays(anchor, FORTNIGHT_DAYS);
}

/**
 * Today in a named zone, falling back to UTC for a zone this runtime cannot read.
 *
 * Through `workDateOf`, which is the module's one instant-to-work-date mapping
 * (Requirement 19, criterion 10). The zone is the business timezone rather than the
 * browser's: a reader opening the calendar at 23:00 on the far side of the world
 * should land on the organisation's current date, which is the same date the
 * coverage read would have defaulted to.
 */
function todayIn(timeZone: string): string {
  const now = new Date();
  try {
    return workDateOf(now, timeZone);
  } catch {
    return workDateOf(now, FALLBACK_TIME_ZONE);
  }
}

/**
 * `candidate` if it is a calendar date this module can step, otherwise `fallback`.
 *
 * The anchors this component is given all come from the server or from its own
 * arithmetic, so this is a backstop rather than a routine path — but a malformed
 * anchor would throw inside `calendarGrid` and take the pane down with it, and an
 * unreadable date in a sibling pane's response is not a reason for the calendar to
 * disappear.
 */
function usableDate(candidate: string | null | undefined, fallback: string): string {
  if (typeof candidate !== 'string') return fallback;
  try {
    return addCalendarDays(candidate, 0);
  } catch {
    return fallback;
  }
}

// ─── The read ────────────────────────────────────────────────────────────────

/**
 * The one read a grid makes: projected coverage for the whole displayed range.
 *
 * `mode=projected` because a calendar of future dates is a projection — live
 * coverage answers a single date from clock state and would mean nothing on the
 * 14th of next month. The department is sent when the screen is filtered to one,
 * so the figures are the same expression over a smaller roster (Requirement 8,
 * criterion 8) rather than an organisation figure displayed under a department
 * heading.
 *
 * Requirements: 8.12
 */
function coverageUrl(range: DateRange, department: Department | null): string {
  const params = new URLSearchParams({ mode: 'projected', from: range.from, to: range.to });
  if (department !== null) params.set('department', department);
  return `/api/coverage?${params.toString()}`;
}

// ─── Cells ───────────────────────────────────────────────────────────────────

/** The four numbers a cell carries, in the order the design fixes them. */
const CELL_FIGURE_LEGEND =
  'Each date shows scheduled (sch), approved off (off), pending requests (pend), and projected available (proj). The minimum required coverage and the interval breakdown are in the date\u2019s panel.';

/** One of the four figures: the number, then its abbreviated caption. */
function CellFigure({ value, caption }: { value: number; caption: string }) {
  return (
    <span className={`whitespace-nowrap ${value === 0 ? 'text-slate-300' : 'text-slate-600'}`}>
      <span className="font-black">{value}</span>
      <span className="ml-0.5 font-bold">{caption}</span>
    </span>
  );
}

/**
 * What a cell's control is called, in full words.
 *
 * The visible figures are abbreviated to fit a date cell and the legend under the
 * grid explains them, but a control's accessible name has to stand on its own
 * (Requirement 22, criterion 12). So the name is written out here: the date, the
 * status, and the four figures, in the same order the cell renders them.
 *
 * Requirements: 22.12
 */
function cellAccessibleName(
  workDate: string,
  coverage: CoverageDate | null,
  highlighted: boolean,
): string {
  const date = formatWorkDateLong(workDate);
  const selection = highlighted ? ' Part of the selected request.' : '';

  if (coverage === null) return `${date}. Coverage not loaded yet.${selection}`;
  if (!hasCoverageFigures(coverage)) {
    return `${date}. No coverage projection: ${coverage.unavailable.reason}${selection}`;
  }

  const { projection } = coverage;
  const closed = coverage.closed ? ' The organisation is closed.' : '';

  return (
    `${date}.${closed} ${projection.scheduled} scheduled, ` +
    `${projection.approvedAbsences} approved off, ${coverage.pendingRequests.length} pending, ` +
    `${projection.available} projected available.${selection}`
  );
}

interface CalendarCellProps {
  workDate: string;
  /** The response's entry for this date, or null while the read is outstanding. */
  coverage: CoverageDate | null;
  /** Whether the date belongs to the anchored month. Always true in the two-week view. */
  inFocus: boolean;
  /** Inside the selected request's requested dates (Requirement 7, criterion 10). */
  highlighted: boolean;
  /** The date whose drawer is open. */
  selected: boolean;
  /** Today in the business timezone, so the current date is findable at a glance. */
  today: boolean;
  onSelect: (workDate: string) => void;
}

/**
 * One date: its numeral, one status indicator, and four numbers.
 *
 * A real `button` rather than a clickable cell, so the drawer has a control to
 * return focus to when it closes and the grid is reachable by keyboard without
 * this component reinventing what a button already does (Requirement 22, criteria
 * 9, 10, and 11).
 *
 * Requirements: 8.3, 8.4, 8.5, 9.14, 22.9, 22.12
 */
function CalendarCell({
  workDate,
  coverage,
  inFocus,
  highlighted,
  selected,
  today,
  onSelect,
}: CalendarCellProps) {
  const accent = colorRoleToken('accent');
  const computed = coverage !== null && hasCoverageFigures(coverage) ? coverage : null;
  const dayOfMonth = Number(workDate.slice(8, 10));

  const shell = [
    'flex h-full w-full flex-col items-start gap-1 rounded-xl border px-2 py-1.5 text-left transition',
    highlighted ? `${accent.surface} ${accent.border}` : 'border-slate-200 bg-white',
    selected ? `ring-2 ${accent.ring}` : '',
    inFocus ? '' : 'opacity-55',
    'hover:bg-slate-50',
  ]
    .filter((part) => part !== '')
    .join(' ');

  return (
    <button
      type="button"
      onClick={() => onSelect(workDate)}
      aria-haspopup="dialog"
      aria-expanded={selected}
      aria-label={cellAccessibleName(workDate, coverage, highlighted)}
      className={shell}
    >
      <span className="flex w-full items-baseline justify-between gap-1">
        <span
          className={
            today
              ? `rounded-md px-1.5 text-[13px] font-black ${accent.surface} ${accent.text}`
              : 'text-[13px] font-black text-slate-900'
          }
        >
          {dayOfMonth}
        </span>
        {computed !== null && computed.closed && (
          <span className="truncate text-[10px] font-bold text-slate-400">
            {computed.closedLabel ?? 'Closed'}
          </span>
        )}
      </span>

      {/* Three states, and the branch narrows the per-date union rather than
          testing a separate flag: a cell either has figures, or is waiting for
          them, or carries the reason it has none. Criteria 3 and 4 hold on the
          first branch — one status indicator, carrying its label and its icon as
          well as its colour, and exactly four numbers. The indicator is rendered
          without counts, because those four are the cell's whole allowance and the
          requirement they are judged against belongs to the drawer (criterion 5). */}
      {coverage === null ? (
        <span className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-400">
          Loading
        </span>
      ) : hasCoverageFigures(coverage) ? (
        <>
          <CoverageBadge status={coverage.projection.status} />
          <span className="flex flex-wrap gap-x-1.5 gap-y-0.5 text-[10px] leading-tight">
            <CellFigure value={coverage.projection.scheduled} caption="sch" />
            <CellFigure value={coverage.projection.approvedAbsences} caption="off" />
            <CellFigure value={coverage.pendingRequests.length} caption="pend" />
            <CellFigure value={coverage.projection.available} caption="proj" />
          </span>
        </>
      ) : (
        <>
          <span className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-400">
            Unavailable
          </span>
          {/* Requirement 9, criterion 14: the reason travels with the date rather
              than replacing the range. Clamped to two lines here; the drawer states
              it in full. */}
          <span className="line-clamp-2 text-[10px] font-semibold text-slate-400">
            {coverage.unavailable.reason}
          </span>
        </>
      )}
    </button>
  );
}

// ─── Chrome ──────────────────────────────────────────────────────────────────

/** The view switch of criterion 1: one control per view, the active one marked. */
function ViewSwitch({
  view,
  onChange,
}: {
  view: CoverageCalendarView;
  onChange: (next: CoverageCalendarView) => void;
}) {
  const accent = colorRoleToken('accent');

  return (
    <div
      role="group"
      aria-label="Calendar view"
      className="inline-flex rounded-xl border border-slate-200 bg-white p-0.5"
    >
      {COVERAGE_CALENDAR_VIEWS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={option === view}
          className={[
            'rounded-lg px-2.5 py-1 text-[11px] font-black transition',
            option === view ? `${accent.surface} ${accent.text}` : 'text-slate-500 hover:bg-slate-50',
          ].join(' ')}
        >
          {VIEW_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

const STEP_BUTTON =
  'inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-[11px] font-black text-slate-600 transition hover:bg-slate-50';

// ─── The pane ────────────────────────────────────────────────────────────────

/**
 * What the calendar takes: the pane context the screen hands its centre pane,
 * plus the two facts the screen has no reason to hold.
 *
 * `CoveragePaneContext` is extended rather than restated, so the seam's contract
 * is checked by the compiler: a field added to the context reaches this component
 * without an edit, and a field renamed there stops this file compiling rather than
 * silently arriving as `undefined`. The import is type-only, so nothing of the
 * screen crosses into this module at runtime and the screen still does not import
 * the calendar.
 */
export interface CoverageCalendarProps extends CoveragePaneContext {
  /**
   * The zone dates and interval bounds are read in: the business timezone. These
   * figures describe the organisation's working day rather than any one reader's
   * clock, so the zone is the organisation's.
   */
  timeZone?: string;
  /** The view the calendar opens in. Defaults to the month. */
  initialView?: CoverageCalendarView;
}

/**
 * The Coverage_Calendar: projected coverage per date, one request per range.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.12, 8.13, 9.14
 */
export function CoverageCalendar({
  highlightedRange,
  window: inboxWindow,
  department,
  timeZone = FALLBACK_TIME_ZONE,
  initialView = 'month',
}: CoverageCalendarProps) {
  const today = useMemo(() => todayIn(timeZone), [timeZone]);

  const [view, setView] = useState<CoverageCalendarView>(initialView);
  const [anchor, setAnchor] = useState<string>(() =>
    usableDate(highlightedRange?.from ?? inboxWindow?.from, today),
  );
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  // Selecting a different request in the inbox moves the calendar to its dates.
  // Criterion 10 asks for the requested dates to be highlighted, and a highlight
  // on a date outside the displayed range is a highlight nobody can see. Adjusted
  // during render rather than in an effect, so the first paint after a selection
  // already shows the right month.
  const highlightFrom = highlightedRange?.from ?? null;
  const [followedHighlight, setFollowedHighlight] = useState<string | null>(highlightFrom);
  if (highlightFrom !== followedHighlight) {
    setFollowedHighlight(highlightFrom);
    if (highlightFrom !== null) {
      setAnchor(usableDate(highlightFrom, today));
      setSelectedDate(null);
    }
  }

  const grid = useMemo(() => calendarGrid(view, anchor), [view, anchor]);
  const url = useMemo(() => coverageUrl(grid.range, department), [grid.range, department]);

  // One read per displayed range (criterion 12). No poll: a projection moves when
  // a schedule or a decision moves, not with the clock.
  const coverage = useAsyncResource(
    (signal) => attendanceJson<CoverageResponse>(url, { signal }),
    {
      deps: [url],
      subject: 'projected coverage',
      filters: [
        { label: 'View', value: VIEW_LABELS[view] },
        {
          label: 'Dates',
          value: `${formatWorkDate(grid.range.from)} to ${formatWorkDate(grid.range.to)}`,
        },
        {
          label: 'Department',
          value: department === null ? 'All departments' : DEPARTMENT_LABELS[department],
        },
      ],
      isEmpty: (response) => response.dates.length === 0,
    },
  );

  const byDate = useMemo<ReadonlyMap<string, CoverageDate>>(
    () => new Map((coverage.data?.dates ?? []).map((date) => [date.workDate, date])),
    [coverage.data],
  );

  const selected = selectedDate === null ? null : (byDate.get(selectedDate) ?? null);
  const namesVisible = coverage.data?.employeeNamesVisible ?? false;
  const thresholdsConfigured = coverage.data?.thresholdsConfigured ?? false;

  // The month view is named by its month; the two-week view has no name but its
  // two ends. Either way the heading states the range the one read covered, so a
  // reader can see which dates the figures below belong to (Requirement 22,
  // criterion 15's sibling: what is on screen says what it is).
  const rangeLabel =
    view === 'month'
      ? formatWorkMonth(anchor)
      : `${formatWorkDate(grid.range.from)} \u2013 ${formatWorkDate(grid.range.to)}`;

  return (
    // One element, because the screen places this straight into the pane grid and
    // a fragment with two children would be two columns. `min-w-0` is what lets the
    // grid track actually shrink: without it the grid's `minmax(0, 1fr)` centre
    // column is widened by the calendar's own minimum width instead of the calendar
    // scrolling inside it.
    <div className="min-w-0">
      <section
        aria-labelledby="coverage-calendar-heading"
        className="rounded-[22px] border border-slate-200 bg-white shadow-sm"
      >
        <div className="space-y-3 border-b border-slate-100 px-4 py-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2
                id="coverage-calendar-heading"
                className="text-xs font-black uppercase tracking-[0.16em] text-slate-500"
              >
                Projected coverage
              </h2>
              <p className="mt-0.5 text-[13px] font-black text-slate-900">{rangeLabel}</p>
            </div>
            <ViewSwitch view={view} onChange={setView} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setAnchor(previousAnchor(view, anchor))}
              className={STEP_BUTTON}
            >
              <ChevronLeft className="h-3 w-3" aria-hidden="true" />
              {view === 'month' ? 'Previous month' : 'Previous two weeks'}
            </button>
            <button type="button" onClick={() => setAnchor(today)} className={STEP_BUTTON}>
              Today
            </button>
            <button
              type="button"
              onClick={() => setAnchor(nextAnchor(view, anchor))}
              className={STEP_BUTTON}
            >
              {view === 'month' ? 'Next month' : 'Next two weeks'}
              <ChevronRight className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>

          {/* What this figure is, so it is not read as a count of who is on the
              floor. The live figure lives on Today; this one reads published
              schedules and absences and no clock data at all. */}
          <p className="text-[12px] font-semibold text-slate-500">
            Employees carrying a published shift on each date, less those with an approved absence
            covering it. Select a date for the minimum required coverage, the people behind each
            figure, and the interval breakdown.
          </p>

          <p className="text-[11px] font-semibold text-slate-400">{CELL_FIGURE_LEGEND}</p>

          {coverage.data !== null && !thresholdsConfigured && (
            <p className="text-[11px] font-semibold text-slate-400">
              No minimum staffing is configured yet, so every date reports a healthy status whatever
              the projection.
            </p>
          )}

          {coverage.data !== null && !namesVisible && (
            <p className="text-[11px] font-semibold text-slate-400">
              Absences are shown without employee names.
            </p>
          )}
        </div>

        <div className="space-y-3 px-4 py-4">
          <AsyncStateBlock
            status={coverage.status}
            failure={coverage.failure}
            pending={coverage.pending}
            onRetry={coverage.retry}
            subject="projected coverage"
            message={coverage.emptyMessage}
          />

          {/* A date cell needs room for a status pill and four figures, so the grid
              carries a minimum width and scrolls rather than crushing its columns
              on a narrow screen. */}
          <div className="overflow-x-auto">
            <div className="min-w-[44rem]">
              <div className="grid grid-cols-7 gap-1 pb-1">
                {WEEKDAY_HEADINGS.map((heading) => (
                  <div
                    key={heading}
                    className="text-center text-[10px] font-black uppercase tracking-[0.12em] text-slate-400"
                  >
                    {heading}
                  </div>
                ))}
              </div>

              <div className="grid auto-rows-fr grid-cols-7 gap-1">
                {grid.dates.map((workDate) => (
                  <CalendarCell
                    key={workDate}
                    workDate={workDate}
                    coverage={byDate.get(workDate) ?? null}
                    inFocus={view === 'fortnight' || workDate.slice(0, 7) === grid.month}
                    highlighted={
                      highlightedRange !== null &&
                      workDate >= highlightedRange.from &&
                      workDate <= highlightedRange.to
                    }
                    selected={workDate === selectedDate}
                    today={workDate === today}
                    onSelect={(date) =>
                      setSelectedDate((current) => (current === date ? null : date))
                    }
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Criterion 5: the scheduled employees, the approved absences, the pending
          requests, and the interval breakdown, plus the required coverage the cell
          has no room for. */}
      <CoverageDateDrawer
        date={selected}
        employeeNamesVisible={namesVisible}
        timeZone={timeZone}
        onClose={() => setSelectedDate(null)}
      />
    </div>
  );
}

/**
 * The Coverage_Calendar as `TimeOffCoverageScreen`'s `renderCoverage` seam expects
 * it: a function of the pane context.
 *
 * The screen owns the three-pane arrangement and passes each pane the context it
 * needs; it does not import the panes themselves, so a screen with no calendar
 * simply has no centre pane. This is the adapter that plugs one in:
 *
 * ```tsx
 * <TimeOffCoverageScreen
 *   initialProfile={profile}
 *   renderCoverage={renderCoveragePane({ timeZone: policy.businessTimezone })}
 * />
 * ```
 *
 * `timeZone` is a parameter rather than a prop of the context because it is a fact
 * about the organisation rather than about the selection, and the screen has no
 * reason to hold it.
 *
 * Requirements: 8.1, 8.12
 */
export function renderCoveragePane(
  options: { timeZone?: string; initialView?: CoverageCalendarView } = {},
): (context: CoveragePaneContext) => ReactNode {
  return function CoveragePane(context: CoveragePaneContext) {
    return <CoverageCalendar {...context} {...options} />;
  };
}

export default CoverageCalendar;
