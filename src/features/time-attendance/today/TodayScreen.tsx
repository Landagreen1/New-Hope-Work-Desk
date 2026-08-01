// src/features/time-attendance/today/TodayScreen.tsx
// The first Time & Attendance navigation item, and the one decision it makes.
//
// Today is one navigation item with two audiences. An employee gets My Day: one
// shift, one action, the alerts that concern them (Requirement 4). An
// Attendance_Administrator gets Team Today: the roster, the summary counters,
// live coverage, and their own clock reduced to a header control (Requirements 5
// and 6). This module is the branch between the two, and the branch holds nothing
// itself, because the two views share almost nothing beyond the date they
// describe.
//
// It is a branch rather than a composition on purpose. Requirement 5, criterion 2
// gives the administrator's primary content area to team attendance rather than
// to the signed-in user's own clock, and criterion 21 gives a non-administrator My
// Day with no part of Team Today. Rendering both to an administrator would break
// the first; rendering Team Today to everyone would break the second.
//
// The predicate is `canAdministerAttendance`, the module's single definition of an
// Attendance_Administrator, imported rather than restated. The workspace gates the
// administrator-only *sections* behind the same predicate, so this branch is not a
// permission check standing alone: it decides which of two permitted views a
// permitted screen shows.
//
// ## Team Today's two reads, and why there are two
//
// `/api/attendance/day` answers today for every employee in scope. It is what the
// eight counters are counted over and what the header control reads its own clock
// state from — the whole team, unfiltered and unpaged, which is what a summary
// has to be counted over.
//
// `/api/attendance/records` answers the roster below, under the query the
// selected counter and the three filters compose. That is the point of the second
// read: Requirement 5, criterion 5 asks the table to show the records that
// produced a counter, and the only way that holds a minute later is if the rows
// come from the server under the counter's own query rather than from a
// client-side pass over the rows the screen happens to be holding.
//
// Both poll on the one sixty-second hook (criterion 19), and both pause while the
// tab is hidden.
//
// None of the eight counters reads a review stamp or a payroll-blocking flag,
// which matters because the day read does not load the review, note, and approval
// tables and the records read does. The two therefore cannot disagree about a
// counter and its rows: every counter is a question about schedules, sessions,
// breaks, and absences, and both reads answer those identically.
//
// ## The two things a row and a department row open
//
// Selecting an employee row opens `EmployeeDayDrawer` (Requirement 5, criteria 10
// through 15); selecting a department row in `LiveCoveragePanel` opens the same
// `SideDrawer` on that department's headcounts (Requirement 6, criterion 14). The
// coverage panel holds its own read of `/api/coverage` in `live` mode, because
// coverage is a different question from attendance and the Coverage_Service is
// what answers it; the employee drawer holds a read of one employee's fortnight
// for the history and the notes, and takes today's own figures from the row this
// component already holds.
//
// ## A committed correction moves the row it changed, and nothing else guesses
//
// Requirement 5, criterion 18 asks the recomputed status and worked hours to
// appear without a page reload. The write endpoints return the recomputed
// `DailyAttendanceRecord`, so `onCommitted` below replaces the affected record in
// both held reads from that response — no derivation in the browser, and no
// request. `refreshAll` follows it, because a corrected record can move a counter
// it was not previously in, and a counter is a count over the whole day read
// rather than over the one row that changed. The coverage panel is not refreshed
// from here: it holds its own read and its own minute.
//
// Requirements: 4.1, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.18,
// 5.19, 5.20, 5.21, 6.1, 6.15, 22.1

'use client';

import { useCallback, useMemo, useState } from 'react';

import { canAdministerAttendance } from '@/lib/permissions';

import type { ProfileLite } from '../../nhwd-shared/types';
import { statusLabel } from '../../nhwd-shared/ui';
import type { RecordQuery, RecordSubjectIndex } from '../domain/attendance';
import type { DailyAttendanceRecord } from '../domain/types';
import type { AttendanceEmployee, DayResponse, RecordPage } from '../server/attendance-service';
import { attendanceJson } from '../shared/api-failure';
import { AsyncStateBlock } from '../shared/AsyncStateBlock';
import { formatTimeOfDay, formatWorkDateLong } from '../shared/format';
import { recordQueryUrl } from '../shared/record-query';
import { useAttendancePoll } from '../shared/useAttendancePoll';
import type { ActiveFilter } from '../shared/useAsyncResource';
import { EmployeeDayDrawer } from './EmployeeDayDrawer';
import { LiveCoveragePanel } from './LiveCoveragePanel';
import { MyDayPanel, emptyDayRecord } from './MyDayPanel';
import { TeamTodayHeader } from './TeamTodayHeader';
import {
  TeamTodaySummary,
  teamTodayCounter,
  teamTodayCounterQuery,
  type TeamTodayCounterId,
} from './TeamTodaySummary';
import {
  NO_TEAM_TODAY_FILTERS,
  TeamTodayTable,
  type TeamTodayFilters,
} from './TeamTodayTable';

/** A stable empty roster, so a memo does not see a new array every render. */
const NO_EMPLOYEES: readonly AttendanceEmployee[] = [];

/**
 * A record list with one record replaced by its recomputed self.
 *
 * Matched on the pair that identifies a record — one employee, one work date
 * (Requirement 3, criterion 1). A record the list does not hold is left out
 * rather than appended: the lists here answer a query, and a row that has just
 * started matching one is the next read's business, not this replacement's.
 *
 * Requirements: 5.18
 */
function withRecord(
  records: readonly DailyAttendanceRecord[],
  next: DailyAttendanceRecord,
): DailyAttendanceRecord[] {
  return records.map((record) =>
    record.profileId === next.profileId && record.workDate === next.workDate ? next : record,
  );
}

/**
 * Team Today: the administrator's operational view of the current date.
 *
 * Holds the two reads and the active query, and nothing else — the counters, the
 * roster, and the clock control each render what they are given.
 *
 * Requirements: 5.1–5.9, 5.19, 5.20
 */
function TeamToday({ profile }: { profile: ProfileLite }) {
  const [counter, setCounter] = useState<TeamTodayCounterId | null>(null);
  const [filters, setFilters] = useState<TeamTodayFilters>(NO_TEAM_TODAY_FILTERS);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);

  // The date is deliberately not sent: the route resolves today in the business
  // timezone, where a browser sending its own local date would file the hour
  // either side of midnight against the wrong work date.
  const day = useAttendancePoll(
    (signal) => attendanceJson<DayResponse>('/api/attendance/day', { signal }),
    { subject: 'today', isEmpty: () => false },
  );

  const today = day.data?.date ?? null;
  const dayEmployees = day.data?.employees ?? NO_EMPLOYEES;

  // The counters are scoped by the date and by the department filter, but not by
  // the status and exception filters. A department is a scope — which part of the
  // team am I looking at — and scoping the counters by it keeps a counter and the
  // rows behind it in agreement. A status filter is itself a selection of the kind
  // the counters partition, so folding it in would zero seven of the eight and
  // leave a summary that summarises nothing.
  const counterBase = useMemo<RecordQuery>(() => {
    if (today === null) return {};
    const query: RecordQuery = { from: today, to: today };
    if (filters.department !== null) query.departments = [filters.department];
    return query;
  }, [today, filters.department]);

  // What the roster is read under: the date, the three filters, and the selected
  // counter's own scope conjoined on top.
  const tableQuery = useMemo<RecordQuery | null>(() => {
    if (today === null) return null;

    const base: RecordQuery = { from: today, to: today };
    if (filters.department !== null) base.departments = [filters.department];
    if (filters.status !== null) base.statuses = [filters.status];
    if (filters.exception !== null) base.exceptionCodes = [filters.exception];

    return counter === null ? base : teamTodayCounterQuery(counter, base);
  }, [today, filters, counter]);

  // A counter and a filter can contradict each other — "working" and "absent" have
  // no record in common — and the intersection of two list filters is then empty.
  // An empty list matches nothing and cannot be written as a query string, so the
  // read is skipped rather than sent as the wider question the parameters would
  // describe.
  const table = useMemo(
    () =>
      tableQuery === null
        ? { url: '', unsatisfiable: false }
        : recordQueryUrl('/api/attendance/records', tableQuery),
    [tableQuery],
  );

  const activeFilters = useMemo<ActiveFilter[]>(
    () => [
      { label: 'Date', value: today ?? 'today' },
      {
        label: 'Counter',
        value: counter === null ? 'All records' : teamTodayCounter(counter).label,
      },
      {
        label: 'Department',
        value: filters.department === null ? 'All departments' : statusLabel(filters.department),
      },
      {
        label: 'Status',
        value: filters.status === null ? 'All statuses' : statusLabel(filters.status),
      },
      {
        label: 'Exception',
        value: filters.exception === null ? 'All exceptions' : statusLabel(filters.exception),
      },
    ],
    [today, counter, filters],
  );

  const records = useAttendancePoll(
    (signal) => attendanceJson<RecordPage>(table.url, { signal }),
    {
      deps: [table.url],
      enabled: table.url !== '' && !table.unsatisfiable,
      subject: 'team attendance',
      filters: activeFilters,
      isEmpty: (page) => page.rows.length === 0,
    },
  );

  const refreshDay = day.refresh;
  const refreshRecords = records.refresh;

  // A clock action, a correction, or any other write moves both reads, because the
  // counters and the rows describe the same records from two angles.
  const refreshAll = useCallback(() => {
    refreshDay();
    refreshRecords();
  }, [refreshDay, refreshRecords]);

  const setDayData = day.setData;
  const setRecordsData = records.setData;
  const dayData = day.data;
  const recordsData = records.data;

  /**
   * A committed write from the employee drawer.
   *
   * The recomputed record replaces the affected row in both held reads, so the
   * status and the worked hours the reader is looking at move immediately and
   * without a request (Requirement 5, criterion 18). The refresh that follows
   * catches the figures a replacement cannot move on its own — the eight counters
   * are counts over the day read, and a corrected record can leave one counter and
   * join another — and it is a background refetch rather than a reload.
   *
   * A response carrying no record is a note on a date with nothing else recorded.
   * There is no row to replace, so the refresh is the whole answer.
   */
  const onCommitted = useCallback(
    (record: DailyAttendanceRecord | null) => {
      if (record !== null) {
        if (dayData !== null) {
          setDayData({ ...dayData, records: withRecord(dayData.records, record) });
        }
        if (recordsData !== null) {
          setRecordsData({ ...recordsData, rows: withRecord(recordsData.rows, record) });
        }
      }
      refreshAll();
    },
    [dayData, recordsData, refreshAll, setDayData, setRecordsData],
  );

  // Departments come from the employee list, which the record queries filter on,
  // so the same objects serve as the subject index and as the row labels.
  const subjects = useMemo<RecordSubjectIndex>(
    () => new Map(dayEmployees.map((employee) => [employee.profileId, employee])),
    [dayEmployees],
  );

  const ownEmployee = dayEmployees.find((employee) => employee.profileId === profile.id);
  const ownTimeZone =
    ownEmployee?.timezone ?? day.data?.policy.businessTimezone ?? 'UTC';

  // A date with nothing recorded still has a clock state and still offers Clock
  // In, so the header is given the empty record rather than being hidden.
  const ownRecord = useMemo(() => {
    const found = day.data?.records.find((record) => record.profileId === profile.id) ?? null;
    if (found !== null) return found;
    return today === null ? null : emptyDayRecord(profile.id, today);
  }, [day.data, profile.id, today]);

  const rows = table.unsatisfiable ? [] : (records.data?.rows ?? []);
  const rowEmployees = records.data?.employees ?? dayEmployees;

  // The selected employee's record for today. Taken from the rows the reader
  // selected it from, and from the day read as the fallback, because the two
  // derive the same date from the same rows and either is the record the drawer is
  // about. A `find` over at most a hundred rows, so it is not worth memoising.
  const selectedRecord =
    selectedProfileId === null
      ? null
      : (rows.find((record) => record.profileId === selectedProfileId) ??
        day.data?.records.find((record) => record.profileId === selectedProfileId) ??
        null);

  const selectedEmployee =
    selectedProfileId === null
      ? undefined
      : (rowEmployees.find((employee) => employee.profileId === selectedProfileId) ??
        dayEmployees.find((employee) => employee.profileId === selectedProfileId));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-black tracking-tight text-slate-950">Team Today</h1>
          <p className="mt-0.5 text-xs font-semibold text-slate-500">
            {today === null ? 'Today' : formatWorkDateLong(today)}
          </p>
        </div>
        {day.data !== null && (
          <p className="text-[11px] font-semibold text-slate-400">
            {day.paused
              ? 'Paused while this tab is hidden'
              : `As at ${formatTimeOfDay(day.data.evaluatedAt, ownTimeZone)}`}
          </p>
        )}
      </div>

      {/* The team read's own loading and failed states, with the retry control of
          criterion 20. The counters below hold their last figures while it is
          outstanding rather than flickering to zero. */}
      <AsyncStateBlock
        status={day.status}
        failure={day.failure}
        pending={day.pending}
        onRetry={day.retry}
        subject={'today\u2019s team'}
      />

      {/* Criterion 1: the administrator's own clock, compact, above the content it
          is subordinate to. */}
      {ownRecord !== null && (
        <TeamTodayHeader
          record={ownRecord}
          displayName={profile.display_name}
          timeZone={ownTimeZone}
          onRecorded={refreshAll}
        />
      )}

      {/* Criteria 3 through 6: the eight counters, each carrying the query that
          both counts it and selects its rows. */}
      <TeamTodaySummary
        records={day.data?.records ?? []}
        subjects={subjects}
        baseQuery={counterBase}
        activeCounter={counter}
        onSelect={setCounter}
        onClear={() => setCounter(null)}
        loading={day.data === null}
      />

      {/* Criteria 7 through 9: the roster, read under the active query. */}
      <TeamTodayTable
        rows={rows}
        employees={rowEmployees}
        total={table.unsatisfiable ? 0 : (records.data?.total ?? rows.length)}
        hasMore={table.unsatisfiable ? false : (records.data?.hasMore ?? false)}
        filters={filters}
        onFiltersChange={setFilters}
        status={table.unsatisfiable ? 'empty' : records.status}
        failure={table.unsatisfiable ? null : records.failure}
        emptyMessage={records.emptyMessage}
        pending={records.pending}
        onRetry={records.retry}
        onSelectEmployee={setSelectedProfileId}
      />

      {/* Requirement 6: current operational coverage per department, on its own
          read of the Coverage_Service and labelled apart from the projection. */}
      <LiveCoveragePanel timeZone={day.data?.policy.businessTimezone} />

      {/* Requirement 5, criteria 10 through 18. Today's figures come from the row
          above; the history, the notes, and the five actions are the drawer's. */}
      <EmployeeDayDrawer
        profileId={selectedProfileId}
        workDate={today}
        employee={selectedEmployee}
        record={selectedRecord}
        employees={dayEmployees}
        fallbackTimeZone={ownTimeZone}
        canAdminister={canAdministerAttendance(profile.role)}
        onClose={() => setSelectedProfileId(null)}
        onCommitted={onCommitted}
      />
    </div>
  );
}

export interface TodayScreenProps {
  initialProfile: ProfileLite;
}

/**
 * The Today screen: Team Today for an administrator, My Day for everyone else.
 *
 * Requirements: 5.2, 5.21
 */
export function TodayScreen({ initialProfile }: TodayScreenProps) {
  return canAdministerAttendance(initialProfile.role) ? (
    <TeamToday profile={initialProfile} />
  ) : (
    <MyDayPanel profile={initialProfile} />
  );
}

export default TodayScreen;
